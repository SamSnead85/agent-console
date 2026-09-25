import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { policyApply, policyRemove, policyStatus } from '../lib/policy/cli.js';

function project(t, policy = 'version: 1\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'agent-policy.yaml'), policy);
  return { root, stateDir: path.join(root, 'private') };
}

test('status detects missing, modified and restored controls without treating installation as enforcement proof', t => {
  const { root, stateDir } = project(t);
  assert.equal(policyStatus(root, { stateDir }).state, 'not-installed');
  policyApply(root, { stateDir });
  const healthy = policyStatus(root, { stateDir });
  assert.equal(healthy.state, 'installed');
  assert.equal(healthy.runtimeVerified, false);
  assert.equal(healthy.coverage.tools, 'configured-unverified');
  assert.equal(healthy.coverage.hardBudgets, 'not-enforced');
  assert.match(healthy.policyDigest, /^[a-f0-9]{64}$/u);
  const hook = path.join(root, '.claude', 'hooks', 'agent-console-policy.mjs');
  const original = fs.readFileSync(hook);
  fs.appendFileSync(hook, '\n// edited');
  assert.equal(policyStatus(root, { stateDir }).state, 'drifted');
  fs.rmSync(hook);
  assert.ok(policyStatus(root, { stateDir }).issues.some(i => i.reason === 'missing'));
  fs.writeFileSync(hook, original);
  assert.equal(policyStatus(root, { stateDir }).state, 'installed');
  policyRemove(root, { stateDir });
  assert.equal(policyStatus(root, { stateDir }).state, 'not-installed');
});

test('status includes organization policy drift without reading raw commands or exposing policy contents', t => {
  const { root, stateDir } = project(t);
  const orgFile = path.join(root, 'organization.json');
  fs.writeFileSync(orgFile, '{"version":1,"gates":{"force_push":"block"}}');
  policyApply(root, { stateDir, orgFile });
  assert.equal(policyStatus(root, { stateDir }).state, 'installed');
  fs.writeFileSync(orgFile, '{"version":1,"gates":{"force_push":"ask"}}');
  const status = policyStatus(root, { stateDir });
  assert.equal(status.state, 'drifted');
  assert.ok(status.issues.some(i => i.file === 'source-policy'));
  assert.ok(!JSON.stringify(status).includes(root));
});

test('installed hook blocks changes to its own controls and asks before uninspected interpreter execution', t => {
  const { root, stateDir } = project(t);
  policyApply(root, { stateDir });
  const hook = path.join(root, '.claude', 'hooks', 'agent-console-policy.mjs');
  const decide = (tool, args) => {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: root,
      tool_name: tool, tool_input: args }), encoding: 'utf8', env: { ...process.env, AGENT_CONSOLE_HOME: root } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow';
  };
  for (const file of ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/classify.mjs', '.claude/agent-console-policy.json']) {
    assert.equal(decide('Write', { file_path: path.join(root, file), content: 'synthetic' }), 'deny');
  }
  assert.equal(decide('Bash', { command: 'echo synthetic > .claude/settings.json' }), 'deny');
  assert.equal(decide('Bash', { command: 'rm -rf .claude' }), 'deny');
  assert.equal(decide('Bash', { command: '> .claude/settings.json' }), 'deny');
  assert.equal(decide('Bash', { command: 'python3 -c "print(1)"' }), 'ask');
  assert.equal(decide('Bash', { command: 'node scripts/task.mjs' }), 'ask');
  assert.equal(decide('Bash', { command: 'python3 --version' }), 'allow');
  assert.equal(decide('Write', { file_path: path.join(root, 'src', 'normal.js'), content: 'synthetic' }), 'allow');
});
