/** Turn local tool input into rule names. Never persist or transmit raw input. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const inside = (target, root) => target === root || target.startsWith(root + path.sep);
const expand = (target, home, repoRoot = null) => {
  const out = target.replace(/^~(?=$|[/\\])/u, home).replace(/^\$\{?HOME\}?(?=$|[/\\])|^%USERPROFILE%/iu, home);
  return repoRoot ? out.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?(?=$|[/\\])/u, repoRoot) : out;
};
const base = (word) => {
  const name = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase();
  return name.endsWith('.exe') ? name.slice(0, -4) : name;
};

const READERS = new Set(['cat', 'sed', 'awk', 'gawk', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'tac', 'strings',
  'base64', 'xxd', 'od', 'hexdump', 'dd', 'type', 'get-content', 'gc', 'cp', 'scp', 'rsync', 'rg', 'grep', 'egrep',
  'fgrep', 'source', '.', 'curl', 'jq']);
// Commands that name a file without printing what is in it. Any other command
// given a secret file as an argument counts as reading it.
const NOT_READERS = new Set(['ls', 'dir', 'stat', 'test', '[', '[[', 'file', 'du', 'wc', 'touch', 'chmod', 'chown',
  'chgrp', 'mkdir', 'rm', 'rmdir', 'unlink', 'shred', 'mv', 'ln', 'echo', 'printf', 'cd', 'pushd', 'popd', 'which',
  'whereis', 'realpath', 'readlink', 'basename', 'dirname', 'true', 'false', 'export', 'unset', 'set-location',
  'test-path', 'remove-item', 'new-item', 'get-childitem']);
const GIT_NOT_READING = new Set(['add', 'rm', 'mv', 'status', 'check-ignore', 'ls-files']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'su']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|mksh|ash|csh|tcsh|fish|pwsh|powershell|iex|invoke-expression|node|nodejs|deno|bun|python[\d.]*|pypy\d*|ruby|perl|php|lua|osascript|source|\.)$/u;
const CODE_RUNNERS = /^(?:node|nodejs|deno|bun|python[\d.]*|pypy\d*|ruby|perl|php)$/u;
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time']);
// Wrappers that run the rest of their arguments as a command, with the options
// of each that take a separate value.
const WRAPPERS = new Map([
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
  ['sudo', new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p',
    '--prompt', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout'])],
  ['doas', new Set(['-u', '-C'])],
  ['command', new Set()],
  ['builtin', new Set()],
  ['exec', new Set(['-a'])],
  ['nohup', new Set()],
  ['noglob', new Set()],
  ['nice', new Set(['-n', '--adjustment'])],
  ['ionice', new Set(['-c', '--class', '-n', '--classdata'])],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['time', new Set(['-f', '--format', '-o', '--output'])],
  ['caffeinate', new Set(['-t', '-w'])],
]);
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path']);
const EXAMPLE = /\.(?:example|sample|template|dist)$/u;
const SECRET_NAMES = ['.env', '.env.local', '.env.production', '.envrc', 'id_rsa', 'id_ed25519', 'server.pem',
  'client.p12', 'credentials', 'credentials.json', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.pgpass'];

/**
 * Match a shell glob against a short name in linear time per star (no
 * backtracking regular expression). Supports *, ? and [...] classes; an
 * unclosed [ is a literal.
 */
function globMatches(glob, text) {
  const tokens = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (tokens.at(-1)?.star !== true) tokens.push({ star: true }); continue; }
    if (c === '?') { tokens.push({ any: true }); continue; }
    if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end !== -1) {
        let body = glob.slice(i + 1, end);
        const negate = body[0] === '!' || body[0] === '^';
        if (negate) body = body.slice(1);
        const set = new Set();
        for (let k = 0; k < body.length; k++) {
          if (body[k + 1] === '-' && k + 2 < body.length) {
            for (let code = body.charCodeAt(k); code <= body.charCodeAt(k + 2) && set.size < 256; code++) set.add(String.fromCharCode(code));
            k += 2;
          } else set.add(body[k]);
        }
        tokens.push({ set, negate });
        i = end;
        continue;
      }
    }
    tokens.push({ literal: c });
  }
  const one = (token, ch) => token.any || (token.set ? token.set.has(ch) !== token.negate : token.literal === ch);
  // Greedy two-pointer wildcard match: remember the last star and retry from it.
  let t = 0, s = 0, star = -1, mark = 0;
  while (s < text.length) {
    if (t < tokens.length && !tokens[t].star && one(tokens[t], text[s])) { t++; s++; }
    else if (t < tokens.length && tokens[t].star) { star = t++; mark = s; }
    else if (star !== -1) { t = star + 1; s = ++mark; }
    else return false;
  }
  while (t < tokens.length && tokens[t].star) t++;
  return t === tokens.length;
}

