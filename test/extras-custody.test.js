/**
 * Custody of the opt-in extras (alerts and tool activity) between a
 * reporter and its console, against the six defects of the 25 September
 * boundary review:
 *
 *   1. a resent envelope or a later-batch failure counted activity again;
 *   2. the same session hash on two machines was summed into one reading;
 *   3. opting out, or an older reporter, still read as a known zero;
 *   4. pending extras died with the reporter, and a console restart forgot
 *      its counts without saying so;
 *   5. OTel dedupe ignored the resource and scope, and attribute order;
 *   6. a minute or a last tool dated in the future became "now".
 *
 * Synthetic transcripts and synthetic envelopes only; the only network is a
 * reporting handler on 127.0.0.1 inside this process.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";

import { runOnce } from "../lib/collector/collector.js";
import { reporterExtras } from "../lib/reporter.js";
import { createRegistry } from "../lib/hub/registry.js";
import { createStore } from "../lib/hub/store.js";
import { createFleetSignals } from "../lib/hub/fleet.js";
import { buildConsole } from "../lib/hub/aggregate.js";
import { createReportingHandler, consoleSignals, allAlerts } from "../lib/hub/routes.js";
import { createActivityBook, ACTIVITY_KINDS } from "../lib/collector/activity.js";
import { activityFor, extrasFor, postRecords } from "../lib/collector/transport.js";
import { eventMeasurement } from "../lib/collector/measurement.js";
import { createInteropStore } from "../lib/interop/ingest.js";
import { createExtrasOutbox, OUTBOX_LIMITS } from "../lib/reporter-outbox.js";
import { parseLine } from "../lib/collector/parsers.js";

const PRICES = JSON.parse(await fs.readFile(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const h = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const floorMinute = (ms) => Math.floor(ms / MINUTE) * MINUTE;
const iso = (ms) => new Date(ms).toISOString();
const CANARY = "CANARY-EXTRAS-PRIVATE";

// ---------------------------------------------------------------------------
// A console's reporting handler on 127.0.0.1, and reporters that post to it
// ---------------------------------------------------------------------------

async function consoleFor(t, { startedAt = Date.now() } = {}) {
  const registry = createRegistry({ dir: null });
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES });
  const fleet = createFleetSignals({ startedAt });
  const config = { demo: false, listen: "0.0.0.0", retentionDays: 8, inviteMinutes: 30, allowPublic: false };
  const handle = createReportingHandler({ config, registry, store, fleet, version: "0.0.0", publicDir: process.cwd() });
  const server = http.createServer((req, res) => { handle(req, res, { secure: true }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/ingest`;
  const join = (machine) => {
    const { code } = registry.invite({ person: "Platform engineer", machine });
    return registry.redeem(code);
  };
  return { registry, store, fleet, url, join };
}

/** A reporter's private state and a synthetic Claude Code transcript. */
async function reporterFor(t, hub, machine = "Laptop") {
  const { device, token } = hub.join(machine);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-console-extras-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "logs");
  const directory = path.join(root, "state");
  await fs.mkdir(source);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "enrollment.json"), JSON.stringify({ v: 1, organizationId: hub.registry.organizationId,
    device: { id: device.id, label: device.label }, orgSalt: hub.registry.orgSalt }), { mode: 0o600 });
  const transcript = path.join(source, "synthetic.jsonl");
  await fs.writeFile(transcript, "");
  let n = 0;
  /** `tools` tool calls in one line at `at`, and as many results, ok unless `failed`. */
  async function append(at, tools, { failed = 0 } = {}) {
    n += 1;
    const lines = [JSON.stringify({ type: "assistant", uuid: `a-${n}`, sessionId: "synthetic-session", cwd: `/${CANARY}/project`, timestamp: iso(at),
      isSidechain: false, message: { id: `msg-${n}`, model: "claude-sonnet-5",
        content: Array.from({ length: tools }, (_, i) => ({ type: "tool_use", id: `call-${n}-${i}`, name: "Read", input: { file_path: `/${CANARY}/${n}-${i}` } })),
        usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })];
    for (let i = 0; i < tools; i += 1) {
      lines.push(JSON.stringify({ type: "user", uuid: `r-${n}-${i}`, sessionId: "synthetic-session", timestamp: iso(at),
        message: { content: [{ type: "tool_result", tool_use_id: `call-${n}-${i}`, is_error: i < failed, content: CANARY }] } }));
    }
    await fs.appendFile(transcript, lines.join("\n") + "\n");
  }
  /** Usage lines without a tool call: records only, to make later batches. */
  async function usageOnly(at, count) {
    const lines = [];
    for (let i = 0; i < count; i += 1) {
      n += 1;
      lines.push(JSON.stringify({ type: "assistant", uuid: `u-${n}`, sessionId: "synthetic-session", cwd: `/${CANARY}/project`, timestamp: iso(at),
        isSidechain: false, message: { id: `msg-${n}`, model: "claude-sonnet-5", content: "synthetic",
          usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }));
    }
    await fs.appendFile(transcript, lines.join("\n") + "\n");
  }
  /** One reporting pass, as `agent-console report` runs it; `extras` is the run's (a new one is a restart). */
  const pass = (extras, fetch) => runOnce({ directory, roots: [{ tool: "claude-code", directory: source }], token, post: hub.url, compact: true,
    share: extras.share, onTranscriptLine: extras.onTranscriptLine, journal: extras.journal, outbox: extras.outbox,
    transport: { fetch, sleep: async () => {}, maxAttempts: 2 } });
  const cursor = async () => JSON.parse(await fs.readFile(path.join(directory, "cursor-v2.json"), "utf8"));
  return { device, directory, append, usageOnly, pass, cursor };
}

/** A fetch that records every envelope, and can lose or refuse some. */
function wire({ lose = () => false, refuse = () => false, unreachable = () => false } = {}) {
  const bodies = [];
  const fetch = async (url, init) => {
    const i = bodies.length;
    bodies.push(JSON.parse(init.body));
    if (unreachable(i, bodies[i])) throw new TypeError("synthetic: no route to the console");
    if (refuse(i, bodies[i])) return { status: 503, headers: new Headers(), json: async () => ({}) };
    const response = await globalThis.fetch(url, init);
    // Lost: the console took the envelope, and its answer never arrived.
    if (lose(i, bodies[i])) throw new TypeError("synthetic: the answer was lost");
    return response;
  };
  return { fetch, bodies };
}

const sessionOf = (bodies) => bodies.find((b) => b.activity)?.activity[0].sessionHash;
const reading = (hub, device, hash, now = Date.now()) => hub.fleet.bookFor(device.id)?.snapshot([hash], now) ?? null;
const ACTIVITY_ONLY = { shareToolActivity: true };

// ---------------------------------------------------------------------------
// 1. Replay
// ---------------------------------------------------------------------------

test("a lost-response replay stays 2/2", async (t) => {
  const hub = await consoleFor(t);
  const r = await reporterFor(t, hub);
  await r.append(Date.now() - 30_000, 2);
  // The console takes the first envelope and its answer is lost; the reporter sends it again.
  const net = wire({ lose: (i) => i === 0 });
  await r.pass(reporterExtras(ACTIVITY_ONLY), net.fetch);
  assert.equal(net.bodies.length, 2, "sent twice");
  assert.deepEqual(net.bodies[1].activity, net.bodies[0].activity, "the resend is the same envelope, the same contribution ids");
  const snap = reading(hub, r.device, sessionOf(net.bodies));
  assert.equal(snap.calls.read, 2);
  assert.equal(snap.results.ok, 2);
});

test("a later-batch failure followed by a resend is not double counted", async (t) => {
  const hub = await consoleFor(t);
  const r = await reporterFor(t, hub);
  const at = Date.now() - 30_000;
  await r.append(at, 2);
  await r.usageOnly(at, 600);  // 602 records: two batches
  const extras = reporterExtras(ACTIVITY_ONLY);
  // The first batch (with the activity) is taken; the second is refused.
  const first = wire({ refuse: (i, body) => !body.activity });
  await assert.rejects(r.pass(extras, first.fetch), /did not acknowledge/u);
  assert.ok(first.bodies[0].activity, "the first batch carried the activity");
  // The next pass sends what is still unacknowledged: the second batch, and the activity again.
  const second = wire();
  await r.pass(extras, second.fetch);
  assert.deepEqual(second.bodies[0].activity.map((e) => e.id), first.bodies[0].activity.map((e) => e.id), "resent under the same ids");
  const snap = reading(hub, r.device, sessionOf(first.bodies));
  assert.equal(snap.calls.read, 2, "counted once");
  assert.equal(snap.results.ok, 2);
  assert.equal((await r.cursor()).extras.activity.length, 0, "acknowledged extras leave the outbox");
});

test("two distinct same-minute contributions both count", async (t) => {
  const hub = await consoleFor(t);
  const r = await reporterFor(t, hub);
  const minute = floorMinute(Date.now()) - MINUTE;   // one whole minute, inside the window
  const extras = reporterExtras(ACTIVITY_ONLY);
  await r.append(minute + 5_000, 2);
  const one = wire();
  await r.pass(extras, one.fetch);
  // More calls in the same minute, read on the next pass: a new contribution, not a rewrite of the first.
  await r.append(minute + 40_000, 3, { failed: 1 });
  const two = wire();
  await r.pass(extras, two.fetch);
  const a = one.bodies[0].activity, b = two.bodies[0].activity;
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  assert.equal(a[0].at, b[0].at, "the same minute");
  assert.notEqual(a[0].id, b[0].id, "two contributions, two ids");
  assert.deepEqual([a[0].calls.read, b[0].calls.read], [2, 3]);
  const snap = reading(hub, r.device, a[0].sessionHash);
  assert.equal(snap.calls.read, 5, "both count; neither overwrites the other");
  assert.deepEqual(snap.results, { ok: 4, error: 1 });
});

// ---------------------------------------------------------------------------
// 2. Device custody
// ---------------------------------------------------------------------------

test("the same session hash on two devices stays separate", async (t) => {
  const hub = await consoleFor(t);
  const now = Date.now();
  const session = h("copied-session");
  const entry = (read, id) => ({ id, sessionHash: session, at: iso(floorMinute(now) - MINUTE),
    calls: Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, k === "read" ? read : 0])), results: { ok: read, error: 0 }, lastTool: null });
  const post = async (joined, body) => {
    const r = await fetch(hub.url, { method: "POST", headers: { authorization: `Bearer ${joined.token}`, "content-type": "application/json" },
      body: JSON.stringify({ v: 1, device: { id: joined.device.id, label: joined.device.label }, freshness: { lastObservedAt: null, lastSyncedAt: null, mode: "live" },
        records: [], share: { alerts: "off", activity: "on" }, ...body }) });
    assert.equal(r.status, 200);
  };
  const a = hub.join("Laptop"), b = hub.join("Workstation");
  // Even one contribution id on both machines is two contributions: custody is per machine.
  await post(a, { activity: [entry(2, h("contribution-1"))] });
  await post(b, { activity: [entry(3, h("contribution-1"))] });
  const signals = consoleSignals({ fleet: hub.fleet }, now);
  const deviceA = hub.registry.list().find((d) => d.id === a.device.id), deviceB = hub.registry.list().find((d) => d.id === b.device.id);
  assert.equal(signals.activity([session], deviceA).calls.read, 2);
  assert.equal(signals.activity([session], deviceB).calls.read, 3);
  assert.equal(signals.results(session, deviceA).ok, 2, "never 5");
});

