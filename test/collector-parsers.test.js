import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseLine } from '../lib/collector/parsers.js';

const hashIdentity = (kind, value) => createHmac('sha256', 'synthetic-local-test-salt').update(`${kind}\0${value}`).digest('hex');
const recordId = (tool, sessionId, messageId) => createHmac('sha256', 'synthetic-org-salt').update(`${tool}|${sessionId}|${messageId}`).digest('hex');
const context = { recordId, reportingDevice: 'synthetic-device-a', sourceId: 'opaque-synthetic-source', offset: 0, hashIdentity,
  projectHash: hashIdentity('project', '/synthetic/project') };
const stamp = '2026-09-20T12:34:56.789Z';
const assistant = (usage, extra = {}) => ({ type: 'assistant', timestamp: stamp, sessionId: 'synthetic-session',
  cwd: '/synthetic/project', isSidechain: false, uuid: `synthetic-line-${usage.output_tokens}`, requestId: 'synthetic-request',
  message: { id: 'synthetic-message', model: 'claude-opus-4-8', usage }, ...extra });
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 };
const tokens = (total, extra = {}) => ({ type: 'event_msg', timestamp: stamp,
  payload: { type: 'token_count', info: { total_token_usage: total } }, ...extra });
const counters = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60, cache_write_input_tokens: 10,
  reasoning_output_tokens: 5, total_tokens: 120 };
