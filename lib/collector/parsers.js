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
// Exact provider ids, including Bedrock and Vertex forms such as
// `us.anthropic.claude-opus-4-6-v1:0`, `claude-opus-4-6@20250805`, an
// inference-profile path, or a `[1m]` context marker (docs/accounting.md §5).
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@\[\]\/-]{0,127}$/;
const modelName = value => typeof value === 'string' && MODEL_ID.test(value) ? value : 'unknown';
const hash = value => createHash('sha256').update(value).digest('hex');
const CODEX_LINES = /"(?:session_meta|turn_context|token_count|token_usage_record)"/;
const TIERS = new Set(['standard', 'fast', 'other']);

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
    // The price tier the response was billed under (docs/accounting.md §9):
    // standard, fast mode, another service tier, or null when not reported.
    tier: TIERS.has(usage.tier) ? usage.tier : null,
    observed: true,
    // Set by the caller when an earlier record already counted this message.
    continuation: false,
    // True when the amounts are the message's running per-class maximum, sent
    // under one message-level id: a receiver keeps the largest it has seen
    // and adds only the growth above it (docs/accounting.md §2).
    cumulative: false,
  };
  result.measurement = eventMeasurement(result);
  return [result];
}

/**
 * The tier a Claude response was billed under. `usage.speed` is "fast" for
 * fast mode; `usage.service_tier` names any other tier. A tier this table
 * cannot price is "other", which is left unpriced rather than guessed.
 */
function claudeTier(usage) {
  const speed = typeof usage.speed === 'string' ? usage.speed : null;
  const service = typeof usage.service_tier === 'string' ? usage.service_tier : null;
  if (service !== null && service !== 'standard') return 'other';
  if (speed === 'fast') return 'fast';
  if (speed !== null && speed !== 'standard') return 'other';
  return speed === null && service === null ? null : 'standard';
}

const usageTotal = usage => ['fresh', 'output', 'cacheWrite', 'cacheRead'].reduce((sum, key) => sum + (count(usage[key]) ?? 0), 0);

