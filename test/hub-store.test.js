import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { createStore, DEVICE_DAILY_RECORDS } from "../lib/hub/store.js";
import { createRegistry } from "../lib/hub/registry.js";
import { buildConsole, deviceStatus } from "../lib/hub/aggregate.js";
import { eventMeasurement } from "../lib/collector/measurement.js";

const PRICES = JSON.parse(fs.readFileSync(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const DAY = 86_400_000;
const h = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

function record({ id, device, session, parent = null, project = "p", model = "claude-sonnet-5", at, fresh = 100, output = 50, cacheWrite = 200, cacheRead = 1000, engagement = null, tool = "claude-code" }) {
  const row = {
    id: h("r" + id), tool, model,
    sessionHash: h("s" + session), parentSessionHash: parent === null ? null : h("s" + parent), isSubagent: parent !== null,
    projectHash: h("p" + project), engagement, reportingDevice: device, executionOrigin: "unknown",
    at: new Date(Math.floor(at / 60_000) * 60_000).toISOString(),
    fresh, output, cacheWrite, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead, observed: true,
  };
  row.measurement = eventMeasurement(row);
  return row;
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("first writer wins: a copied record is a duplicate and never adds tokens", (t) => {
  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: scratch(t), retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const rows = [1, 2, 3].map((i) => record({ id: i, device: "dev_a", session: 1, at: now - i * 60_000 }));
  assert.deepEqual(store.ingest("dev_a", rows), { accepted: 3, duplicate: 0, expired: 0, rejected: [] });
  // the same transcript, read on another machine, reported by it
  const copies = rows.map((r) => ({ ...r, reportingDevice: "dev_b" }));
  assert.deepEqual(store.ingest("dev_b", copies), { accepted: 0, duplicate: 3, expired: 0, rejected: [] });
  let total = 0;
  store.eachBucket(0, Infinity, (_m, b) => { total += b.fresh + b.output + b.cacheWrite + b.cacheRead; assert.equal(b.deviceId, "dev_a"); });
  assert.equal(total, 3 * 1350);
});

test("records outside the window are accounted for as expired, not stored", (t) => {
  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: scratch(t), retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const receipt = store.ingest("dev_a", [
    record({ id: 1, device: "dev_a", session: 1, at: now - 9 * DAY }),
    record({ id: 2, device: "dev_a", session: 1, at: now + 2 * DAY }),
    record({ id: 3, device: "dev_a", session: 1, at: now - 60_000 }),
  ]);
  assert.deepEqual(receipt, { accepted: 1, duplicate: 0, expired: 2, rejected: [] });
  assert.equal(store.recordCount, 1);
});

test("records survive a restart in one file per day, and a day past retention is deleted whole", (t) => {
  const dir = scratch(t);
  let now = Date.UTC(2026, 8, 22, 12);
  const a = createStore({ dir, retentionMs: 2 * DAY, prices: PRICES, now: () => now });
  a.ingest("dev_a", [1, 2, 3, 4].map((i) => record({ id: i, device: "dev_a", session: 1, at: now - i * 60_000 })));
  const today = path.join(dir, "records-2026-09-22.ndjson");
  if (process.platform !== "win32") assert.equal(fs.statSync(today).mode & 0o777, 0o600);  // Windows has no POSIX modes
  const b = createStore({ dir, retentionMs: 2 * DAY, prices: PRICES, now: () => now });
  assert.deepEqual(b.load(), { loaded: 4, expired: 0, damaged: 0 });
  assert.deepEqual(b.ingest("dev_a", [record({ id: 1, device: "dev_a", session: 1, at: now - 60_000 })]).duplicate, 1);
  now += 4 * DAY;
  const c = createStore({ dir, retentionMs: 2 * DAY, prices: PRICES, now: () => now });
  c.load();
  assert.equal(c.recordCount, 0);
  assert.equal(fs.existsSync(today), false, "the expired day's file was deleted");
});

test("a damaged or hostile file cannot stop the hub from starting", (t) => {
  const dir = scratch(t);
  const now = Date.UTC(2026, 8, 22, 12);
  const good = record({ id: 1, device: "dev_a", session: 1, at: now - 60_000 });
  const lines = [
    JSON.stringify(good),
    "{not json",
    JSON.stringify({ ...record({ id: 2, device: "dev_a", session: 1, at: now - 60_000 }), sessionHash: "__proto__" }),
    JSON.stringify({ ...record({ id: 3, device: "dev_a", session: 1, at: now - 60_000 }), model: "<script>alert(1)</script>" }),
    "x".repeat(40 * 1024),
    JSON.stringify(record({ id: 4, device: "dev_a", session: 1, at: now - 120_000 })),
  ];
  // The 0.2.0 single file: read line by line, what is valid moves to today's file.
  fs.writeFileSync(path.join(dir, "records.ndjson"), lines.join("\n") + "\n");
  const store = createStore({ dir, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const tally = store.load();
  assert.equal(tally.loaded, 2);
  assert.equal(tally.damaged, 3, "unparseable, a non-hash and markup as a model are skipped; an over-long line is dropped unread");
  assert.equal(fs.existsSync(path.join(dir, "records.ndjson")), false);
  assert.equal(fs.readFileSync(path.join(dir, "records-2026-09-22.ndjson"), "utf8").trim().split("\n").length, 2);
});

test("one machine can add only its daily allowance; the hub's own machine is not limited", (t) => {
  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  assert.equal(store.quotaLeft("dev_a"), DEVICE_DAILY_RECORDS);
  store.ingest("dev_a", [1, 2, 3].map((i) => record({ id: i, device: "dev_a", session: 1, at: now - i * 60_000 })));
  assert.equal(store.quotaLeft("dev_a"), DEVICE_DAILY_RECORDS - 3);
  assert.equal(store.quotaLeft("dev_b"), DEVICE_DAILY_RECORDS);
});

test("an unreported class is a floor, not a zero, and an unpriced model is never priced at zero", (t) => {
  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const registry = createRegistry({ dir: null, now: () => now });
  registry.addSynthetic({ id: "dev_a", label: "Laptop", person: "You", createdAt: new Date(now - DAY).toISOString() });
  registry.touch("dev_a", { at: now, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null } });
  store.ingest("dev_a", [
    record({ id: 1, device: "dev_a", session: 1, at: now - 60_000, cacheWrite: null }),
    record({ id: 2, device: "dev_a", session: 1, at: now - 60_000, model: "some-internal-model" }),
  ]);
  const view = buildConsole({ store, registry, now, hub: {} });
  assert.equal(view.day.unknown.cacheWrite, 1, "one message did not report cache writes");
  assert.equal(view.day.tokens.cacheWrite, 200, "only the reported write is counted");
  assert.equal(view.day.cost.status, "unpriced", "neither record can be priced: one class unknown, one model unlisted");
  assert.equal(view.day.cost.usd, null);
  assert.deepEqual(view.day.cost.unpricedModels, ["claude-sonnet-5", "some-internal-model"]);
  const unlisted = view.day.models.find((m) => m.model === "some-internal-model");
  assert.equal(unlisted.usd, null);
});

test("cache read and cache write are shares of ALL tokens, and each machine and person is broken out", (t) => {
  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const registry = createRegistry({ dir: null, now: () => now });
  for (const [id, label, person] of [["dev_a", "Studio", "You"], ["dev_b", "Laptop", "You"], ["dev_c", "Workstation", "Platform engineer"]]) {
    registry.addSynthetic({ id, label, person, createdAt: new Date(now - DAY).toISOString() });
    registry.touch(id, { at: now, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null } });
  }
  store.ingest("dev_a", [record({ id: 1, device: "dev_a", session: 1, at: now - 60_000, fresh: 100, output: 100, cacheWrite: 200, cacheRead: 600 })]);
  store.ingest("dev_b", [record({ id: 2, device: "dev_b", session: 2, at: now - 60_000, fresh: 100, output: 100, cacheWrite: 0, cacheRead: 800 })]);
  store.ingest("dev_c", [record({ id: 3, device: "dev_c", session: 3, at: now - 60_000, model: "gpt-5.6-sol", tool: "codex", fresh: 500, output: 500, cacheWrite: 0, cacheRead: 1000 })]);
  const view = buildConsole({ store, registry, now, hub: {} });
  assert.equal(view.day.tokens.total, 4000);
  assert.equal(view.day.shares.cacheRead, 2400 / 4000);
  assert.equal(view.day.shares.cacheWrite, 200 / 4000);
  assert.equal(view.day.shares.cacheHitOnInput, 2400 / (700 + 200 + 2400), "the other reading is labelled separately");
  const you = view.people.find((p) => p.person === "You");
  assert.equal(you.devices.length, 2);
  assert.equal(you.day.tokens.total, 2000, "two machines, one person, one total");
  assert.equal(you.day.shareOfWhole, 0.5);
  assert.equal(view.devices.find((d) => d.label === "Workstation").day.models[0].model, "gpt-5.6-sol");
  assert.equal(view.day.models.find((m) => m.model === "gpt-5.6-sol").vendor, "openai");
  assert.equal(view.day.models.find((m) => m.model === "claude-sonnet-5").vendor, "anthropic");
});

test("a silent machine is not a quiet one: its lanes are unknown, it is left out of the burn, and it is named", (t) => {
  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const registry = createRegistry({ dir: null, now: () => now });
  registry.addSynthetic({ id: "dev_live", label: "Studio", person: "You", createdAt: new Date(now - DAY).toISOString() });
  registry.addSynthetic({ id: "dev_gone", label: "Build box", person: "You", createdAt: new Date(now - DAY).toISOString() });
  registry.touch("dev_live", { at: now - 5_000, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null } });
  registry.touch("dev_gone", { at: now - 40 * 60_000, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null } });
  store.ingest("dev_live", [record({ id: 1, device: "dev_live", session: 1, at: now - 60_000 })]);
  store.ingest("dev_gone", [record({ id: 2, device: "dev_gone", session: 2, at: now - 41 * 60_000 })]);
  const view = buildConsole({ store, registry, now, hub: {} });
  const gone = view.lanes.find((l) => l.device.id === "dev_gone");
  assert.equal(gone.state, "silent");
  assert.equal(gone.tokens5m, null, "unknown, never zero");
  assert.equal(view.devices.find((d) => d.id === "dev_gone").status, "silent");
  assert.deepEqual(view.burn.excluded.map((d) => d.label), ["Build box"]);
  assert.equal(view.burn.reporting, 1);
  assert.equal(view.silentSince, now - 40 * 60_000);
  assert.equal(view.day.tokens.total, 2 * 1350, "what it reported before it went silent still counts");
});

test("subagents fold into their parent's lane; agents are counted live and in total", (t) => {
  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const registry = createRegistry({ dir: null, now: () => now });
  registry.addSynthetic({ id: "dev_a", label: "Studio", person: "You", local: true, createdAt: new Date(now - DAY).toISOString() });
  registry.touch("dev_a", { at: now, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null } });
  store.ingest("dev_a", [
    record({ id: 1, device: "dev_a", session: "top", project: "atlas", at: now - 60_000 }),
    record({ id: 2, device: "dev_a", session: "kid1", parent: "top", project: "atlas", at: now - 60_000, model: "claude-haiku-4-5-20251001" }),
    record({ id: 3, device: "dev_a", session: "kid2", parent: "top", project: "atlas", at: now - 30 * 60_000 }),
  ]);
  const names = { project: (hash) => (hash === h("patlas") ? "atlas" : null), branch: () => "main" };
  const view = buildConsole({ store, registry, names, now, hub: {} });
  assert.equal(view.lanes.length, 1);
  const lane = view.lanes[0];
  assert.deepEqual(lane.agents, { live: 1, total: 2 });
  assert.equal(lane.tokensDay, 3 * 1350);
  assert.deepEqual(lane.project, { name: "atlas", source: "local" });
  assert.equal(lane.branch, "main");
  assert.equal(lane.state, "live");
});

