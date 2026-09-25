/** Versioned policy parser. Pure: no filesystem, network, or hook input. */
export const POLICY_VERSION = 1;
const ACTIONS = ['allow', 'ask', 'block'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const GATES = ['force_push', 'delete_outside_repo', 'pipe_to_interpreter', 'credential_read', 'production_migration', 'policy_change', 'uninspected_execution'];
const MODEL = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/u;
const NAME = /^[a-z][a-z0-9_-]{0,39}$/u;

export const DEFAULT_POLICY = Object.freeze({
  version: 1, on_error: 'ask',
  effort: { default_by_task: { search: 'low', exploration: 'low', log_reading: 'low', code_edit: 'high' }, max_allowlist: [] },
  routing: { roles: { search: { model: 'haiku' }, exploration: { model: 'haiku' },
    log_reading: { model: 'haiku' }, code_edit: { model: 'opus', with_verifying_test: 'sonnet' } } },
  escalation: { after_failures: 2, model: 'opus' },
  model_allowlist: ['haiku', 'sonnet', 'opus'],
  budgets: { per_run: { tokens: 200000, usd: 50 }, per_day: { tokens: 1000000, usd: 200 } },
  cache: { forbid_model_switch_in_task: true, idle_gap_minutes: 5 },
  gates: { force_push: 'ask', delete_outside_repo: 'block', pipe_to_interpreter: 'ask',
    credential_read: 'ask', production_migration: 'block', policy_change: 'block', uninspected_execution: 'ask' },
});
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const shape = (x, allowed, label) => {
  if (!object(x) || Object.keys(x).some((key) => !allowed.includes(key))) throw new Error(`Invalid ${label}`);
};
const scalar = (raw) => {
  const x = raw.trim();
  if (!x || /^[!&*>{]/u.test(x)) throw new Error('Unsupported YAML scalar');
  if (x.startsWith('"')) return JSON.parse(x);
  if (x.startsWith("'")) {
    if (!x.endsWith("'")) throw new Error('Unclosed YAML string');
    return x.slice(1, -1).replaceAll("''", "'");
  }
  if (x === 'true') return true;
  if (x === 'false') return false;
  if (x === 'null') return null;
  if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(x)) return Number(x);
  if (x.startsWith('[') && x.endsWith(']')) {
    const inside = x.slice(1, -1).trim();
    return inside ? inside.split(',').map(scalar) : [];
  }
  if (/[[\]{}#]|:\s/u.test(x)) throw new Error('Unsupported YAML scalar');
  return x;
};

/** YAML subset: two-space maps, scalar lists, inline scalar arrays, no anchors or tags. */
export function parsePolicyDocument(text) {
  if (object(text)) return structuredClone(text);
  if (typeof text !== 'string' || text.length > 65536) throw new Error('Policy must be small YAML or JSON');
  if (text.trim().startsWith('{')) return JSON.parse(text);
  const lines = text.replaceAll('\r\n', '\n').split('\n').flatMap((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return [];
    if (line.includes('\t') || /\s+$/u.test(line)) throw new Error(`Invalid YAML line ${index + 1}`);
    const indent = line.length - line.trimStart().length;
    if (indent % 2) throw new Error(`Use two-space indentation on line ${index + 1}`);
    return [{ indent, body: line.slice(indent), line: index + 1 }];
  });
  let at = 0;
  const block = (indent) => {
    const result = {};
    while (at < lines.length && lines[at].indent === indent) {
      const { body, line } = lines[at++];
      const match = /^([a-z][a-z0-9_]*):(.*)$/u.exec(body);
      if (!match) throw new Error(`Invalid YAML mapping on line ${line}`);
      const [, key, tail] = match;
      if (Object.hasOwn(result, key)) throw new Error(`Repeated YAML key ${key}`);
      if (tail.trim()) { result[key] = scalar(tail); continue; }
      if (at >= lines.length || lines[at].indent !== indent + 2) throw new Error(`Missing YAML value for ${key}`);
      if (lines[at].body.startsWith('- ')) {
        const items = [];
        while (at < lines.length && lines[at].indent === indent + 2 && lines[at].body.startsWith('- '))
          items.push(scalar(lines[at++].body.slice(2)));
        result[key] = items;
      } else result[key] = block(indent + 2);
    }
    return result;
  };
  if (!lines.length || lines[0].indent !== 0) throw new Error('Policy needs a root mapping');
  const result = block(0);
  if (at !== lines.length) throw new Error(`Unexpected YAML indentation on line ${lines[at].line}`);
  return result;
}
const merge = (base, override) => {
  if (!object(base) || !object(override)) return structuredClone(override);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) out[key] = key in out ? merge(out[key], value) : structuredClone(value);
  return out;
};

/** Organization overrides are merged before defaults, validation, and compilation. */
export function parsePolicy(repoText, orgText = null) {
  const repo = parsePolicyDocument(repoText);
  const org = orgText === null ? null : parsePolicyDocument(orgText);
  for (const part of [repo, org].filter(Boolean)) {
    shape(part, Object.keys(DEFAULT_POLICY), 'policy root');
    if (part.version !== POLICY_VERSION) throw new Error(`Policy version must be ${POLICY_VERSION}`);
  }
  const p = merge(merge(DEFAULT_POLICY, repo), org || {});
  if (!ACTIONS.includes(p.on_error)) throw new Error('Invalid on_error');
  shape(p.effort, ['default_by_task', 'max_allowlist'], 'effort');
  shape(p.effort.default_by_task, Object.keys(p.effort.default_by_task), 'task effort');
  if (!Array.isArray(p.effort.max_allowlist) || p.effort.max_allowlist.some((x) => !NAME.test(x))) throw new Error('Invalid max allowlist');
  for (const [task, level] of Object.entries(p.effort.default_by_task)) {
    if (!NAME.test(task) || !EFFORTS.includes(level) || (level === 'max' && !p.effort.max_allowlist.includes(task)))
      throw new Error('Invalid or unlisted max effort');
  }
  shape(p.routing, ['roles'], 'routing');
  shape(p.routing.roles, Object.keys(p.routing.roles), 'roles');
  for (const [role, route] of Object.entries(p.routing.roles)) {
    if (!NAME.test(role)) throw new Error('Invalid role');
    shape(route, ['model', 'with_verifying_test'], `route ${role}`);
    if (!MODEL.test(route.model) || (route.with_verifying_test && !MODEL.test(route.with_verifying_test))) throw new Error('Invalid route model');
  }
  shape(p.escalation, ['after_failures', 'model'], 'escalation');
  if (!Number.isSafeInteger(p.escalation.after_failures) || p.escalation.after_failures < 1 || !MODEL.test(p.escalation.model)) throw new Error('Invalid escalation');
  if (!Array.isArray(p.model_allowlist) || !p.model_allowlist.length || p.model_allowlist.some((x) => !MODEL.test(x))
    || new Set(p.model_allowlist).size !== p.model_allowlist.length) throw new Error('Invalid model allowlist');
  const used = [p.escalation.model, ...Object.values(p.routing.roles).flatMap((route) => [route.model, route.with_verifying_test].filter(Boolean))];
  if (used.some((model) => !p.model_allowlist.includes(model))) throw new Error('Routed model missing from allowlist');
  shape(p.budgets, ['per_run', 'per_day'], 'budgets');
  for (const period of ['per_run', 'per_day']) {
    shape(p.budgets[period], ['tokens', 'usd'], `${period} budget`);
    if (!Number.isSafeInteger(p.budgets[period].tokens) || p.budgets[period].tokens < 1
      || !Number.isFinite(p.budgets[period].usd) || p.budgets[period].usd <= 0) throw new Error('Invalid budget');
  }
  shape(p.cache, ['forbid_model_switch_in_task', 'idle_gap_minutes'], 'cache');
  if (typeof p.cache.forbid_model_switch_in_task !== 'boolean' || !Number.isSafeInteger(p.cache.idle_gap_minutes)
    || p.cache.idle_gap_minutes < 1) throw new Error('Invalid cache policy');
  shape(p.gates, GATES, 'gates');
  if (GATES.some((gate) => !ACTIONS.includes(p.gates[gate]))) throw new Error('Invalid action gate');
  return p;
}
