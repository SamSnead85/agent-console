/** Repo-scoped Claude Code policy compiler with reversible, private backups. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parsePolicy } from '../analysis/index.js';

const source = path.dirname(fileURLToPath(import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const SYMLINK = 'Refusing a symlinked .claude path';
const lstat = (filename) => { try { return fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const real = (filename) => { try { return fs.realpathSync(filename); } catch { return null; } };

/**
 * Resolve a generated path under <root>/.claude without following links.
 * Every directory from the project root down, and the file itself, must be a
 * real directory or regular file, and the directory must resolve inside the
 * project. The user-level Claude directory is never a target.
 */
function locate(root, filename, create = false) {
  const realRoot = fs.realpathSync(root);
  const userDirs = [path.join(os.homedir(), '.claude'), process.env.CLAUDE_CONFIG_DIR].filter(Boolean)
    .map((dir) => path.resolve(dir)).flatMap((dir) => [real(dir), real(path.dirname(dir)) && path.join(real(path.dirname(dir)), path.basename(dir))]);
  if (userDirs.includes(path.join(realRoot, '.claude'))) throw new Error('Refusing to write user-level Claude settings');
  const parts = path.relative(root, filename).split(path.sep);
  if (parts.length < 2 || parts[0] !== '.claude' || parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('Refusing a path outside the project .claude directory');
  let dir = root;
  let realDir = realRoot;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    realDir = path.join(realDir, part);
    let stat = lstat(dir);
    if (!stat && create) {
      fs.mkdirSync(dir, { mode: 0o755 });
      stat = fs.lstatSync(dir);
    }
    if (!stat) return { dir, realDir, stat: null };
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(SYMLINK);
  }
  if (real(dir) !== realDir) throw new Error(SYMLINK);
  const stat = lstat(filename);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error(SYMLINK);
  return { dir, realDir, stat };
}

function read(root, filename) {
  if (!locate(root, filename).stat) return null;
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | NOFOLLOW);
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}

/** Write a temporary file in the verified directory, then rename it over the target. */
function write(root, filename, content, mode = 0o644) {
  const { dir, realDir } = locate(root, filename, true);
  const temporary = path.join(dir, '.' + path.basename(filename) + '.agent-console-' + randomBytes(5).toString('hex'));
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, mode);
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, mode);
  } finally { fs.closeSync(fd); }
  const target = lstat(filename);
  if (real(dir) !== realDir || target && (target.isSymbolicLink() || !target.isFile())) {
    fs.unlinkSync(temporary);
    throw new Error(SYMLINK);
  }
  fs.renameSync(temporary, filename);
}

function unlink(root, filename) {
  if (locate(root, filename).stat) fs.unlinkSync(filename);
}

function writePrivate(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.agent-console-' + randomBytes(5).toString('hex');
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filename);
}
const statePath = (root, stateDir) => path.join(stateDir || path.join(os.homedir(), '.agent-console', 'policy'), hash(root), 'install', 'manifest.json');
const agentName = (role) => `agent-console-${role.replaceAll('_', '-')}`;
const agentFile = (name, model, effort, description, body) =>
  `---\nname: ${name}\ndescription: ${description}\nmodel: ${model}\neffort: ${effort}\n---\n\n${body}\n`;

function inputPolicy(root, orgFile) {
  const yaml = path.join(root, 'agent-policy.yaml');
  const jsonFile = path.join(root, 'agent-policy.json');
  if (fs.existsSync(yaml) && fs.existsSync(jsonFile)) throw new Error('Keep one repo policy: YAML or JSON');
  const policyFile = fs.existsSync(yaml) ? yaml : jsonFile;
  if (!fs.existsSync(policyFile)) throw new Error('Add agent-policy.yaml or agent-policy.json in the project root');
  return parsePolicy(fs.readFileSync(policyFile, 'utf8'), orgFile ? fs.readFileSync(orgFile, 'utf8') : null);
}

