/** Local opt-in guard setup. Existing settings and hooks are preserved. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseGuardPolicy } from '../analysis/index.js';
import { defaultGuardPolicy } from './default-policy.js';

const libRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const writeJson = (filename, value) => {
  const tmp = filename + '.tmp-' + randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filename);
};

export function guardPaths(home) {
  const guardDir = path.join(home, '.agent-console', 'guard');
  return { guardDir, policyFile: path.join(guardDir, 'policy.json'), saltFile: path.join(guardDir, 'salt'),
    settingsFile: path.join(home, '.claude', 'settings.json'),
    codexFile: path.join(home, '.codex', 'hooks.json'),
    runtime: path.join(guardDir, 'runtime'),
    hook: path.join(guardDir, 'runtime', 'lib', 'guard', 'hook.js') };
}

export function initGuard(home) {
  const p = guardPaths(home);
  fs.mkdirSync(p.guardDir, { recursive: true, mode: 0o700 });
  const created = [];
  if (!fs.existsSync(p.policyFile)) { writeJson(p.policyFile, defaultGuardPolicy()); created.push('policy'); }
  if (!fs.existsSync(p.saltFile)) { fs.writeFileSync(p.saltFile, randomBytes(32), { mode: 0o600 }); created.push('salt'); }
  parseGuardPolicy(fs.readFileSync(p.policyFile, 'utf8'));
  return { ...p, created };
}

function owned(group, hook) {
  return Array.isArray(group?.hooks) && group.hooks.some((item) => item?.args?.[0] === hook);
}

function copyRuntime(p) {
  fs.mkdirSync(path.join(p.runtime, 'lib', 'guard'), { recursive: true, mode: 0o700 });
  fs.cpSync(path.join(libRoot, 'analysis'), path.join(p.runtime, 'lib', 'analysis'), { recursive: true });
  for (const name of ['hook.js', 'classify.js']) {
    fs.copyFileSync(path.join(libRoot, 'guard', name), path.join(p.runtime, 'lib', 'guard', name));
  }
  writeJson(path.join(p.runtime, 'package.json'), { type: 'module' });
}

function backup(filename, existing) {
  if (!existing) return null;
  const saved = filename + '.agent-console-backup-' + Date.now() + '-' + randomBytes(3).toString('hex');
  fs.copyFileSync(filename, saved);
  return saved;
}

export function installGuard(home) {
  const p = initGuard(home);
  fs.mkdirSync(path.dirname(p.settingsFile), { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(p.settingsFile);
  const settings = existing ? JSON.parse(fs.readFileSync(p.settingsFile, 'utf8')) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid Claude settings');
  if (settings.hooks && typeof settings.hooks !== 'object') throw new Error('Invalid Claude hooks');
  settings.hooks ||= {};
  for (const event of ['PreToolUse', 'PreModelSwitch']) {
    if (settings.hooks[event] && !Array.isArray(settings.hooks[event])) throw new Error('Invalid Claude hook list');
  }
  if (['PreToolUse', 'PreModelSwitch'].some((event) => (settings.hooks[event] || []).some((group) => owned(group, p.hook)))) {
    return { ...p, installed: false, backup: null };
  }
  copyRuntime(p);
  const handler = { type: 'command', command: process.execPath, args: [p.hook, p.guardDir], timeout: 30 };
  for (const event of ['PreToolUse', 'PreModelSwitch']) {
    settings.hooks[event] ||= [];
    settings.hooks[event].push({ matcher: '*', hooks: [handler] });
  }
  const saved = backup(p.settingsFile, existing);
  writeJson(p.settingsFile, settings);
  return { ...p, installed: true, backup: saved };
}

export function uninstallGuard(home) {
  const p = guardPaths(home);
  if (!fs.existsSync(p.settingsFile)) return { ...p, removed: 0, backup: null };
  const settings = JSON.parse(fs.readFileSync(p.settingsFile, 'utf8'));
  let removed = 0;
  for (const event of ['PreToolUse', 'PreModelSwitch']) {
    const groups = settings.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.map((group) => {
      if (!Array.isArray(group.hooks)) return group;
      const kept = group.hooks.filter((item) => item?.args?.[0] !== p.hook);
      removed += group.hooks.length - kept.length;
      return { ...group, hooks: kept };
    }).filter((group) => !Array.isArray(group.hooks) || group.hooks.length);
  }
  if (!removed) return { ...p, removed: 0, backup: null };
  const saved = backup(p.settingsFile, true);
  writeJson(p.settingsFile, settings);
  return { ...p, removed, backup: saved };
}

function codexCommand(p) { return `${quote(process.execPath)} ${quote(p.hook)} ${quote(p.guardDir)} codex`; }
function codexOwned(item, p) { return item?.type === 'command' && item.command === codexCommand(p); }

export function installCodexGuard(home) {
  const p = initGuard(home);
  fs.mkdirSync(path.dirname(p.codexFile), { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(p.codexFile);
  const settings = existing ? JSON.parse(fs.readFileSync(p.codexFile, 'utf8')) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || (settings.hooks && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)))) {
    throw new Error('Invalid Codex hooks');
  }
  settings.hooks ||= {};
  if (settings.hooks.PreToolUse && !Array.isArray(settings.hooks.PreToolUse)) throw new Error('Invalid Codex PreToolUse');
  if ((settings.hooks.PreToolUse || []).some((group) => group.hooks?.some((item) => codexOwned(item, p)))) {
    return { ...p, installed: false, backup: null };
  }
  copyRuntime(p);
  settings.hooks.PreToolUse ||= [];
  settings.hooks.PreToolUse.push({ matcher: 'Bash|Read', hooks: [
    { type: 'command', command: codexCommand(p), timeout: 30, statusMessage: 'Checking local guard policy' },
  ] });
  const saved = backup(p.codexFile, existing);
  writeJson(p.codexFile, settings);
  return { ...p, installed: true, backup: saved };
}

export function uninstallCodexGuard(home) {
  const p = guardPaths(home);
  if (!fs.existsSync(p.codexFile)) return { ...p, removed: 0, backup: null };
  const settings = JSON.parse(fs.readFileSync(p.codexFile, 'utf8'));
  const groups = settings.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return { ...p, removed: 0, backup: null };
  let removed = 0;
  settings.hooks.PreToolUse = groups.map((group) => {
    if (!Array.isArray(group.hooks)) return group;
    const hooks = group.hooks.filter((item) => !codexOwned(item, p));
    removed += group.hooks.length - hooks.length;
    return { ...group, hooks };
  }).filter((group) => !Array.isArray(group.hooks) || group.hooks.length);
  if (!removed) return { ...p, removed: 0, backup: null };
  const saved = backup(p.codexFile, true);
  writeJson(p.codexFile, settings);
  return { ...p, removed, backup: saved };
}

export function projectHash(home, directory) {
  const salt = fs.readFileSync(initGuard(home).saltFile);
  return createHmac('sha256', salt).update(path.resolve(directory)).digest('hex');
}

export function mainGuard(args) {
  const command = args[0];
  const home = path.resolve(flag(args, '--home') || process.env.AGENT_CONSOLE_HOME || os.homedir());
  if (command === 'init') {
    const p = initGuard(home);
    process.stdout.write(`Guard policy: ${p.policyFile}\nCreated: ${p.created.join(', ') || 'nothing'}\n`);
  } else if (command === 'install') {
    const p = installGuard(home);
    process.stdout.write(p.installed ? `Added PreToolUse and PreModelSwitch hooks in ${p.settingsFile}. Backup: ${p.backup || 'new file'}.\n`
      : `Guard hooks already installed in ${p.settingsFile}.\n`);
  } else if (command === 'uninstall') {
    const p = uninstallGuard(home);
    process.stdout.write(`Removed ${p.removed} Agent Console hook handlers from ${p.settingsFile}. Backup: ${p.backup || 'not needed'}.\n`);
  } else if (command === 'install-codex') {
    const p = installCodexGuard(home);
    process.stdout.write(p.installed ? `Added PreToolUse hook in ${p.codexFile}. Backup: ${p.backup || 'new file'}. Review and trust it with /hooks in Codex.\n`
      : `Guard hook already installed in ${p.codexFile}.\n`);
  } else if (command === 'uninstall-codex') {
    const p = uninstallCodexGuard(home);
    process.stdout.write(`Removed ${p.removed} Agent Console hook handlers from ${p.codexFile}. Backup: ${p.backup || 'not needed'}.\n`);
  } else if (command === 'project-hash') {
    const directory = args[1];
    if (!directory || directory.startsWith('--')) throw new Error('Give a project directory');
    process.stdout.write(projectHash(home, directory) + '\n');
  } else {
    process.stdout.write('Usage: agent-console guard init|install|uninstall|install-codex|uninstall-codex|project-hash <directory> [--home <directory>]\n');
    if (command && command !== '--help') process.exitCode = 1;
  }
}
