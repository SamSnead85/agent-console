import { eventMeasurement } from './measurement.js';
import { createHash } from 'node:crypto';

// Measurement behavior derived from agent-console v0.1.0: per-message high
// water and disjoint cache categories. Portable IDs and explicit replay-ordinal
// boundaries were added by LockedIn Labs' console collector.
const CLASSES = ['fresh', 'output', 'cacheWrite', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
const CODEX_CLASSES = ['input', 'output', 'cacheWrite', 'cacheRead'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 16_384 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const modelName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) ? value : 'unknown';
const hash = value => createHash('sha256').update(value).digest('hex');

function minute(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(Math.floor(time / 60_000) * 60_000).toISOString() : null;
}

function identity(context, kind, value) {
  return value === null ? null : context.hashIdentity(kind, value);
}

function startingState(tool, context, state) {
  const previous = object(state) && state.v === 2 && state.tool === tool ? state : {};
  return {
    ...previous,
    v: 2,
    tool,
    sessionHash: previous.sessionHash ?? null,
    parentSessionHash: previous.parentSessionHash ?? context.parentSessionHash ?? null,
    projectHash: previous.projectHash ?? context.projectHash ?? null,
    isSubagent: previous.isSubagent ?? context.isSubagent ?? false,
    model: modelName(previous.model),
    executionOrigin: previous.executionOrigin ?? 'unknown',
  };
}

function debt(state, reason) {
  state.coverageDebt ??= {};
  state.coverageDebt[reason] = (count(state.coverageDebt[reason]) ?? 0) + 1;
}

/**
 * The hub's own machine may name its lanes: it is reading its own disk and
 * serves the result only on loopback. The hook receives the raw directory and
 * branch, and exists only when the hub set it — a reporter never does, so
 * nothing here can reach a record, the spool or the wire.
 */
function localLabel(context, state, cwd, branch) {
  if (typeof context.onLocalLabel !== 'function' || !state.sessionHash) return;
  context.onLocalLabel({ sessionHash: state.sessionHash, projectHash: state.projectHash, cwd, branch });
}

function origin(context, state, metadata) {
  const value = text(metadata.executionOrigin) ?? text(metadata.execution_origin);
  if (value && value !== 'unknown') state.executionOrigin = identity(context, 'execution-origin', value);
}

function record(tool, context, state, timestamp, usage, messageId, observedChange = false, eventAt = null) {
  // docs/accounting.md §2: an event is dated by its first transcript line.
  // Increments written on later lines of the same API response carry that
  // same minute, so a response streamed across a minute (or window) boundary
  // lands wholly on the side where it began.
  const at = eventAt ?? minute(timestamp);
  if (!at) { debt(state, 'missingTimestamp'); return []; }
  if (!state.projectHash) { debt(state, 'missingProject'); return []; }
  if (!state.rawSessionId || !state.sessionHash || !messageId) { debt(state, 'missingIdentity'); return []; }
  if (!observedChange && !CLASSES.some(key => count(usage[key]) !== null && usage[key] > 0)) return [];
  const split = count(usage.cacheWrite5m) !== null && count(usage.cacheWrite1h) !== null
    && Number.isSafeInteger(usage.cacheWrite5m + usage.cacheWrite1h)
    && usage.cacheWrite5m + usage.cacheWrite1h === count(usage.cacheWrite);
  if (!split && (count(usage.cacheWrite5m) !== null || count(usage.cacheWrite1h) !== null)) debt(state, 'ttlConflict');
  const result = {
    id: context.recordId(tool, state.rawSessionId, messageId),
    tool,
    model: state.model,
    sessionHash: state.sessionHash,
    parentSessionHash: state.parentSessionHash,
    isSubagent: state.isSubagent,
    projectHash: state.projectHash,
    reportingDevice: context.reportingDevice,
    executionOrigin: state.executionOrigin,
    at,
    fresh: count(usage.fresh),
    output: count(usage.output),
    cacheWrite: count(usage.cacheWrite),
    cacheRead: count(usage.cacheRead),
    cacheWrite5m: split ? usage.cacheWrite5m : null,
    cacheWrite1h: split ? usage.cacheWrite1h : null,
    ttl: split ? 'split' : 'unknown',
    observed: true,
    // Set by the caller when an earlier record already counted this message.
    continuation: false,
  };
  result.measurement = eventMeasurement(result);
  return [result];
}

function claude(line, context, state) {
  const session = text(line.sessionId);
  const agent = text(line.agentId);
  const sidechain = typeof line.isSidechain === 'boolean' ? line.isSidechain : state.isSubagent;
  if (session) {
    state.rawSessionId = session;
    const parent = identity(context, 'session', `claude-code:${session}`);
    state.sessionHash = sidechain ? agent ? identity(context, 'session', `claude-code:${session}:agent:${agent}`) : null : parent;
    state.parentSessionHash = sidechain ? parent : null;
  }
  state.isSubagent = sidechain;
  if (text(line.cwd)) state.projectHash = identity(context, 'project', line.cwd);
  if (text(line.cwd)) localLabel(context, state, line.cwd, text(line.gitBranch));
  origin(context, state, line);
  const message = object(line.message) ? line.message : null;
  if (line.type !== 'assistant' || !message || !object(message.usage)) return { records: [], state };
  if (message.model === '<synthetic>') return { records: [], state };
  state.model = modelName(message.model);
  const uuid = text(line.uuid);
  const nativeMessage = text(message.id);
  const request = text(line.requestId);
  const recordMessage = uuid ?? (nativeMessage && request ? `${nativeMessage}:${request}` : null);
  if (!session || !state.sessionHash || !recordMessage || !nativeMessage) {
    debt(state, 'missingIdentity'); return { records: [], state };
  }
  const creation = object(message.usage.cache_creation) ? message.usage.cache_creation : {};
  const five = count(creation.ephemeral_5m_input_tokens);
  const hour = count(creation.ephemeral_1h_input_tokens);
  const total = count(message.usage.cache_creation_input_tokens);
  const usage = {
    fresh: count(message.usage.input_tokens),
    output: count(message.usage.output_tokens),
    cacheWrite: total ?? (five !== null && hour !== null ? count(five + hour) : null),
    cacheRead: count(message.usage.cache_read_input_tokens),
    cacheWrite5m: five,
    cacheWrite1h: hour,
  };
  // Repeated Claude content blocks describe one API response. Retain numeric
  // high-water marks, never its message body. Line UUIDs identify the deltas.
  const messageKey = hash(`claude-message\0${state.sessionHash}\0${nativeMessage}`);
  const previous = state.claudeUsage?.[messageKey];
  // One API response is streamed over several lines, and each line whose usage
  // grew becomes its own record. Only the first record of a message counts as
  // a message; the rest are marked as its continuation.
  const counted = previous?.counted === true;
  const delta = {};
  const highWater = {};
  for (const key of CLASSES) {
    const current = usage[key];
    const prior = count(previous?.[key]);
    delta[key] = current === null ? null : prior === null ? current : Math.max(0, current - prior);
    highWater[key] = current === null ? prior : prior === null ? current : Math.max(prior, current);
  }
  // The minute of the first line seen for this response dates every increment.
  highWater.firstAt = typeof previous?.firstAt === 'string' ? previous.firstAt : minute(line.timestamp);
  state.claudeUsage ??= {};
  state.claudeUsage[messageKey] = highWater;
  if (!uuid) {
    // Fallback identity is response-level. Streamed revisions cannot be posted
    // as different deltas with the same first-writer-wins ID. Wait for the
    // transcript's definitive response stop and emit the whole measurement once.
    const fallbackKey = hash(recordMessage);
    state.claudeFallbackSent ??= {};
    if (state.claudeFallbackSent[fallbackKey]) {
      if (CLASSES.some(key => delta[key] > 0)) debt(state, 'changedFinalUsage');
      return { records: [], state };
    }
    if (!text(message.stop_reason)) { debt(state, 'awaitingFinalUsage'); return { records: [], state }; }
    const records = record('claude-code', context, state, line.timestamp, highWater, recordMessage, false, highWater.firstAt);
    if (records.length) { state.claudeFallbackSent[fallbackKey] = true; records[0].continuation = counted; }
    highWater.counted = counted || records.length > 0;
    return { records, state };
  }
  const records = record('claude-code', context, state, line.timestamp, delta, recordMessage, false, highWater.firstAt);
  if (records.length) records[0].continuation = counted;
  highWater.counted = counted || records.length > 0;
  return { records, state };
}

function codexUsage(value) {
  return {
    input: count(value.input_tokens),
    output: count(value.output_tokens),
    cacheWrite: count(value.cache_write_input_tokens),
    cacheRead: count(value.cached_input_tokens),
  };
}

function codex(line, context, state) {
  const payload = object(line.payload) ? line.payload : {};
  if (line.type === 'session_meta') {
    // Later session_meta rows can be replayed ancestor metadata. Only the first
    // metadata row identifies this rollout; it is never replaced by its parent.
    if (state.ownMetaSeen) return { records: [], state };
    state.ownMetaSeen = true;
    const id = text(payload.id);
    const source = object(payload.source) ? payload.source : {};
    const subagent = object(source.subagent) ? source.subagent : {};
    const spawn = object(subagent.thread_spawn) ? subagent.thread_spawn : {};
    const parent = text(payload.parent_thread_id) ?? text(spawn.parent_thread_id);
    state.rawSessionId = id;
    state.sessionHash = id ? identity(context, 'session', `codex:${id}`) : null;
    state.isSubagent = parent !== null || source.subagent !== undefined || context.isSubagent === true;
    state.parentSessionHash = parent ? identity(context, 'session', `codex:${parent}`) : null;
    state.inherited = text(payload.forked_from_id) !== null;
    state.historyStartOrdinal = count(payload.subagent_history_start_ordinal);
    if (text(payload.cwd)) state.projectHash = identity(context, 'project', payload.cwd);
    if (text(payload.model)) state.model = modelName(payload.model);
    if (text(payload.cwd)) localLabel(context, state, payload.cwd, object(payload.git) ? text(payload.git.branch) : null);
    origin(context, state, payload);
    return { records: [], state };
  }
  if (line.type === 'turn_context') {
    state.model = modelName(payload.model);
    if (text(payload.cwd)) state.projectHash = identity(context, 'project', payload.cwd);
    origin(context, state, payload);
    return { records: [], state };
  }
  if (line.type !== 'event_msg' || payload.type !== 'token_count' || !object(payload.info)
      || !object(payload.info.total_token_usage)) return { records: [], state };
  const cumulative = codexUsage(payload.info.total_token_usage);
  const previous = state.codexUsage;
  const reset = previous && CODEX_CLASSES.some(key => cumulative[key] !== null && count(previous[key]) !== null
    && cumulative[key] < previous[key]);
  state.codexUsage = cumulative;
  const ordinal = count(line.ordinal) ?? count(line.sequence) ?? count(payload.sequence);
  if (state.historyStartOrdinal !== null && state.historyStartOrdinal !== undefined) {
    if (ordinal === null) { debt(state, 'missingReplayOrdinal'); return { records: [], state }; }
    if (ordinal < state.historyStartOrdinal) {
      state.skippedBaselines = (count(state.skippedBaselines) ?? 0) + 1;
      return { records: [], state };
    }
  } else if (state.inherited) {
    // A two-second replay heuristic exists in the released console. It is not
    // an intrinsic boundary, so an unbounded inherited prefix stays unmeasured.
    debt(state, 'unboundedReplay'); return { records: [], state };
  }
  // docs/accounting.md §4: a counter that went down restarted from zero. When
  // the event's own last_token_usage equals the new cumulative total in every
  // class (every restart observed so far, including each forked child's first
  // own request after its inherited history), the new total IS this event's
  // usage. Anything else could be a rollback to an earlier checkpoint, which
  // the logs cannot distinguish, so it stays an unmeasured baseline.
  let baseline = previous;
  if (reset) {
    const last = object(payload.info.last_token_usage) ? codexUsage(payload.info.last_token_usage) : null;
    if (!last || !CODEX_CLASSES.every(key => last[key] === cumulative[key])) {
      state.skippedBaselines = (count(state.skippedBaselines) ?? 0) + 1;
      debt(state, 'counterReset'); return { records: [], state };
    }
    baseline = null;
    state.counterRestarts = (count(state.counterRestarts) ?? 0) + 1;
  }
  const timestamp = text(line.timestamp);
  const messageId = ordinal !== null ? `ordinal:${ordinal}` : minute(timestamp) ? `timestamp:${timestamp}` : null;
  if (!state.rawSessionId || !messageId) { debt(state, 'missingIdentity'); return { records: [], state }; }
  const delta = {};
  for (const key of CODEX_CLASSES) {
    delta[key] = cumulative[key] === null ? null : !baseline ? cumulative[key]
      : count(baseline[key]) === null ? null : cumulative[key] - baseline[key];
  }
  const changed = CODEX_CLASSES.some(key => delta[key] !== null && delta[key] > 0);
  // Old logs can repeat one millisecond without a sequence. Reuse of that
  // identity with changing usage is a coverage gap, never a conflicting post.
  state.codexEventIds ??= {};
  const identityKey = hash(messageId);
  if (state.codexEventIds[identityKey]) {
    if (changed) debt(state, 'ambiguousEventIdentity');
    return { records: [], state };
  }
  const fresh = delta.input !== null && delta.cacheRead !== null && delta.cacheWrite !== null
    && delta.cacheRead <= delta.input && delta.cacheWrite <= delta.input - delta.cacheRead
    ? delta.input - delta.cacheRead - delta.cacheWrite : null;
  const records = record('codex', context, state, line.timestamp, {
    fresh, output: delta.output, cacheWrite: delta.cacheWrite, cacheRead: delta.cacheRead,
    cacheWrite5m: null, cacheWrite1h: null,
  }, messageId, delta.input !== null && delta.input > 0);
  if (records.length) state.codexEventIds[identityKey] = true;
  return { records, state };
}

/**
 * Parse one complete JSONL line. The caller owns newline framing, byte offsets,
 * local file cursors, salt, and output delivery. No transcript text or path is
 * retained. State v2 may retain a raw intrinsic session ID privately; outputs
 * contain only organization-salted identities. hashIdentity receives raw identity values only
 * in memory and must return opaque salted hashes.
 *
 * Context: {hashIdentity(kind, value), recordId(tool, sessionId, messageId),
 *           reportingDevice, projectHash?, isSubagent?}. Source paths and byte
 * offsets belong only to the caller's cursor and never enter record identity.
 * Returns {records, state}; persist state atomically with the caller's cursor.
 */
export function parseLine(tool, line, context, state = {}) {
  const canonical = tool === 'claude' ? 'claude-code' : tool;
  if (!['claude-code', 'codex'].includes(canonical)) return { records: [], state };
  if (!object(context) || typeof context.hashIdentity !== 'function' || typeof context.recordId !== 'function'
      || !text(context.reportingDevice)) throw new TypeError('Organization identity and record hashers plus a reporting device are required.');
  let value;
  try { value = JSON.parse(line); } catch { return { records: [], state }; }
  if (!object(value)) return { records: [], state };
  const next = startingState(canonical, context, state);
  const result = canonical === 'claude-code' ? claude(value, context, next) : codex(value, context, next);
  // A local observer may react to newly tailed lines. It sees the same
  // accounting deltas and salted identity as the collector; no second token
  // parser or report field is introduced.
  if (typeof context.onParsedLine === 'function') context.onParsedLine(value, result);
  return result;
}