const call = (tool, line, state, offset = 0) => {
  if (tool === 'codex' && line.type === 'event_msg') {
    if (!state) state = parseLine('codex', JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-codex-session' } }), context).state;
    line = { ordinal: offset + 1, ...line };
  }
  return parseLine(tool, JSON.stringify(line), { ...context, offset }, state);
};

test('Claude classes are disjoint, timestamp is minute precision, and intrinsic ids are independent of offsets', () => {
  const first = call('claude-code', assistant(usage));
  const row = first.records[0];
  assert.equal(row.fresh, 10);
  assert.equal(row.output, 5);
  assert.equal(row.cacheWrite, 20);
  assert.equal(row.cacheRead, 30);
  assert.equal(row.at, '2026-09-20T12:34:00.000Z');
  assert.equal(row.observed, true);
  assert.equal(row.id, call('claude-code', assistant(usage)).records[0].id);
  assert.equal(row.id, call('claude-code', assistant(usage), {}, 123).records[0].id);
  assert.notEqual(row.id, call('claude-code', assistant(usage, { uuid: 'another-line' })).records[0].id);
});

test('Claude repeated content blocks and growing outputs emit only high-water deltas', () => {
  const first = call('claude-code', assistant(usage));
  const duplicate = call('claude-code', assistant(usage), first.state, 100);
  assert.deepEqual(duplicate.records, []);
  const grown = call('claude-code', assistant({ ...usage, output_tokens: 12 }), duplicate.state, 200);
  assert.deepEqual(Object.fromEntries(['fresh', 'output', 'cacheWrite', 'cacheRead'].map(k => [k, grown.records[0][k]])),
    { fresh: 0, output: 7, cacheWrite: 0, cacheRead: 0 });
  const regressed = call('claude-code', assistant({ ...usage, output_tokens: 1 }), grown.state, 300);
  assert.deepEqual(regressed.records, []);
  const restored = call('claude-code', assistant({ ...usage, output_tokens: 12 }), regressed.state, 400);
  assert.deepEqual(restored.records, []);
  const independent = assistant(usage);
  independent.message.id = 'another-synthetic-message';
  assert.equal(call('claude-code', independent, restored.state, 500).records[0].fresh, 10);
});

test('Claude subagents share a parent session but have distinct child identities; parentUuid is ignored', () => {
  const parent = call('claude-code', assistant(usage)).records[0];
  const child = call('claude-code', assistant(usage, { isSidechain: true, agentId: 'child-one', parentUuid: 'not-a-session' })).records[0];
  const sibling = call('claude-code', assistant(usage, { isSidechain: true, agentId: 'child-two' })).records[0];
  assert.equal(child.isSubagent, true);
  assert.equal(child.parentSessionHash, parent.sessionHash);
  assert.notEqual(child.sessionHash, parent.sessionHash);
  assert.notEqual(child.sessionHash, sibling.sessionHash);
  assert.equal(parent.parentSessionHash, null);
});

test('metadata lines establish Codex model/project and child thread identity without emitting usage', () => {
  const meta = call('codex', { type: 'session_meta', payload: { id: 'child-thread', session_id: 'parent-thread',
    cwd: '/synthetic/child', parent_thread_id: 'parent-thread', source: { subagent: { thread_spawn: { parent_thread_id: 'fallback' } } } } });
  assert.deepEqual(meta.records, []);
  assert.equal(meta.state.sessionHash, hashIdentity('session', 'codex:child-thread'));
  assert.equal(meta.state.parentSessionHash, hashIdentity('session', 'codex:parent-thread'));
  assert.equal(meta.state.projectHash, hashIdentity('project', '/synthetic/child'));
  assert.equal(meta.state.isSubagent, true);
  const turn = call('codex', { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }, meta.state);
  assert.equal(turn.state.model, 'gpt-5.6-sol');
  assert.deepEqual(turn.records, []);
});

test('Codex cumulative deltas deduplicate repeated totals and exclude reasoning from extra output', () => {
  const first = call('codex', tokens(counters));
  assert.deepEqual(Object.fromEntries(['fresh', 'output', 'cacheWrite', 'cacheRead'].map(k => [k, first.records[0][k]])),
    { fresh: 30, output: 20, cacheWrite: 10, cacheRead: 60 });
  const repeated = call('codex', tokens(counters), first.state, 100);
  assert.deepEqual(repeated.records, []);
  const grown = call('codex', tokens({ ...counters, input_tokens: 150, cached_input_tokens: 90, cache_write_input_tokens: 15,
    output_tokens: 28, reasoning_output_tokens: 7 }), repeated.state, 200);
  assert.deepEqual(Object.fromEntries(['fresh', 'output', 'cacheWrite', 'cacheRead'].map(k => [k, grown.records[0][k]])),
    { fresh: 15, output: 8, cacheWrite: 5, cacheRead: 30 });
});

test('inherited Codex counters and resets establish baselines instead of billing parent history again', () => {
  const meta = call('codex', { type: 'session_meta', payload: { id: 'child', parent_thread_id: 'parent', forked_from_id: 'parent', subagent_history_start_ordinal: 150 } });
  const inherited = call('codex', tokens(counters), meta.state, 100);
  assert.deepEqual(inherited.records, []);
  assert.equal(inherited.state.skippedBaselines, 1);
  const grown = call('codex', tokens({ ...counters, input_tokens: 110, output_tokens: 23 }), inherited.state, 200);
  assert.equal(grown.records[0].fresh, 10);
  assert.equal(grown.records[0].output, 3);
  const reset = call('codex', tokens({ input_tokens: 8, output_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0 }), grown.state, 300);
  assert.deepEqual(reset.records, []);
  assert.equal(reset.state.skippedBaselines, 2);
  const fork = call('codex', { type: 'session_meta', payload: { id: 'fork', forked_from_id: 'source', source: 'cli' } });
  assert.equal(fork.state.isSubagent, false);
  assert.equal(fork.state.parentSessionHash, null);
  assert.deepEqual(call('codex', tokens(counters), fork.state).records, []);
});

test('missing classes stay null; unsafe numbers and impossible cache counts are never fresh zero', () => {
  const absent = call('codex', tokens({ input_tokens: 100, output_tokens: 3, cached_input_tokens: 60 })).records[0];
  assert.equal(absent.cacheWrite, null);
  assert.equal(absent.fresh, null);
  const bad = call('claude-code', assistant({ input_tokens: -1, output_tokens: 3, cache_creation_input_tokens: 1.5,
    cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1 })).records[0];
  assert.equal(bad.fresh, null);
  assert.equal(bad.cacheWrite, null);
  assert.equal(bad.cacheRead, null);
  const impossible = call('codex', tokens({ ...counters, input_tokens: 5 })).records[0];
  assert.equal(impossible.fresh, null);
});

test('Codex input-only consumption with an unreported cache class is preserved as unknown, then deduplicated', () => {
  const inputOnly = tokens({ input_tokens: 40, output_tokens: 0, cached_input_tokens: 0 });
  const first = call('codex', inputOnly);
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].fresh, null);
  assert.equal(first.records[0].cacheWrite, null);
  assert.equal(first.records[0].cacheRead, 0);
  assert.equal(first.records[0].output, 0);
  assert.equal(first.records[0].observed, true);
  assert.deepEqual(call('codex', inputOnly, first.state, 100).records, []);
});