// ---------------------------------------------------------------------------
// 3. Coverage: declared, and never a zero it cannot vouch for
// ---------------------------------------------------------------------------

function consoleWith({ now, startedAt, createdAt = now - 9 * DAY }) {
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const registry = createRegistry({ dir: null, now: () => now });
  registry.addSynthetic({ id: "dev_local", label: "Studio", person: "You", local: true, createdAt: iso(now - 9 * DAY) });
  registry.addSynthetic({ id: "dev_r", label: "Laptop", person: "Platform engineer", createdAt: iso(createdAt) });
  for (const id of ["dev_local", "dev_r"]) registry.touch(id, { at: now, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null }, coverage: {} });
  const rec = (device, session, at) => {
    const r = { id: h(`${device}|${session}|${at}`), tool: "claude-code", model: "claude-sonnet-5", sessionHash: h(session), parentSessionHash: null,
      isSubagent: false, projectHash: h("p"), engagement: null, reportingDevice: device, executionOrigin: "unknown", at: iso(floorMinute(at)),
      fresh: 100, output: 10, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 0, observed: true,
      continuation: false, tier: "standard", cumulative: false };
    r.measurement = eventMeasurement(r);
    return r;
  };
  store.ingest("dev_r", [rec("dev_r", "busy", now - MINUTE), rec("dev_r", "quiet", now - MINUTE)]);
  store.ingest("dev_local", [rec("dev_local", "local", now - MINUTE)]);
  let clock = now;
  const fleet = createFleetSignals({ now: () => clock, startedAt });
  const local = createActivityBook({ now: () => clock });
  const entry = (id, at, read = 2) => ({ id: h(id), sessionHash: h("busy"), at: iso(floorMinute(at)),
    calls: Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, k === "read" ? read : 0])), results: { ok: read, error: 0 }, lastTool: { kind: "read", at: iso(floorMinute(at)) } });
  const view = (t = clock) => {
    clock = t;
    const alerts = { list: () => [] };
    return buildConsole({ store, registry, now: t, hub: {}, alerts: allAlerts({ alerts, fleet, localId: "dev_local" }, t),
      signals: consoleSignals({ alerts, fleet, activity: local }, t) });
  };
  const lane = (v, session) => v.lanes.find((l) => l.key === h(session).slice(0, 16));
  return { fleet, local, entry, view, lane, setClock: (t) => { clock = t; } };
}

