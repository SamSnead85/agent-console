/**
 * The hub's next data contract (H01–H17): alert time truth and magnitude,
 * fleet alerts and their coverage, stacked series per period, counts over
 * every lane, project cost standing and identity, one clock, a named
 * per-machine denominator, coverage truth, tool activity as counts only, the
 * week by local day, the period's basis, and priced bench models.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import crypto from "node:crypto";

import { createStore } from "../lib/hub/store.js";
import { createRegistry } from "../lib/hub/registry.js";
import { buildConsole, LANES_SHOWN } from "../lib/hub/aggregate.js";
import { projectsPayload } from "../lib/hub/projects.js";
import { createAlerts } from "../lib/hub/alerts.js";
import { createFleetSignals } from "../lib/hub/fleet.js";
import { allAlerts, consoleSignals } from "../lib/hub/routes.js";
import { startDemo } from "../lib/hub/demo.js";
import { createActivityBook, toolKind, ACTIVITY_KINDS } from "../lib/collector/activity.js";
import { alertsFor, activityFor, postRecords } from "../lib/collector/transport.js";
import { priceRecord } from "../lib/collector/pricing.js";
import { eventMeasurement } from "../lib/collector/measurement.js";
import { reporterExtras } from "../lib/reporter.js";
import { BENCH_MODELS } from "../bench/generate.mjs";
import { analyzeAlertEvent, emptyAlertState } from "../lib/analysis/alerts.js";

const PRICES = JSON.parse(fs.readFileSync(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const h = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const NOW = Date.UTC(2026, 8, 24, 15, 30, 20);

function rec({ device = "dev_a", session = "s1", parent = null, project = "p1", model = "claude-sonnet-5", at = NOW, tokens = 1000, id = null, tier = "standard" }) {
  const r = { id: id || h(`${device}|${session}|${at}|${tokens}|${Math.random()}`), tool: "claude-code", model, sessionHash: h(session),
    parentSessionHash: parent ? h(parent) : null, isSubagent: Boolean(parent), projectHash: h(project), engagement: null,
    reportingDevice: device, executionOrigin: "unknown", at: new Date(Math.floor(at / MINUTE) * MINUTE).toISOString(),
    fresh: tokens, output: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 0, observed: true,
    continuation: false, tier, cumulative: false };
  r.measurement = eventMeasurement(r);
  return r;
}

function hub({ now = NOW, devices = [{ id: "dev_a", label: "Studio", person: "You", local: true }] } = {}) {
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const registry = createRegistry({ dir: null, now: () => now });
  for (const d of devices) {
    registry.addSynthetic({ id: d.id, label: d.label, person: d.person, local: Boolean(d.local), createdAt: new Date(now - 9 * DAY).toISOString() });
    if (d.contact !== null) registry.touch(d.id, { at: d.contact ?? now, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null },
      ...(d.coverage === undefined ? { coverage: {} } : d.coverage === null ? {} : { coverage: d.coverage }) });
  }
  return { store, registry };
}

function demoHub() {
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES });
  const registry = createRegistry({ dir: null });
  const fleet = createFleetSignals();
  const activity = createActivityBook();
  const demo = startDemo({ registry, store, fleet, activity, tickMs: 1e9 });
  demo.stop();
  const alerts = { list: () => demo.alerts() };
  const now = Date.now();
  const view = buildConsole({ store, registry, names: demo.names, now, hub: { demo: true },
    alerts: allAlerts({ alerts, fleet }, now), signals: consoleSignals({ alerts, fleet, activity }, now) });
  return { store, registry, demo, view, now };
}

const claudeToolLine = (i, at, name = "Bash", input = { command: "CANARY-PRIVATE-COMMAND" }) => ({ type: "assistant", sessionId: "synthetic", timestamp: new Date(at).toISOString(),
  message: { id: `m-${i}`, content: [{ type: "tool_use", id: `call-${i}`, name, input }] } });

// ---------------------------------------------------------------------------
// H01 alert time truth
// ---------------------------------------------------------------------------

test("H01: a 30-hour-old loop line read today is historical, never a live alert, and is dated by its own line", () => {
  let clock = NOW;
  const raised = [];
  const engine = createAlerts({ now: () => clock, repeat: 5, onAlert: (a) => raised.push(a) });
  const old = NOW - 30 * HOUR;
  for (let i = 0; i < 5; i += 1) engine.observeLine({ tool: "claude-code", line: claudeToolLine(i, old + i * 1000), records: [],
    sessionHash: h("s"), projectHash: h("p"), hashIdentity: (k, v) => h(k + v) });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, "loop");
  assert.equal(raised[0].historical, true, "a day-old loop is history");
  assert.equal(raised[0].at, old + 4000, "dated by the transcript line, not by the reading");
  assert.equal(raised[0].seenAt, NOW);
  assert.equal(engine.list().filter((a) => !a.historical).length, 0, "no live alert");
});

test("H01: while the first read is still running no alert is live, however fresh its line", () => {
  let firstRunComplete = false;
  const engine = createAlerts({ now: () => NOW, repeat: 5, live: () => firstRunComplete });
  const feed = (i) => engine.observeLine({ tool: "claude-code", line: claudeToolLine(i, NOW - 5000 + i), records: [],
    sessionHash: h("s"), projectHash: h("p"), hashIdentity: (k, v) => h(k + v) });
  for (let i = 0; i < 5; i += 1) feed(i);
  assert.equal(engine.list()[0].historical, true);
  firstRunComplete = true;
  for (let i = 5; i < 10; i += 1) feed(i);
  assert.equal(engine.list().filter((a) => !a.historical).length, 1, "after the first read, a fresh loop is live");
});

test("H01: stall arithmetic runs on the lines' own clock, not on how fast they were read", () => {
  const run = (sourceStep, readStep) => {
    let state = emptyAlertState();
    const out = [];
    for (let i = 0; i < 8; i += 1) {
      const next = analyzeAlertEvent(state, { kind: "usage", sessionHash: "x", at: NOW + i * readStep, sourceAt: NOW + i * sourceStep, tokens: 100_000 });
      state = next.state; out.push(...next.signals);
    }
    return out.filter((s) => s.kind === "stall");
  };
  assert.equal(run(MINUTE, 10).length, 1, "seven minutes of spend read in a burst is a stall");
  assert.equal(run(10, MINUTE).length, 0, "a second of spend read slowly is not");
});

// ---------------------------------------------------------------------------
// H02 magnitude, H03 fleet alerts
// ---------------------------------------------------------------------------

test("H02: a spike names its five minutes against the session's own median, and its lane", () => {
  const { store, registry } = hub();
  const rows = [];
  for (let k = 1; k <= 30; k += 1) rows.push(rec({ at: NOW - 60 * MINUTE + k * MINUTE - 30 * MINUTE, tokens: 1000 }));
  for (let k = 0; k < 5; k += 1) rows.push(rec({ at: NOW - k * MINUTE, tokens: 10_000 }));
  store.ingest("dev_a", rows);
  const alert = { id: h("a1"), kind: "spike", at: NOW, seenAt: NOW, historical: false, sessionHash: h("s1"), count: 10_000, deviceId: "dev_a" };
  const view = buildConsole({ store, registry, names: { project: () => "atlas", branch: () => null }, now: NOW, hub: {}, alerts: [alert] });
  const a = view.alerts[0];
  assert.equal(a.tokens5m, 50_000);
  assert.equal(a.median5m, 5_000);
  assert.equal(a.factor, 10);
  assert.deepEqual(a.lane, { key: h("s1").slice(0, 16), projectHash: h("p1"), deviceId: "dev_a", displayName: "atlas" });
  assert.equal(view.lanes[0].key, a.lane.key, "the alert opens its lane");
});

test("H03: fleet alerts merge per machine; the coverage says which machines are not watched", () => {
  const { store, registry } = hub({ devices: [{ id: "dev_a", label: "Studio", local: true }, { id: "dev_b", label: "Laptop" }, { id: "dev_c", label: "Box" }, { id: "dev_d", label: "Gone" }] });
  registry.revoke("dev_d");
  const fleet = createFleetSignals({ now: () => NOW, startedAt: NOW - 2 * HOUR });
  const at = new Date(Math.floor((NOW - 2 * MINUTE) / MINUTE) * MINUTE).toISOString();
  const sent = alertsFor([{ id: h("x"), kind: "spike", at, sessionHash: h("sb"), count: 90_000, historical: false }]);
  const share = { alerts: "on", activity: "off" };
  fleet.accept("dev_b", { share }, NOW - 2 * HOUR);   // sharing since two hours ago: the hour is whole
  fleet.accept("dev_b", { share, alerts: sent });
  fleet.accept("dev_b", { share, alerts: sent });   // the same envelope again: once
  fleet.accept("dev_c", {});                        // a 0.3 reporter: no declaration
  const local = { list: () => [] };
  const view = buildConsole({ store, registry, now: NOW, hub: {}, alerts: allAlerts({ alerts: local, fleet, localId: "dev_a" }, NOW),
    signals: consoleSignals({ alerts: local, fleet }, NOW) });
  assert.equal(view.alerts.length, 1);
  assert.equal(view.alerts[0].deviceId, "dev_b");
  assert.equal(view.alerts[0].historical, false);
  assert.deepEqual({ ...view.alertsCoverage, byDevice: undefined }, { watched: 2, unwatched: 1, unwatchedDevices: ["dev_c"], since: null, reason: null, byDevice: undefined });
  assert.deepEqual(view.alertsCoverage.byDevice.dev_c, { state: "undeclared", since: NOW, reason: "reporter-undeclared" });
  assert.equal(view.alertsCoverage.byDevice.dev_b.state, "complete");
  assert.equal(view.asOf, NOW);
  assert.equal(view.alertsAsOf, NOW);
});

test("H03: an envelope alert is counts, kinds, minutes and salted hashes; anything else is refused at the door", () => {
  const good = { id: h("x"), kind: "loop", at: "2026-09-24T15:30:00.000Z", sessionHash: h("s"), count: 5, historical: false };
  assert.doesNotThrow(() => alertsFor([good]));
  for (const bad of [{ ...good, kind: "custom" }, { ...good, at: "2026-09-24T15:30:12.000Z" }, { ...good, sessionHash: "raw-session-id" },
    { ...good, tool: "Bash" }, { ...good, count: -1 }, { ...good, historical: "no" }]) {
    assert.throws(() => alertsFor([bad]), /invalid/u);
  }
});

test("H03/H11: the reporter sends alerts and activity only when asked, on the first envelope, and nothing private", async () => {
  const off = reporterExtras({});
  assert.equal(off.outbox, null, "off by default: nothing extra leaves the machine");
  let clock = NOW;
  const extras = reporterExtras({ shareAlerts: true, shareToolActivity: true, now: () => clock });
  const hashIdentity = (k, v) => h(k + v);
  // The collector's side of the cursor write (lib/collector/collector.js), done by hand here.
  extras.journal.restore(null, { hashIdentity, deviceId: "dev_r" });
  for (let i = 0; i < 5; i += 1) {
    extras.onTranscriptLine({ tool: "claude-code", line: claudeToolLine(i, NOW - 60_000 + i, "mcp__canary-private-server__tool", { path: "/CANARY/secret" }),
      records: [], sessionHash: h("s"), projectHash: h("p"), hashIdentity });
    extras.onTranscriptLine({ tool: "claude-code", line: { type: "user", timestamp: new Date(NOW - 50_000).toISOString(),
      message: { content: [{ type: "tool_result", is_error: i === 0, content: "CANARY-OUTPUT" }] } }, records: [], sessionHash: h("s"), hashIdentity });
  }
  const bodies = [];
  const fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); const n = JSON.parse(init.body).records.length;
    return { status: 200, json: async () => ({ accepted: n, duplicate: 0, expired: 0, rejected: [] }) }; };
  const records = Array.from({ length: 600 }, (_, i) => ({ ...rec({ device: "dev_r", at: NOW - i * 1000 }) }));
  extras.journal.file(true);
  assert.ok(extras.journal.prepare(), "sealed with the cursor");
  extras.journal.commit();
  const taken = extras.outbox.take();
  await postRecords("http://127.0.0.1:9/api/ingest", { id: "dev_r", label: "Laptop" }, records,
    { token: "t".repeat(40), fetch, sleep: async () => {}, freshness: { lastObservedAt: null, lastSyncedAt: null, mode: "live" }, share: extras.share, ...taken });
  extras.outbox.ack();
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].alerts && bodies[0].activity, "the first envelope carries them");
  assert.ok(!("alerts" in bodies[1]) && !("activity" in bodies[1]), "later batches do not repeat them");
  for (const b of bodies) assert.deepEqual(b.share, { alerts: "on", activity: "on" }, "every envelope says what this run shares");
  assert.equal(bodies[0].alerts[0].kind, "loop");
  assert.equal(bodies[0].alerts[0].historical, true, "raised while reading the backlog");
  const activity = bodies[0].activity;
  assert.equal(activity[0].calls.mcp, 5, "an MCP server's name collapses to mcp");
  assert.deepEqual(activity.reduce((a, e) => ({ ok: a.ok + e.results.ok, error: a.error + e.results.error }), { ok: 0, error: 0 }), { ok: 4, error: 1 });
  const wire = JSON.stringify(bodies[0].alerts) + JSON.stringify(bodies[0].activity);
  assert.ok(!/canary|CANARY|secret|Bash/u.test(wire), "no tool name, argument, output or path leaves the machine");
  for (const e of activity) for (const k of Object.keys(e.calls)) assert.ok(ACTIVITY_KINDS.includes(k));
  assert.deepEqual(extras.outbox.take(), { alerts: [], activity: [] }, "acknowledged extras are not sent again");
  assert.deepEqual(reporterExtras({}).share, { alerts: "off", activity: "off" }, "a run that shares nothing says so");
});

// ---------------------------------------------------------------------------
// H04 stacked series, H12 local days
// ---------------------------------------------------------------------------

test("H04/H12: every period's machine bands add up to its headline; the week names its zone and its days", () => {
  const { view } = demoHub();
  const steps = { "1h": [20, 3 * MINUTE], "24h": [96, 15 * MINUTE], "7d": [84, 2 * HOUR], "30d": [30, DAY] };
  for (const [key, [count, step]] of Object.entries(steps)) {
    const s = view.series[key].byDevice;
    assert.equal(s.frame.steps, count, key);
    assert.equal(s.frame.step, step, key);
    assert.ok(s.bands.length <= 4);
    const sum = s.bands.reduce((a, b) => a + b.tokens.reduce((x, y) => x + y, 0), 0) + s.rest.reduce((a, b) => a + b, 0);
    assert.equal(sum, view.windows[key].tokens.total, `${key} bands add up to the headline`);
    for (const b of s.bands) assert.ok(view.devices.some((d) => d.id === b.deviceId));
  }
  assert.equal(view.series["1h"].byDevice.frame.start, view.windows["1h"].from, "the hour's frame is its 60 whole minutes");
  const week = view.series["7d"].byLocalDay;
  assert.equal(week.tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[6].partial, true, "today is in progress");
  assert.match(week.days[0].date, /^\d{4}-\d{2}-\d{2}$/u);
  assert.ok(week.days.reduce((a, d) => a + d.tokens, 0) <= view.windows["7d"].tokens.total);
});

// ---------------------------------------------------------------------------
// H05 counts over every lane, H17 disclosure
// ---------------------------------------------------------------------------

test("H05/H17: counts come from every lane, not the 80 sent; an old root keeps its subagent", () => {
  const { store, registry } = hub({ devices: [{ id: "dev_a", label: "Studio", person: "You", local: true }, { id: "dev_b", label: "Laptop", person: "Platform engineer" }] });
  const rows = [];
  for (let i = 0; i < 100; i += 1) rows.push(rec({ device: i % 2 ? "dev_b" : "dev_a", session: "lane-" + i, project: "p" + (i % 3), at: NOW - (i % 50) * MINUTE }));
  // A root that last reported 30 hours ago and its subagent working now.
  rows.push(rec({ session: "old-root", at: NOW - 30 * HOUR }));
  rows.push(rec({ session: "child", parent: "old-root", at: NOW - MINUTE }));
  store.ingest("dev_a", rows.filter((r) => r.reportingDevice === "dev_a"));
  store.ingest("dev_b", rows.filter((r) => r.reportingDevice === "dev_b"));
  const view = buildConsole({ store, registry, now: NOW, hub: {} });
  assert.equal(view.lanes.length, LANES_SHOWN);
  assert.equal(view.laneTotals.total, 101);
  assert.equal(view.laneTotals.shown, 80);
  assert.equal(view.laneTotals.byTool["claude-code"].sessions, 101);
  assert.equal(view.laneTotals.byDevice.dev_b.sessions, 50);
  assert.equal(view.laneTotals.byPerson.You.sessions, 51);
  assert.equal(view.laneTotals.subagentCount, 1);
  assert.ok(!view.lanes.some((l) => l.key === h("child").slice(0, 16)), "a subagent is never its own lane");
  const all = Object.values(view.laneTotals.byLocalProject);
  assert.equal(all.reduce((a, p) => a + p.sessions, 0), 51, "this machine's lanes, by project");
  assert.equal(all.reduce((a, p) => a + p.subagents, 0), 1, "this machine's subagents, by project (R2-M1): from the rollup, never the rows drawn");
  for (const p of all) assert.equal(p.hourSpark.length, 20);
});

// ---------------------------------------------------------------------------
// H06 project cost, H07 identity, H08 one clock, H14 basis
// ---------------------------------------------------------------------------

test("H06/H07/H08/H14: project money names its standing; same-named folders stay apart; fleet totals share the clock", async () => {
  const { store, registry } = hub({ devices: [{ id: "dev_a", label: "Studio", local: true }, { id: "dev_b", label: "Laptop" }] });
  const paths = { [h("alpha-app")]: "/work/alpha/app", [h("beta-app")]: "/work/beta/app" };
  const names = { project: (p) => (paths[p] ? "app" : null), branch: () => "main", path: (p) => paths[p] || null };
  store.ingest("dev_a", [rec({ session: "a", project: "alpha-app", tokens: 1000 }),
    rec({ session: "a", project: "alpha-app", tokens: 500, model: "unlisted-model" }),
    rec({ session: "b", project: "beta-app", tokens: 2000 })]);
  store.ingest("dev_b", [rec({ device: "dev_b", session: "c", project: "gamma", tokens: 4000 })]);
  const p = await projectsPayload({ store, registry, names, period: "24h", demo: false, now: NOW });
  assert.equal(p.projects.length, 2, "two folders called app are two rows");
  assert.deepEqual(p.projects.map((x) => x.parent).sort(), ["alpha", "beta"]);
  const alpha = p.projects.find((x) => x.parent === "alpha");
  assert.equal(alpha.projectHash, h("alpha-app"));
  assert.equal(alpha.cost.status, "partial");
  assert.ok(alpha.cost.usd > 0);
  assert.equal(alpha.cost.unpricedTokens, 500);
  assert.deepEqual(alpha.cost.unpricedModels, ["unlisted-model"]);
  assert.equal(p.projects.find((x) => x.parent === "beta").cost.status, "priced");
  assert.equal(p.cost.status, "partial", "the payload's money is a floor when any row's is");
  assert.equal(p.computedAt, NOW);
  assert.equal(p.fleet["24h"].tokens, 7500, "the whole team, every machine");
  assert.equal(p.fleet["24h"].commits, null, "Git is read on this machine only");
  const view = buildConsole({ store, registry, now: NOW, hub: {} });
  for (const key of ["1h", "24h", "7d", "30d"]) assert.equal(p.fleet[key].tokens, view.windows[key].tokens.total, key);
  assert.deepEqual([p.period.basis, p.period.branchesKept, p.period.sessionsKept], ["minutes", true, true]);
  const month = await projectsPayload({ store, registry, names, period: "30d", demo: false, now: NOW });
  assert.deepEqual([month.period.basis, month.period.branchesKept, month.period.sessionsKept], ["utc-days", false, false]);
  const s = p.series["24h"].byProject;
  assert.equal(s.bands.reduce((a, b) => a + b.tokens.reduce((x, y) => x + y, 0), 0) + s.rest.reduce((a, b) => a + b, 0), p.tokens);
  assert.ok(s.bands.every((b) => /^[a-f0-9]{64}$/u.test(b.projectHash)), "bands are keyed by hash; names never leave the hub");
});

// ---------------------------------------------------------------------------
// H09 per machine, H10 coverage
// ---------------------------------------------------------------------------

test("H09/H10: per machine divides by the machines heard in the period; unreported coverage is unknown, never 0", () => {
  const { store, registry } = hub({ devices: [
    { id: "dev_a", label: "Studio", local: true },
    { id: "dev_b", label: "Laptop", coverage: null },
    { id: "dev_c", label: "Old box", contact: NOW - 3 * HOUR },
    { id: "dev_d", label: "Removed" },
  ] });
  registry.revoke("dev_d");
  store.ingest("dev_a", [rec({ tokens: 1_000_000 })]);
  store.ingest("dev_b", [rec({ device: "dev_b", session: "b", tokens: 1_000_000, model: "unlisted-model" })]);
  store.ingest("dev_d", [rec({ device: "dev_d", session: "d", tokens: 9_000_000 })]);
  const view = buildConsole({ store, registry, now: NOW, hub: {} });
  const hour = view.team.perMachine["1h"];
  assert.deepEqual([hour.reporting, hour.current, hour.status], [2, 3, "partial"]);
  assert.equal(hour.usdReporting, 2, "a million uncached tokens of claude-sonnet-5 at $2, never the removed machine's");
  assert.equal(hour.usdPerMachine, 1);
  assert.equal(view.team.perMachine["24h"].reporting, 3);
  const laptop = view.devices.find((d) => d.id === "dev_b");
  assert.deepEqual([laptop.coverage.reported, laptop.coverage.dropped, laptop.coverage.since], [false, null, null]);
  const studio = view.devices.find((d) => d.id === "dev_a");
  assert.deepEqual([studio.coverage.reported, studio.coverage.dropped, studio.coverage.since], [true, 0, NOW]);
});

// ---------------------------------------------------------------------------
// H11 activity
// ---------------------------------------------------------------------------

test("H11: tool names map to eight kinds on the machine; activity refuses anything else", () => {
  assert.equal(toolKind("claude-code", "Edit"), "edit");
  assert.equal(toolKind("claude-code", "Bash"), "shell");
  assert.equal(toolKind("claude-code", "mcp__private-server__lookup"), "mcp");
  assert.equal(toolKind("claude-code", "SomeNewTool"), "other");
  assert.equal(toolKind("codex", "apply_patch"), "edit");
  assert.equal(toolKind("codex", "exec_command"), "shell");
  const entry = { id: h("c1"), sessionHash: h("s"), at: "2026-09-24T15:30:00.000Z", calls: Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, 1])),
    results: { ok: 1, error: 0 }, lastTool: { kind: "edit", at: "2026-09-24T15:30:00.000Z" } };
  assert.doesNotThrow(() => activityFor([entry]));
  const { id: _id, ...noId } = entry;
  for (const bad of [{ ...entry, calls: { ...entry.calls, Bash: 1 } }, { ...entry, lastTool: { kind: "Bash", at: entry.at } },
    { ...entry, tool: "Edit" }, { ...entry, results: { ok: 1, error: 0, output: "x" } }, noId, { ...entry, id: "contribution-1" }]) {
    assert.throws(() => activityFor([bad]), /invalid/u);
  }
  assert.throws(() => activityFor([entry, { ...entry }]), /invalid/u, "one contribution id twice in one envelope");
});

test("H11: a lane's Doing reading comes from its activity; an unshared machine says so", () => {
  const { view } = demoHub();
  const shared = view.lanes.filter((l) => l.activityShared && l.state === "live");
  assert.ok(shared.length >= 4);
  for (const l of shared) {
    assert.equal(l.activity.window, "5m");
    assert.deepEqual(Object.keys(l.activity.calls).sort(), [...ACTIVITY_KINDS].sort());
  }
  assert.ok(shared.some((l) => l.lastTool && ACTIVITY_KINDS.includes(l.lastTool.kind)));
  const infra = view.lanes.find((l) => l.project.name === "infra");
  assert.ok(infra.activity.results.error > 0, "the demo's failing shell lane");
  const unshared = view.lanes.filter((l) => !l.activityShared);
  assert.ok(unshared.length >= 1);
  for (const l of unshared) {
    assert.equal(l.activity, null); assert.equal(l.lastTool, null);
    assert.ok(["off", "undeclared", "unknown"].includes(l.activityCoverage.state), l.activityCoverage.state);
    assert.ok(l.activityCoverage.reason);
  }
  for (const l of shared) assert.equal(l.activityCoverage.state, "complete");
});

test("demo: alerts tie to demo lanes, one is earlier, and two machines are not watched", () => {
  const { view } = demoHub();
  assert.ok(view.alerts.some((a) => !a.historical) && view.alerts.some((a) => a.historical));
  for (const a of view.alerts) assert.ok(a.lane && a.deviceId);
  const spike = view.alerts.find((a) => a.kind === "spike");
  assert.ok(spike.factor > 1.5, `the spike measures above normal (${spike.factor})`);
  assert.equal(view.alertsCoverage.unwatched, 2);
  assert.equal(view.devices.find((d) => d.label === "Design laptop").coverage.dropped, null);
});

// ---------------------------------------------------------------------------
// H15 prices
// ---------------------------------------------------------------------------

test("H15: every model the bench generator writes resolves to a price, the alias through its dated row", () => {
  for (const model of BENCH_MODELS) {
    const p = priceRecord({ model, fresh: 1000, output: 1000, cacheRead: 1000, cacheWrite: 0, ttl: "unknown", tier: null }, PRICES);
    assert.equal(p.status, "estimated", model);
  }
  const alias = priceRecord({ model: "claude-haiku-4-5", fresh: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, ttl: "unknown" }, PRICES);
  const dated = priceRecord({ model: "claude-haiku-4-5-20251001", fresh: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, ttl: "unknown" }, PRICES);
  assert.equal(alias.usd, dated.usd);
  for (const a of PRICES.aliases) {
    assert.match(a.source, /^https:\/\/platform\.claude\.com\//u);
    assert.match(a.verifiedOn, /^\d{4}-\d{2}-\d{2}$/u);
    assert.ok(PRICES.rows.some((r) => r.model === a.aliasOf && r.status === "verified"));
  }
  assert.equal(priceRecord({ model: "claude-haiku-4", fresh: 1, output: 0, cacheRead: 0, cacheWrite: 0, ttl: "unknown" }, PRICES).status, "unpriced",
    "no guessing beyond a published alias");
});

// ---------------------------------------------------------------------------
// F4 the period drives Team's counts and every row's sparkline
// F6 Git figures nobody could read are unknown, never 0
// ---------------------------------------------------------------------------

test("F4: sessions and tokens by tool, machine and person follow the period; 30 days says sessions are not kept", () => {
  const { store, registry } = hub({ devices: [{ id: "dev_a", label: "Studio", person: "You", local: true }, { id: "dev_b", label: "Laptop", person: "Platform engineer" }] });
  store.ingest("dev_a", [
    rec({ session: "now", at: NOW - MINUTE, tokens: 100 }),
    rec({ session: "now-child", parent: "now", at: NOW - 2 * MINUTE, tokens: 50 }),
    rec({ session: "three-hours", at: NOW - 3 * HOUR, tokens: 200 }),
  ]);
  store.ingest("dev_b", [rec({ device: "dev_b", session: "three-days", at: NOW - 3 * DAY, tokens: 400 })]);
  store.seedDaily("dev_b", { ...rec({ device: "dev_b", session: "twenty-days", at: NOW - 20 * DAY, tokens: 800 }) });
  const view = buildConsole({ store, registry, now: NOW, hub: {} });
  const p = view.laneTotals.periods;
  assert.deepEqual(Object.keys(p), ["1h", "24h", "7d", "30d"]);
  assert.equal(p["1h"].byTool["claude-code"].sessions, 1, "a subagent is folded into its lane");
  assert.equal(p["1h"].byTool["claude-code"].tokens, 150);
  assert.equal(p["24h"].byTool["claude-code"].sessions, 2);
  assert.equal(p["7d"].byTool["claude-code"].sessions, 3);
  assert.equal(p["7d"].sessions, 3);
  assert.equal(p["7d"].byPerson["Platform engineer"].sessions, 1);
  assert.equal(p["7d"].byDevice.dev_a.tokens, 350);
  assert.equal(p["30d"].sessionsKept, false);
  assert.equal(p["30d"].sessions, null);
  assert.equal(p["30d"].byTool["claude-code"].sessions, null, "never the day's count under a month's caption");
  assert.ok(p["30d"].reason.length > 0);
  assert.equal(p["30d"].byTool["claude-code"].tokens, view.windows["30d"].tokens.total);
  for (const key of ["1h", "24h", "7d", "30d"]) {
    assert.equal(Object.values(p[key].byTool).reduce((a, t) => a + t.tokens, 0), view.windows[key].tokens.total, key);
    for (const d of view.devices) {
      const spark = d.sparks[key];
      assert.equal(spark.tokens.reduce((a, n) => a + n, 0), d.windows[key].tokens.total, `${key} ${d.id} spark adds up`);
      assert.equal(spark.start, view.series[key].byDevice.frame.start);
      assert.equal(spark.step, view.series[key].byDevice.frame.step);
    }
    for (const person of view.people) assert.equal(person.sparks[key].tokens.reduce((a, n) => a + n, 0), person.windows[key].tokens.total, `${key} ${person.person}`);
  }
  assert.equal(view.devices.find((d) => d.id === "dev_b").sparks["30d"].tokens.length, 30);
});

test("F4: each project row's sparkline covers the requested period", async () => {
  const { store, registry } = hub();
  const names = { project: () => "atlas", branch: () => null, path: () => null };
  store.ingest("dev_a", [rec({ session: "a", at: NOW - 2 * DAY, tokens: 300 }), rec({ session: "a", at: NOW - MINUTE, tokens: 100 })]);
  for (const [key, steps, total] of [["1h", 20, 100], ["24h", 96, 100], ["7d", 84, 400], ["30d", 30, 400]]) {
    const p = await projectsPayload({ store, registry, names, period: key, demo: false, now: NOW });
    const spark = p.projects[0].spark;
    assert.equal(spark.tokens.length, steps, key);
    assert.equal(spark.tokens.reduce((a, n) => a + n, 0), total, key);
    assert.equal(spark.tokens.reduce((a, n) => a + n, 0), p.projects[0].tokens, key);
  }
  const legacy = await projectsPayload({ store, registry, names, period: "3d", demo: false, now: NOW });
  assert.equal(legacy.projects[0].spark, null);
});

test("F6: with no project in Git the totals are unknown with a reason, never measured zeros", async () => {
  const { store, registry } = hub();
  const names = { project: () => "scratch", branch: () => null, path: () => null };
  store.ingest("dev_a", [rec({ session: "a", tokens: 100 })]);
  const p = await projectsPayload({ store, registry, names, period: "24h", demo: false, now: NOW });
  assert.equal(p.withRepo, 0);
  assert.deepEqual([p.totals.commits, p.totals.added, p.totals.removed, p.totals.prsMerged], [null, null, null, null]);
  assert.match(p.totals.reason, /Git/u);
  const { store: s2, registry: r2, demo } = demoHub();
  const d = await projectsPayload({ store: s2, registry: r2, names: demo.names, period: "24h", demo: true, now: Date.now() });
  assert.ok(d.withRepo > 0);
  assert.ok(Number.isFinite(d.totals.commits));
  assert.equal(d.totals.reason, null);
});
