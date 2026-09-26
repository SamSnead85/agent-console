/**
 * Round-3 verification of the data layer: two machines reporting the same
 * session hash, and a reporter's bounded outbox holding observations inside
 * the clock-skew allowance. Synthetic records and envelopes only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import crypto from "node:crypto";

import { createStore } from "../lib/hub/store.js";
import { createRegistry } from "../lib/hub/registry.js";
import { createFleetSignals } from "../lib/hub/fleet.js";
import { buildConsole } from "../lib/hub/aggregate.js";
import { consoleSignals, allAlerts } from "../lib/hub/routes.js";
import { ACTIVITY_KINDS, createActivityBook } from "../lib/collector/activity.js";
import { activityFor, extrasFor, postRecords } from "../lib/collector/transport.js";
import { eventMeasurement } from "../lib/collector/measurement.js";
import { createExtrasOutbox, OUTBOX_LIMITS } from "../lib/reporter-outbox.js";
import { accountingReport } from "../lib/hub/accounting.js";

const PRICES = JSON.parse(fs.readFileSync(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const h = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const iso = (ms) => new Date(ms).toISOString();
const floorMinute = (ms) => Math.floor(ms / MINUTE) * MINUTE;

function rec({ device, session = "shared", parent = null, at, tokens, id }) {
  const r = { id: h(id), tool: "claude-code", model: "claude-sonnet-5", sessionHash: h(session), parentSessionHash: parent ? h(parent) : null,
    isSubagent: Boolean(parent), projectHash: h("project"), engagement: null, reportingDevice: device, executionOrigin: "unknown",
    at: iso(floorMinute(at)), fresh: tokens, output: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 0,
    observed: true, continuation: false, tier: "standard", cumulative: false };
  r.measurement = eventMeasurement(r);
  return r;
}

test("two machines reporting the same session hash each keep their own lane, tokens and activity", () => {
  const NOW = Date.UTC(2026, 8, 26, 12, 0, 30);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => NOW });
  const registry = createRegistry({ dir: null, now: () => NOW });
  for (const [id, label] of [["dev_a", "Laptop"], ["dev_b", "Workstation"]]) {
    registry.addSynthetic({ id, label, person: "Platform engineer", createdAt: iso(NOW - 9 * DAY) });
    registry.touch(id, { at: NOW, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null }, coverage: {} });
  }
  // The same session on two machines (a synced home folder): different records, 10 tokens each.
  store.ingest("dev_a", [rec({ device: "dev_a", at: NOW - 3 * MINUTE, tokens: 10, id: "a1" })]);
  store.ingest("dev_b", [rec({ device: "dev_b", at: NOW - 2 * MINUTE, tokens: 10, id: "b1" }),
    rec({ device: "dev_b", session: "child", parent: "shared", at: NOW - MINUTE, tokens: 5, id: "b2" })]);
  // Both share their tool activity: read 2 on A, 3 on B, under the one session hash.
  const fleet = createFleetSignals({ now: () => NOW, startedAt: NOW - 2 * HOUR });
  const entry = (read, id) => ({ id: h(id), sessionHash: h("shared"), at: iso(floorMinute(NOW - MINUTE)),
    calls: Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, k === "read" ? read : 0])), results: { ok: read, error: 0 }, lastTool: null });
  const share = { alerts: "on", activity: "on" };
  for (const [device, read] of [["dev_a", 2], ["dev_b", 3]]) {
    fleet.accept(device, { share }, NOW - HOUR);
    fleet.accept(device, { share, activity: activityFor([entry(read, device + "-c1")]) }, NOW);
  }
  const alert = { id: h("spike"), kind: "spike", at: NOW - MINUTE, seenAt: NOW, historical: false, sessionHash: h("shared"), count: 10, deviceId: "dev_a" };
  const view = buildConsole({ store, registry, now: NOW, hub: {}, alerts: allAlerts({ alerts: { list: () => [] }, fleet }, NOW).concat([alert]),
    signals: consoleSignals({ fleet }, NOW) });
  const lanes = view.lanes.filter((l) => l.device.id === "dev_a" || l.device.id === "dev_b");
  assert.equal(lanes.length, 2, "one lane per machine, not one lane for whichever reported last");
  const a = lanes.find((l) => l.device.id === "dev_a"), b = lanes.find((l) => l.device.id === "dev_b");
  assert.deepEqual([a.tokensDay, b.tokensDay], [10, 15], "each its own tokens (B's subagent folds into B's lane)");
  assert.deepEqual([a.activity.calls.read, b.activity.calls.read], [2, 3], "each its own activity");
  assert.deepEqual([a.agents.total, b.agents.total], [0, 1]);
  assert.notEqual(a.key, b.key, "two lanes, two keys");
  assert.deepEqual([view.devices.find((d) => d.id === "dev_a").day.tokens.total, view.devices.find((d) => d.id === "dev_b").day.tokens.total], [10, 15]);
  assert.equal(view.laneTotals.total, 2);
  assert.equal(view.windows["24h"].sessions, 3, "two top-level sessions and a subagent, per machine");
  // An alert names its machine, and opens that machine's lane.
  assert.equal(view.alerts.find((x) => x.id === h("spike")).lane.key, a.key);
  // The accounting report keeps its unit, the session hash: 25 tokens, counted once each.
  const report = accountingReport({ store, registry, from: floorMinute(NOW) - HOUR, to: floorMinute(NOW) + MINUTE });
  assert.equal(report.sessions[h("shared")].total, 20);
});

test("1001 pending contributions at now+90 s restore to an ordered loss interval, and the delivery goes on", async () => {
  const NOW = Date.UTC(2026, 8, 26, 2, 24, 30);
  const ahead = iso(floorMinute(NOW + 90_000));
  const hash = (k, v) => h(`${k}|${v}`);
  const saved = { v: 1, epoch: "a".repeat(32), seq: 1001, alerts: [], lost: [],
    activity: Array.from({ length: OUTBOX_LIMITS.activity + 1 }, (_, i) => ({ id: h("contribution-" + i), sessionHash: h("s" + i), at: ahead,
      calls: Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, k === "read" ? 1 : 0])), results: { ok: 1, error: 0 }, lastTool: null })) };
  const box = createExtrasOutbox({ activity: createActivityBook({ now: () => NOW }), now: () => NOW });
  box.journal.restore(saved, { deviceId: "dev_r", hashIdentity: hash });
  const kept = box.saved();
  assert.equal(kept.activity.length, OUTBOX_LIMITS.activity);
  assert.equal(kept.lost.length, 1);
  assert.deepEqual([kept.lost[0].from, kept.lost[0].to, kept.lost[0].count], [ahead, ahead, 1], "from is not after to");
  // The envelope passes the console's door, and its records are delivered.
  const taken = box.take();
  const share = { alerts: "off", activity: "on" };
  assert.doesNotThrow(() => extrasFor({ share, activity: taken.activity, lost: taken.lost }));
  const record = rec({ device: "dev_r", at: NOW - MINUTE, tokens: 7, id: "r1" });
  const bodies = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    extrasFor(body);   // what the console checks; it would answer 400 on a reversed interval
    return { status: 200, json: async () => ({ accepted: body.records.length, duplicate: 0, expired: 0, rejected: [] }) };
  };
  const receipt = await postRecords("http://127.0.0.1:9/api/ingest", { id: "dev_r", label: "Laptop" }, [record], { token: "t".repeat(40), fetch,
    sleep: async () => {}, freshness: { lastObservedAt: null, lastSyncedAt: null, mode: "live" }, share, ...taken });
  assert.equal(receipt.accepted, 1, "the token record is delivered");
  assert.equal(bodies[0].lost.length, 1);
  // And the console takes the marker: the minute ahead is inside the skew allowance.
  const fleet = createFleetSignals({ now: () => NOW, startedAt: NOW - 2 * HOUR });
  const out = fleet.accept("dev_r", extrasFor(bodies[0]), NOW);
  assert.deepEqual([out.lost.accepted, out.lost.future], [1, 0]);
});