test('unknown lines are ignored; malformed timestamps never get assigned a made-up minute', () => {
  for (const line of ['', '{', 'null', '[]', '{"type":"unexpected"}']) {
    assert.deepEqual(parseLine('codex', line, context).records, []);
  }
  assert.deepEqual(call('claude-code', assistant(usage, { timestamp: 'SENTINEL_TIME' })).records, []);
  assert.deepEqual(parseLine('unrecognized', '{}', context).records, []);
  const msg = assistant(usage);
  delete msg.message.model;
  assert.equal(call('claude-code', msg).records[0].model, 'unknown');
});

test('redaction: records contain no raw identifiers; private state contains no prompt, reply, command, path or branch', () => {
  const sentinel = 'SENTINEL_PRIVATE_DATA';
  const input = assistant(usage, { cwd: `/private/${sentinel}/project`, sessionId: `${sentinel}-session`,
    parentUuid: `${sentinel}-parent-message`, gitBranch: `${sentinel}-branch`,
    message: { id: `${sentinel}-message`, model: 'claude-opus-4-8', usage,
      content: [{ type: 'text', text: `${sentinel} prompt and reply` },
        { type: 'tool_use', input: { command: `cat /private/${sentinel}/file` } }] } });
  const result = call('claude-code', input);
  assert.equal(result.records.length, 1);
  assert.doesNotMatch(JSON.stringify(result.records), /SENTINEL_PRIVATE_DATA|\/private\/|prompt and reply|cat /);
  assert.doesNotMatch(JSON.stringify(result.state), /\/private\/|prompt and reply|cat |SENTINEL_PRIVATE_DATA-branch/);
  const meta = call('codex', { type: 'session_meta', payload: { id: `${sentinel}-child`,
    parent_thread_id: `${sentinel}-parent`, cwd: `/private/${sentinel}/project`,
    base_instructions: `${sentinel} prompt`, git: { branch: `${sentinel}-branch` } } });
  const turn = call('codex', { type: 'turn_context', payload: { model: 'gpt-5.6-sol', cwd: `/private/${sentinel}/project`,
    summary: `${sentinel} response and command` } }, meta.state);
  const baseline = call('codex', tokens(counters), turn.state);
  const updated = call('codex', tokens({ ...counters, output_tokens: 25 }), baseline.state, 10);
  assert.equal(updated.records.length, 1);
  assert.doesNotMatch(JSON.stringify(updated.records), /SENTINEL_PRIVATE_DATA|\/private\/|response and command/);
  assert.doesNotMatch(JSON.stringify(updated.state), /\/private\/|response and command/);
  assert.deepEqual(Object.keys(updated.records[0]).sort(), ['id','tool','model','sessionHash','parentSessionHash',
    'isSubagent','projectHash','reportingDevice','executionOrigin','at','fresh','output','cacheWrite','cacheRead','cacheWrite5m','cacheWrite1h','ttl','observed','measurement','continuation','tier'].sort());
});

