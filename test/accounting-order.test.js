/**
 * Accounting checks from the 0.3.0 release candidate's review. Each test
 * states the invariant from docs/accounting.md it holds the code to. Synthetic
 * data only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runOnce } from "../lib/collector/collector.js";
import { createStore } from "../lib/hub/store.js";
import { createRegistry } from "../lib/hub/registry.js";
import { accountingReport } from "../lib/hub/accounting.js";
import { buildConsole } from "../lib/hub/aggregate.js";
import { projectRecord } from "../lib/collector/collector.js";

const prices = JSON.parse(fs.readFileSync(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const SALT = Buffer.alloc(32, 7).toString("base64url");
const ORG = "org_verify0001";
// Live transcripts are recent: the collector forgets per-message marks six
// hours after the newest one, measured against the wall clock.
const MINUTE = 60_000;
const T0 = Math.floor(Date.now() / MINUTE) * MINUTE - 10 * MINUTE;
const W1 = T0 + 60 * MINUTE, W0 = W1 - 24 * 60 * MINUTE;

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-verify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function enrol(dir, id) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "enrollment.json"), JSON.stringify({ v: 1, orgSalt: SALT, organizationId: ORG, device: { id, label: id } }), { mode: 0o600 });
  return dir;
}
async function pass(stateDir, roots) {
  let sent = [];
  const result = await runOnce({ directory: stateDir, roots, sinkName: "verify", now: new Date(W1),
    deliver: async (_d, records) => { sent = sent.concat(records.map((r) => JSON.parse(JSON.stringify(r)))); return { accepted: records.length, duplicate: 0, rejected: [] }; } });
  return { records: sent, coverage: result.coverage.coverageDebt };
}
function hub(deliveries) {
  const store = createStore({ dir: null, retentionMs: 30 * 86_400_000, prices, now: () => W1 - 1 });
  const registry = createRegistry({ dir: null, now: () => W1 - 1 });
  const ids = new Set(deliveries.map((d) => d.deviceId));
  for (const id of ids) registry.addSynthetic({ id, label: id, person: "Person A", createdAt: W0 });
  for (const d of deliveries) store.ingest(d.deviceId, d.records);
  return accountingReport({ store, registry, from: W0, to: W1, prices }).team;
}
const at = (s) => new Date(T0 + s * 1000).toISOString();

// ---------------------------------------------------------------------------
// §2 / §3.1 / §8: a forked subagent's mid-stream snapshot, read by two machines.
// ---------------------------------------------------------------------------
const SESSION = "c0000010-0000-4000-8000-00000000abcd";
const USAGE = (output) => ({ input_tokens: 4, cache_creation_input_tokens: 1000, cache_read_input_tokens: 3000, output_tokens: output,
  service_tier: "standard", speed: "standard", cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } });
const line = (uuid, seconds, output, extra = {}) => ({ type: "assistant", uuid, sessionId: SESSION, cwd: "/synthetic/project", isSidechain: false,
  timestamp: at(seconds), message: { id: "msg_verify_1", model: "claude-opus-5-5", usage: USAGE(output), stop_reason: null }, ...extra });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function writeFork(root, { parentLines }) {
  const project = path.join(root, "-synthetic-project");
  fs.mkdirSync(path.join(project, SESSION, "subagents"), { recursive: true });
  const parent = [line("u-44", 0, 2), line("u-45", 10, 150), line("u-46", 20, 399, { message: { id: "msg_verify_1", model: "claude-opus-5-5", usage: USAGE(399), stop_reason: "tool_use" } })];
  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), jsonl(parent.slice(0, parentLines)));
  // The fork copied u-45 mid-stream (output 60), exactly the conformance suite's agent-f1 shape.
  fs.writeFileSync(path.join(project, SESSION, "subagents", "agent-f1.jsonl"),
    jsonl([line("u-45", 10, 60, { isSidechain: true, agentId: "f1" })]));
  return { project, parent };
}

test("A1/§8: a fork snapshot read by a live machine and by a synced copy is counted once, in either delivery order", async (t) => {
  const base = scratch(t);
  // Machine A reads live: its first pass lands after the fork was written and
  // before the parent's own u-45 line was flushed; the second pass sees the rest.
  const liveLogs = path.join(base, "live");
  const { project, parent } = writeFork(liveLogs, { parentLines: 1 });
  const liveState = enrol(path.join(base, "state-live"), "dev_live");
  const a1 = await pass(liveState, [{ tool: "claude-code", directory: liveLogs }]);
  fs.appendFileSync(path.join(project, `${SESSION}.jsonl`), jsonl(parent.slice(1)));
  const a2 = await pass(liveState, [{ tool: "claude-code", directory: liveLogs }]);
  // Machine B holds a synced copy of the same finished transcripts.
  const syncedLogs = path.join(base, "synced");
  writeFork(syncedLogs, { parentLines: 3 });
  const b = await pass(enrol(path.join(base, "state-synced"), "dev_synced"), [{ tool: "claude-code", directory: syncedLogs }]);

  const A = [{ deviceId: "dev_live", records: a1.records }, { deviceId: "dev_live", records: a2.records }];
  const B = [{ deviceId: "dev_synced", records: b.records }];
  // Ground truth: one message, per-class maximum over every line in every file.
  const truth = { fresh: 4, output: 399, cacheRead: 3000, cacheWrite: 1000 };
  for (const [name, order] of [["live first", [...A, ...B]], ["synced copy first", [...B, ...A]]]) {
    const team = hub(order);
    for (const [key, want] of Object.entries(truth)) assert.equal(team[key], want, `${name}: ${key}`);
    assert.equal(team.messages, 1, `${name}: messages`);
  }
});

test("§8: a machine that lost its cursor after reading a fork snapshot re-sends without losing the parent's growth", async (t) => {
  const base = scratch(t);
  const logs = path.join(base, "live");
  const { project, parent } = writeFork(logs, { parentLines: 1 });
  const a1 = await pass(enrol(path.join(base, "state-before"), "dev_live"), [{ tool: "claude-code", directory: logs }]);
  // The parent's lines are flushed; the reporter's state is lost (the
  // conformance suite's step 3) and it re-reads everything from the start.
  fs.appendFileSync(path.join(project, `${SESSION}.jsonl`), jsonl(parent.slice(1)));
  const again = await pass(enrol(path.join(base, "state-lost"), "dev_live"), [{ tool: "claude-code", directory: logs }]);
  const team = hub([{ deviceId: "dev_live", records: a1.records }, { deviceId: "dev_live", records: again.records }]);
  assert.equal(team.output, 399, "output");
  assert.equal(team.messages, 1, "messages");
});

// ---------------------------------------------------------------------------
// §2 / §3.2 / §4.7: a Codex thread that began before rollouts wrote
// per-response records and was resumed after they did (seen in real rollouts:
// `thread_settings_applied`, then a record before each running-total line).
// ---------------------------------------------------------------------------
test("A3/§3.2: records that start mid-thread are counted, compaction included, and nothing counted is reported as dropped", async (t) => {
  const base = scratch(t);
  const thread = "d0000077-0000-4000-8000-000000000077";
  const dir = path.join(base, "codex", "2026", "09", "20");
  fs.mkdirSync(dir, { recursive: true });
  const totals = (input, output) => ({ input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
  const tc = (s, ordinal, cum, last) => ({ timestamp: at(s), ordinal, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: cum, last_token_usage: last, model_context_window: 400000 } } });
  const rec = (s, ordinal, id, own, thr) => ({ timestamp: at(s), ordinal, type: "token_usage_record",
    payload: { thread_id: thread, turn_id: "turn", session_id: thread, root_turn_id: "turn", response_id: id, usage: own, turn_token_usage: own, thread_token_usage: thr } });
  const rows = [
    { timestamp: at(0), type: "session_meta", payload: { id: thread, cwd: "/synthetic/project" } },
    { timestamp: at(0), ordinal: 1, type: "turn_context", payload: { model: "gpt-5.6-sol", cwd: "/synthetic/project" } },
    // An older Codex: running totals only.
    tc(1, 2, totals(100, 10), totals(100, 10)),
    // Resumed after an upgrade: each record is written before its running total.
    { timestamp: at(60), ordinal: 3, type: "event_msg", payload: { type: "thread_settings_applied" } },
    rec(61, 4, "resp_a", totals(40, 5), totals(40, 5)),
    tc(61, 5, totals(140, 15), totals(40, 5)),
    // A compaction request: a record, and no running-total line at all.
    rec(62, 6, "resp_compact", totals(30, 3), totals(70, 8)),
    rec(63, 7, "resp_b", totals(20, 2), totals(90, 10)),
    tc(63, 8, totals(160, 17), totals(20, 2)),
  ];
  fs.writeFileSync(path.join(dir, `rollout-2026-09-20T15-00-00-${thread}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const got = await pass(enrol(path.join(base, "state"), "dev_codex"), [{ tool: "codex", directory: path.join(base, "codex") }]);
  const sum = (key) => got.records.reduce((a, r) => a + (r[key] ?? 0), 0);
  // Every response once: 110 + 45 + 33 (compaction) + 22.
  assert.equal(sum("fresh") + sum("output"), 210, "tokens");
  assert.equal(got.coverage.lateUsageRecord ?? 0, 0, "records whose usage was counted are reported as dropped");
});

test("§3.2: a record written after the running total that already counted its response is late, and counted once", async (t) => {
  const base = scratch(t);
  const thread = "d0000078-0000-4000-8000-000000000078";
  const dir = path.join(base, "codex", "2026", "09", "20");
  fs.mkdirSync(dir, { recursive: true });
  const totals = (input, output) => ({ input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
  const rows = [
    { timestamp: at(0), type: "session_meta", payload: { id: thread, cwd: "/synthetic/project" } },
    { timestamp: at(0), ordinal: 1, type: "turn_context", payload: { model: "gpt-5.6-sol", cwd: "/synthetic/project" } },
    { timestamp: at(1), ordinal: 2, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: totals(100, 10), last_token_usage: totals(100, 10) } } },
    { timestamp: at(1), ordinal: 3, type: "token_usage_record", payload: { thread_id: thread, response_id: "resp_1", usage: totals(100, 10) } },
  ];
  fs.writeFileSync(path.join(dir, `rollout-2026-09-20T15-00-00-${thread}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const got = await pass(enrol(path.join(base, "state"), "dev_codex_late"), [{ tool: "codex", directory: path.join(base, "codex") }]);
  assert.equal(got.records.reduce((a, r) => a + r.fresh + r.output, 0), 110);
  assert.equal(got.coverage.lateUsageRecord, 1);
});

// ---------------------------------------------------------------------------
// §6 / §3.2: the 30-day period from the daily rollup, with the default 8 days
// of minute retention. A reporter that was off for ten days (a closed window,
// a laptop in a bag) delivers its backlog when it comes back.
// ---------------------------------------------------------------------------
test("§6: a record inside the last 30 days that arrives after the retention edge is in the 30-day total, or reported", () => {
  const DAY = 86_400_000;
  const now = Date.parse("2026-09-24T12:00:30.000Z");
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices, now: () => now });
  store.dailySince = "2026-08-01"; // a console that has kept daily totals all month
  const registry = createRegistry({ dir: null, now: () => now });
  registry.addSynthetic({ id: "dev_laptop", label: "laptop", person: "Person A", createdAt: now - 60 * DAY });
  const h = (n) => n.repeat(64);
  const record = (atMs, id) => projectRecord({ id: h(id), tool: "claude-code", model: "claude-sonnet-5", sessionHash: h("a"), parentSessionHash: null,
    isSubagent: false, projectHash: h("b"), reportingDevice: "dev_laptop", executionOrigin: "unknown", at: new Date(atMs).toISOString(),
    fresh: 100, output: 50, cacheWrite: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ttl: "split", tier: "standard", continuation: false });
  const receipt = store.ingest("dev_laptop", [record(now - 10 * DAY, "c"), record(now - 1 * DAY, "d")]);
  const view = buildConsole({ store, registry, now, hub: { version: "verify" } });
  const month = view.windows["30d"];
  const explained = month.partial || view.coverage.dropped > 0;
  assert.ok(month.tokens.total === 300 || explained,
    `30 days shows ${month.tokens.total} of 300 tokens, partial=${month.partial}, dropped=${view.coverage.dropped}, receipt=${JSON.stringify(receipt)}`);
});

test("§6: with --retention-days below 7, the 7-day headline agrees with the days it covers, or says it is partial", () => {
  const DAY = 86_400_000;
  let now = Date.parse("2026-09-20T12:00:30.000Z");
  const store = createStore({ dir: null, retentionMs: 3 * DAY, prices, now: () => now }); // --retention-days 3 (allowed: 1-90)
  store.dailySince = "2026-08-01";
  const registry = createRegistry({ dir: null, now: () => now });
  registry.addSynthetic({ id: "dev_a", label: "a", person: "Person A", createdAt: now - 60 * DAY });
  const h = (n) => n.repeat(64);
  const record = (atMs, id) => projectRecord({ id: h(id), tool: "claude-code", model: "claude-sonnet-5", sessionHash: h("a"), parentSessionHash: null,
    isSubagent: false, projectHash: h("b"), reportingDevice: "dev_a", executionOrigin: "unknown", at: new Date(atMs).toISOString(),
    fresh: 100, output: 50, cacheWrite: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ttl: "split", tier: "standard", continuation: false });
  store.ingest("dev_a", [record(now, "c")]);           // counted live, five days before the view
  now += 5 * DAY;
  store.ingest("dev_a", [record(now - 60_000, "d")]);  // and one from a minute ago
  const view = buildConsole({ store, registry, now, hub: { version: "verify" } });
  const week = view.windows["7d"], month = view.windows["30d"];
  const lastSevenDaysOfMonth = month.tokens.total; // both records are inside the last 7 days
  assert.ok(week.tokens.total === lastSevenDaysOfMonth || week.partial === true,
    `7 days shows ${week.tokens.total}, the 30-day view has ${lastSevenDaysOfMonth} in the same 7 days; partial=${week.partial}`);
});

// ---------------------------------------------------------------------------
// §3.2: what real transcripts rewrite. On the reference machine every line
// rewritten "lower" in the last 40 days was a later copy of a counted line
// with all-zero usage, same uuid, same timestamp, thousands of lines on.
// ---------------------------------------------------------------------------
test("§3.2: a counted line rewritten later with all-zero usage is not reported as a dropped line", async (t) => {
  const base = scratch(t);
  const project = path.join(base, "claude", "-synthetic-project");
  fs.mkdirSync(project, { recursive: true });
  const counted = line("u-90", 0, 1794, { message: { id: "msg_verify_z", model: "claude-opus-5-5", usage: USAGE(1794), stop_reason: "end_turn" } });
  const zeroed = { ...counted, message: { ...counted.message, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), jsonl([counted, { type: "user", uuid: "u-91", sessionId: SESSION, timestamp: at(5) }, zeroed]));
  const got = await pass(enrol(path.join(base, "state"), "dev_z"), [{ tool: "claude-code", directory: path.join(base, "claude") }]);
  assert.equal(got.records.reduce((a, r) => a + r.output, 0), 1794, "output counted once");
  assert.equal(got.coverage.revisedDown ?? 0, 0, "reported as a line that could not be counted");
});

test("§3.2: drops cover the transcripts the collector still reads; a deleted transcript's drops go with it", async (t) => {
  const base = scratch(t);
  const project = path.join(base, "claude", "-synthetic-project");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${SESSION}.jsonl`);
  // One counted line and one usage line that is not valid JSON.
  fs.writeFileSync(file, jsonl([line("u-1", 0, 10, { message: { id: "msg_verify_d", model: "claude-opus-5-5", usage: USAGE(10), stop_reason: "end_turn" } })])
    + '{"type":"assistant","message":{"usage":{"input_tokens":1}\n');
  const state = enrol(path.join(base, "state"), "dev_d");
  const roots = [{ tool: "claude-code", directory: path.join(base, "claude") }];
  assert.equal((await pass(state, roots)).coverage.unreadableLine, 1);
  fs.rmSync(file); // Claude Code removes transcripts past cleanupPeriodDays; people delete them too
  assert.equal((await pass(state, roots)).coverage.unreadableLine ?? 0, 0, "a deleted transcript's drop is still reported");
});

test("§3.2: a transcript replaced in place (same path, new file) is not counted as dropping its bad line twice", async (t) => {
  const base = scratch(t);
  const project = path.join(base, "claude", "-synthetic-project");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${SESSION}.jsonl`);
  const text = jsonl([line("u-1", 0, 10, { message: { id: "msg_verify_r", model: "claude-opus-5-5", usage: USAGE(10), stop_reason: "end_turn" } })])
    + '{"type":"assistant","message":{"usage":{"input_tokens":1}\n';
  fs.writeFileSync(file, text);
  const state = enrol(path.join(base, "state"), "dev_r");
  const roots = [{ tool: "claude-code", directory: path.join(base, "claude") }];
  assert.equal((await pass(state, roots)).coverage.unreadableLine, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(file + ".tmp", text + jsonl([line("u-2", 30, 20, { message: { id: "msg_verify_r2", model: "claude-opus-5-5", usage: USAGE(20), stop_reason: "end_turn" } })]));
  fs.renameSync(file + ".tmp", file); // an atomic rewrite: same path, a new file
  const again = await pass(state, roots);
  assert.equal(again.coverage.unreadableLine, 1, "one bad line on disk");
});