test("a lane from another machine is named only by its own label, or a short hash", (t) => {
  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const registry = createRegistry({ dir: null, now: () => now });
  registry.addSynthetic({ id: "dev_r", label: "Laptop", person: "You", createdAt: new Date(now - DAY).toISOString() });
  registry.touch("dev_r", { at: now, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null } });
  store.ingest("dev_r", [
    record({ id: 1, device: "dev_r", session: 1, project: "a", at: now - 60_000, engagement: "mobile-app" }),
    record({ id: 2, device: "dev_r", session: 2, project: "b", at: now - 60_000 }),
  ]);
  // even a names provider that knows these hashes is ignored for a remote machine
  const names = { project: () => "leaked-local-name", branch: () => "leaked-branch" };
  const view = buildConsole({ store, registry, names, now, hub: {} });
  const sources = view.lanes.map((l) => l.project.source).sort();
  assert.deepEqual(sources, ["hash", "label"]);
  assert.ok(!JSON.stringify(view).includes("leaked-"), "a local name was applied to another machine");
  assert.match(view.lanes.find((l) => l.project.source === "hash").project.name, /^project [0-9a-f]{6}$/u);
});

test("device status: waiting, reporting, silent, removed — and hourly reporters get an hourly allowance", () => {
  const now = 10_000_000;
  assert.equal(deviceStatus({ lastContactAt: null }, now), "waiting");
  assert.equal(deviceStatus({ lastContactAt: now - 30_000, mode: "live" }, now), "reporting");
  assert.equal(deviceStatus({ lastContactAt: now - 120_000, mode: "live" }, now), "silent");
  assert.equal(deviceStatus({ lastContactAt: now - 50 * 60_000, mode: "periodic" }, now), "reporting");
  assert.equal(deviceStatus({ lastContactAt: now, revokedAt: "x" }, now), "revoked");
});