test('copied transcripts have portable organization IDs and unchanged consumption on another reporting device', () => {
  const transcript = [
    assistant({ ...usage, cache_creation: { ephemeral_5m_input_tokens: 12, ephemeral_1h_input_tokens: 8 } }),
    assistant({ ...usage, output_tokens: 11, cache_creation: { ephemeral_5m_input_tokens: 12, ephemeral_1h_input_tokens: 8 } }),
    // The subagent's own response: its own message id (a copy of the parent's
    // message would carry the parent's id and count once, docs/accounting.md §2).
    { ...assistant(usage, { isSidechain: true, agentId: 'child-one', uuid: 'child-line' }),
      message: { id: 'synthetic-child-message', model: 'claude-opus-4-8', usage } },
  ];
  const collect = device => {
    let state;
    return transcript.flatMap((line, index) => {
      const next = parseLine('claude-code', JSON.stringify(line), { ...context,
        sourceId: `different-local-source-${device}`, offset: device === 'a' ? index * 100 : index * 700,
        reportingDevice: device }, state);
      state = next.state;
      return next.records;
    });
  };
  const a = collect('a');
  const b = collect('b');
  assert.equal(a.length, 3);
  assert.equal(a[0].id, recordId('claude-code', 'synthetic-session', transcript[0].uuid));
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual({ ...a[i], reportingDevice: undefined }, { ...b[i], reportingDevice: undefined });
    assert.notEqual(a[i].reportingDevice, b[i].reportingDevice);
    assert.equal(a[i].executionOrigin, 'unknown');
  }
  const accepted = new Map(a.map(row => [row.id, row]));
  const before = JSON.stringify([...accepted.values()]);
  let duplicates = 0;
  for (const row of b) if (accepted.has(row.id)) duplicates++; else accepted.set(row.id, row);
  assert.equal(duplicates, 3);
  assert.equal(JSON.stringify([...accepted.values()]), before);
});

test('Claude response-level fallback waits for definitive final usage and never emits conflicting revisions', () => {
  const partial = assistant({ ...usage, output_tokens: 1 }, { uuid: undefined });
  const waiting = call('claude-code', partial);
  assert.deepEqual(waiting.records, []);
  const complete = assistant({ ...usage, output_tokens: 12 }, { uuid: undefined });
  complete.message.stop_reason = 'end_turn';
  const final = call('claude-code', complete, waiting.state);
  assert.equal(final.records.length, 1);
  assert.equal(final.records[0].fresh, 10);
  assert.equal(final.records[0].output, 12);
  assert.equal(final.records[0].id, recordId('claude-code', 'synthetic-session', 'synthetic-message:synthetic-request'));
  assert.deepEqual(call('claude-code', complete, final.state).records, []);
  const later = structuredClone(complete);
  later.message.usage.output_tokens = 13;
  const conflict = call('claude-code', later, final.state);
  assert.deepEqual(conflict.records, []);
  assert.equal(conflict.state.coverageDebt.changedFinalUsage, 1);
});

test('missing intrinsic session or event identity is coverage debt, with no path or offset fallback', () => {
  const missingSession = call('claude-code', assistant(usage, { sessionId: undefined }));
  assert.deepEqual(missingSession.records, []);
  assert.equal(missingSession.state.coverageDebt.missingIdentity, 1);
  const missingUuidAndRequest = call('claude-code', assistant(usage, { uuid: undefined, requestId: undefined }));
  assert.deepEqual(missingUuidAndRequest.records, []);
  const missingCodexMeta = parseLine('codex', JSON.stringify({ ...tokens(counters), ordinal: 1 }), context);
  assert.deepEqual(missingCodexMeta.records, []);
  assert.equal(missingCodexMeta.state.coverageDebt.missingIdentity, 1);
});