function targets(root, policy) {
  const files = new Map();
  const hook = { type: 'command', command: 'node',
    args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-console-policy.mjs'], timeout: 30 };
  const settingsFile = path.join(root, '.claude', 'settings.json');
  const old = read(root, settingsFile);
  const settings = old ? JSON.parse(old.toString('utf8')) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || settings.hooks && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error('Invalid Claude settings');
  settings.hooks ||= {};
  for (const [event, matcher] of [['PreToolUse', 'Agent|Bash|PowerShell|Read|Grep|Glob|Edit|Write|NotebookEdit'], ['PreModelSwitch', '*']]) {
    if (settings.hooks[event] && !Array.isArray(settings.hooks[event])) throw new Error(`Invalid ${event} hook list`);
    settings.hooks[event] = (settings.hooks[event] || []).map((group) => {
      if (!Array.isArray(group.hooks)) return group;
      return { ...group, hooks: group.hooks.filter((item) => item?.args?.[0] !== hook.args[0]) };
    }).filter((group) => !Array.isArray(group.hooks) || group.hooks.length);
    settings.hooks[event].push({ matcher, hooks: [hook] });
  }
  files.set(settingsFile, json(settings));
  files.set(path.join(root, '.claude', 'agent-console-policy.json'), json(policy));
  files.set(path.join(root, '.claude', 'hooks', 'agent-console-policy.mjs'), fs.readFileSync(path.join(source, 'hook.mjs')));
  files.set(path.join(root, '.claude', 'hooks', 'classify.mjs'), fs.readFileSync(path.join(source, 'classify.mjs')));
  for (const [role, route] of Object.entries(policy.routing.roles)) {
    const name = agentName(role);
    const effort = policy.effort.default_by_task[role] || 'medium';
    files.set(path.join(root, '.claude', 'agents', `${name}.md`), agentFile(name, route.model, effort,
      `Handles ${role.replaceAll('_', ' ')} tasks under the project policy`, `Handle ${role.replaceAll('_', ' ')} tasks. Follow the project's policy and report evidence.`));
    if (route.with_verifying_test) {
      const verifiedName = `${name}-verified`;
      files.set(path.join(root, '.claude', 'agents', `${verifiedName}.md`), agentFile(verifiedName,
        route.with_verifying_test, effort, `Handles ${role.replaceAll('_', ' ')} tasks with a verifying test`,
        'Use only when a verifying test covers the requested change. Run it and report the result.'));
    }
  }
  files.set(path.join(root, '.claude', 'agents', 'agent-console-escalation.md'), agentFile('agent-console-escalation',
    policy.escalation.model, 'high', 'Escalates a task after repeated verified failures',
    `Use after ${policy.escalation.after_failures} failed attempts. State what failed and verify the new result.`));
  return files;
}

export function policyDiff(root, orgFile = null) {
  root = path.resolve(root);
  const policy = inputPolicy(root, orgFile);
  const files = targets(root, policy);
  return { policy, files, changes: [...files].map(([filename, next]) => {
    const previous = read(root, filename);
    const action = previous === null ? 'create' : Buffer.compare(previous, Buffer.from(next)) === 0 ? 'unchanged' : 'update';
    return { path: filename, action };
  }) };
}

export function policyApply(root, { orgFile = null, stateDir = null } = {}) {
  root = path.resolve(root);
  const manifestFile = statePath(root, stateDir);
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.files.every((entry) => { const bytes = read(root, entry.path); return bytes && hash(bytes) === entry.applied; })
      && policyDiff(root, orgFile).changes.every((change) => change.action === 'unchanged'))
      return { alreadyApplied: true, changes: [] };
    throw new Error('Installed policy or source changed; inspect diff, then remove and apply');
  }
  const { policy, files, changes } = policyDiff(root, orgFile);
  const generated = changes.filter((item) => item.path !== path.join(root, '.claude', 'settings.json'));
  if (generated.some((item) => item.action !== 'create')) throw new Error('Generated policy path already exists; refusing to overwrite it');
  const dir = path.dirname(manifestFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entries = [];
  try {
    for (const [index, [filename, content]] of [...files].entries()) {
      const before = read(root, filename);
      const backup = before === null ? null : `backup-${index}`;
      const mode = before === null ? 0o644 : fs.lstatSync(filename).mode & 0o777;
      if (backup) fs.writeFileSync(path.join(dir, backup), before, { mode: 0o600, flag: 'wx' });
      entries.push({ path: filename, backup, mode, applied: hash(content) });
      write(root, filename, content, mode);
    }
    writePrivate(manifestFile, json({ version: 1, root, files: entries, policyDigest: hash(json(policy)), orgPolicy: orgFile ? path.resolve(orgFile) : null }));
  } catch (error) {
    for (const entry of entries.reverse()) {
      try {
        if (entry.backup) write(root, entry.path, fs.readFileSync(path.join(dir, entry.backup)), entry.mode);
        else unlink(root, entry.path);
      } catch { /* Keep rolling back; the original error is the one to report. */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { alreadyApplied: false, changes, backup: dir };
}

export function policyRemove(root, { stateDir = null } = {}) {
  root = path.resolve(root);
  const manifestFile = statePath(root, stateDir);
  if (!fs.existsSync(manifestFile)) return { removed: false, changes: [] };
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.version !== 1 || manifest.root !== root || !Array.isArray(manifest.files)) throw new Error('Invalid policy install manifest');
  for (const entry of manifest.files) {
    if (!entry.path.startsWith(path.join(root, '.claude') + path.sep)
      || entry.backup && !/^backup-\d+$/u.test(entry.backup)
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)
      throw new Error(`Policy file changed since apply: ${entry.path}`);
    const bytes = read(root, entry.path);
    if (!bytes || hash(bytes) !== entry.applied) throw new Error(`Policy file changed since apply: ${entry.path}`);
  }
  for (const entry of manifest.files) {
    if (entry.backup) write(root, entry.path, fs.readFileSync(path.join(path.dirname(manifestFile), entry.backup)), entry.mode);
    else unlink(root, entry.path);
  }
  fs.rmSync(path.dirname(manifestFile), { recursive: true });
  return { removed: true, changes: manifest.files.map((entry) => entry.path) };
}

/** Read-only installed-state verification. It does not pretend to attest the running host. */
export function policyStatus(root, { stateDir = null, orgFile = null } = {}) {
  root = path.resolve(root);
  const result = { state: 'not-installed', policyDigest: null, runtimeVerified: false, issues: [],
    coverage: { tools: 'not-installed', modelSwitch: 'not-installed', hardBudgets: 'not-enforced', gateway: 'not-configured' } };
  const filename = statePath(root, stateDir);
  if (!fs.existsSync(filename)) return result;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('manifest');
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (manifest.version !== 1 || manifest.root !== root || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 128) throw new Error('manifest');
    const expected = ['.claude/settings.json', '.claude/agent-console-policy.json', '.claude/hooks/agent-console-policy.mjs', '.claude/hooks/classify.mjs'];
    for (const name of expected) if (!manifest.files.some(e => e.path === path.join(root, name))) throw new Error('manifest');
    for (const entry of manifest.files) {
      if (typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.applied)) throw new Error('manifest');
      const rel = path.relative(root, entry.path);
      if (!rel.startsWith('.claude' + path.sep) || rel.split(path.sep).includes('..')) throw new Error('manifest');
      try {
        const bytes = read(root, entry.path);
        if (!bytes || hash(bytes) !== entry.applied) result.issues.push({ file: rel, reason: bytes ? 'changed' : 'missing' });
      } catch { result.issues.push({ file: rel, reason: 'unsafe-path' }); }
    }
    const compiled = read(root, path.join(root, '.claude', 'agent-console-policy.json'));
    if (compiled) result.policyDigest = hash(compiled);
    try {
      const wanted = inputPolicy(root, orgFile || manifest.orgPolicy || null);
      if (!compiled || hash(json(wanted)) !== hash(compiled)) result.issues.push({ file: 'source-policy', reason: 'changed' });
    } catch { result.issues.push({ file: 'source-policy', reason: 'unreadable-or-invalid' }); }
    result.state = result.issues.length ? 'drifted' : 'installed';
    result.coverage.tools = result.coverage.modelSwitch = result.state === 'installed' ? 'configured-unverified' : 'drifted';
  } catch {
    result.state = 'invalid'; result.issues.push({ file: 'install-manifest', reason: 'invalid' });
    result.coverage.tools = result.coverage.modelSwitch = 'unknown';
  }
  return result;
}