test("F3: the daily rollup outlives the minute detail, survives a restart, and answers 30 days", (t) => {
  const dir = scratch(t);
  let now = Date.UTC(2026, 8, 1, 12);
  const open = () => { const s = createStore({ dir, retentionMs: 2 * DAY, prices: PRICES, now: () => now }); s.load(); return s; };
  let store = open();
  store.ingest("dev_a", [record({ id: "old", device: "dev_a", session: 1, at: now - 60_000, fresh: 7, output: 11, cacheWrite: 0, cacheRead: 0 })]);
  store.flush();
  // Twenty days later the minute detail is long gone, and the hub has restarted.
  now += 20 * DAY;
  store = open();
  store.ingest("dev_a", [record({ id: "new", device: "dev_a", session: 2, at: now - 60_000, fresh: 1, output: 2, cacheWrite: 0, cacheRead: 0 })]);
  const registry = createRegistry({ dir: null, now: () => now });
  registry.addSynthetic({ id: "dev_a", label: "A", person: "Role A", createdAt: new Date(now - 30 * DAY).toISOString() });
  const view = buildConsole({ store, registry, now, hub: {} });
  assert.equal(view.windows["7d"].tokens.total, 3, "the minute periods hold only what retention keeps");
  assert.equal(view.windows["30d"].tokens.total, 21, "30 days include a day whose minutes were pruned");
  assert.equal(view.windows["30d"].sessions, null, "the rollup keeps no sessions, and says so");
  assert.equal(view.windows["30d"].partial, true, "the hub has not been keeping daily totals for 30 days yet, and says so");
  assert.equal(view.series["30d"].values.reduce((a, v) => a + v, 0), 21);
});