test("opt-out makes coverage unavailable", () => {
  const NOW = Date.UTC(2026, 8, 25, 22, 0, 30);
  const c = consoleWith({ now: NOW, startedAt: NOW - 2 * HOUR });
  const on = { alerts: "on", activity: "on" };
  c.fleet.accept("dev_r", { share: on }, NOW - HOUR);   // sharing, as heard an hour ago
  c.fleet.accept("dev_r", { share: on, alerts: [], activity: activityFor([c.entry("c1", NOW - MINUTE)]) }, NOW);
  let v = c.view(NOW);
  assert.equal(c.lane(v, "busy").activity.calls.read, 2);
  assert.deepEqual(c.lane(v, "quiet").activity.calls, Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, 0])), "shared for the whole window: a known zero");
  assert.equal(c.lane(v, "quiet").activityCoverage.state, "complete");
  // A later batch carries no lists; the declaration still says on. Omission alone changes nothing.
  c.fleet.accept("dev_r", { share: on }, NOW);
  v = c.view(NOW);
  assert.equal(c.lane(v, "quiet").activityCoverage.state, "complete");
  assert.ok(!v.alertsCoverage.unwatchedDevices.includes("dev_r"));
  // The reporter runs again without --share-tool-activity and --share-alerts.
  c.fleet.accept("dev_r", { share: { alerts: "off", activity: "off" } }, NOW + 10_000);
  v = c.view(NOW + 10_000);
  for (const session of ["busy", "quiet"]) {
    const l = c.lane(v, session);
    assert.equal(l.activity, null, `${session}: unavailable, not zero`);
    assert.equal(l.activityShared, false);
    assert.equal(l.lastTool, null);
    assert.deepEqual(l.activityCoverage, { state: "off", since: NOW + 10_000, reason: "sharing-off" });
  }
  assert.ok(v.alertsCoverage.unwatchedDevices.includes("dev_r"), "its silence is not \"no alert\"");
  assert.deepEqual(v.devices.find((d) => d.id === "dev_r").sharing.alerts, { state: "off", since: NOW + 10_000, reason: "sharing-off" });
  // A list its own declaration says is off is refused at the door.
  assert.throws(() => extrasFor({ share: { alerts: "off", activity: "off" }, activity: [c.entry("c2", NOW - MINUTE)] }), /off/u);
});

