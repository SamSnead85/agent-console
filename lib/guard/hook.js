#!/usr/bin/env node
/** Copied to a stable local runtime by guard install. No network and no raw-input log. */
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { parseGuardPolicy, evaluateGuard } from '../analysis/index.js';
import { classifyTool } from './classify.js';

const guardDir = process.argv[2] || '';
const codex = process.argv[3] === 'codex';
const policyFile = path.join(guardDir, 'policy.json');
const saltFile = path.join(guardDir, 'salt');
const logFile = path.join(guardDir, 'decisions.ndjson');
let policy;
let hookEvent = 'PreToolUse';
try { policy = parseGuardPolicy(fs.readFileSync(policyFile, 'utf8')); } catch { policy = null; }
const onError = policy?.on_error || 'ask';
const findRepoRoot = (cwd) => {
  let dir = path.resolve(cwd || '.');
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
};
const output = (event, action, ruleId) => {
  // Codex PreToolUse currently supports deny, but not ask. Deny instead of
  // returning an unsupported ask decision, which would let the call continue.
  const applied = codex && action === 'ask' ? 'block' : action;
  if (ruleId) {
    try { fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), ruleId, action: applied }) + '\n', { mode: 0o600 }); }
    catch { /* logging must not reveal input or alter the decision */ }
  }
  if (!action) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: event,
    permissionDecision: applied === 'block' ? 'deny' : applied,
    permissionDecisionReason: ruleId ? `Agent Console guard: ${ruleId}` : 'Agent Console guard could not evaluate this call',
  } }) + '\n');
};

try {
  let raw = '';
  for await (const part of process.stdin) {
    raw += part;
    if (raw.length > 1_000_000) throw new Error('hook input too large');
  }
  if (!policy) throw new Error('policy unavailable');
  const input = JSON.parse(raw);
  const event = !codex && input.hook_event_name === 'PreModelSwitch' ? 'PreModelSwitch' : 'PreToolUse';
  hookEvent = event;
  const salt = fs.readFileSync(saltFile);
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  const projectHash = cwd ? createHmac('sha256', salt).update(path.resolve(cwd)).digest('hex') : null;
  const repoRoot = process.env.CLAUDE_PROJECT_DIR || findRepoRoot(cwd);
  const facts = event === 'PreModelSwitch'
    ? { projectHash, modelId: input.to_model }
    : { tool: input.tool_name, matches: classifyTool(input, repoRoot), projectHash };
  const decision = evaluateGuard(policy, facts);
  output(event, decision.action, decision.ruleId);
} catch {
  output(hookEvent, onError, 'hook-error');
}