/** True when a single shell word or tool path names a secret file. */
export function isSecretPath(value) {
  if (typeof value !== 'string' || !value) return false;
  const word = value.replace(/^--?[\w-]+=/u, '').replace(/^@/u, '').replace(/[\\/]+$/u, '');
  if (/[/\\]\.aws[/\\]credentials$|[/\\]\.docker[/\\]config\.json$|keychain|credential_store/iu.test(word)) return true;
  const name = word.replace(/^.*[/\\]/u, '').toLowerCase();
  if (/[*?[]/u.test(name)) {
    // A glob names a secret when it could expand to one. Require two literal
    // characters so `cat *` is not treated as a credential read, except for a
    // dot-glob such as `.*`, which expands to every hidden file.
    if (!name.startsWith('.') && name.replace(/[*?[\]]/gu, '').length < 2) return false;
    return SECRET_NAMES.some((candidate) => globMatches(name, candidate));
  }
  if (EXAMPLE.test(name)) return false;
  return /^\.env(?:rc)?(?:\..+)?$|\.env$/u.test(name)
    || /\.(?:pem|key|p12|pfx)$/u.test(name) && name !== '.key'
    || /^id_[a-z0-9_-]+$/u.test(name)
    || /^\.?credentials(?:\.[a-z]+)?$|^\.git-credentials$|^_?\.?netrc$|^\.npmrc$|^\.pypirc$|^\.pgpass$/u.test(name);
}

const ANSI = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
/** Decode one ANSI-C (`$'…'`) escape starting after the backslash; returns [text, characters consumed]. */
function ansiEscape(command, i) {
  const c = command[i];
  if (c in ANSI) return [ANSI[c], 1];
  const run = (pattern, max) => { let n = 0; while (n < max && pattern.test(command[i + 1 + n] ?? '')) n++; return n; };
  if (c === 'x' || c === 'u' || c === 'U') {
    const n = run(/[0-9a-f]/iu, c === 'x' ? 2 : c === 'u' ? 4 : 8);
    if (!n) return ['\\' + c, 1];
    const code = Number.parseInt(command.slice(i + 1, i + 1 + n), 16);
    return [code <= 0x10ffff ? String.fromCodePoint(code) : '', n + 1];
  }
  if (/[0-7]/u.test(c)) {
    let n = 1; while (n < 3 && /[0-7]/u.test(command[i + n] ?? '')) n++;
    return [String.fromCharCode(Number.parseInt(command.slice(i, i + n), 8) & 0xff), n];
  }
  if (c === 'c' && command[i + 1] !== undefined) return [String.fromCharCode(command.charCodeAt(i + 1) & 0x1f), 2];
  return ['\\' + (c ?? ''), c === undefined ? 0 : 1];
}

/**
 * Split a command into simple commands, applying shell quote removal. Returns
 * [{ words, inputs, outputs, strings, piped, scope, cut, substCommand }]: `inputs` are
 * `<` redirection sources, `outputs` retains output targets, and `strings`
 * are `<<<` here-strings. `piped` marks a command whose standard
 * input is the previous command's output. Substitutions and subshells become
 * their own segments with their own `scope` (its parent is in `.parents`);
 * `cut` marks a segment interrupted by one, and `substCommand` a segment whose
 * command word was a substitution.
 */
export function shellSegments(command) {
  const out = [];
  out.parents = scanShellSegments(command, (segment) => out.push(segment));
  return out;
}

// Classification consumes each segment immediately instead of retaining the
// whole command's segment/word arrays. Keep the exported snapshot API above.
function scanShellSegments(command, visit) {
  const parents = new Map([[0, null]]);
  const stack = [];
  let ids = 0;
  let words = [];
  let inputs = [];
  let outputs = [];
  let strings = [];
  let word = '';
  let has = false;
  let quote = null;
  let redirect = null;
  let piped = false;
  let substCommand = false;
  const scope = () => stack.at(-1)?.id ?? 0;
  const endWord = () => {
    if (has) {
      if (redirect === '<') inputs.push(word);
      else if (redirect === '>') outputs.push(word);
      else if (redirect === '<<<') strings.push(word);
      else if (!redirect) words.push(word);
      redirect = null;
    }
    word = ''; has = false;
  };
  const endSegment = (cut = false) => {
    endWord();
    redirect = null;
    if (words.length || inputs.length || outputs.length || strings.length) visit({ words, inputs, outputs, strings, piped, scope: scope(), cut, substCommand }, parents);
    words = []; inputs = []; outputs = []; strings = [];
    piped = false; substCommand = false;
  };
  const open = (tick) => {
    const leading = !words.length && !has;
    const carry = piped && leading;
    endSegment(!leading);
    const id = ++ids;
    parents.set(id, scope());
    stack.push({ quote, tick, id, leading });
    quote = null;
    piped = carry;
  };
  const close = () => {
    endSegment();
    const frame = stack.pop();
    quote = frame ? frame.quote : null;
    substCommand = Boolean(frame?.leading);
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (quote === "$'") {
      if (c === "'") quote = null;
      else if (c === '\\') { const [text, used] = ansiEscape(command, i + 1); word += text; i += used; }
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && next !== undefined && '"\\$`\n'.includes(next)) { i++; if (next !== '\n') word += next; }
      else if (c === '$' && next === '(') { i++; open(false); }
      else if (c === '`') open(true);
      else word += c;
      continue;
    }
    if (c === '$' && next === "'") { i++; quote = "$'"; has = true; continue; }
    if (c === '$' && next === '"') { i++; quote = '"'; has = true; continue; }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\') { if (next !== undefined) { i++; if (next !== '\n') { word += next; has = true; } } continue; }
    if (c === '|') {
      if (next === '|') { i++; endSegment(); continue; }
      if (next === '&') i++;
      endSegment();
      piped = true;
      continue;
    }
    if (c === '&' && next === '>') {
      endWord();
      i++;
      while (command[i + 1] === '>' || command[i + 1] === '|') i++;
      redirect = '>';
      continue;
    }
    if (c === '\n' || c === ';' || c === '&') { endSegment(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
    if (c === '$' && next === '(') { i++; open(false); continue; }
    if (c === '(') { open(false); continue; }
    if (c === ')') { close(); continue; }
    if (c === '`') { if (stack.at(-1)?.tick) close(); else open(true); continue; }
    if (c === '<' || c === '>') {
      if (/^\d+$/u.test(word)) { word = ''; has = false; } else endWord();
      const start = i;
      while (command[i + 1] === '<' || command[i + 1] === '>' || command[i + 1] === '&' || command[i + 1] === '|') i++;
      const op = command.slice(start, i + 1);
      redirect = op === '<' || op === '<>' ? '<' : op === '<<<' ? '<<<' : '>';
      continue;
    }
    word += c; has = true;
  }
  endSegment();
  return parents;
}

/** The command a simple command runs, after keywords, VAR=value prefixes and wrappers. */
function commandWords(words) {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (KEYWORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) { i++; continue; }
    const options = WRAPPERS.get(base(word));
    if (!options) break;
    const name = base(word);
    i++;
    while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
      if (words[i] === '--') { i++; break; }
      i += options.has(words[i]) ? 2 : 1;
    }
    if (name === 'timeout' && i < words.length) i++; // the duration
  }
  return words.slice(i);
}