test('TTL splits retain their own high-water deltas and explicit origin is separate from reporting device', () => {
  const splitUsage = { ...usage, cache_creation: { ephemeral_5m_input_tokens: 12, ephemeral_1h_input_tokens: 8 } };
  const first = call('claude-code', assistant(splitUsage, { execution_origin: 'synthetic-origin-device' }));
  assert.equal(first.records[0].ttl, 'split');
  assert.equal(first.records[0].cacheWrite5m, 12);
  assert.equal(first.records[0].cacheWrite1h, 8);
  assert.equal(first.records[0].executionOrigin, hashIdentity('execution-origin', 'synthetic-origin-device'));
  assert.notEqual(first.records[0].executionOrigin, first.records[0].reportingDevice);
  const grown = call('claude-code', assistant({ ...splitUsage, output_tokens: 6, cache_creation_input_tokens: 25,
    cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 10 } }), first.state);
  assert.equal(grown.records[0].ttl, 'split');
  assert.equal(grown.records[0].cacheWrite, 5);
  assert.equal(grown.records[0].cacheWrite5m, 3);
  assert.equal(grown.records[0].cacheWrite1h, 2);
  const totalOnly = call('claude-code', assistant(usage)).records[0];
  assert.equal(totalOnly.ttl, 'unknown');
  assert.equal(totalOnly.cacheWrite5m, null);
  assert.equal(totalOnly.cacheWrite1h, null);
  const inconsistent = call('claude-code', assistant({ ...splitUsage,
    cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 50 } }));
  assert.equal(inconsistent.records[0].ttl, 'unknown');
  assert.equal(inconsistent.records[0].cacheWrite5m, null);
  assert.equal(inconsistent.state.coverageDebt.ttlConflict, 1);
});

test('Codex exact replay boundary excludes every inherited event and pins first metadata identity', () => {
  let state = call('codex', { type: 'session_meta', ordinal: 0, payload: { id: 'child', parent_thread_id: 'parent',
    forked_from_id: 'parent', subagent_history_start_ordinal: 100 } }).state;
  for (const ordinal of [2, 5, 20, 98]) {
    const next = call('codex', tokens({ ...counters, input_tokens: 1000 + ordinal }, { ordinal }), state);
    assert.deepEqual(next.records, []);
    state = next.state;
  }
  state = call('codex', { type: 'session_meta', ordinal: 50, payload: { id: 'ancestor' } }, state).state;
  assert.equal(state.rawSessionId, 'child');
  const own = call('codex', tokens({ ...counters, input_tokens: 1140, output_tokens: 30 }, { ordinal: 101 }), state);
  assert.equal(own.records.length, 1);
  assert.equal(own.records[0].fresh, 42);
  assert.equal(own.records[0].output, 10);
  assert.equal(own.records[0].id, recordId('codex', 'child', 'ordinal:101'));
  assert.equal(own.records[0].parentSessionHash, hashIdentity('session', 'codex:parent'));
});

test('fresh Codex subagents retain first own usage; unknown inherited boundaries stay unmeasured', () => {
  const fresh = call('codex', { type: 'session_meta', payload: { id: 'fresh-child', parent_thread_id: 'parent',
    subagent_history_start_ordinal: 3 } });
  const firstOwn = call('codex', tokens(counters, { ordinal: 4 }), fresh.state);
  assert.equal(firstOwn.records[0].fresh, 30);
  assert.equal(firstOwn.records[0].output, 20);
  const oldFork = call('codex', { type: 'session_meta', payload: { id: 'old-fork', forked_from_id: 'parent' } });
  const unknown = call('codex', tokens(counters), oldFork.state);
  assert.deepEqual(unknown.records, []);
  assert.equal(unknown.state.coverageDebt.unboundedReplay, 1);
});

test('Codex timestamp fallback is intrinsic and changing usage at the same unsequenced instant is refused', () => {
  const initial = call('codex', { type: 'session_meta', payload: { id: 'timestamp-session' } }).state;
  const first = parseLine('codex', JSON.stringify(tokens(counters)), context, initial);
  assert.equal(first.records[0].id, recordId('codex', 'timestamp-session', `timestamp:${stamp}`));
  const changed = parseLine('codex', JSON.stringify(tokens({ ...counters, output_tokens: 21 })), context, first.state);
  assert.deepEqual(changed.records, []);
  assert.equal(changed.state.coverageDebt.ambiguousEventIdentity, 1);
});