export function mainPolicy(args) {
  const command = args[0];
  if (!['diff', 'apply', 'remove', 'status'].includes(command)) throw new Error('Usage: agent-console policy diff|apply|remove|status [--project path] [--org-policy file] [--json]');
  const option = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const root = path.resolve(option('--project') || process.cwd());
  const orgFile = option('--org-policy');
  if (args.some((arg, index) => arg.startsWith('--') && !['--project', '--org-policy', '--json'].includes(arg)
    || ['--project', '--org-policy'].includes(arg) && (!args[index + 1] || args[index + 1].startsWith('--'))))
    throw new Error('Unknown or incomplete policy option');
  if (args.includes('--json') && command !== 'status') throw new Error('--json is supported by policy status only');
  if (command === 'status') {
    const status = policyStatus(root, { orgFile });
    if (args.includes('--json')) process.stdout.write(json(status));
    else {
      process.stdout.write(`Policy: ${status.state}\nRuntime enforcement: unverified\n`);
      for (const issue of status.issues) process.stdout.write(`${issue.reason}: ${issue.file}\n`);
      process.stdout.write('Hard budgets: not enforced. Gateway: not configured.\n');
    }
    if (status.state !== 'installed') process.exitCode = 1;
    return;
  }
  if (command === 'diff') {
    const result = policyDiff(root, orgFile);
    for (const change of result.changes) process.stdout.write(`${change.action}: ${change.path}\n`);
  } else if (command === 'apply') {
    const result = policyApply(root, { orgFile });
    for (const change of result.changes) process.stdout.write(`${change.action}: ${change.path}\n`);
    process.stdout.write(result.alreadyApplied ? 'Policy already applied.\n' : `Private backups: ${result.backup}\n`);
  } else {
    const result = policyRemove(root);
    for (const filename of result.changes) process.stdout.write(`restored: ${filename}\n`);
    if (!result.removed) process.stdout.write('No applied policy found.\n');
  }
  process.stdout.write('Not enforceable yet: hard token/dollar budgets, verifying-test proof, failed-attempt count.\n');
}
