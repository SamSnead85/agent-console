import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../lib/config.js';
import { policyApply, policyRemove } from '../lib/policy/cli.js';

const bin = fileURLToPath(new URL('../bin/agent-console.mjs', import.meta.url));
const scratch = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const run = (args, options = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 20_000, ...options });

test('--help lists the policy command, and policy --help prints its usage with a runnable command', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /policy diff\|apply\|remove/u);
  for (const args of [['policy', '--help'], ['policy', 'help'], ['policy', 'diff', '--help']]) {
    const usage = run(args);
    assert.equal(usage.status, 0, args.join(' '));
    assert.match(usage.stdout, /policy diff\|apply\|remove/u);
    // Never a bare `agent-console`: that name fetches an unrelated package.
    assert.doesNotMatch(usage.stdout, /(?:^|\s)agent-console policy/mu);
    assert.match(usage.stdout, /node '[^']+agent-console\.mjs' policy/u);
  }
  assert.equal(run(['policy', 'frobnicate']).status, 1);
});

test('policy remove says removed for files it deleted, takes away the directories apply made, and skips the budget note', (t) => {
  const root = path.join(scratch(t, 'agent-console-remove-'), 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'agent-policy.yaml'), 'version: 1\n');
  const env = { ...process.env, HOME: path.dirname(root), USERPROFILE: path.dirname(root), CLAUDE_CONFIG_DIR: '' };
  const apply = run(['policy', 'apply', '--project', root], { env });
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Not enforceable yet/u);
  const remove = run(['policy', 'remove', '--project', root], { env });
  assert.equal(remove.status, 0, remove.stderr);
  assert.doesNotMatch(remove.stdout, /restored:/u);
  assert.match(remove.stdout, /removed: .*settings\.json/u);
  assert.doesNotMatch(remove.stdout, /Not enforceable yet/u);
  assert.deepEqual(fs.readdirSync(root), ['agent-policy.yaml']);
  const again = run(['policy', 'remove', '--project', root], { env });
  assert.equal(again.stdout, 'No applied policy found.\n');
});

test('policy remove keeps a .claude directory that existed, and a directory someone added files to', (t) => {
  const root = path.join(scratch(t, 'agent-console-remove-keep-'), 'project');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent-policy.yaml'), 'version: 1\n');
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}\n');
  const stateDir = path.join(root, '..', 'state');
  policyApply(root, { stateDir });
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'mine.md'), 'kept\n');
  const result = policyRemove(root, { stateDir });
  assert.deepEqual(result.restored, [path.join(root, '.claude', 'settings.json')]);
  assert.ok(result.deleted.length > 0);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'agents', 'mine.md')));
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'hooks')));
});

test('apply refuses the user-level Claude directory spelled with different case', { skip: process.platform === 'win32' }, (t) => {
  const home = scratch(t, 'agent-console-userdir-');
  const miscased = path.join(path.dirname(home), path.basename(home).toUpperCase());
  if (!fs.existsSync(miscased)) { t.skip('this volume is case-sensitive'); return; }
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(home, 'agent-policy.yaml'), 'version: 1\n');
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  assert.throws(() => policyApply(miscased, { stateDir: path.join(home, 'state') }), /user-level/u);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{}\n');
});

test('metrics-token refuses mistakes and answers --help without printing the token', (t) => {
  const state = scratch(t, 'agent-console-token-');
  const key = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(state, 'admin.key'), key + '\n', { mode: 0o600 });
  const token = crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update('agent-console/metrics/v1').digest('base64url');
  const help = run(['metrics-token', '--help', '--state-dir', state]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /metrics-token \[--state-dir <path>\]/u);
  assert.ok(!help.stdout.includes(token) && !help.stderr.includes(token));
  for (const args of [['--bogus'], ['extra'], ['--stat-dir', '/other/hub']]) {
    const refused = run(['metrics-token', '--state-dir', state, ...args]);
    assert.equal(refused.status, 2, args.join(' '));
    assert.ok(!refused.stdout.includes(token) && !refused.stderr.includes(token), args.join(' '));
  }
  const json = run(['metrics-token', '--state-dir', state, '--bogus', '--json']);
  assert.equal(JSON.parse(json.stdout).ok, false);
  const good = run(['metrics-token', '--state-dir', state]);
  assert.equal(good.status, 0);
  assert.ok(good.stdout.includes(token));
});

test('--name and --person need a value', () => {
  assert.match(readConfig(['--name'], {}).errors.join(' '), /--name needs a value/u);
  assert.match(readConfig(['--person', '--name'], {}).errors.join(' '), /--person needs a value/u);
  assert.deepEqual(readConfig(['--name', 'Build box', '--person', 'Platform engineer'], {}).errors, []);
});