test("an old client without a declaration shows unavailable, not zero", () => {
  const NOW = Date.UTC(2026, 8, 25, 22, 0, 30);
  const c = consoleWith({ now: NOW, startedAt: NOW - 2 * HOUR });
  c.fleet.accept("dev_r", {}, NOW);   // a 0.3 envelope: records only, no declaration
  const v = c.view(NOW);
  for (const session of ["busy", "quiet"]) {
    const l = c.lane(v, session);
    assert.equal(l.activity, null);
    assert.equal(l.activityShared, false);
    assert.deepEqual(l.activityCoverage, { state: "undeclared", since: NOW, reason: "reporter-undeclared" });
  }
  assert.deepEqual(v.alertsCoverage.byDevice.dev_r, { state: "undeclared", since: NOW, reason: "reporter-undeclared" });
  assert.ok(v.alertsCoverage.unwatchedDevices.includes("dev_r"));
  // Before its first envelope since this console started, a machine is unknown, never zero either.
  const fresh = consoleWith({ now: NOW, startedAt: NOW - 2 * HOUR });
  assert.deepEqual(fresh.lane(fresh.view(NOW), "quiet").activityCoverage, { state: "unknown", since: NOW - 2 * HOUR, reason: "not-heard" });
  assert.equal(fresh.lane(fresh.view(NOW), "quiet").activity, null);
});

// ---------------------------------------------------------------------------
// 4. Restarts
// ---------------------------------------------------------------------------