const FORCE = (option) => /^--(?:force(?:-with-lease)?(?:=.*)?|force-if-includes|mirror)$/u.test(option)
  || /^-[a-z]*f[a-z]*$/iu.test(option) || /^\+\S/u.test(option);

function forcePush(words) {
  for (let g = 0; g < words.length; g++) {
    if (base(words[g]) !== 'git') continue;
    const aliases = new Map();
    let forcedByConfig = false;
    let p = g + 1;
    while (p < words.length && words[p] !== 'push') {
      if (!words[p].startsWith('-')) break;
      const config = words[p] === '-c' ? words[p + 1] : words[p].startsWith('-c') ? words[p].slice(2) : null;
      if (typeof config === 'string') {
        const alias = /^alias\.([^=]+)=(.*)$/isu.exec(config);
        if (alias) aliases.set(alias[1].toLowerCase(), alias[2]);
        if (/^remote\.[^=]+\.push=\s*\+/iu.test(config) || /^remote\.[^=]+\.mirror=(?:true|yes|on|1)$/iu.test(config)) forcedByConfig = true;
      }
      p += GIT_VALUE_OPTIONS.has(words[p]) ? 2 : 1;
    }
    const sub = words[p];
    if (sub === undefined) continue;
    let rest = words.slice(p + 1);
    if (aliases.has(sub.toLowerCase())) {
      // An alias defined on the command line: expand it (a `!` alias is a shell
      // command, which is classified as one) and look for a push inside.
      const expansion = aliases.get(sub.toLowerCase()).replace(/^!\s*/u, '').split(/\s+/u).filter(Boolean);
      if (expansion[0] === 'git') expansion.shift();
      const at = expansion.indexOf('push');
      if (at === -1) continue;
      rest = [...expansion.slice(at + 1), ...rest];
    } else if (sub !== 'push') continue;
    if (forcedByConfig) return true;
    for (const option of rest) {
      if (option === '--') continue;
      if (FORCE(option)) return true;
    }
  }
  return false;
}

