/**
 * The console's readings by token class reconcile with the readings they
 * split (docs/PRINCIPLES.md §7):
 *
 * - each step of every series splits into four classes that add up to it;
 * - the estimate by class adds up to the estimate, with what could not be
 *   split by class named as `unsplitUsd`, never spread across the classes;
 * - a lane's day splits the same way, and its own estimate is what its
 *   priced records cost — null, not $0, while nothing in it is priced.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import crypto from "node:crypto";

import { createStore } from "../lib/hub/store.js";
import { createRegistry } from "../lib/hub/registry.js";
import { buildConsole } from "../lib/hub/aggregate.js";
import { eventMeasurement } from "../lib/collector/measurement.js";
import { priceRecord } from "../lib/collector/pricing.js";

const PRICES = JSON.parse(fs.readFileSync(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const DAY = 86_400_000;
const h = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const CLASSES = ["fresh", "output", "cacheWrite", "cacheRead"];
const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)), `${what}: ${a} is not ${b}`);

function record(i, { model, at, session = "s", tier = "standard", fresh = 1000, output = 500, cacheRead = 20_000, split = null, unknownClass = null }) {
  const r = { id: h("r" + i), tool: "claude-code", model, sessionHash: h(session), parentSessionHash: null, isSubagent: false,
    projectHash: h("p"), engagement: null, reportingDevice: "device-a", executionOrigin: "unknown", tier,
    at: new Date(Math.floor(at / 60_000) * 60_000).toISOString(), observed: true, continuation: false,
    fresh, output, cacheRead,
    ...(split ? { cacheWrite: split[0] + split[1], cacheWrite5m: split[0], cacheWrite1h: split[1], ttl: "split" }
      : { cacheWrite: 3000, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown" }) };
  if (unknownClass) r[unknownClass] = null;
  r.measurement = eventMeasurement(r);
  return r;
}

function console_(records, now) {
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const registry = createRegistry({ dir: null, now: () => now });
  registry.addSynthetic({ id: "device-a", label: "Laptop", person: "You", createdAt: new Date(now - DAY).toISOString() });
  registry.touch("device-a", { at: now, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null } });
  store.ingest("device-a", records);
  return buildConsole({ store, registry, now, hub: {} });
}

test("every series step splits into four classes that add up to it", () => {
  const now = Date.UTC(2026, 8, 22, 12);
  const records = [
    record(1, { model: "claude-sonnet-5", at: now - 60_000, split: [4000, 2000] }),
    record(2, { model: "claude-sonnet-5", at: now - 40 * 60_000, session: "t" }),
    record(3, { model: "some-unlisted-model", at: now - 3 * 60 * 60_000, session: "u" }),
    record(4, { model: "claude-sonnet-5", at: now - 3 * DAY, session: "v" }),
  ];
  const view = console_(records, now);
  for (const key of ["1h", "24h", "7d", "30d"]) {
    const s = view.series[key];
    assert.deepEqual(Object.keys(s.classes).sort(), [...CLASSES].sort(), key + " has the four classes");
    for (const k of CLASSES) assert.equal(s.classes[k].length, s.values.length, `${key}: ${k} has a value per step`);
    for (let i = 0; i < s.values.length; i += 1) {
      assert.equal(CLASSES.reduce((sum, k) => sum + s.classes[k][i], 0), s.values[i], `${key} step ${i}`);
    }
    assert.ok(s.values.some((v) => v > 0) === s.values.length > 0 && (key === "1h" ? s.values.some((v) => v > 0) : true), key + " carries the usage");
  }
});

test("the estimate by class adds up to the estimate, and what cannot be split is named, never spread", () => {
  const now = Date.UTC(2026, 8, 22, 12);
  const priced = [
    record(1, { model: "claude-sonnet-5", at: now - 60_000, split: [4000, 2000] }),
    record(2, { model: "claude-opus-5", at: now - 5 * 60_000, tier: "fast" }),
    record(3, { model: "claude-opus-5", at: now - 9 * 60_000, session: "t" }),
  ];
  let view = console_(priced, now);
  const c = view.day.cost;
  assert.equal(c.status, "estimated");
  const expected = priced.reduce((sum, r) => sum + priceRecord(r, PRICES).usd, 0);
  near(c.usd, expected, "the estimate is the sum of the records' prices");
  near(CLASSES.reduce((sum, k) => sum + c.byClass[k], 0) + c.byClass.unsplitUsd, c.usd, "the classes add up to the estimate");
  assert.equal(c.byClass.unsplitUsd, 0, "every bucket was of one priced model and tier, so everything splits");
  // A split-lifetime write is priced at its own two rates, so cache write is
  // not simply the flat rate: check it against the pricer directly.
  const cw = (r) => priceRecord({ ...r, fresh: 0, output: 0, cacheRead: 0 }, PRICES).usd;
  near(c.byClass.cacheWrite, priced.reduce((sum, r) => sum + cw(r), 0), "cache write by class");
  for (const k of CLASSES) assert.ok(c.byClass[k] > 0, k + " has dollars");

  // An unpriced model adds tokens and no dollars: the split still reconciles and the status says partial.
  view = console_([...priced, record(4, { model: "some-unlisted-model", at: now - 2 * 60_000, session: "u" })], now);
  assert.equal(view.day.cost.status, "partial");
  near(CLASSES.reduce((sum, k) => sum + view.day.cost.byClass[k], 0) + view.day.cost.byClass.unsplitUsd, view.day.cost.usd, "partial still reconciles");
  near(view.day.cost.byClass.fresh, c.byClass.fresh, "the unpriced model's tokens are in no class's dollars");

  // One minute, one model, one session: a record that did not report a class
  // lands in the same bucket as a priced one. That bucket's dollars cannot be
  // told apart by class, so they are carried whole as unsplit.
  view = console_([record(1, { model: "claude-sonnet-5", at: now - 60_000 }),
    record(2, { model: "claude-sonnet-5", at: now - 60_000, unknownClass: "cacheRead" })], now);
  assert.equal(view.day.cost.status, "partial");
  assert.ok(view.day.cost.byClass.unsplitUsd > 0, "the mixed bucket's dollars are unsplit");
  for (const k of CLASSES) assert.equal(view.day.cost.byClass[k], 0, k + " gets none of a mixed bucket");
  near(view.day.cost.byClass.unsplitUsd, view.day.cost.usd, "unsplit is the whole estimate here");

  // Nothing priced: unknown, not $0.
  view = console_([record(1, { model: "some-unlisted-model", at: now - 60_000 })], now);
  assert.equal(view.day.cost.byClass, null);
  assert.equal(view.day.cost.usd, null);
  // Machines and people carry the same split.
  view = console_(priced, now);
  near(CLASSES.reduce((sum, k) => sum + view.devices[0].day.cost.byClass[k], 0), view.devices[0].day.cost.usd, "machine");
  near(CLASSES.reduce((sum, k) => sum + view.people[0].day.cost.byClass[k], 0), view.people[0].day.cost.usd, "person");
});

test("a lane's day splits by class, and its estimate is what its priced records cost", () => {
  const now = Date.UTC(2026, 8, 22, 12);
  const mine = [record(1, { model: "claude-sonnet-5", at: now - 60_000, split: [4000, 2000] }),
    record(2, { model: "claude-sonnet-5", at: now - 30 * 60_000 })];
  const other = [record(3, { model: "some-unlisted-model", at: now - 60_000, session: "t" })];
  const view = console_([...mine, ...other], now);
  const lane = view.lanes.find((l) => l.key === h("s").slice(0, 16));
  const otherLane = view.lanes.find((l) => l.key === h("t").slice(0, 16));
  assert.ok(lane && otherLane);
  assert.equal(CLASSES.reduce((sum, k) => sum + lane.tokensDayByClass[k], 0), lane.tokensDay, "the classes add up to the lane's day");
  assert.equal(lane.tokensDayByClass.cacheWrite, 6000 + 3000);
  near(lane.costDay.usd, mine.reduce((sum, r) => sum + priceRecord(r, PRICES).usd, 0), "the lane's estimate");
  assert.equal(lane.costDay.status, "estimated");
  assert.equal(otherLane.costDay.usd, null, "unpriced: unknown, not $0");
  assert.equal(otherLane.costDay.status, "unpriced");
  near(lane.costDay.usd, view.day.cost.usd, "one priced lane: its estimate is the day's");
});