test("a reporter restart replays pending extras exactly once", async (t) => {
  const hub = await consoleFor(t);
  const r = await reporterFor(t, hub);
  const opts = { shareToolActivity: true, shareAlerts: true };
  // The console cannot be reached; the reporter stops before any answer.
  await r.append(Date.now() - 50_000, 2);
  const down = wire({ unreachable: () => true });
  await assert.rejects(r.pass(reporterExtras(opts), down.fetch));
  const kept = await r.cursor();
  assert.equal(kept.extras.activity.length, 1, "kept with the cursor that read it");
  assert.deepEqual(Object.keys(kept.extras).sort(), ["activity", "alerts", "epoch", "lost", "seq", "v"]);
  assert.deepEqual(kept.extras.lost, [], "nothing dropped, so no loss marker");
  const raw = await fs.readFile(path.join(r.directory, "cursor-v2.json"), "utf8");
  assert.ok(!raw.includes(CANARY) && !JSON.stringify(kept.extras).includes("Read"), "counts, kinds and hashes only");
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(r.directory, "cursor-v2.json"))).mode & 0o777, 0o600);
  // A new process: nothing in memory, the transcript already read. It sends what was kept.
  const back = wire();
  await r.pass(reporterExtras(opts), back.fetch);
  assert.deepEqual(back.bodies[0].activity.map((e) => e.id), down.bodies[0].activity.map((e) => e.id), "the same contribution ids after a restart");
  const session = back.bodies[0].activity[0].sessionHash;
  assert.equal(reading(hub, r.device, session).calls.read, 2);
  assert.equal((await r.cursor()).extras.activity.length, 0, "cleared on receipt");

  // The console takes an envelope, its answer is lost, and the reporter restarts before the retry.
  await r.append(Date.now() - 20_000, 3);
  const lost = wire({ lose: () => true });
  await assert.rejects(r.pass(reporterExtras(opts), lost.fetch));
  assert.equal(reading(hub, r.device, session).calls.read, 5, "the console has it");
  const again = wire();
  await r.pass(reporterExtras(opts), again.fetch);
  assert.deepEqual(again.bodies[0].activity.map((e) => e.id), lost.bodies[0].activity.map((e) => e.id));
  assert.equal(reading(hub, r.device, session).calls.read, 5, "replayed, counted once");
  // And nothing is read twice on the reporter: one more pass sends nothing new.
  const idle = wire();
  await r.pass(reporterExtras(opts), idle.fetch);
  assert.ok(idle.bodies.every((b) => !b.activity));
  assert.equal(reading(hub, r.device, session).calls.read, 5);
});

test("a hub restart shows the unavailable interval", () => {
  const NOW = Date.UTC(2026, 8, 25, 22, 0, 30);
  // This console restarted twenty seconds ago; the reporter, sharing all
  // along, is heard at its next report, within one live interval.
  const startedAt = NOW - 20_000;
  const c = consoleWith({ now: NOW, startedAt });
  c.fleet.accept("dev_r", { share: { alerts: "on", activity: "on" }, activity: activityFor([c.entry("c1", NOW - MINUTE)]) }, NOW);
  let v = c.view(NOW);
  const busy = c.lane(v, "busy"), quiet = c.lane(v, "quiet"), local = c.lane(v, "local");
  // Covered from the first "on" this console heard, and the window began before the console did.
  const gap = { state: "partial", since: NOW, reason: "console-restarted" };
  assert.deepEqual(busy.activityCoverage, gap);
  assert.equal(busy.activity.calls.read, 2, "what is held is shown, as a floor");
  assert.deepEqual(quiet.activityCoverage, gap);
  assert.equal(quiet.activity, null, "nothing held since the restart is unavailable, not zero");
  assert.deepEqual(local.activityCoverage, { state: "partial", since: startedAt, reason: "console-restarted" }, "this machine's own reading restarted too");
  assert.equal(local.activity, null);
  assert.equal(v.alertsCoverage.since, NOW);
  assert.equal(v.alertsCoverage.reason, "console-restarted");
  assert.deepEqual(v.devices.find((d) => d.id === "dev_r").sharing.activity, gap);
  // Five whole minutes after the first "on" the window is covered again: zero is known.
  v = c.view(NOW + 6 * MINUTE);
  assert.equal(c.lane(v, "quiet").activityCoverage.state, "complete");
  assert.deepEqual(c.lane(v, "quiet").activity.calls, Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, 0])));
  assert.equal(c.lane(v, "local").activityCoverage.state, "complete");
  // Even a machine that joined after the restart is covered only from its first "on".
  const joined = consoleWith({ now: NOW, startedAt, createdAt: NOW - MINUTE });
  joined.fleet.accept("dev_r", { share: { alerts: "on", activity: "on" } }, NOW);
  assert.equal(joined.lane(joined.view(NOW), "quiet").activityCoverage.state, "partial");
});

