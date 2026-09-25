import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createStore, DEVICE_DAILY_RECORDS } from "../lib/hub/store.js";

const NOW = Date.UTC(2026, 8, 22, 12);
const DAY = 86_400_000;
const PRICES = JSON.parse(fs.readFileSync(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function row(id) {
  return {
    id: hash(`record-${id}`), tool: "codex", model: "unknown-model",
    sessionHash: hash("session"), parentSessionHash: null, isSubagent: false,
    projectHash: hash("project"), engagement: null, reportingDevice: "device",
    executionOrigin: "unknown", at: new Date(NOW).toISOString(),
    fresh: 10, output: 5, cacheWrite: 0, cacheRead: 20,
  };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-durability-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = () => createStore({ dir, retentionMs: 8 * DAY, prices: PRICES, now: () => NOW });
  return { dir, file: path.join(dir, "records-2026-09-22.ndjson"), make, store: make() };
}
const diskError = () => Object.assign(new Error("Synthetic storage failure"), { code: "EIO" });
function checkRestart(make, count) {
  const restored = make();
  assert.equal(restored.load().loaded, count);
  assert.equal(restored.recordCount, count);
  return restored;
}

test("an append-open failure leaves no phantom ids, totals or quota usage", (t) => {
  const { file, make, store } = fixture(t);
  fs.mkdirSync(file);
  assert.throws(() => store.ingest("device", [row(1)]));
  assert.equal(store.recordCount, 0);
  assert.equal(store.sessions.size, 0);
  assert.equal(store.quotaLeft("device"), DEVICE_DAILY_RECORDS);
  let buckets = 0;
  store.eachBucket(0, Infinity, () => { buckets += 1; });
  assert.equal(buckets, 0);
  fs.rmdirSync(file);
  assert.equal(store.ingest("device", [row(1)]).accepted, 1);
  assert.equal(checkRestart(make, 1).ingest("device", [row(1)]).duplicate, 1);
});

test("short writes complete every byte and deduplicate within the same batch", (t) => {
  const { make, store } = fixture(t);
  const write = fs.writeSync.bind(fs);
  t.mock.method(fs, "writeSync", (fd, buffer, offset, length, position) => write(fd, buffer, offset, Math.min(length, 17), position));
  const receipt = store.ingest("device", [row(1), row(1), row(2)]);
  t.mock.reset();
  assert.equal(receipt.accepted, 2);
  assert.equal(receipt.duplicate, 1);
  checkRestart(make, 2);
});

test("a partial append rolls back only the new batch and permits a safe retry", (t) => {
  const { file, make, store } = fixture(t);
  store.ingest("device", [row(1)]);
  const before = fs.readFileSync(file);
  const write = fs.writeSync.bind(fs);
  let calls = 0;
  t.mock.method(fs, "writeSync", (fd, buffer, offset, _length, position) => {
    if (++calls > 1) throw diskError();
    return write(fd, buffer, offset, buffer.indexOf(10) + 8, position);
  });
  assert.throws(() => store.ingest("device", [row(2), row(3)]), { code: "EIO" });
  t.mock.reset();
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(store.recordCount, 1);
  assert.equal(store.quotaLeft("device"), DEVICE_DAILY_RECORDS - 1);
  assert.equal(store.ingest("device", [row(2), row(3)]).accepted, 2);
  checkRestart(make, 3);
});

test("an fsync failure does not acknowledge or index its batch", (t) => {
  const { make, store } = fixture(t);
  store.ingest("device", [row(1)]);
  const sync = fs.fsyncSync.bind(fs);
  let calls = 0;
  t.mock.method(fs, "fsyncSync", (fd) => { if (++calls === 1) throw diskError(); return sync(fd); });
  assert.throws(() => store.ingest("device", [row(2)]), { code: "EIO" });
  t.mock.reset();
  assert.equal(store.recordCount, 1);
  checkRestart(make, 1);
  assert.equal(store.ingest("device", [row(2)]).accepted, 1);
  checkRestart(make, 2);
});

test("a failed rollback stops ingestion until restart recovers complete lines", (t) => {
  const { make, store } = fixture(t);
  store.ingest("device", [row(1)]);
  const write = fs.writeSync.bind(fs);
  let calls = 0;
  t.mock.method(fs, "writeSync", (fd, buffer, offset, _length, position) => {
    if (++calls > 1) throw diskError();
    return write(fd, buffer, offset, buffer.indexOf(10) + 8, position);
  });
  t.mock.method(fs, "ftruncateSync", () => { throw diskError(); });
  assert.throws(() => store.ingest("device", [row(2), row(3)]), AggregateError);
  t.mock.reset();
  assert.throws(() => store.ingest("device", [row(2), row(3)]), AggregateError);
  assert.equal(store.recordCount, 1);
  const restored = make();
  assert.deepEqual(restored.load(), { loaded: 2, expired: 0, damaged: 1 });
  const retry = restored.ingest("device", [row(2), row(3)]);
  assert.equal(retry.accepted, 1);
  assert.equal(retry.duplicate, 1);
  checkRestart(make, 3);
});

test("recovery must fsync surviving rows before rebuilding the dedup index", (t) => {
  const { file, make } = fixture(t);
  fs.writeFileSync(file, JSON.stringify(row(1)) + "\n");
  const restored = make();
  t.mock.method(fs, "fsyncSync", () => { throw diskError(); });
  assert.throws(() => restored.load(), { code: "EIO" });
  assert.equal(restored.recordCount, 0);
  t.mock.reset();
  assert.equal(restored.load().loaded, 1);
  assert.equal(restored.ingest("device", [row(1)]).duplicate, 1);
});

test("a torn first line is removed so a retry remains readable after restart", (t) => {
  const { file, make } = fixture(t);
  fs.writeFileSync(file, JSON.stringify(row(1)).slice(0, 40));
  const restored = make();
  assert.deepEqual(restored.load(), { loaded: 0, expired: 0, damaged: 1 });
  assert.equal(restored.ingest("device", [row(1)]).accepted, 1);
  checkRestart(make, 1);
});

test("a zero-byte write cannot loop forever or create a phantom record", (t) => {
  const { make, store } = fixture(t);
  t.mock.method(fs, "writeSync", () => 0);
  assert.throws(() => store.ingest("device", [row(1)]), /no progress/);
  t.mock.reset();
  assert.equal(store.recordCount, 0);
  assert.equal(store.ingest("device", [row(1)]).accepted, 1);
  checkRestart(make, 1);
});

function usage(store) {
  const total = { fresh: 0, output: 0, messages: 0 };
  store.eachBucket(0, Infinity, (_minute, bucket) => {
    for (const key of Object.keys(total)) total[key] += bucket[key];
  });
  return total;
}

test("a failed cumulative append preserves the held maximum, totals and retry", (t) => {
  const { file, make, store } = fixture(t);
  const initial = { ...row(1), tool: "claude-code", cumulative: true };
  const grown = { ...initial, fresh: 30, output: 20, continuation: true };
  store.ingest("device", [initial]);
  const before = fs.readFileSync(file);
  const beforeUsage = usage(store);
  const sync = fs.fsyncSync.bind(fs);
  let calls = 0;
  t.mock.method(fs, "fsyncSync", (fd) => { if (++calls === 1) throw diskError(); return sync(fd); });
  assert.throws(() => store.ingest("device", [grown]), { code: "EIO" });
  t.mock.reset();
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(usage(store), beforeUsage);
  assert.equal(store.quotaLeft("device"), DEVICE_DAILY_RECORDS - 1);
  assert.equal(store.ingest("device", [grown]).accepted, 1);
  assert.deepEqual(usage(store), { fresh: 30, output: 20, messages: 1 });
  assert.deepEqual(usage(checkRestart(make, 1)), usage(store));
});

test("one durable batch keeps only cumulative growth across repeated identities", (t) => {
  const { make, store } = fixture(t);
  const initial = { ...row(1), tool: "claude-code", cumulative: true };
  const grown = { ...initial, fresh: 30, output: 20, continuation: true };
  const greatest = { ...grown, fresh: 40, output: 30 };
  const receipt = store.ingest("device", [initial, grown, initial, greatest, grown]);
  assert.equal(receipt.accepted, 3);
  assert.equal(receipt.duplicate, 2);
  assert.equal(store.recordCount, 1);
  assert.deepEqual(usage(store), { fresh: 40, output: 30, messages: 1 });
  const restored = checkRestart(make, 1);
  assert.deepEqual(usage(restored), usage(store));
  assert.equal(restored.ingest("device", [greatest]).duplicate, 1);
});
