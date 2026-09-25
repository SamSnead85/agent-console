#!/usr/bin/env node
/** Standalone native Claude Code hook copied by policy apply. No network. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let policy;
let event = 'PreToolUse';
let actionOnError = 'ask';
let failClosed = false;
const audit = (rule, action) => {
  if (!rule) return;
  try {
    const key = createHash('sha256').update(project).digest('hex');
    const dir = path.join(process.env.AGENT_CONSOLE_HOME || os.homedir(), '.agent-console', 'policy', key);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, 'decisions.ndjson'), JSON.stringify({ at: Date.now(), rule, action }) + '\n', { mode: 0o600 });
  } catch { /* An audit failure cannot reveal input or change the decision. */ }
};
let decided = false;
const emit = (action, rule) => {
  if (decided) return;
  decided = true;
  if (!action || action === 'allow') return;
  audit(rule, action);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: event,
    permissionDecision: action === 'block' ? 'deny' : 'ask',
    permissionDecisionReason: `Agent Console policy: ${rule}`,
  } }) + '\n');
};
// Claude Code kills a hook at its settings timeout (30 s) and then lets the
// tool call run. The hook keeps its own, much shorter budget: past it, it
// answers as it would for an error, asking even when on_error is allow.
// Classification runs on a worker thread so this timer fires even if the
// classifier is busy.
const BUDGET_MS = 5000;
const deadline = setTimeout(() => {
  emit(actionOnError === 'allow' ? 'ask' : actionOnError, 'hook_timeout');
  process.stdout.write('', () => process.exit(0));
}, BUDGET_MS);
const classifyOffThread = (input) => new Promise((resolve, reject) => {
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
import(workerData.url).then((m) => parentPort.postMessage(m.classifyTool(workerData.input, workerData.project)));`,
  { eval: true, workerData: { url: new URL('./classify.mjs', import.meta.url).href, input, project } });
  worker.once('message', (facts) => { resolve(facts); worker.terminate(); });
  worker.once('error', reject);
  worker.once('exit', () => reject(new Error('classifier ended without an answer')));
});
const allowed = (model, list) => list.some((item) => item === model
  || ['haiku', 'sonnet', 'opus', 'fable'].includes(item) && model.startsWith(`claude-${item}-`));

try {
  policy = JSON.parse(fs.readFileSync(new URL('../agent-console-policy.json', import.meta.url), 'utf8'));
  actionOnError = ['allow', 'ask', 'block'].includes(policy.on_error) ? policy.on_error : 'ask';
  // Load the classifier inside the try: a missing or broken classifier must
  // end in a decision, never a non-blocking crash that lets the tool run.
  failClosed = true;
  const { classifyTool } = await import('./classify.mjs');
  if (typeof classifyTool !== 'function') throw new Error('classifier unavailable');
  failClosed = false;
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('hook input too large');
  }
  const input = JSON.parse(raw);
  event = input.hook_event_name === 'PreModelSwitch' ? 'PreModelSwitch' : 'PreToolUse';
  if (event === 'PreModelSwitch') {
    if (typeof input.to_model !== 'string') throw new Error('missing model');
    if (!allowed(input.to_model, policy.model_allowlist)) emit('block', 'model_allowlist');
    else if (policy.cache.forbid_model_switch_in_task && input.agent_id) emit('block', 'model_switch_in_task');
  } else if (input.tool_name === 'Agent') {
    const type = input.tool_input?.subagent_type;
    const requested = input.tool_input?.model;
    if (requested && !allowed(requested, policy.model_allowlist)) emit('block', 'model_allowlist');
    else if (typeof type === 'string' && type.startsWith('agent-console-')) {
      const role = type.slice('agent-console-'.length).replaceAll('-', '_');
      const route = role === 'escalation' ? policy.escalation.model : role.endsWith('_verified')
        ? policy.routing.roles[role.slice(0, -9)]?.with_verifying_test : policy.routing.roles[role]?.model;
      if (!route) emit('block', 'unknown_policy_role');
      else if (requested && requested !== route && !(route === 'opus' && requested.startsWith('claude-opus-'))
        && !(route === 'sonnet' && requested.startsWith('claude-sonnet-'))
        && !(route === 'haiku' && requested.startsWith('claude-haiku-'))) emit('block', 'role_model_override');
    }
  } else {
    const facts = await classifyOffThread(input);
    if (!Array.isArray(facts)) throw new Error('classifier answer unreadable');
    const decisions = facts.map((rule) => [rule, policy.gates[rule]]).filter(([, action]) => action && action !== 'allow');
    const chosen = decisions.find(([, action]) => action === 'block') || decisions[0];
    if (chosen) emit(chosen[1], chosen[0]);
  }
} catch {
  // Without a classifier the hook cannot tell a safe command from a gated one,
  // so it asks or denies even when on_error is allow.
  emit(failClosed && actionOnError === 'allow' ? 'ask' : actionOnError, 'hook_error');
}
decided = true;
clearTimeout(deadline);