function decodePowerShell(value) {
  try { return Buffer.from(value, 'base64').toString('utf16le'); } catch { return ''; }
}

/** Command strings a shell word list runs: `sh -c`, `eval`, PowerShell -Command. */
function nested(words) {
  const found = [];
  for (let i = 0; i < words.length; i++) {
    const name = base(words[i]);
    if (name === 'eval') { found.push(words.slice(i + 1).join(' ')); break; }
    if (POWERSHELLS.has(name)) {
      for (let j = i + 1; j < words.length; j++) {
        if (/^[-/](?:c|co|com|comm|comma|comman|command)$/iu.test(words[j])) { found.push(words.slice(j + 1).join(' ')); break; }
        if (/^[-/](?:e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/iu.test(words[j]) && words[j + 1]) {
          found.push(decodePowerShell(words[j + 1])); break;
        }
      }
      continue;
    }
    if (!SHELLS.has(name)) continue;
    let sawC = false;
    let j = i + 1;
    for (; j < words.length; j++) {
      const word = words[j];
      if (word === '--') { if (sawC && words[j + 1] !== undefined) found.push(words[j + 1]); break; }
      if (word === '-' ) continue;
      if (/^--(?:rcfile|init-file)$/u.test(word)) { j++; continue; }
      if (word.startsWith('--')) continue;
      if (/^[-+][A-Za-z]+$/u.test(word)) {
        if (word[0] === '-' && word.includes('c')) { sawC = true; if (words[j + 1] !== undefined) found.push(words[j + 1]); }
        if (/[oO]$/u.test(word)) j++; // -o / +o / -O / +O take an option name
        continue;
      }
      if (sawC) found.push(word);
      break;
    }
    // su accepts options after its operands (`su - user -c '…'`): a later -c still counts.
    if (name === 'su') {
      for (j++; j < words.length; j++) if (/^-[A-Za-z]*c[A-Za-z]*$/u.test(words[j]) && words[j + 1] !== undefined) { found.push(words[j + 1]); break; }
    }
  }
  return [...new Set(found)];
}

/** A path with its existing part resolved through symbolic links. */
let realCache = new Map();
function real(target, followLast) {
  const key = (followLast ? '1' : '0') + target;
  if (!realCache.has(key)) {
    if (realCache.size > 10_000) realCache = new Map();
    realCache.set(key, resolveReal(target, followLast));
  }
  return realCache.get(key);
}
function resolveReal(target, followLast) {
  let existing = followLast ? target : path.dirname(target);
  const rest = followLast ? [] : [path.basename(target)];
  for (let guard = 0; guard < 4096; guard++) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return target;
}

function deleteOutside(words, dir, repoRoot, home, root) {
  for (let i = 0; i < words.length; i++) {
    const current = base(words[i]);
    if (current !== 'rm' && current !== 'remove-item') continue;
    const targets = words.slice(i + 1).filter((word) => word !== '--' && !word.startsWith('-'));
    if (!targets.length) return true;
    for (const target of targets) {
      const expanded = expand(target, home, repoRoot);
      // ~name, ~+ and ~- are other homes and directory-stack entries: outside.
      if (/\$|%[A-Za-z_]+%|^~/u.test(expanded)) return true;
      if (!path.isAbsolute(expanded) && dir === null) return true;
      const resolved = path.resolve(dir ?? repoRoot, expanded);
      if (!inside(real(resolved, /[/\\]$|[*?[]/u.test(target)), root)) return true;
    }
  }
  return false;
}

/** The working directory after a cd, pushd or popd: a path, or null when unknown. */
function changeDirectory(command, dir, home, stack, cut, repoRoot) {
  const name = base(command[0]);
  if (cut) return null;
  if (name === 'popd') return stack.length ? stack.pop() : null;
  const args = command.slice(1).filter((word) => !/^-[LPe@]+$/u.test(word) && word !== '--' && !/^-(?:path|literalpath)$/iu.test(word));
  const target = args[0];
  if (name === 'pushd') stack.push(dir);
  if (target === undefined) return name === 'pushd' ? null : home;
  if (target === '-' || /^[+-]\d+$/u.test(target)) return null;
  const expanded = expand(target, home, repoRoot);
  if (/\$|%[A-Za-z_]+%|^~|`/u.test(expanded)) return null;
  if (!path.isAbsolute(expanded) && dir === null) return null;
  return path.resolve(dir ?? home, expanded);
}

function readsSecretDirectory(command, dir) {
  const name = base(command[0] ?? '');
  const options = command.slice(1).filter((word) => word.startsWith('-'));
  const recursive = name === 'rg'
    ? options.some((word) => word === '--hidden' || /^-[A-Za-z]*\.[A-Za-z]*$/u.test(word) || /^-[A-Za-z]*u{2,}[A-Za-z]*$/u.test(word))
    : ['grep', 'egrep', 'fgrep', 'ggrep'].includes(name)
      && options.some((word) => /^-[A-Za-z]*[rR][A-Za-z]*$/u.test(word) || /^--(?:dereference-)?recursive$/u.test(word));
  if (!recursive || dir === null) return false;
  const operands = command.slice(1).filter((word) => !word.startsWith('-'));
  const directories = operands.map((word) => path.resolve(dir, word)).filter((candidate) => {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  });
  if (!directories.length) directories.push(dir);
  for (const directory of directories) {
    let handle;
    try {
      handle = fs.opendirSync(directory);
      for (let n = 0, entry; n < 5000 && (entry = handle.readSync()); n++) if (isSecretPath(entry.name)) return true;
    } catch { /* unreadable: nothing to report */ } finally { try { handle?.closeSync(); } catch { /* closed */ } }
  }
  return false;
}

function readsSecret({ words, inputs }, command, dir) {
  if (inputs.some(isSecretPath)) return true;
  if (words.some((word) => READERS.has(base(word))) && words.some(isSecretPath)) return true;
  const name = base(command[0] ?? '');
  if (!name) return false;
  if (CODE_RUNNERS.test(name)) {
    for (let i = 1; i < command.length - 1; i++) {
      if (/^(?:-[ceEpr]|--eval|--print|-[A-Za-z]*[ce])$/u.test(command[i])
        && command[i + 1].split(/[\s'"`()[\]{},;+=]+/u).some(isSecretPath)) return true;
    }
  }
  if (readsSecretDirectory(command, dir)) return true;
  if (NOT_READERS.has(name)) return false;
  if (name === 'git') {
    const sub = commandWords(command.slice(1)).find((word) => !word.startsWith('-'));
    if (GIT_NOT_READING.has(sub)) return false;
  }
  // Any other program handed a secret file is taken to read it. An option of
  // the form --name=file (node --env-file=.env) loads rather than prints.
  return command.slice(1).some((word) => !word.startsWith('-') && isSecretPath(word));
}

