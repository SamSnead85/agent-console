/**
 * Counts that are exact and reasons that are true (verified gaps G01, G02,
 * G12, R2-L2): the day's alerts are counted, not the length of a bounded
 * list; Projects counts sessions as the Console counts lanes; an empty
 * minute period is a counted zero, not "not kept"; and a partial interval
 * names the cause that is true.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { createStore } from "../lib/hub/store.js";
import { createRegistry } from "../lib/hub/registry.js";
import { buildConsole } from "../lib/hub/aggregate.js";
import { projectsPayload } from "../lib/hub/projects.js";
import { createAlerts } from "../lib/hub/alerts.js";
import { createAlertDay, localDayOf } from "../lib/hub/alert-day.js";
import { createFleetSignals } from "../lib/hub/fleet.js";
import { allAlerts, consoleSignals, coverageOf, RESTART_GRACE_MS } from "../lib/hub/routes.js";
import { eventMeasurement } from "../lib/collector/measurement.js";

const PRICES = JSON.parse(fs.readFileSync(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const h = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
// Midday on this machine's own calendar, so "today" is one day wherever the test runs.
const NOW = new Date(2026, 8, 25, 12, 0, 20).getTime();
const iso = (ms) => new Date(Math.floor(ms / MINUTE) * MINUTE).toISOString();

function rec({ device = "dev_a", session = "s1", parent = null, project = "p1", at = NOW - MINUTE, tokens = 1000 }) {
  const r = { id: h(`${device}|${session}|${at}|${tokens}|${Math.random()}`), tool: "claude-code", model: "claude-sonnet-5", sessionHash: h(session),
    parentSessionHash: parent ? h(parent) : null, isSubagent: Boolean(parent), projectHash: h(project), engagement: null,
    reportingDevice: device, executionOrigin: "unknown", at: iso(at),
    fresh: tokens, output: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 0, observed: true,
    continuation: false, tier: "standard", cumulative: false };
  r.measurement = eventMeasurement(r);
  return r;
}

function hub(devices = [{ id: "dev_a", label: "Studio", person: "You", local: true }]) {
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => NOW });
  const registry = createRegistry({ dir: null, now: () => NOW });
  for (const d of devices) {
    registry.addSynthetic({ id: d.id, label: d.label, person: d.person, local: Boolean(d.local), createdAt: new Date(NOW - 9 * DAY).toISOString() });
    registry.touch(d.id, { at: NOW, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null }, coverage: {} });
  }
  return { store, registry };
}

// --- G01: the day's alerts are counted, not the list's length --------------

test("G01: 150 alerts today read 150, with the 100 the list keeps named apart", () => {
  const { store, registry } = hub([{ id: "dev_a", label: "Studio", person: "You", local: true },
    { id: "dev_b", label: "Laptop", person: "Platform engineer" }]);
  const day = createAlertDay({ now: () => NOW, fromMidnight: true });
  const fleet = createFleetSignals({ now: () => NOW, startedAt: NOW - 6 * HOUR, day });
  const alerts = Array.from({ length: 150 }, (_, i) => ({ id: h("a" + i), kind: i % 3 ? "loop" : "spike", at: iso(NOW - (150 - i) * MINUTE),
    sessionHash: h("s"), count: 5 }));
  fleet.accept("dev_b", { share: { alerts: "on", activity: "off" }, alerts }, NOW);
  const view = buildConsole({ store, registry, now: NOW, hub: {}, alerts: allAlerts({ fleet }, NOW), alertDay: day.read(NOW) });
  assert.equal(view.alerts.length, 100, "the list is bounded");
  assert.equal(view.alertsToday.count, 150, "the head says 150, not 100");
  assert.equal(view.alertsToday.kept, 100);
  assert.equal(view.alertsToday.exact, true);
  assert.equal(view.alertsToday.byKind.spike + view.alertsToday.byKind.loop, 150);
  assert.equal(view.alertsToday.lastHour, 59, "live: dated within the hour, not the list's share of it");
  assert.equal(view.alertsToday.since, localDayOf(NOW).from, "whole from midnight");
  assert.equal(view.alertsToday.date, localDayOf(NOW).date);
  // A resent envelope is not counted twice.
  fleet.accept("dev_b", { share: { alerts: "on", activity: "off" }, alerts: alerts.slice(-10) }, NOW);
  assert.equal(day.read(NOW).count, 150);
});

test("G01: the local engine counts every alert it raises, and yesterday's are not today's", () => {
  const day = createAlertDay({ now: () => NOW, fromMidnight: true });
  let clock = NOW;
  const engine = createAlerts({ now: () => clock, repeat: 2, day });
  const hashIdentity = (kind, v) => h(kind + "|" + v);
  const line = (at, id) => ({ type: "assistant", timestamp: new Date(at).toISOString(),
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "same" } }] } });
  for (let i = 0; i < 6; i += 1) engine.observeLine({ tool: "claude-code", line: line(NOW - 10 * MINUTE + i * 1000, "c" + i), sessionHash: h("s"), hashIdentity });
  const raised = engine.list().length;
  assert.ok(raised > 0);
  assert.equal(day.read(NOW).count, raised);
  day.add({ kind: "loop", at: localDayOf(NOW).from - MINUTE }, NOW);
  assert.equal(day.read(NOW).count, raised, "an alert dated yesterday is not today's");
});

test("G01: the count is kept with the state and starts again at midnight", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-alert-day-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "alerts-today.json");
  let clock = NOW;
  const first = createAlertDay({ now: () => clock, file });
  assert.equal(first.read().since, NOW, "an upgrade with no count kept is whole only from now");
  for (let i = 0; i < 7; i += 1) first.add({ kind: "stall", at: NOW - i * MINUTE });
  first.stop();
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), process.platform === "win32" ? (fs.statSync(file).mode & 0o777).toString(8) : "600");
  clock = NOW + HOUR;
  const again = createAlertDay({ now: () => clock, file });
  assert.equal(again.read().count, 7, "a restart keeps the day's count");
  assert.equal(again.read().since, NOW);
  // Past midnight: a new day, counted from its midnight.
  const tomorrow = localDayOf(NOW).from + DAY + 5 * MINUTE;
  clock = tomorrow;
  assert.equal(again.read().count, 0);
  assert.equal(again.read().since, localDayOf(tomorrow).from);
  again.add({ kind: "loop", at: tomorrow - MINUTE });
  again.stop();
  // A count kept from an earlier day is continuous: the next run is whole from its midnight.
  clock = tomorrow + DAY;
  assert.equal(createAlertDay({ now: () => clock, file }).read().since, localDayOf(clock).from);
});

test("G01: without a counter the figure is the list's, and says it is not exact", () => {
  const { store, registry } = hub();
  const view = buildConsole({ store, registry, now: NOW, hub: {}, alerts: [{ id: "x", kind: "loop", at: NOW - MINUTE, sessionHash: h("s"), count: 5 }] });
  assert.deepEqual([view.alertsToday.count, view.alertsToday.kept, view.alertsToday.exact, view.alertsToday.since], [1, 1, false, null]);
});

// --- G02: Projects counts sessions as the Console counts lanes -------------

test("G02: one parent and three subagent threads are one session and three subagents", async () => {
  const { store, registry } = hub();
  store.ingest("dev_a", [rec({ session: "parent", tokens: 400 }),
    rec({ session: "sub1", parent: "parent" }), rec({ session: "sub2", parent: "parent" }),
    rec({ session: "sub3", parent: "sub2" })]);
  const names = { project: () => "atlas", branch: () => "main", path: () => null };
  const p = await projectsPayload({ store, registry, names, period: "24h", demo: false, now: NOW });
  assert.equal(p.projects.length, 1);
  assert.equal(p.projects[0].sessions, 1);
  assert.equal(p.projects[0].subagents, 3, "a subagent of a subagent folds into the same lane");
  assert.equal(p.sessions, 1);
  assert.equal(p.subagents, 3);
  const view = buildConsole({ store, registry, now: NOW, hub: {} });
  assert.equal(p.sessions, view.laneCount, "the Projects band and the lanes say the same number");
  assert.equal(view.laneTotals.subagentCount, 3);
  const month = await projectsPayload({ store, registry, names, period: "30d", demo: false, now: NOW });
  assert.deepEqual([month.projects[0].sessions, month.projects[0].subagents], [null, null], "the rollup keeps neither");
});

// --- G12: an empty minute period is a counted zero --------------------------

test("G12: an hour with no session is 0 for every machine, person and tool; the month is not kept", () => {
  const { store, registry } = hub([{ id: "dev_a", label: "Studio", person: "You", local: true },
    { id: "dev_b", label: "Workstation", person: "Platform lead" }]);
  store.ingest("dev_b", [rec({ device: "dev_b", session: "old", at: NOW - 5 * HOUR })]);
  const view = buildConsole({ store, registry, now: NOW, hub: {} });
  const hour = view.laneTotals.periods["1h"];
  assert.equal(hour.sessionsKept, true);
  assert.equal(hour.sessions, 0);
  assert.deepEqual(hour.byPerson["Platform lead"], { sessions: 0, tokens: 0 });
  assert.deepEqual(hour.byPerson.You, { sessions: 0, tokens: 0 });
  assert.deepEqual(hour.byDevice.dev_b, { sessions: 0, tokens: 0 });
  assert.deepEqual(hour.byTool["claude-code"], { sessions: 0, tokens: 0 });
  assert.equal(view.laneTotals.periods["24h"].byPerson["Platform lead"].sessions, 1);
  const month = view.laneTotals.periods["30d"];
  assert.equal(month.sessionsKept, false);
  assert.equal(month.byPerson["Platform lead"].sessions, null, "not kept: null, only here");
});

// --- R2-L2: the cause of a partial interval ---------------------------------

test("R2-L2: an \"on\" first heard two minutes after the console started means sharing started", () => {
  const T = NOW - 3 * MINUTE;
  let clock = T + 2 * MINUTE;
  const fleet = createFleetSignals({ now: () => clock, startedAt: T });
  fleet.accept("dev_b", { share: { alerts: "on", activity: "on" } }, T + 2 * MINUTE);
  clock = T + 3 * MINUTE;
  const signals = consoleSignals({ fleet }, clock);
  const c = signals.alertsCoverage({ id: "dev_b", local: false });
  assert.deepEqual(c, { state: "partial", since: T + 2 * MINUTE, reason: "sharing-started" });
});

test("R2-L2: a restart is the reason only for a first \"on\" within one report interval of the start", () => {
  const T = NOW - 10 * MINUTE, from = NOW - HOUR;
  assert.equal(coverageOf({ state: "on", since: T, after: null }, from, T).reason, "console-restarted", "this machine's own reading");
  assert.equal(coverageOf({ state: "on", since: T + 20_000, after: null }, from, T).reason, "console-restarted", "the next report after a restart");
  assert.equal(coverageOf({ state: "on", since: T + RESTART_GRACE_MS + 1, after: null }, from, T).reason, "sharing-started");
  assert.equal(coverageOf({ state: "on", since: T + 5_000, after: "off" }, from, T).reason, "sharing-started", "heard off, then on");
  assert.equal(coverageOf({ state: "on", since: T + 5_000, after: "undeclared" }, from, T).reason, "sharing-started");
  assert.equal(coverageOf({ state: "on", since: from + MINUTE, after: null }, from, from - HOUR).reason, "sharing-started", "the console ran all window");
  // Heard off and then on through the fleet: the switch is the cause.
  let clock = T + 5_000;
  const fleet = createFleetSignals({ now: () => clock, startedAt: T });
  fleet.accept("dev_b", { share: { alerts: "off", activity: "off" } }, T + 5_000);
  fleet.accept("dev_b", { share: { alerts: "on", activity: "on" } }, T + 10_000);
  clock = NOW;
  assert.equal(consoleSignals({ fleet }, NOW).alertsCoverage({ id: "dev_b", local: false }).reason, "sharing-started");
});