test("an off run then a restart with sharing on is never backdated: partial, not complete or zero", async (t) => {
  // The console has run for two hours; this machine's reporter has not reached it yet.
  const hub = await consoleFor(t, { startedAt: Date.now() - 2 * HOUR });
  const r = await reporterFor(t, hub);
  await r.append(Date.now() - 30_000, 1);
  // A run with sharing off reads the Read call and moves its cursor past it; the console is unreachable.
  await assert.rejects(r.pass(reporterExtras({}), wire({ unreachable: () => true }).fetch));
  // Restarted with sharing on: the token record arrives, the Read's activity was never counted.
  const net = wire();
  await r.pass(reporterExtras(ACTIVITY_ONLY), net.fetch);
  assert.ok(net.bodies[0].records.length > 0, "the tokens arrive");
  assert.ok(!("activity" in net.bodies[0]), "no contribution: the call was read while sharing was off");
  assert.deepEqual(net.bodies[0].share, { alerts: "off", activity: "on" });
  const now = Date.now();
  const view = buildConsole({ store: hub.store, registry: hub.registry, now, hub: {}, signals: consoleSignals({ fleet: hub.fleet }, now) });
  const lane = view.lanes.find((l) => l.device.id === r.device.id);
  assert.ok(lane, "the lane is there, from its tokens");
  assert.equal(lane.activityCoverage.state, "partial", "covered from the first \"on\" the console heard, never from its own start");
  assert.equal(lane.activityCoverage.reason, "sharing-started");
  assert.ok(lane.activityCoverage.since >= now - MINUTE);
  assert.equal(lane.activity, null, "unavailable — never read 0 for a Read that happened");
  assert.equal(view.devices.find((d) => d.id === r.device.id).sharing.activity.state, "partial");
});

test("an outbox over its bound carries a loss marker, and the console reads partial with outbox-overflow", () => {
  const NOW = Date.UTC(2026, 8, 25, 22, 0, 30);
  const minute = floorMinute(NOW - 30_000);
  const book = createActivityBook({ now: () => NOW });
  const box = createExtrasOutbox({ activity: book, now: () => NOW });
  box.journal.restore(null, { deviceId: "dev_r", hashIdentity: (k, v) => h(`${k}|${v}`) });
  for (let i = 0; i < 1001; i += 1) {
    book.observeLine({ tool: "claude-code", sessionHash: h(`session-${i}`),
      line: { type: "assistant", timestamp: iso(NOW - 30_000), message: { content: [{ type: "tool_use", name: "Read" }] } } });
  }
  box.journal.file(true);
  const saved = box.journal.prepare();
  box.journal.commit();
  assert.equal(saved.activity.length, 1000, "the bound holds");
  assert.ok(!saved.activity.some((e) => e.sessionHash === h("session-0")), "the oldest went");
  assert.equal(saved.lost.length, 1, "and it went with a marker, not in silence");
  assert.deepEqual({ ...saved.lost[0], id: undefined }, { id: undefined, kind: "activity", count: 1, from: iso(minute), to: iso(minute) });
  // The marker travels with the extras and passes the console's door.
  const taken = box.take();
  const share = { alerts: "off", activity: "on" };
  const extras = extrasFor({ share, activity: taken.activity, lost: taken.lost });
  assert.equal(extras.lost.length, 1);
  const c = consoleWith({ now: NOW, startedAt: NOW - 2 * HOUR });
  c.fleet.accept("dev_r", { share }, NOW - HOUR);   // sharing for an hour: the window would be whole
  c.fleet.accept("dev_r", extras, NOW);
  c.fleet.accept("dev_r", extras, NOW);             // resent: one gap, not two
  let v = c.view(NOW);
  const overflow = { state: "partial", since: minute + MINUTE, reason: "outbox-overflow" };
  assert.deepEqual(c.lane(v, "quiet").activityCoverage, overflow);
  assert.equal(c.lane(v, "quiet").activity, null, "never a known zero over the lost minute");
  assert.deepEqual(v.devices.find((d) => d.id === "dev_r").sharing.activity, overflow);
  // Acknowledged: the marker leaves the outbox.
  assert.equal(box.ack(), true);
  assert.deepEqual(box.saved().lost, []);
  // Once the lost minute has left the window, the window is whole again.
  v = c.view(NOW + 6 * MINUTE);
  assert.equal(c.lane(v, "quiet").activityCoverage.state, "complete");
  // A declared-off kind cannot carry a marker.
  assert.throws(() => extrasFor({ share: { alerts: "off", activity: "off" }, lost: taken.lost }), /off/u);
});