function canonical(filename) {
  let current = path.resolve(filename);
  const missing = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...missing); } catch { /* resolve existing ancestors */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(filename);
    missing.unshift(path.basename(current)); current = parent;
  }
}

/** Protect only policy/configuration paths; ordinary project edits stay ordinary. */
function policyPath(value, cwd, root, home) {
  if (typeof value !== 'string' || !value) return false;
  const target = path.resolve(cwd ?? root, expand(value, home, root));
  const candidates = [path.relative(path.resolve(root), target), path.relative(canonical(root), canonical(target))];
  return candidates.some(relative => {
    const rel = relative.split(path.sep).join('/');
    return ['agent-policy.yaml', 'agent-policy.json', '.claude', '.claude/settings.json',
    '.claude/settings.local.json', '.claude/agent-console-policy.json', '.claude/hooks',
    '.claude/hooks/agent-console-policy.mjs', '.claude/hooks/classify.mjs', '.claude/agents'].includes(rel)
    || /^\.claude\/agents\/agent-console-[a-z0-9_-]+\.md$/u.test(rel);
  });
}
const WRITERS = new Set(['rm', 'remove-item', 'mv', 'move-item', 'cp', 'copy-item', 'tee', 'sed', 'perl', 'truncate',
  'set-content', 'add-content', 'out-file', 'chmod', 'chown', 'ln', 'unlink', 'rmdir']);
