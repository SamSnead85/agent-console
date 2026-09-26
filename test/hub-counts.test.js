/**
 * Counts with explicit scope: alert summaries describe the retained list;
 * Projects counts sessions as the Console counts lanes; an empty
 * minute period is a counted zero, not "not kept"; and a partial interval
 * names the cause that is true.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import crypto from "node:crypto";

import { createStore } from "../lib/hub/store.js";
import { createRegistry } from "../lib/hub/registry.js";
import { buildConsole } from "../lib/hub/aggregate.js";
import { projectsPayload } from "../lib/hub/projects.js";
import { alertsTodayOf, localDayOf } from "../lib/hub/alert-day.js";
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

// A bounded list never represents a complete durable daily alert count.

test("retained alert counts remain bounded through eviction, replay and restart", () => {
  const { store, registry } = hub([{ id: "dev_a", label: "Studio", person: "You", local: true },
    { id: "dev_b", label: "Laptop", person: "Platform engineer" }]);
  let fleet = createFleetSignals({ now: () => NOW, startedAt: NOW - 6 * HOUR });
  const alerts = Array.from({ length: 150 }, (_, i) => ({ id: h("a" + i), kind: i % 3 ? "loop" : "spike", at: iso(NOW - (150 - i) * MINUTE),
    sessionHash: h("s"), count: 5 }));
  const send = (batch) => fleet.accept("dev_b", { share: { alerts: "on", activity: "off" }, alerts: batch }, NOW);
  const view = () => buildConsole({ store, registry, now: NOW, hub: {}, alerts: allAlerts({ fleet }, NOW), signals: consoleSignals({ fleet }, NOW) });
  send(alerts);
  assert.deepEqual([view().alertsToday.count, view().alertsToday.kept, view().alertsToday.exact, view().alertsToday.since], [100, 100, false, null]);
  send(alerts.slice(0, 1)); // This identity was evicted from the bounded list.
  assert.equal(view().alertsToday.count, 100, "replay cannot increment a separate lifetime counter");
  assert.equal(view().alertsToday.exact, false, "the retained count is never claimed to be the day's full total");
  fleet = createFleetSignals({ now: () => NOW, startedAt: NOW });
  assert.deepEqual([view().alertsToday.count, view().alertsToday.lastHour, view().alertsToday.exact, view().alertsToday.since], [0, 0, false, null]);
  send(alerts.slice(-1));
  const receipt = send(alerts.slice(-1));
  assert.equal(receipt.alerts.duplicate, 1);
  assert.equal(view().alertsToday.count, 1, "only the newly retained alert is counted after restart");
  assert.equal(view().alertsToday.exact, false);
  assert.equal(view().alertsCoverage.byDevice.dev_b.reason, "console-restarted");
});

test("retained daily and hourly alerts use their own time boundaries across midnight", () => {
  const now = localDayOf(NOW).from + 5 * MINUTE;
  const reading = alertsTodayOf([
    { kind: "loop", at: now - 10 * MINUTE },
    { kind: "spike", at: now - MINUTE },
    { kind: "stall", at: now + 3 * MINUTE },
  ], now);
  assert.equal(reading.count, 1, "yesterday's and overly future alerts are outside today's list");
  assert.equal(reading.lastHour, 2, "a rolling hour can include retained alerts from yesterday");
  assert.deepEqual(reading.byKind, { loop: 0, spike: 1, stall: 0 });
  assert.equal(reading.exact, false);
  assert.equal(reading.since, null);
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
