#!/usr/bin/env node
/** Standalone native Claude Code hook copied by policy apply. No network. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classifyTool } from './classify.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let policy;
let event = 'PreToolUse';
let actionOnError = 'ask';
const audit = (rule, action) => {
  if (!rule) return;
  try {
    const key = createHash('sha256').update(project).digest('hex');
    const dir = path.join(process.env.AGENT_CONSOLE_HOME || os.homedir(), '.agent-console', 'policy', key);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, 'decisions.ndjson'), JSON.stringify({ at: Date.now(), rule, action }) + '\n', { mode: 0o600 });
  } catch { /* An audit failure cannot reveal input or change the decision. */ }
};
const emit = (action, rule) => {
  if (!action || action === 'allow') return;
  audit(rule, action);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: event,
    permissionDecision: action === 'block' ? 'deny' : 'ask',
    permissionDecisionReason: `Agent Console policy: ${rule}`,
  } }) + '\n');
};
const allowed = (model, list) => list.some((item) => item === model
  || ['haiku', 'sonnet', 'opus', 'fable'].includes(item) && model.startsWith(`claude-${item}-`));

try {
  policy = JSON.parse(fs.readFileSync(new URL('../agent-console-policy.json', import.meta.url), 'utf8'));
  actionOnError = ['allow', 'ask', 'block'].includes(policy.on_error) ? policy.on_error : 'ask';
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
      const route = role.endsWith('_verified')
        ? policy.routing.roles[role.slice(0, -9)]?.with_verifying_test : policy.routing.roles[role]?.model;
      if (!route) emit('block', 'unknown_policy_role');
      else if (requested && requested !== route && !(route === 'opus' && requested.startsWith('claude-opus-'))
        && !(route === 'sonnet' && requested.startsWith('claude-sonnet-'))
        && !(route === 'haiku' && requested.startsWith('claude-haiku-'))) emit('block', 'role_model_override');
    }
  } else {
    const facts = classifyTool(input, project);
    const decisions = facts.map((rule) => [rule, policy.gates[rule]]).filter(([, action]) => action && action !== 'allow');
    const chosen = decisions.find(([, action]) => action === 'block') || decisions[0];
    if (chosen) emit(chosen[1], chosen[0]);
  }
} catch {
  emit(actionOnError, 'hook_error');
}