const OPAQUE_INTERPRETER = /^(?:python(?:\d+(?:\.\d+)*)?|node|nodejs|ruby|perl|php|deno|bun|lua|luajit)$/u;
function opaqueExecution(words) {
  for (let i = 0; i < words.length; i++) {
    const name = base(words[i]);
    if (OPAQUE_INTERPRETER.test(name)) {
      const rest = words.slice(i + 1);
      if (rest.length === 1 && ['--version', '-V', '--help', '-h'].includes(rest[0])) continue;
      return true;
    }
    // A script or opaque command expansion is not something this classifier can prove safe.
    if (/^\.\.?[/\\]|\.(?:sh|bash|zsh|ps1|py|js|mjs|cjs|rb|pl)$/iu.test(words[i]) && i === 0) return true;
    if (/^\$|^%[A-Za-z_]+%/u.test(words[i]) && i === 0) return true;
    if ((SHELLS.has(name) || POWERSHELLS.has(name)) && !words.slice(i + 1).some(w => /^-[a-z]*c[a-z]*$|^-command$/iu.test(w))) return true;
  }
  return false;
}

function classifyCommand(command, cwd, repoRoot, home, found, depth, mayRemainOutside = false) {
  if (/\b(?:prisma\s+migrate\s+deploy|knex\s+migrate:latest|db:migrate|alembic\s+upgrade|flyway\s+migrate)\b/iu.test(command)
    && /\b(?:prod|production)\b/iu.test(command)) found.add('production_migration');
  // The repository's own top level, asked of git from inside it, is the
  // repository root: `cd "$(git rev-parse --show-toplevel)"` stays known.
  const root = real(path.resolve(repoRoot), true);
  const text = cwd !== null && inside(real(path.resolve(cwd), true), root)
    ? command.replace(/\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)|`\s*git\s+rev-parse\s+--show-toplevel\s*`/gu, '${CLAUDE_PROJECT_DIR}')
    : command;
  const dirs = new Map();
  const stacks = new Map();
  // A later cd can fail and leave an earlier outside directory in effect.
  // Retain that possibility per shell scope; child scopes must not taint parents.
  const outsideFallback = new Map();
  const isOutside = (dir) => dir === null || !inside(real(path.resolve(dir), true), root);
  const dirOf = (scope, parents) => {
    // A subshell starts in its parent's directory as it was when it opened.
    const chain = [];
    for (let at = scope; at !== null && at !== undefined && !dirs.has(at); at = parents.get(at)) chain.push(at);
    for (const at of chain.reverse()) {
      const parent = parents.get(at);
      dirs.set(at, parent === null || parent === undefined ? cwd : dirs.get(parent));
      stacks.set(at, [...(stacks.get(parent) || [])]);
      outsideFallback.set(at, parent === null || parent === undefined
        ? mayRemainOutside || isOutside(cwd) : outsideFallback.get(parent));
    }
    return dirs.get(scope);
  };
  scanShellSegments(text, (segment, parents) => {
    const { words, outputs, strings, piped, scope, cut, substCommand } = segment;
    const dir = dirOf(scope, parents);
    const run = commandWords(words);
    const name = base(run[0] ?? '');
    const innerCommands = nested(words);
    const shellStrings = SHELLS.has(name) || POWERSHELLS.has(name) ? strings : [];
    const writes = outputs.length > 0 || words.some(word => WRITERS.has(base(word)));
    if (opaqueExecution(run) || substCommand || dir === null && writes
      || depth >= 4 && (innerCommands.length || shellStrings.length)) found.add('uninspected_execution');
    if (outputs.some(word => policyPath(word, dir, repoRoot, home))
      || words.some(word => WRITERS.has(base(word))) && words.some(word => policyPath(word, dir, repoRoot, home))) found.add('policy_change');
    if (piped && INTERPRETER.test(name)) found.add('pipe_to_interpreter');
    if (forcePush(words) || substCommand && forcePush(['git', ...words])) found.add('force_push');
    if (readsSecret(segment, run, dir)) found.add('credential_read');
    // An absolute in-repository target is safe from every possible cwd, but
    // a relative deletion must remain guarded once this scope may be outside.
    if (words.some((word) => /^(?:rm|remove-item)$/u.test(base(word)))
      && (deleteOutside(words, dir, repoRoot, home, root)
        || outsideFallback.get(scope) && deleteOutside(words, null, repoRoot, home, root))) found.add('delete_outside_repo');
    if (depth < 4) {
      for (const inner of innerCommands) classifyCommand(inner, dir, repoRoot, home, found, depth + 1, outsideFallback.get(scope));
      for (const text of shellStrings) classifyCommand(text, dir, repoRoot, home, found, depth + 1, outsideFallback.get(scope));
    }
    if (['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location'].includes(name)) {
      const kind = name === 'push-location' ? 'pushd' : name === 'pop-location' ? 'popd' : name;
      const next = changeDirectory([kind, ...run.slice(1)], dir, home, stacks.get(scope), cut, repoRoot);
      outsideFallback.set(scope, outsideFallback.get(scope) || isOutside(dir) || isOutside(next));
      dirs.set(scope, next);
    }
  });
}

export function classifyTool(input, repoRoot, home = os.homedir()) {
  const tool = String(input?.tool_name || '');
  const args = input?.tool_input || {};
  const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '';
  const cwd = typeof input?.cwd === 'string' ? input.cwd : repoRoot;
  const found = new Set();
  realCache = new Map();
  if (['Read', 'Grep', 'Glob'].includes(tool)
    && [args.file_path, args.path, args.pattern, args.glob].some(isSecretPath)) found.add('credential_read');
  if (['Write', 'Edit', 'NotebookEdit'].includes(tool) && policyPath(args.file_path || args.notebook_path, cwd, repoRoot, home)) found.add('policy_change');
  if (tool !== 'Bash' && tool !== 'PowerShell') return [...found];
  classifyCommand(command, cwd, repoRoot, home, found, 0);
  return [...found];
}
