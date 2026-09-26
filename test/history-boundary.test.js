import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createStore, DEVICE_DAILY_RECORDS } from "../lib/hub/store.js";
import { createRegistry } from "../lib/hub/registry.js";
import { buildConsole } from "../lib/hub/aggregate.js";
import { eventMeasurement } from "../lib/collector/measurement.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-25T12:00:00Z");
const prices = JSON.parse(fs.readFileSync(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function record(device, at, id) {
  const r = { id: hash(id), tool: "claude-code", model: "claude-sonnet-5", sessionHash: hash("shared-session"),
    parentSessionHash: null, isSubagent: false, projectHash: hash("shared-project"), engagement: null,
    reportingDevice: device, executionOrigin: "unknown", at: new Date(at).toISOString(), fresh: 100,
    output: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 0,
    observed: true, continuation: false, tier: "standard", cumulative: false };
  r.measurement = eventMeasurement(r);
  return r;
}
function total(store) {
  let tokens = 0;
  store.eachDay("2026-08-27", "2026-09-25", (_day, bucket) => { tokens += bucket.fresh; });
  return tokens;
}

test("copied history respects retention, global identity and quota across restart", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-retention-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { dir, retentionMs: 8 * DAY, prices, now: () => NOW };
  let store = createStore(options);
  for (const device of ["dev_a", "dev_b"]) {
    // An unsupported historical-import hint cannot bypass the normal receipt.
    const result = store.ingest(device, [record(device, NOW - 20 * DAY, "old-shared")], { backfill: "2026-08-27" });
    assert.deepEqual(result, { accepted: 0, duplicate: 0, expired: 1, rejected: [] });
  }
  assert.equal(total(store), 0);
  assert.equal(store.dropped.pastRetention, 2);
  const at = NOW - 8 * DAY + 3_600_000;
  assert.equal(store.ingest("dev_a", [record("dev_a", at, "edge-shared")]).accepted, 1);
  assert.equal(store.quotaLeft("dev_a"), DEVICE_DAILY_RECORDS - 1);
  assert.equal(store.ingest("dev_b", [record("dev_b", at, "edge-shared")]).duplicate, 1);
  assert.equal(store.quotaLeft("dev_b"), DEVICE_DAILY_RECORDS);
  assert.equal(store.recordCount, 1);
  assert.equal(total(store), 100, "a copied transcript is charged to its first writer once");
  store.flush();
  store = createStore(options);
  store.load();
  assert.equal(store.ingest("dev_b", [record("dev_b", at, "edge-shared")]).duplicate, 1);
  assert.equal(total(store), 100, "restart preserves the original attribution and total");
  assert.equal(store.quotaLeft("dev_a"), DEVICE_DAILY_RECORDS - 1);
});

test("a first start with eight retained days labels the thirty-day view partial", () => {
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices, now: () => NOW });
  const registry = createRegistry({ dir: null, now: () => NOW });
  registry.addSynthetic({ id: "dev_a", label: "Studio", person: "Engineer", local: true });
  store.ingest("dev_a", [record("dev_a", NOW - DAY, "recent")]);
  const view = buildConsole({ store, registry, now: NOW, hub: {} });
  assert.equal(view.windows["30d"].partial, true);
  assert.ok(view.series["30d"].whole.some((whole) => !whole));
  assert.equal(view.windows["30d"].tokens.total, 100);
});
