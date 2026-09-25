/** Turn local tool input into rule names. Never persist or transmit raw input. */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const inside = (target, root) => target === root || target.startsWith(root + path.sep);
const expand = (target, home) => target.replace(/^~(?=$|[/\\])/u, home)
  .replace(/^\$\{?HOME\}?|^%USERPROFILE%/iu, home);
const base = (word) => word.replace(/^.*[/\\]/u, '').toLowerCase().replace(/\.exe$/u, '');

const READERS = new Set(['cat', 'sed', 'awk', 'gawk', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'tac', 'strings',
  'base64', 'xxd', 'od', 'hexdump', 'dd', 'type', 'get-content', 'gc', 'cp', 'scp', 'rsync', 'rg', 'grep', 'egrep',
  'fgrep', 'source', '.', 'curl', 'jq']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'su', 'pwsh', 'powershell']);
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path']);
const EXAMPLE = /\.(?:example|sample|template|dist)$/u;
const SECRET_NAMES = ['.env', '.env.local', '.env.production', '.envrc', 'id_rsa', 'id_ed25519', 'server.pem',
  'client.p12', 'credentials', 'credentials.json', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.pgpass'];

/** True when a single shell word or tool path names a secret file. */
export function isSecretPath(value) {
  if (typeof value !== 'string' || !value) return false;
  const word = value.replace(/^--?[\w-]+=/u, '').replace(/^@/u, '').replace(/[\\/]+$/u, '');
  if (/[/\\]\.aws[/\\]credentials$|[/\\]\.docker[/\\]config\.json$|keychain|credential_store/iu.test(word)) return true;
  const name = word.replace(/^.*[/\\]/u, '').toLowerCase();
  if (/[*?[]/u.test(name)) {
    // A glob names a secret when it could expand to one. Require two literal
    // characters so `cat *` is not treated as a credential read.
    if (name.replace(/[*?[\]]/gu, '').length < 2) return false;
    const pattern = new RegExp('^' + name.replace(/[.+^${}()|\\]/gu, '\\$&').replace(/\*/gu, '.*').replace(/\?/gu, '.') + '$', 'u');
    return SECRET_NAMES.some((candidate) => pattern.test(candidate));
  }
  if (EXAMPLE.test(name)) return false;
  return /^\.env(?:rc)?(?:\..+)?$|\.env$/u.test(name)
    || /\.(?:pem|key|p12|pfx)$/u.test(name) && name !== '.key'
    || /^id_[a-z0-9_-]+$/u.test(name)
    || /^\.?credentials(?:\.[a-z]+)?$|^\.git-credentials$|^_?\.?netrc$|^\.npmrc$|^\.pypirc$|^\.pgpass$/u.test(name);
}

/**
 * Split a command into simple commands, applying shell quote removal. Returns
 * [{ words, inputs, outputs }]: redirection sources and targets are retained. Substitutions become their own segments.
 */
export function shellSegments(command) {
  const out = [];
  const stack = [];
  let words = [];
  let inputs = [];
  let outputs = [];
  let word = '';
  let has = false;
  let quote = null;
  let redirect = null;
  const endWord = () => {
    if (has) {
      if (redirect === '<') inputs.push(word);
      else if (redirect === '>') outputs.push(word);
      else if (!redirect) words.push(word);
      redirect = null;
    }
    word = ''; has = false;
  };
  const endSegment = () => {
    endWord();
    redirect = null;
    if (words.length || inputs.length || outputs.length) out.push({ words, inputs, outputs });
    words = []; inputs = []; outputs = [];
  };
  const open = (tick) => { stack.push({ quote, tick }); quote = null; endSegment(); };
  const close = () => { const frame = stack.pop(); endSegment(); quote = frame ? frame.quote : null; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && next !== undefined && '"\\$`\n'.includes(next)) { i++; if (next !== '\n') word += next; }
      else if (c === '$' && next === '(') { i++; open(false); }
      else if (c === '`') open(true);
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\') { if (next !== undefined) { i++; if (next !== '\n') { word += next; has = true; } } continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&') { endSegment(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
    if (c === '$' && next === '(') { i++; open(false); continue; }
    if (c === '(') { open(false); continue; }
    if (c === ')') { close(); continue; }
    if (c === '`') { if (stack.at(-1)?.tick) close(); else open(true); continue; }
    if (c === '<' || c === '>') {
      if (/^\d+$/u.test(word)) { word = ''; has = false; } else endWord();
      while (command[i + 1] === '<' || command[i + 1] === '>' || command[i + 1] === '&' || command[i + 1] === '|') i++;
      redirect = c;
      continue;
    }
    word += c; has = true;
  }
  endSegment();
  return out;
}

function forcePush(words) {
  for (let g = 0; g < words.length; g++) {
    if (base(words[g]) !== 'git') continue;
    let p = g + 1;
    while (p < words.length && words[p] !== 'push') {
      if (!words[p].startsWith('-')) break;
      p += GIT_VALUE_OPTIONS.has(words[p]) ? 2 : 1;
    }
    if (words[p] !== 'push') continue;
    for (const option of words.slice(p + 1)) {
      if (option === '--') continue;
      if (/^--(?:force(?:-with-lease)?(?:=.*)?|mirror)$/u.test(option) || /^-[a-z]*f[a-z]*$/iu.test(option)
        || /^\+\S/u.test(option)) return true;
    }
  }
  return false;
}

function nested(words) {
  const found = [];
  for (let i = 0; i < words.length; i++) {
    const name = base(words[i]);
    if (name === 'eval') { found.push(words.slice(i + 1).join(' ')); break; }
    if (!SHELLS.has(name)) continue;
    for (let j = i + 1; j < words.length; j++) {
      if (/^-[a-z]*c[a-z]*$/iu.test(words[j]) || /^-command$/iu.test(words[j])) {
        if (words[j + 1] !== undefined) found.push(words[j + 1]);
        break;
      }
      if (!words[j].startsWith('-')) break;
    }
  }
  return found;
}

function deleteOutside(words, cwd, repoRoot, home) {
  for (let i = 0; i < words.length; i++) {
    const current = base(words[i]);
    if (current !== 'rm' && current !== 'remove-item') continue;
    const targets = words.slice(i + 1).filter((word) => word !== '--' && !word.startsWith('-'));
    if (!targets.length) return true;
    for (const target of targets) {
      const expanded = expand(target, home);
      if (/\$|%[A-Za-z_]+%/u.test(expanded) || !inside(path.resolve(cwd || repoRoot, expanded), path.resolve(repoRoot))) return true;
    }
  }
  return false;
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
  const target = path.resolve(cwd, expand(value, home));
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
const INTERPRETER = /^(?:python(?:\d+(?:\.\d+)*)?|node|nodejs|ruby|perl|php|deno|bun|lua|luajit)$/u;
function opaqueExecution(words) {
  for (let i = 0; i < words.length; i++) {
    const name = base(words[i]);
    if (INTERPRETER.test(name)) {
      const rest = words.slice(i + 1);
      if (rest.length === 1 && ['--version', '-V', '--help', '-h'].includes(rest[0])) continue;
      return true;
    }
    // A script or opaque command expansion is not something this classifier can prove safe.
    if (/^\.\.?[/\\]|\.(?:sh|bash|zsh|ps1|py|js|mjs|cjs|rb|pl)$/iu.test(words[i]) && i === 0) return true;
    if (/^\$|^%[A-Za-z_]+%/u.test(words[i]) && i === 0) return true;
    if (SHELLS.has(name) && !words.slice(i + 1).some(w => /^-[a-z]*c[a-z]*$|^-command$/iu.test(w))) return true;
  }
  return false;
}

function classifyCommand(command, cwd, repoRoot, home, found, depth) {
  if (/\|\s*(?:sudo\s+)?(?:\S*[/\\])?(?:sh|bash|zsh|node|python\d*|ruby|perl)\b/iu.test(command)) found.add('pipe_to_interpreter');
  if (/\b(?:prisma\s+migrate\s+deploy|knex\s+migrate:latest|db:migrate|alembic\s+upgrade|flyway\s+migrate)\b/iu.test(command)
    && /\b(?:prod|production)\b/iu.test(command)) found.add('production_migration');
  for (const { words, inputs, outputs } of shellSegments(command)) {
    if (opaqueExecution(words) || depth >= 4 && nested(words).length) found.add('uninspected_execution');
    if (outputs.some(word => policyPath(word, cwd, repoRoot, home))
      || words.some(word => WRITERS.has(base(word))) && words.some(word => policyPath(word, cwd, repoRoot, home))) found.add('policy_change');
    if (forcePush(words)) found.add('force_push');
    if (inputs.some(isSecretPath) || words.some((word) => READERS.has(base(word))) && words.some(isSecretPath)) found.add('credential_read');
    if (deleteOutside(words, cwd, repoRoot, home)) found.add('delete_outside_repo');
    if (depth < 4) for (const inner of nested(words)) classifyCommand(inner, cwd, repoRoot, home, found, depth + 1);
  }
}

export function classifyTool(input, repoRoot, home = os.homedir()) {
  const tool = String(input?.tool_name || '');
  const args = input?.tool_input || {};
  const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '';
  const cwd = typeof input?.cwd === 'string' ? input.cwd : repoRoot;
  const found = new Set();
  if (['Read', 'Grep', 'Glob'].includes(tool)
    && [args.file_path, args.path, args.pattern, args.glob].some(isSecretPath)) found.add('credential_read');
  if (['Write', 'Edit', 'NotebookEdit'].includes(tool) && policyPath(args.file_path || args.notebook_path, cwd, repoRoot, home)) found.add('policy_change');
  if (tool !== 'Bash' && tool !== 'PowerShell') return [...found];
  classifyCommand(command, cwd, repoRoot, home, found, 0);
  return [...found];
}