test('a streamed Claude response is dated by its first line, even when later lines cross a minute or window edge', () => {
  const at = (timestamp, output) => assistant({ ...usage, output_tokens: output }, { timestamp, uuid: `line-${output}` });
  const first = call('claude-code', at('2026-09-19T23:59:30.000Z', 3));
  const later = call('claude-code', at('2026-09-20T00:00:20.000Z', 250), first.state);
  assert.equal(first.records[0].at, '2026-09-19T23:59:00.000Z');
  assert.equal(later.records[0].at, '2026-09-19T23:59:00.000Z', 'the increment moved to the minute its line was written');
  assert.equal(later.records[0].output, 247);
  assert.equal(later.records[0].continuation, true);
});

test('a Codex counter that restarts from zero counts the restarting request; an unexplained drop stays unmeasured', () => {
  const withLast = (total, last) => ({ type: 'event_msg', timestamp: stamp, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
  const first = call('codex', withLast(counters, counters));
  const restart = { input_tokens: 600, output_tokens: 40, cached_input_tokens: 400, cache_write_input_tokens: 0 };
  const restarted = call('codex', withLast(restart, restart), first.state, 100);
  assert.deepEqual(['fresh', 'output', 'cacheRead', 'cacheWrite'].map(k => restarted.records[0][k]), [200, 40, 400, 0]);
  assert.equal(restarted.state.coverageDebt?.counterReset, undefined);
  const rollback = call('codex', withLast({ ...restart, input_tokens: 300, cached_input_tokens: 100 }, { input_tokens: 50, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0 }), restarted.state, 200);
  assert.deepEqual(rollback.records, []);
  assert.equal(rollback.state.coverageDebt.counterReset, 1);
});

test("a forked Codex child's first own request is counted although its counter starts below the inherited one", () => {
  const withLast = (total, last = total) => ({ type: 'event_msg', timestamp: stamp, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
  const meta = call('codex', { type: 'session_meta', payload: { id: 'child', parent_thread_id: 'parent', forked_from_id: 'parent', subagent_history_start_ordinal: 150 } });
  const inherited = call('codex', withLast({ input_tokens: 2500, output_tokens: 130, cached_input_tokens: 1000, cache_write_input_tokens: 300 }), meta.state, 100);
  assert.deepEqual(inherited.records, []);
  const own = { input_tokens: 900, output_tokens: 70, cached_input_tokens: 0, cache_write_input_tokens: 300 };
  const first = call('codex', withLast(own), inherited.state, 200);
  assert.deepEqual(['fresh', 'output', 'cacheRead', 'cacheWrite'].map(k => first.records[0][k]), [600, 70, 0, 300]);
});

test('A1: a message copied into forked subagent files counts once, whatever order the files are read in', () => {
  // One parent response streamed over three lines; three forks hold copies:
  // a mid-stream snapshot of line 2, lines 1-2, and line 3 alone.
  const u = (output) => ({ input_tokens: 4, output_tokens: output, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 });
  const line = (n, output, extra = {}) => assistant(u(output), { uuid: `parent-line-${n}`, ...extra });
  const fork = (agentId) => ({ isSidechain: true, agentId });
  const files = {
    parent: [line(1, 2), line(2, 150), line(3, 399)],
    f1: [line(2, 60, fork('f1'))],
    f2: [line(1, 2, fork('f2')), line(2, 150, fork('f2'))],
    f3: [line(3, 399, fork('f3'))],
  };
  const read = (order) => {
    const shared = {};
    const accepted = new Map();
    for (const name of order) {
      let state;
      for (const row of files[name]) {
        const next = parseLine('claude-code', JSON.stringify(row), { ...context, shared }, state);
        state = next.state;
        for (const record of next.records) if (!accepted.has(record.id)) accepted.set(record.id, record);
      }
    }
    const rows = [...accepted.values()];
    const sum = (key) => rows.reduce((a, r) => a + r[key], 0);
    return { fresh: sum('fresh'), output: sum('output'), cacheWrite: sum('cacheWrite'), cacheRead: sum('cacheRead'),
      messages: rows.filter((r) => !r.continuation).length };
  };
  const truth = { fresh: 4, output: 399, cacheWrite: 100, cacheRead: 1000, messages: 1 };
  for (const order of [['parent', 'f1', 'f2', 'f3'], ['f1', 'f2', 'f3', 'parent'], ['f3', 'f1', 'parent', 'f2'], ['f2', 'f1', 'f3', 'parent']]) {
    assert.deepEqual(read(order), truth, order.join(' → '));
  }
});

test('A4: a line rewritten with lower usage is counted as coverage debt, never subtracted or silently kept', () => {
  const first = call('claude-code', assistant({ ...usage, output_tokens: 40 }, { uuid: 'rewritten' }));
  const lower = call('claude-code', assistant({ ...usage, output_tokens: 30 }, { uuid: 'rewritten' }), first.state);
  assert.deepEqual(lower.records, []);
  assert.equal(lower.state.coverageDebt.revisedDown, 1);
  const higher = call('claude-code', assistant({ ...usage, output_tokens: 55 }, { uuid: 'rewritten' }), lower.state);
  assert.equal(higher.records.length, 1);
  assert.equal(higher.records[0].output, 15);
  assert.notEqual(higher.records[0].id, first.records[0].id, 'growth on a known line is a new increment the hub will not drop');
});

test('A4: Bedrock and Vertex model ids are kept exactly, not turned into unknown', () => {
  for (const model of ['us.anthropic.claude-opus-4-6-v1:0', 'claude-opus-4-6@20250805', 'claude-opus-4-6[1m]']) {
    const row = call('claude-code', { ...assistant(usage), message: { id: 'm-' + model, model, usage } }).records[0];
    assert.equal(row.model, model);
  }
});

test('F5: fast mode and other service tiers are carried on the record', () => {
  const tierOf = (extra) => call('claude-code', { ...assistant(usage), message: { id: 'tier-' + JSON.stringify(extra), model: 'claude-opus-5-5', usage: { ...usage, ...extra } } }).records[0].tier;
  assert.equal(tierOf({ speed: 'fast', service_tier: 'standard' }), 'fast');
  assert.equal(tierOf({ speed: 'standard', service_tier: 'standard' }), 'standard');
  assert.equal(tierOf({ service_tier: 'priority' }), 'other');
  assert.equal(tierOf({}), null);
});

test('A3: Codex per-response records are the events; replayed and repeated records add nothing', () => {
  const meta = parseLine('codex', JSON.stringify({ type: 'session_meta', payload: { id: 'own-thread' } }), context).state;
  const response = (id, thread, input, output, extra = {}) => ({ type: 'token_usage_record', timestamp: stamp, ...extra,
    payload: { thread_id: thread, response_id: id, usage: { input_tokens: input, cached_input_tokens: 10, cache_write_input_tokens: 5, output_tokens: output } } });
  let state = meta;
  const out = [];
  for (const row of [response('r-parent', 'parent-thread', 900, 90), response('r1', 'own-thread', 100, 20), tokens({ ...counters, input_tokens: 100, output_tokens: 20 }, { ordinal: 3 }),
    response('r-compact', 'own-thread', 400, 30), response('r1', 'own-thread', 100, 20)]) {
    const next = parseLine('codex', JSON.stringify(row), context, state);
    state = next.state;
    out.push(...next.records);
  }
  assert.deepEqual(out.map((r) => [r.fresh, r.cacheRead, r.cacheWrite, r.output]), [[85, 10, 5, 20], [385, 10, 5, 30]]);
});
