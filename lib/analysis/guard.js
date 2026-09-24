/** Versioned guard policy validation and count-only decision evaluation. No I/O. */
export const GUARD_POLICY_VERSION = 1;
const ACTIONS = new Set(['allow', 'ask', 'block']);
const PATTERNS = new Set(['force-push', 'protected-push', 'recursive-delete-outside-repo',
  'pipe-to-interpreter', 'credential-read', 'production-migration']);
const TOOLS = new Set(['*', 'Bash', 'PowerShell', 'Read', 'Edit', 'Write']);
const HASH = /^[a-f0-9]{64}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const exactKeys = (value, keys) => Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

export function parseGuardPolicy(value) {
  const policy = typeof value === 'string' ? JSON.parse(value) : value;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || !exactKeys(policy, ['version', 'on_error', 'rules', 'models']) || policy.version !== GUARD_POLICY_VERSION
    || !ACTIONS.has(policy.on_error) || !Array.isArray(policy.rules) || !Array.isArray(policy.models)) {
    throw new Error('Guard policy must follow schema version 1');
  }
  const ids = new Set();
  for (const rule of policy.rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || !exactKeys(rule, ['id', 'tool', 'pattern', 'action'])
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(rule.id) || ids.has(rule.id)
      || !TOOLS.has(rule.tool) || !PATTERNS.has(rule.pattern) || !ACTIONS.has(rule.action)) {
      throw new Error('Invalid or repeated guard rule');
    }
    ids.add(rule.id);
  }
  for (const model of policy.models) {
    if (!model || typeof model !== 'object' || Array.isArray(model)
      || !exactKeys(model, ['projectHash', 'allowedModelIds', 'action'])
      || !HASH.test(model.projectHash) || !Array.isArray(model.allowedModelIds)
      || !model.allowedModelIds.every((id) => typeof id === 'string' && MODEL.test(id))
      || !ACTIONS.has(model.action)) throw new Error('Invalid project model rule');
  }
  return {
    version: GUARD_POLICY_VERSION, on_error: policy.on_error,
    rules: policy.rules.map(({ id, tool, pattern, action }) => ({ id, tool, pattern, action })),
    models: policy.models.map(({ projectHash, allowedModelIds, action }) =>
      ({ projectHash, allowedModelIds: allowedModelIds.slice(), action })),
  };
}

/** Facts contain only enums, salted project hash and model ID; never command text. */
export function evaluateGuard(policy, { tool, matches = [], projectHash = null, modelId = null } = {}) {
  const decisions = policy.rules.filter((rule) => (rule.tool === '*' || rule.tool === tool)
    && matches.includes(rule.pattern)).map((rule) => ({ ruleId: rule.id, action: rule.action }));
  const model = policy.models.find((entry) => entry.projectHash === projectHash);
  if (model && modelId && !model.allowedModelIds.includes(modelId)) {
    decisions.push({ ruleId: 'model-deviation', action: model.action });
  }
  const priority = { block: 3, ask: 2, allow: 1 };
  decisions.sort((a, b) => priority[b.action] - priority[a.action]);
  return decisions[0] || { ruleId: null, action: null };
}
