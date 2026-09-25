/** Repo-scoped Claude Code policy compiler with reversible, private backups. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parsePolicy } from '../analysis/index.js';

const source = path.dirname(fileURLToPath(import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const read = (filename) => fs.existsSync(filename) ? fs.readFileSync(filename) : null;
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const write = (filename, content, mode = 0o644) => {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + '.agent-console-' + randomBytes(5).toString('hex');
  fs.writeFileSync(temporary, content, { mode });
  fs.renameSync(temporary, filename);
};
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
  const old = read(settingsFile);
  const settings = old ? JSON.parse(old.toString('utf8')) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || settings.hooks && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error('Invalid Claude settings');
  settings.hooks ||= {};
  for (const [event, matcher] of [['PreToolUse', 'Agent|Bash|PowerShell|Read|Grep|Glob|Edit|Write'], ['PreModelSwitch', '*']]) {
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
    const previous = read(filename);
    const action = previous === null ? 'create' : Buffer.compare(previous, Buffer.from(next)) === 0 ? 'unchanged' : 'update';
    return { path: filename, action };
  }) };
}

export function policyApply(root, { orgFile = null, stateDir = null } = {}) {
  root = path.resolve(root);
  const manifestFile = statePath(root, stateDir);
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.files.every((entry) => read(entry.path) && hash(read(entry.path)) === entry.applied)
      && policyDiff(root, orgFile).changes.every((change) => change.action === 'unchanged'))
      return { alreadyApplied: true, changes: [] };
    throw new Error('Installed policy or source changed; inspect diff, then remove and apply');
  }
  const { files, changes } = policyDiff(root, orgFile);
  const generated = changes.filter((item) => item.path !== path.join(root, '.claude', 'settings.json'));
  if (generated.some((item) => item.action !== 'create')) throw new Error('Generated policy path already exists; refusing to overwrite it');
  const dir = path.dirname(manifestFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entries = [];
  try {
    for (const [index, [filename, content]] of [...files].entries()) {
      const before = read(filename);
      const backup = before === null ? null : `backup-${index}`;
      const mode = before === null ? 0o644 : fs.statSync(filename).mode & 0o777;
      if (backup) fs.writeFileSync(path.join(dir, backup), before, { mode: 0o600, flag: 'wx' });
      entries.push({ path: filename, backup, mode, applied: hash(content) });
      write(filename, content, mode);
    }
    write(manifestFile, json({ version: 1, root, files: entries }), 0o600);
  } catch (error) {
    for (const entry of entries.reverse()) {
      if (entry.backup) write(entry.path, fs.readFileSync(path.join(dir, entry.backup)), entry.mode);
      else fs.rmSync(entry.path, { force: true });
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
      || !read(entry.path) || hash(read(entry.path)) !== entry.applied)
      throw new Error(`Policy file changed since apply: ${entry.path}`);
  }
  for (const entry of manifest.files) {
    if (entry.backup) write(entry.path, fs.readFileSync(path.join(path.dirname(manifestFile), entry.backup)), entry.mode);
    else fs.rmSync(entry.path);
  }
  fs.rmSync(path.dirname(manifestFile), { recursive: true });
  return { removed: true, changes: manifest.files.map((entry) => entry.path) };
}

export function mainPolicy(args) {
  const command = args[0];
  if (!['diff', 'apply', 'remove'].includes(command)) throw new Error('Usage: agent-console policy diff|apply|remove [--project path] [--org-policy file]');
  const option = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const root = path.resolve(option('--project') || process.cwd());
  const orgFile = option('--org-policy');
  if (args.some((arg, index) => arg.startsWith('--') && !['--project', '--org-policy'].includes(arg)
    || ['--project', '--org-policy'].includes(arg) && (!args[index + 1] || args[index + 1].startsWith('--'))))
    throw new Error('Unknown or incomplete policy option');
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