function claude(line, context, state) {
  const session = text(line.sessionId);
  const agent = text(line.agentId);
  const sidechain = typeof line.isSidechain === 'boolean' ? line.isSidechain : state.isSubagent;
  if (session) {
    state.rawSessionId = session;
    const parent = identity(context, 'session', `claude-code:${session}`);
    state.sessionHash = sidechain ? agent ? identity(context, 'session', `claude-code:${session}:agent:${agent}`) : null : parent;
    state.parentSessionHash = sidechain ? parent : null;
    state.sidechainWithoutAgent = sidechain && !agent;
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
    debt(state, session && state.sidechainWithoutAgent ? 'sidechainWithoutAgent' : 'missingIdentity'); return { records: [], state };
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
  const tier = claudeTier(message.usage);
  // docs/accounting.md §2: one event per (conversation sessionId, message.id),
  // with the per-class maximum over EVERY line that carries it — in any file.
  // Forked subagents copy their parent's context, so the same message (the
  // same line uuids, sometimes a mid-stream snapshot) appears in several
  // subagents/agent-*.jsonl files. The marks live in a ledger the collector
  // shares across all files (`context.shared`), keyed by the conversation, not
  // by the file's own agent session, so a copy adds only what it grew by.
  const ledger = object(context.shared) ? context.shared : state;
  ledger.claudeUsage ??= {};
  const messageKey = hash(`claude-message\0${session}\0${nativeMessage}`);
  // A 0.2 cursor kept its marks per file, keyed by the file's session hash.
  const previous = ledger.claudeUsage[messageKey]
    ?? state.claudeUsage?.[hash(`claude-message\0${state.sessionHash}\0${nativeMessage}`)];
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
  highWater.lines = object(previous?.lines) ? { ...previous.lines } : {};
  ledger.claudeUsage[messageKey] = highWater;
  delta.tier = tier;
  if (!uuid) {
    // Fallback identity is response-level. Streamed revisions cannot be posted
    // as different deltas with the same first-writer-wins ID. Wait for the
    // transcript's definitive response stop and emit the whole measurement once.
    const fallbackKey = hash(recordMessage);
    ledger.claudeFallbackSent ??= {};
    ledger.claudeFallbackPending ??= {};
    if (ledger.claudeFallbackSent[fallbackKey]) {
      if (CLASSES.some(key => delta[key] > 0)) debt(state, 'changedFinalUsage');
      return { records: [], state };
    }
    // Still streaming. Not a drop yet: the collector reports a response that
    // never reaches its stop as `noFinalUsage` once it is too old to finish.
    if (!text(message.stop_reason)) { ledger.claudeFallbackPending[fallbackKey] = highWater.firstAt; return { records: [], state }; }
    const records = record('claude-code', context, state, line.timestamp, { ...highWater, tier }, recordMessage, false, highWater.firstAt);
    if (records.length) {
      ledger.claudeFallbackSent[fallbackKey] = highWater.firstAt;
      delete ledger.claudeFallbackPending[fallbackKey];
      records[0].continuation = counted;
    }
    highWater.counted = counted || records.length > 0;
    return { records, state };
  }
  // The same transcript rewriting a line with LOWER usage cannot un-count what
  // was reported, and is surfaced as coverage debt (§3.1); a lower copy in
  // another file is only a snapshot. A rewrite that carries no usage at all
  // (Claude Code writes such copies of counted lines) takes nothing away.
  const lineKey = hash(`claude-line\0${uuid}`).slice(0, 16);
  const lineTotal = usageTotal(usage);
  const file = typeof context.fileTag === 'string' ? context.fileTag : typeof context.sourceId === 'string' ? context.sourceId : '';
  const tag = hash(`claude-file\0${file}`).slice(0, 8);
  const known = highWater.lines[lineKey];
  const seenLine = Array.isArray(known) ? count(known[0]) : count(known);
  const seenIn = Array.isArray(known) ? known[1] : null;
  if (seenLine !== null && lineTotal > 0 && lineTotal < seenLine && seenIn === tag) debt(state, 'revisedDown');
  highWater.lines[lineKey] = [Math.max(seenLine ?? 0, lineTotal), seenLine !== null && seenIn !== null ? seenIn : tag];
  const grown = CLASSES.some(key => delta[key] > 0);
  // A message first counted by this version is sent as its running maximum
  // under one message-level id. What each reader sends then no longer
  // depends on the order it read the lines and the forks' mid-stream copies
  // in, and the receiver keeps the largest (§2, §8). A message a 0.2 cursor
  // already counted line by line keeps that form, so nothing is sent twice.
  if (!(counted && previous?.cumulative !== true)) {
    highWater.cumulative = true;
    highWater.counted = counted;
    if (counted && !grown) return { records: [], state };
    const running = { tier };
    for (const key of CLASSES) running[key] = highWater[key] ?? null;
    const records = record('claude-code', context, state, line.timestamp, running, `message:${nativeMessage}`, false, highWater.firstAt);
    if (records.length) { records[0].continuation = counted; records[0].cumulative = true; }
    highWater.counted = counted || records.length > 0;
    return { records, state };
  }
  const lineMessage = seenLine !== null && grown ? `${uuid}:revised:${CLASSES.map(key => usage[key] ?? '').join(',')}` : uuid;
  const records = record('claude-code', context, state, line.timestamp, delta, lineMessage, false, highWater.firstAt);
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
  if (line.type === 'token_usage_record') return codexResponse(line, payload, context, state);
  if (line.type !== 'event_msg' || payload.type !== 'token_count' || !object(payload.info)
      || !object(payload.info.total_token_usage)) return { records: [], state };
  const cumulative = codexUsage(payload.info.total_token_usage);
  const previous = state.codexUsage;
  const reset = previous && CODEX_CLASSES.some(key => cumulative[key] !== null && count(previous[key]) !== null
    && cumulative[key] < previous[key]);
  state.codexUsage = cumulative;
  // A rollout that writes per-response records is counted from them
  // (§4.7); its running total then only moves the baseline.
  if (state.usageRecords) return { records: [], state };
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
  // The minute, not just "seen": the collector forgets identities once they
  // are hours old (collector.js, pruneParserState), and needs their age for it.
  if (records.length) {
    state.codexEventIds[identityKey] = records[0].at;
    state.cumulativeCounted = true;
    // The response this running total counted, so a record for that same
    // response, written after it, is known to be already counted.
    state.lastCountedResponse = object(payload.info.last_token_usage) ? codexUsage(payload.info.last_token_usage) : null;
  }
  return { records, state };
}

/**
 * docs/accounting.md §4.7: a per-response `token_usage_record` is the event
 * itself — one API response, identified by its `response_id`, with its own
 * usage (not a running total). It also records calls the running total never
 * shows, such as a compaction request. A record for another thread is history
 * replayed into a fork and belongs to that thread's own rollout.
 */
function codexResponse(line, payload, context, state) {
  const thread = text(payload.thread_id);
  const response = text(payload.response_id);
  if (!object(payload.usage) || !response || !thread) { debt(state, 'missingIdentity'); return { records: [], state }; }
  if (!state.rawSessionId || thread !== state.rawSessionId) return { records: [], state };
  const usage = codexUsage(payload.usage);
  // A thread counted from running totals so far (it began before Codex wrote
  // records, and was resumed by one that does) switches to records at its
  // first own record, which is written before its own running total. Only a
  // record for the response the last counted running total already covered
  // would count it twice: that one is late, and is not counted.
  if (state.cumulativeCounted && !state.usageRecords) {
    const last = state.lastCountedResponse;
    if (object(last) && CODEX_CLASSES.every(key => (last[key] ?? null) === usage[key])) { debt(state, 'lateUsageRecord'); return { records: [], state }; }
  }
  state.usageRecords = true;
  const messageId = `response:${response}`;
  state.codexEventIds ??= {};
  const identityKey = hash(messageId);
  if (state.codexEventIds[identityKey]) return { records: [], state };
  const fresh = usage.input !== null && usage.cacheRead !== null && usage.cacheWrite !== null
    && usage.cacheRead + usage.cacheWrite <= usage.input ? usage.input - usage.cacheRead - usage.cacheWrite : null;
  const records = record('codex', context, state, line.timestamp, {
    fresh, output: usage.output, cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead,
    cacheWrite5m: null, cacheWrite1h: null,
  }, messageId, usage.input !== null && usage.input > 0);
  if (records.length) state.codexEventIds[identityKey] = records[0].at;
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
  // Most transcript bytes are prompts, replies and tool output, which no
  // record reads. A line that cannot change a record is not parsed at all:
  // Codex reads only session_meta, turn_context and token_count lines, and a
  // Claude Code line matters only if it carries usage (every Claude Code line
  // repeats its session, folder and sidechain fields, so the usage line sets
  // them itself) or an execution origin, which only some lines carry.
  if (typeof line === 'string' && (canonical === 'codex' ? !CODEX_LINES.test(line)
    : !line.includes('"usage"') && !line.includes('xecution'))) return { records: [], state };
  let value;
  try { value = JSON.parse(line); } catch {
    // A complete line that looked like usage and cannot be read is a drop,
    // counted so the console can say so (§3.2).
    if (typeof line === 'string' && (canonical === 'codex' ? /token_count|token_usage_record/.test(line) : line.includes('"assistant"'))) {
      const next = startingState(canonical, context, state);
      debt(next, 'unreadableLine');
      return { records: [], state: next };
    }
    return { records: [], state };
  }
  if (!object(value)) return { records: [], state };
  const next = startingState(canonical, context, state);
  const result = canonical === 'claude-code' ? claude(value, context, next) : codex(value, context, next);
  // A local observer may react to newly tailed lines. It sees the same
  // accounting deltas and salted identity as the collector; no second token
  // parser or report field is introduced.
  if (typeof context.onParsedLine === 'function') context.onParsedLine(value, result);
  return result;
}

/** The balanced JSON object that starts at `start` (a `{`), or null. Strings are skipped. */
function objectAt(value, start) {
  let depth = 0, inString = false;
  for (let index = start; index < value.length; index++) {
    const character = value[index];
    if (inString) {
      if (character === '\\') index++;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return value.slice(start, index + 1);
  }
  return null;
}

/** The last `"key":"string"` (or `"key":true|false|null`) in a fragment, decoded; undefined when absent. */
function lastField(fragment, key) {
  const pattern = new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*"|true|false|null)`, 'g');
  let found;
  for (const match of fragment.matchAll(pattern)) found = match[1];
  if (found === undefined) return undefined;
  try { return JSON.parse(found); } catch { return undefined; }
}

/**
 * A Claude Code line too long to hold (a huge tool input or file) still ends
 * with its usage. Given the line's first and last bytes, this rebuilds the
 * few fields accounting reads — the session, the message id and model, the
 * usage, the line uuid, request id and time — from the parts outside the
 * message content, and returns them as one small JSON line. It returns null
 * whenever any of them cannot be found where Claude Code writes it; the caller
 * then reports the line as coverage debt (`oversizedLine`), never a guess.
 */
export function salvageClaudeLine(head, tail) {
  if (typeof head !== 'string' || typeof tail !== 'string') return null;
  const messageAt = head.indexOf('"message":{');
  const usageAt = tail.lastIndexOf('"usage":{');
  if (messageAt < 0 || usageAt < 0) return null;
  const usageText = objectAt(tail, usageAt + '"usage":'.length);
  if (!usageText) return null;
  let usage;
  try { usage = JSON.parse(usageText); } catch { return null; }
  const top = head.slice(0, messageAt);
  const contentAt = head.indexOf('"content":', messageAt);
  const messageHead = head.slice(messageAt, contentAt < 0 ? head.length : contentAt);
  const after = tail.slice(usageAt + '"usage":'.length + usageText.length);
  const beforeUsage = tail.slice(0, usageAt);
  const line = {
    type: lastField(after, 'type') ?? lastField(top, 'type'),
    uuid: lastField(after, 'uuid') ?? lastField(top, 'uuid'),
    timestamp: lastField(after, 'timestamp') ?? lastField(top, 'timestamp'),
    requestId: lastField(after, 'requestId') ?? lastField(top, 'requestId'),
    sessionId: lastField(top, 'sessionId') ?? lastField(after, 'sessionId'),
    cwd: lastField(top, 'cwd') ?? lastField(after, 'cwd'),
    isSidechain: lastField(top, 'isSidechain') ?? lastField(after, 'isSidechain'),
    agentId: lastField(top, 'agentId') ?? lastField(after, 'agentId'),
    message: {
      id: lastField(messageHead, 'id'),
      model: lastField(messageHead, 'model'),
      stop_reason: lastField(beforeUsage, 'stop_reason') ?? null,
      usage,
    },
  };
  if (line.type !== 'assistant' || typeof line.message.id !== 'string' || typeof line.message.model !== 'string'
    || typeof line.sessionId !== 'string' || typeof line.timestamp !== 'string') return null;
  for (const key of Object.keys(line)) if (line[key] === undefined || line[key] === null) delete line[key];
  return JSON.stringify(line);
}

/** Counts one line that could not be counted, in the state a later parseLine keeps. */
export function countDebt(tool, context, state, reason) {
  const canonical = tool === 'claude' ? 'claude-code' : tool;
  const next = startingState(canonical, context, state);
  debt(next, reason);
  return next;
}