for (const kind of ["activity", "alerts"]) test(`clock-skew overflow in ${kind} preserves loss coverage and token delivery`, async (t) => {
  const now = Date.now();
  const at = iso(floorMinute(now + 90_000));
  const hub = await consoleFor(t);
  const { device, token } = hub.join("Synthetic workstation");
  const ctx = { deviceId: device.id, hashIdentity: (k, v) => h(`${k}|${v}`) };
  const pending = Array.from({ length: OUTBOX_LIMITS[kind] + 1 }, (_, i) => kind === "activity"
    ? { id: h(`activity-${i}`), sessionHash: h(`session-${i}`), at,
      calls: Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, k === "read" ? 1 : 0])),
      results: { ok: 1, error: 0 }, lastTool: null }
    : { id: h(`alert-${i}`), kind: "loop", sessionHash: h(`session-${i}`), at, count: 1, historical: false });
  const makeBox = () => createExtrasOutbox({ now: () => now,
    ...(kind === "activity" ? { activity: createActivityBook({ now: () => now }) } : { alerts: { drain: () => [] } }) });
  const box = makeBox();
  box.journal.restore({ v: 1, epoch: "a".repeat(32), seq: pending.length, activity: [], alerts: [], lost: [], [kind]: pending }, ctx);
  const saved = box.saved();
  assert.equal(saved[kind].length, OUTBOX_LIMITS[kind]);
  assert.equal(saved.lost.length, 1);
  assert.equal(saved.lost[0].from, at);
  assert.equal(saved.lost[0].to, at, "the interval covers the dropped minute, including supported clock skew");
  const restarted = makeBox();
  restarted.journal.restore(saved, ctx);
  assert.deepEqual(restarted.saved().lost, saved.lost, "the same loss marker survives restart");
  const extras = { share: { activity: kind === "activity" ? "on" : "off", alerts: kind === "alerts" ? "on" : "off" }, ...restarted.take() };
  const record = { id: h("skew-usage"), tool: "claude-code", model: "claude-sonnet-5", sessionHash: h("usage-session"),
    parentSessionHash: null, isSubagent: false, projectHash: h("synthetic-project"), engagement: null,
    reportingDevice: device.id, executionOrigin: "unknown", at: iso(floorMinute(now)), fresh: 10, output: 4,
    cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 0, observed: true,
    continuation: false, tier: "standard", cumulative: false };
  record.measurement = eventMeasurement(record);
  const identity = { id: device.id, label: device.label };
  const first = await postRecords(hub.url, identity, [record], { token, ...extras });
  assert.equal(first.accepted, 1, "valid tokens are delivered alongside the overflow marker");
  const replay = await postRecords(hub.url, identity, [record], { token, ...extras });
  assert.equal(replay.duplicate, 1, "a retry does not count the usage twice");
  const lossReplay = hub.fleet.accept(device.id, extras, now);
  assert.equal(lossReplay.lost.duplicate, 1, "the hub retained the original loss marker");
  assert.equal(lossReplay.lost.future, 0, "the existing clock-skew allowance is preserved");
  assert.equal(restarted.ack(), true);
  assert.deepEqual(restarted.saved().lost, []);
});

test("a cursor write that landed although the pass saw it fail is adopted, not overwritten", () => {
  const NOW = Date.UTC(2026, 8, 25, 22, 0, 30);
  const ctx = { deviceId: "dev_r", hashIdentity: (k, v) => h(`${k}|${v}`) };
  const book = createActivityBook({ now: () => NOW });
  const box = createExtrasOutbox({ activity: book, now: () => NOW });
  box.journal.restore(null, ctx);
  book.observeLine({ tool: "claude-code", sessionHash: h("s"), line: { type: "assistant", timestamp: iso(NOW - 30_000), message: { content: [{ type: "tool_use", name: "Read" }] } } });
  box.journal.file(true);
  const onDisk = box.journal.prepare();
  box.journal.abort();                    // the write landed; the pass was told it failed
  box.journal.restore(onDisk, ctx);        // the next pass reads that cursor: its positions are past the line
  const next = box.journal.prepare();
  box.journal.commit();
  assert.deepEqual(next.activity.map((e) => e.id), onDisk.activity.map((e) => e.id), "the landed contribution is kept, under its id");
  assert.equal(box.saved().activity[0].calls.read, 1);
});

// ---------------------------------------------------------------------------
// 5. OTel series identity
// ---------------------------------------------------------------------------

test("OTel accepts two service.instance.id values with identical points and time, and dedups a retry with reordered attributes", () => {
  const store = createInteropStore();
  const stamp = String(BigInt(Date.now()) * 1_000_000n);
  const str = (key, value) => ({ key, value: { stringValue: value } });
  const body = (reorder) => ({
    resourceMetrics: ["instance-a", "instance-b"].map((instance, i) => {
      const resource = [str("service.name", "claude-code"), str("service.instance.id", instance), { key: "host.cpus", value: { intValue: "8" } }];
      const point = [str("model", "claude-sonnet-5"), str("type", "input"), str("session.id", "synthetic")];
      return {
        resource: { attributes: reorder ? [...resource].reverse().map((a) => (a.key === "host.cpus" ? { key: a.key, value: { intValue: 8 } } : a)) : resource },
        scopeMetrics: [{ scope: { name: "com.anthropic.claude_code", version: "1.0.0" }, metrics: [{ name: "claude_code.token.usage",
          sum: { aggregationTemporality: 1, dataPoints: [{ attributes: reorder ? [...point].reverse() : point, timeUnixNano: stamp, asInt: String(10 * (i + 1)) }] } }] }],
      };
    }),
  });
  assert.equal(store.acceptOtlp(body(false)), 2, "two resources, the same point and time: two series");
  assert.equal(store.snapshot().otel.tokens.input, 30);
  assert.equal(store.acceptOtlp(body(true)), 0, "the same points with every attribute list reordered: a retry");
  const snap = store.snapshot();
  assert.equal(snap.otel.tokens.input, 30);
  assert.equal(snap.otel.dedupedSamples, 2);
  assert.ok(!/instance-a|instance-b|synthetic/u.test(JSON.stringify(snap)), "no raw label leaves the adapter");
});