test("A2: records the hub cannot keep are counted, not silently dropped", (t) => {
  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: scratch(t), retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  store.ingest("dev_a", [record({ id: "ahead", device: "dev_a", session: 1, at: now + 3 * DAY })]);
  assert.equal(store.dropped.future, 1);
  const registry = createRegistry({ dir: null, now: () => now });
  const view = buildConsole({ store, registry, now, hub: {} });
  assert.equal(view.coverage.dropped, 1);
  assert.equal(view.coverage.reasons[0].kind, "future");
});

test("A5: the chart for each minute period is cut from the same minutes as its headline", () => {
  const now = Date.UTC(2026, 8, 22, 12, 7, 30);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const rows = [];
  for (let m = 0; m < 7 * 24 * 60; m += 37) rows.push(record({ id: "m" + m, device: "dev_a", session: m % 5, at: now - m * 60_000 }));
  for (let i = 0; i < rows.length; i += 500) store.ingest("dev_a", rows.slice(i, i + 500));
  const view = buildConsole({ store, registry: createRegistry({ dir: null, now: () => now }), now, hub: {} });
  for (const key of ["1h", "24h", "7d"]) {
    assert.equal(view.series[key].values.reduce((a, v) => a + v, 0), view.windows[key].tokens.total, key);
    assert.equal(view.windows[key].to - view.windows[key].from, { "1h": 3_600_000, "24h": DAY, "7d": 7 * DAY }[key]);
  }
  assert.equal(view.windows["24h"].tokens.total, view.day.tokens.total);
});
