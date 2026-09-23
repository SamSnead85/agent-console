/**
 * A machine with a large backlog must finish uploading, say how far it has
 * got, and never be shown as complete before it is.
 *
 * The defect these tests pin: a reporter with 68,430 records sent them in 500
 * record batches and moved its cursor only after every batch had succeeded.
 * The hub paced it (429, wait 60 s), the reporter waited at most 4 s, gave up,
 * and started again from the first record — forever — while its window said
 * "cannot reach the hub" and the console said "Reporting · now".
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
import { failureReason } from "../lib/reporter.js";
import { createRegistry } from "../lib/hub/registry.js";
import { createStore } from "../lib/hub/store.js";
import { buildConsole } from "../lib/hub/aggregate.js";
import { createHubRoutes, INGEST_PER_MINUTE } from "../lib/hub/routes.js";
import { eventMeasurement } from "../lib/collector/measurement.js";

const PRICES = JSON.parse(await fs.readFile(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const TOKEN = "synthetic-device-token";
const DAY = 86_400_000;

async function reporterState(t, { files = 1, perFile = 1200 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-console-catchup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "logs");
  const directory = path.join(root, "state");
  await fs.mkdir(source);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "enrollment.json"), JSON.stringify({ v: 1, organizationId: "synthetic-org",
    device: { id: "device-a", label: "Laptop" }, orgSalt: Buffer.alloc(32, 9).toString("base64url") }), { mode: 0o600 });
  const at = new Date().toISOString();
  for (let f = 0; f < files; f += 1) {
    const lines = [];
    for (let i = 0; i < perFile; i += 1) {
      lines.push(JSON.stringify({ type: "assistant", uuid: `line-${f}-${i}`, sessionId: `session-${f}`, cwd: "/synthetic/project",
        timestamp: at, isSidechain: false,
        message: { id: `msg-${f}-${i}`, model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 7 } } }));
    }
    await fs.writeFile(path.join(source, `synthetic-${f}.jsonl`), lines.join("\n") + "\n");
  }
  return { directory, roots: [{ tool: "claude-code", directory: source }], prices: PRICES };
}

const accept = (envelope) => ({ status: 200, json: async () => ({ accepted: envelope.records.length, duplicate: 0, expired: 0, rejected: [] }) });

test("a delivery that stops part-way keeps every acknowledged batch and resumes from there", async (t) => {
  const state = await reporterState(t);
  const sent = [];
  let calls = 0;
  await assert.rejects(runOnce({
    ...state, post: "http://127.0.0.1:9/api/ingest", token: TOKEN,
    transport: {
      maxAttempts: 2, sleep: async () => {},
      fetch: async (_url, request) => {
        calls += 1;
        const envelope = JSON.parse(request.body);
        if (calls > 2) throw new Error("network down");
        sent.push(envelope);
        return accept(envelope);
      },
    },
  }), (error) => {
    assert.equal(error.code, "ingestion_unavailable");
    assert.equal(error.status, null, "nothing answered, and the error says so");
    assert.deepEqual(error.progress, { delivered: 1000, total: 1200 });
    return true;
  });
  assert.deepEqual(sent.map((e) => e.records.length), [500, 500]);
  assert.deepEqual(sent.map((e) => e.backlog), [{ delivered: 500, total: 1200 }, { delivered: 1000, total: 1200 }]);
  const cursor = JSON.parse(await fs.readFile(path.join(state.directory, "cursor-v2.json"), "utf8"));
  const sink = Object.values(cursor.sinks)[0];
  assert.ok(sink.offset > 0, "the acknowledged batches moved the cursor");
  assert.deepEqual(sink.catchUp, { delivered: 1000, total: 1200 });

  // The next attempt sends only what is left, and the count carries on.
  const resumed = [];
  const result = await runOnce({
    ...state, post: "http://127.0.0.1:9/api/ingest", token: TOKEN,
    transport: { fetch: async (_url, request) => { const e = JSON.parse(request.body); resumed.push(e); return accept(e); } },
  });
  assert.equal(result.emitted, 200, "the first 1,000 records were not sent again");
  assert.deepEqual(resumed.map((e) => e.backlog), [{ delivered: 1200, total: 1200 }]);
  const after = JSON.parse(await fs.readFile(path.join(state.directory, "cursor-v2.json"), "utf8"));
  assert.equal(Object.values(after.sinks)[0].catchUp, undefined, "a finished catch-up leaves no count behind");
});

test("a hub that paces a large upload with 429 and Retry-After is waited for, and the upload finishes", async (t) => {
  const state = await reporterState(t, { perFile: 1600 });
  let requests = 0, paced = 0, stored = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests += 1;
      // Two batches, then "slow down" once, like a hub at its per-minute limit.
      if (requests % 3 === 0) {
        paced += 1;
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ ok: false, reason: "reporting too often" }));
        return;
      }
      const envelope = JSON.parse(body);
      stored += envelope.records.length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: envelope.records.length, duplicate: 0, expired: 0, rejected: [] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const progress = [];
  const started = Date.now();
  const result = await runOnce({
    ...state, post: `http://127.0.0.1:${server.address().port}/api/ingest`, token: TOKEN,
    onProgress: (p) => { if (p.phase === "deliver") progress.push(p.delivered); },
  });
  assert.equal(result.emitted, 1600);
  assert.equal(stored, 1600, "every record arrived");
  assert.ok(paced >= 1, "the hub did pace the upload");
  assert.ok(Date.now() - started >= 1000, "the named wait was honoured, not cut short");
  assert.deepEqual(progress, [0, 500, 1000, 1500, 1600]);
});

test("the first read of a large set of transcripts reports its progress file by file", async (t) => {
  const state = await reporterState(t, { files: 3, perFile: 5 });
  const seen = [];
  await runOnce({ ...state, stdout: { write: (_c, done) => { done?.(); return true; }, once() {}, off() {} },
    onProgress: (p) => { if (p.phase === "scan") seen.push([p.files, p.filesTotal]); } }).catch(() => {});
  assert.deepEqual(seen, [[1, 3], [2, 3], [3, 3]]);
});

test("the reporter names the real reason a report did not go through", () => {
  const hub = "http://192.168.1.20:6787";
  const error = (status, progress) => Object.assign(new Error("x"), { code: "ingestion_unavailable", status, ...(progress ? { progress } : {}) });
  assert.equal(failureReason(error(null), hub).kind, "unreachable");
  assert.match(failureReason(error(null), hub).text, /cannot reach the hub at http:\/\/192\.168\.1\.20:6787/u);
  const paced = failureReason(error(429, { delivered: 12_000, total: 68_430 }), hub);
  assert.equal(paced.kind, "paced");
  assert.doesNotMatch(paced.text, /cannot reach/u, "a paced upload is not an unreachable hub");
  assert.match(paced.text, /12,000 of 68,430 records sent so far/u);
  assert.equal(failureReason(error(503), hub).kind, "hub-error");
  assert.equal(failureReason(Object.assign(new Error("x"), { code: "ingestion_refused", status: 400 }), hub).kind, "refused");
});

// ---- the hub side ----------------------------------------------------------

const h = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
function row(i, device, at) {
  const r = { id: h("r" + i), tool: "claude-code", model: "claude-sonnet-5", sessionHash: h("s1"), parentSessionHash: null, isSubagent: false,
    projectHash: h("p"), engagement: null, reportingDevice: device, executionOrigin: "unknown", at: new Date(Math.floor(at / 60_000) * 60_000).toISOString(),
    fresh: 10, output: 4, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 7, observed: true, continuation: false };
  r.measurement = eventMeasurement(r);
  return r;
}

function hubFor(now) {
  const registry = createRegistry({ dir: null, now: () => now });
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const config = { demo: false, listen: "0.0.0.0", retentionDays: 8, inviteMinutes: 30 };
  const handle = createHubRoutes({ config, registry, store, names: null, local: null, version: "0.0.0", root: process.cwd() });
  const { code } = registry.invite({ person: "You", machine: "Laptop" });
  const { device, token } = registry.redeem(code);
  async function ingest(envelope) {
    const answer = { status: 0, body: null, headers: {} };
    const req = { method: "POST", headers: { authorization: "Bearer " + token, host: "192.168.1.20:6787" }, socket: { remoteAddress: "192.168.1.30" } };
    const res = { setHeader: (k, v) => { answer.headers[k.toLowerCase()] = v; } };
    await handle(req, res, "/api/ingest", {
      readBody: async () => envelope,
      sendJson: (_res, status, body) => { answer.status = status; answer.body = body; },
      send: () => {}, port: 6787,
    });
    return answer;
  }
  return { registry, store, device, ingest };
}

test("the hub lets a first sync through, and paces beyond that with a named wait", async () => {
  const now = Date.UTC(2026, 8, 22, 12);
  const { device, ingest } = hubFor(now);
  // 68,430 records is 137 batches: well inside one minute's allowance.
  assert.ok(Math.ceil(68_430 / 500) <= INGEST_PER_MINUTE);
  let last;
  for (let i = 0; i <= INGEST_PER_MINUTE; i += 1) {
    last = await ingest({ v: 1, device: { id: device.id, label: device.label }, freshness: { lastObservedAt: null, lastSyncedAt: null, mode: "live" }, records: [] });
    if (i < INGEST_PER_MINUTE) assert.equal(last.status, 200);
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers["retry-after"]) > 0, "a 429 says how long to wait");
});

test("a machine still sending its backlog is 'catching up · N of M', left out of right now, never 'Reporting'", async () => {
  const now = Date.UTC(2026, 8, 22, 12);
  const { registry, store, device, ingest } = hubFor(now);
  const envelope = (records, backlog) => ({ v: 1, device: { id: device.id, label: device.label },
    freshness: { lastObservedAt: null, lastSyncedAt: null, mode: "live" }, records, backlog });
  const first = await ingest(envelope([row(1, device.id, now - 60_000)], { delivered: 12_000, total: 68_430 }));
  assert.equal(first.status, 200);
  let view = buildConsole({ store, registry, now, hub: {} });
  let d = view.devices.find((x) => x.id === device.id);
  assert.equal(d.status, "catching-up");
  assert.deepEqual(d.backlog, { delivered: 12_000, total: 68_430 });
  assert.equal(view.burn.reporting, 0, "its partial figures are not a rate for right now");
  assert.deepEqual(view.burn.excluded.map((x) => [x.label, x.status]), [["Laptop", "catching-up"]]);
  assert.equal(view.lanes[0].state, "catching-up");
  assert.equal(view.lanes[0].tokens5m, null, "unknown, not zero");

  // A malformed count is refused like any other malformed envelope.
  assert.equal((await ingest(envelope([], { delivered: 5, total: 2 }))).status, 400);

  // The last batch arrives: now it is reporting.
  await ingest(envelope([row(2, device.id, now - 60_000)], { delivered: 68_430, total: 68_430 }));
  view = buildConsole({ store, registry, now, hub: {} });
  d = view.devices.find((x) => x.id === device.id);
  assert.equal(d.status, "reporting");
  assert.equal(d.backlog, null);
});

test("the console's own first read records its progress for the screen", async (t) => {
  const { startLocalCollection } = await import("../lib/hub/local.js");
  const state = await reporterState(t, { files: 3, perFile: 4 });
  const now = Date.now();
  const registry = createRegistry({ dir: null, now: () => now });
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const hubDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-console-hub-"));
  t.after(() => fs.rm(hubDir, { recursive: true, force: true }));
  const names = { set() {}, save() {}, project: () => null, branch: () => null };
  const local = startLocalCollection({ registry, store, names, stateDir: hubDir, roots: state.roots, intervalMs: 60_000 });
  t.after(() => local.stop());
  await local.ready;
  assert.deepEqual(local.status.progress, { files: 3, filesTotal: 3, records: 12 });
  assert.equal(local.status.firstRunComplete, true);
});