// ---------------------------------------------------------------------------
// 6. Future timestamps
// ---------------------------------------------------------------------------

test("a +1 h bucket and a far-future lastTool are rejected and never become current", () => {
  const NOW = Date.UTC(2026, 8, 25, 22, 0, 30);
  const c = consoleWith({ now: NOW, startedAt: NOW - 2 * HOUR });
  const ahead = c.entry("ahead", NOW + HOUR, 7);
  const farTool = { ...c.entry("far-tool", NOW - MINUTE, 1), lastTool: { kind: "shell", at: iso(floorMinute(NOW + 30 * DAY)) } };
  const skewed = c.entry("skewed", NOW + 90_000, 1);   // within two minutes: a fast clock, accepted
  const out = c.fleet.accept("dev_r", { share: { alerts: "on", activity: "on" }, activity: activityFor([ahead, farTool, skewed]),
    alerts: [{ id: h("alert-ahead"), kind: "loop", at: iso(floorMinute(NOW + HOUR)), sessionHash: h("busy"), count: 5, historical: false }] }, NOW);
  assert.equal(out.activity.future, 2);
  assert.equal(out.activity.accepted, 1);
  assert.equal(out.alerts.future, 1);
  const book = c.fleet.bookFor("dev_r");
  // Now, an hour on (when the refused bucket would have been current), and a month on (its last tool's time).
  for (const t of [NOW, NOW + HOUR, NOW + 30 * DAY]) {
    const snap = book.snapshot([h("busy")], t);
    assert.equal(snap.calls.read, 0, "the +1 h bucket never becomes current");
    assert.ok(snap.lastTool === null || snap.lastTool.kind !== "shell", "the far-future last tool never becomes the last tool");
  }
  assert.equal(book.snapshot([h("busy")], NOW).lastTool, null, "a last tool ahead of now is not the last tool yet");
  // The minute 90 s ahead is in the window only once its minute has come.
  assert.equal(book.snapshot([h("busy")], NOW + 2 * MINUTE).calls.read, 1);
  const v = c.view(NOW);
  assert.equal(c.lane(v, "busy").lastTool, null);
  assert.equal(v.devices.find((d) => d.id === "dev_r").sharing.rejectedFuture, 3, "refused and counted, never stored");
  assert.ok(!c.fleet.alerts(NOW + HOUR).some((a) => a.id === h("alert-ahead")));
  // The same rule on this machine's own transcripts: a line from the future is not read into a count.
  const local = createActivityBook({ now: () => NOW });
  local.observeLine({ tool: "claude-code", sessionHash: h("own"), line: { type: "assistant", timestamp: iso(NOW + HOUR),
    message: { content: [{ type: "tool_use", id: "x", name: "Read", input: {} }] } } });
  local.fileRead(true);
  local.commitPass();
  assert.equal(local.snapshot([h("own")], NOW + HOUR), null);
});

// ---------------------------------------------------------------------------
// The line observer sees tool calls and results; accounting does not
// ---------------------------------------------------------------------------

test("a Claude Code tool result and a Codex tool call reach the line observer, with no record and the state unchanged", () => {
  const seen = [];
  const context = { hashIdentity: (k, v) => h(k + v), recordId: (...a) => h(a.join("|")), reportingDevice: "dev_r", onParsedLine: (value) => seen.push(value.type) };
  const at = iso(Date.UTC(2026, 8, 25, 22, 0, 0));
  const claudeResult = JSON.stringify({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: CANARY }] } });
  const codexCall = JSON.stringify({ type: "response_item", timestamp: at, payload: { type: "function_call", name: "exec_command", arguments: "{}", call_id: "c1" } });
  const state = { sessionHash: h("s") };
  for (const [tool, line] of [["claude-code", claudeResult], ["codex", codexCall]]) {
    const out = parseLine(tool, line, context, state);
    assert.deepEqual(out.records, []);
    assert.equal(out.state, state, "accounting state untouched");
  }
  assert.deepEqual(seen, ["user", "response_item"]);
  // Without an observer such a line is not parsed at all, as before.
  const quiet = { ...context, onParsedLine: undefined };
  assert.deepEqual(parseLine("codex", codexCall, quiet, state), { records: [], state });
});
