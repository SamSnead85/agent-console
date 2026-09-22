import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { isPrivateHost, postRecords } from "../lib/collector/transport.js";
import { parseLine } from "../lib/collector/parsers.js";
import { eventMeasurement } from "../lib/collector/measurement.js";

const TOKEN = "SENTINEL_DEVICE_CREDENTIAL";
const URL = "https://example.invalid/api/ingest";
const DEVICE = { id: "device-synthetic", label: "Synthetic workstation" };
const record = (id = "record-1") => { const row = { id, tool: "codex", model: "synthetic-model", sessionHash: "hashed-session", parentSessionHash: null,
  isSubagent: false, projectHash: "hashed-project", engagement: null, reportingDevice: DEVICE.id, executionOrigin: "unknown",
  at: "2026-09-20T12:00:00.000Z", fresh: 12,
  output: 7, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 3, observed: true }; return { ...row, measurement: eventMeasurement(row) }; };
const response = value => ({ status: 200, json: async () => value });
const receipt = (accepted = 1, duplicate = 0, rejected = []) => ({ accepted, duplicate, rejected });
const delivered = (accepted = 1, duplicate = 0, rejected = [], expired = 0) => ({ accepted, duplicate, expired, rejected });

function safeError(error) {
  assert.equal(error.name, "CollectorTransportError");
  assert.doesNotMatch(String(error), /SENTINEL_|example\.invalid|private-body/);
  assert.equal(error.cause, undefined);
  return true;
}

test("sends only metadata envelopes in batches of 500, aggregating complete receipts", async () => {
  const batches = [];
  const result = await postRecords(URL, DEVICE, Array.from({ length: 1001 }, (_, id) => record(`record-${id}`)), {
    token: TOKEN,
    fetch: async (url, request) => {
      assert.equal(url, URL);
      assert.equal(request.redirect, "error");
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(request.cache, "no-store");
      assert.ok(request.signal instanceof AbortSignal);
      const envelope = JSON.parse(request.body);
      assert.deepEqual(Object.keys(envelope), ["v", "device", "freshness", "records"]);
      assert.equal(envelope.v, 1);
      assert.deepEqual(envelope.device, DEVICE);
      assert.deepEqual(envelope.freshness, { lastObservedAt: "2026-09-20T12:00:00.000Z", lastSyncedAt: null, mode: "periodic" });
      batches.push(envelope.records.length);
      assert.ok(!request.body.includes(TOKEN));
      return response(receipt(envelope.records.length - 1, 1));
    },
  });
  assert.deepEqual(batches, [500, 500, 1]);
  assert.deepEqual(result, delivered(998, 3));
});

test("retries network and transient HTTP failures with bounded exponential backoff", async () => {
  let attempts = 0;
  const waits = [];
  const result = await postRecords(URL, DEVICE, [record()], {
    token: TOKEN, baseDelayMs: 10, maxDelayMs: 15,
    sleep: async milliseconds => { waits.push(milliseconds); },
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error(`${URL} ${TOKEN}`);
      if (attempts === 2) return { status: 429 };
      if (attempts === 3) return { status: 503 };
      return response(receipt(1));
    },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [10, 15, 15]);
  assert.deepEqual(result, delivered(1));
});

test("stops after bounded retries without exposing network error text", async () => {
  let attempts = 0;
  await assert.rejects(postRecords(URL, DEVICE, [record()], {
    token: TOKEN, maxAttempts: 3, sleep: async () => {}, fetch: async () => { attempts += 1; throw new Error(`${TOKEN} private-body ${URL}`); },
  }), safeError);
  assert.equal(attempts, 3);
});

test("honors numeric and dated Retry-After on 429 and 503 within the configured delay bound", async () => {
  const now = Date.parse("2026-09-20T12:00:00Z");
  for (const [status, header, expected] of [
    [429, "3", 3000],
    [503, "Sun, 20 Sep 2026 12:00:02 GMT", 2000],
    [429, "99", 4000],
    [503, "Sun, 20 Sep 2026 12:01:00 GMT", 4000],
    [429, "Sun, 20 Sep 2026 11:59:00 GMT", 250],
    [503, "invalid", 250],
    [500, "3", 250],
  ]) {
    let attempts = 0;
    const waits = [];
    await postRecords(URL, DEVICE, [record()], {
      token: TOKEN, now: () => now, maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 4000,
      sleep: async milliseconds => { waits.push(milliseconds); },
      fetch: async () => ++attempts === 1 ? { status, headers: new Headers({ "Retry-After": header }) } : response(receipt(1)),
    });
    assert.deepEqual(waits, [expected]);
    assert.equal(attempts, 2);
  }
});

test("permanent refusals and redirects are not retried or read as bodies", async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 403, 413]) {
    let calls = 0;
    await assert.rejects(postRecords(URL, DEVICE, [record()], {
      token: TOKEN, sleep: async () => assert.fail("permanent status was retried"),
      fetch: async () => { calls += 1; return { status, json: async () => assert.fail("error body was read") }; },
    }), safeError);
    assert.equal(calls, 1);
  }
});

test("rejects malformed, incomplete, foreign and duplicate rejection receipts", async () => {
  for (const value of [null, {}, receipt(0), receipt(2), receipt(-1, 2), receipt(0.5, 0.5),
    receipt(0, 0, [{ id: "foreign-record", because: "Unknown record" }]),
    receipt(0, 0, [{ id: "record-1", because: TOKEN }]),
    receipt(0, 0, [{ id: "record-1", because: "" }]),
    { ...receipt(1), privateBody: "SENTINEL_BODY" }]) {
    await assert.rejects(postRecords(URL, DEVICE, [record()], { token: TOKEN, fetch: async () => response(value) }), safeError);
  }
  await assert.rejects(postRecords(URL, DEVICE, [record(), record("record-2")], {
    token: TOKEN, fetch: async () => response(receipt(0, 0, [{ id: "record-1", because: "Invalid metadata" }, { id: "record-1", because: "Invalid metadata" }])),
  }), safeError);
  await assert.rejects(postRecords(URL, DEVICE, [record()], {
    token: TOKEN, fetch: async () => ({ status: 200, json: async () => { throw new Error(TOKEN); } }),
  }), safeError);
});

test("returns explicit rejections and preserves IDs for idempotent replay after a later batch fails", async () => {
  const rejected = [{ id: "record-1", because: "Unrecognized engagement" }];
  assert.deepEqual(await postRecords(URL, DEVICE, [record()], { token: TOKEN, fetch: async () => response(receipt(0, 0, rejected)) }), delivered(0, 0, rejected));
  const records = Array.from({ length: 501 }, (_, index) => record(`record-${index}`));
  const before = JSON.stringify(records);
  let batch = 0;
  await assert.rejects(postRecords(URL, DEVICE, records, {
    token: TOKEN, maxAttempts: 1, fetch: async () => (++batch === 1 ? response(receipt(500)) : { status: 503 }),
  }), safeError);
  assert.equal(JSON.stringify(records), before);
  batch = 0;
  assert.deepEqual(await postRecords(URL, DEVICE, records, {
    token: TOKEN, fetch: async () => response(++batch === 1 ? receipt(0, 500) : receipt(1)),
  }), delivered(1, 500));
});

test("refuses unsafe endpoints and accidental non-metadata fields before any upload", async () => {
  for (const url of ["not a URL", "http://example.invalid/ingest", "https://account:SENTINEL_DEVICE_CREDENTIAL@example.invalid/ingest", "file:///private-body", `${URL}#fragment`]) {
    await assert.rejects(postRecords(url, DEVICE, [record()], { token: TOKEN, fetch: async () => assert.fail("unsafe endpoint used") }), safeError);
  }
  for (const records of [[{ ...record(), prompt: "SENTINEL_PROMPT /private/SENTINEL_PATH command SENTINEL_COMMAND" }], [record(), record()], [{ ...record(), fresh: -1 }], [{ ...record(), tool: "claude" }], [{ ...record(), model: null }]]) {
    await assert.rejects(postRecords(URL, DEVICE, records, { token: TOKEN, fetch: async () => assert.fail("invalid metadata uploaded") }), safeError);
  }
});

test("reads the production token from the environment and accepts an empty batch without a request", async () => {
  const previous = process.env.AGENT_CONSOLE_TOKEN;
  try {
    process.env.AGENT_CONSOLE_TOKEN = TOKEN;
    assert.deepEqual(await postRecords(URL, DEVICE, [], { fetch: async () => assert.fail("empty request") }), delivered(0));
    await postRecords(URL, DEVICE, [record()], { fetch: async (_url, request) => { assert.equal(request.headers.authorization, `Bearer ${TOKEN}`); return response(receipt(1)); } });
    delete process.env.AGENT_CONSOLE_TOKEN;
    await assert.rejects(postRecords(URL, DEVICE, [record()], { fetch: async () => assert.fail("missing token uploaded") }), safeError);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CONSOLE_TOKEN;
    else process.env.AGENT_CONSOLE_TOKEN = previous;
  }
});

test("sends explicit freshness even with no new records and refuses invalid freshness", async () => {
  const freshness = { lastObservedAt: "2026-09-20T12:00:00.000Z", lastSyncedAt: "2026-09-20T12:05:04.123Z", mode: "periodic" };
  let calls = 0;
  const result = await postRecords(URL, DEVICE, [], {
    token: TOKEN, freshness, fetch: async (_url, request) => {
      calls += 1;
      assert.deepEqual(JSON.parse(request.body), { v: 1, device: DEVICE, freshness, records: [] });
      return response(receipt(0));
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, delivered(0));
  for (const invalid of [null, { ...freshness, mode: "realtime" }, { ...freshness, lastSyncedAt: "SENTINEL_BAD_DATE" }, { ...freshness, prompt: "SENTINEL_PROMPT" }]) {
    await assert.rejects(postRecords(URL, DEVICE, [], { token: TOKEN, freshness: invalid, fetch: async () => assert.fail("invalid freshness uploaded") }), safeError);
  }
});

test("transmits cache lifetimes without double counting and refuses inconsistent split totals or reporting devices", async () => {
  const split = { ...record(), cacheWrite: 13, cacheWrite5m: 3, cacheWrite1h: 10, ttl: "split" };
  await postRecords(URL, DEVICE, [split], { token: TOKEN, fetch: async (_url, request) => {
    assert.deepEqual(JSON.parse(request.body).records, [split]);
    return response(receipt(1));
  } });
  for (const invalid of [
    { ...split, cacheWrite: 14 }, { ...split, cacheWrite5m: null },
    { ...split, ttl: "unknown" }, { ...record(), cacheWrite5m: 0 }, { ...record(), cacheWrite1h: 0 },
    { ...split, cacheWrite: Number.MAX_SAFE_INTEGER, cacheWrite5m: Number.MAX_SAFE_INTEGER, cacheWrite1h: 1 },
    { ...split, reportingDevice: "another-device" }, { ...split, executionOrigin: "SENTINEL_RAW_HOST" },
  ]) {
    await assert.rejects(postRecords(URL, DEVICE, [invalid], { token: TOKEN, fetch: async () => assert.fail("invalid record uploaded") }), safeError);
  }
});

test("a copied intrinsic transcript from device B is entirely duplicate and changes no totals or original attribution", async () => {
  const orgSalt = "synthetic-server-issued-shared-organization-salt";
  const hash = value => createHmac("sha256", orgSalt).update(value).digest("hex");
  const usage = { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 30, cache_creation_input_tokens: 10,
    cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 7 } };
  const transcript = Buffer.from([false, true].map((isSidechain, index) => JSON.stringify({
    type: "assistant", uuid: `synthetic-intrinsic-message-${index}`, sessionId: "synthetic-parent-session",
    timestamp: `2026-09-20T12:0${index}:34.000Z`, cwd: "/synthetic/SENTINEL_PATH", isSidechain,
    ...(isSidechain ? { agentId: "synthetic-child-session" } : {}),
    message: { id: `synthetic-provider-message-${index}`, model: "claude-fable-5-1", usage, content: "SENTINEL_PROMPT" },
    command: "SENTINEL_COMMAND",
  })).join("\n") + "\n");
  const deviceA = { id: "device-A", label: "Synthetic laptop" };
  const deviceB = { id: "device-B", label: "Synthetic desktop" };
  function readCopy(bytes, device) {
    let state = {};
    let offset = 0;
    const records = [];
    for (const line of bytes.toString("utf8").trimEnd().split("\n")) {
      const parsed = parseLine("claude-code", line, {
        sourceId: `different-local-file-${device.id}`, offset,
        reportingDevice: device.id,
        hashIdentity: (kind, value) => hash(`${kind}\0${value}`),
        recordId: (tool, sessionId, messageId) => hash(`${tool}|${sessionId}|${messageId}`),
      }, state);
      state = parsed.state;
      records.push(...parsed.records.map(row => ({ ...row, engagement: null })));
      offset += Buffer.byteLength(line) + 1;
    }
    return records;
  }
  const fromA = readCopy(transcript, deviceA);
  const fromB = readCopy(Buffer.from(transcript), deviceB);
  assert.equal(fromA.length, 2);
  assert.equal(fromB.length, fromA.length);
  const intrinsic = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "reportingDevice"));
  assert.deepEqual(fromB.map(intrinsic), fromA.map(intrinsic));
  assert.equal(fromA[1].parentSessionHash, fromA[0].sessionHash);
  assert.equal(fromA[1].isSubagent, true);
  assert.ok(fromA.every(row => row.executionOrigin === "unknown"));

  const retained = new Map();
  const devices = new Map([deviceA, deviceB].map(device => [device.id, {
    lastObservedAt: null, lastSyncedAt: null, mode: "periodic",
  }]));
  let sequence = 0;
  const server = createServer(async (request, reply) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.doesNotMatch(body, /SENTINEL_PROMPT|SENTINEL_PATH|SENTINEL_COMMAND/);
      const envelope = JSON.parse(body);
      assert.equal(request.headers.authorization, `Bearer synthetic-token-${envelope.device.id}`);
      const result = receipt(0);
      for (const row of envelope.records) {
        assert.equal(row.reportingDevice, envelope.device.id);
        const first = retained.get(row.id);
        if (!first) { retained.set(row.id, structuredClone(row)); result.accepted += 1; }
        else if (JSON.stringify(intrinsic(first)) === JSON.stringify(intrinsic(row))) result.duplicate += 1;
        else result.rejected.push({ id: row.id, because: "id_conflict" });
      }
      // Receiver clock is authoritative. A copied observation updates only
      // the reporting device's sync receipt; never the retained original row.
      const previousFreshness = devices.get(envelope.device.id);
      devices.set(envelope.device.id, {
        ...(result.accepted > 0 ? envelope.freshness : previousFreshness),
        lastSyncedAt: new Date(Date.UTC(2026, 8, 20, 13, 0, ++sequence)).toISOString(),
      });
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify(result));
    } catch { reply.writeHead(400); reply.end(); }
  });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/api/ingest`;
    const freshness = { lastObservedAt: fromA.at(-1).at, lastSyncedAt: null, mode: "periodic" };
    const first = await postRecords(url, deviceA, fromA, { token: "synthetic-token-device-A", freshness });
    assert.deepEqual(first, delivered(2));
    const before = structuredClone([...retained.values()]);
    const totals = rows => Object.fromEntries(["fresh", "output", "cacheWrite", "cacheWrite5m", "cacheWrite1h", "cacheRead"]
      .map(key => [key, rows.reduce((sum, row) => sum + row[key], 0)]));
    const beforeTotals = totals(before);
    const deviceABefore = structuredClone(devices.get(deviceA.id));
    const deviceBBefore = structuredClone(devices.get(deviceB.id));
    const copied = await postRecords(url, deviceB, fromB, { token: "synthetic-token-device-B", freshness });
    assert.deepEqual(copied, delivered(0, 2));
    assert.deepEqual([...retained.values()], before);
    assert.deepEqual(totals([...retained.values()]), beforeTotals);
    assert.deepEqual(devices.get(deviceA.id), deviceABefore);
    assert.ok(devices.get(deviceB.id).lastSyncedAt > deviceABefore.lastSyncedAt);
    assert.deepEqual({ ...devices.get(deviceB.id), lastSyncedAt: null }, deviceBBefore);
    assert.ok([...retained.values()].every(row => row.reportingDevice === deviceA.id));
    const conflicting = await postRecords(url, deviceB, [{ ...fromB[0], output: fromB[0].output + 99 }], { token: "synthetic-token-device-B", freshness });
    assert.deepEqual(conflicting, delivered(0, 0, [{ id: fromB[0].id, because: "id_conflict" }]));
    assert.deepEqual([...retained.values()], before);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("a real loopback redirect cannot forward the device credential", async () => {
  let redirected = 0;
  const sink = createServer((_request, response) => { redirected += 1; response.writeHead(200); response.end(JSON.stringify(receipt(1))); });
  const source = createServer((_request, response) => { response.writeHead(307, { location: `http://127.0.0.1:${sink.address().port}/sink` }); response.end(); });
  try {
    sink.listen(0, "127.0.0.1"); await once(sink, "listening");
    source.listen(0, "127.0.0.1"); await once(source, "listening");
    await assert.rejects(postRecords(`http://127.0.0.1:${source.address().port}/ingest`, DEVICE, [record()], { token: TOKEN, maxAttempts: 1 }), safeError);
    assert.equal(redirected, 0);
  } finally {
    await Promise.all([new Promise(resolve => sink.close(resolve)), new Promise(resolve => source.close(resolve))]);
  }
});

test('a device cannot claim verified provenance or smuggle context that disagrees with its event', async () => {
  const valid=record();
  for(const measurement of [undefined,{...valid.measurement,provenance:'verified'},
    {...valid.measurement,population:{...valid.measurement.population,recordId:'another-record'}},
    {...valid.measurement,window:{kind:'event',at:'2026-09-19T12:00:00.000Z'}},
    {...valid.measurement,source:{...valid.measurement.source,path:'SENTINEL_PRIVATE_PATH'}}]) {
    await assert.rejects(postRecords(URL,DEVICE,[{...valid,measurement}],{token:TOKEN,fetch:async()=>assert.fail('invalid context uploaded')}),safeError);
  }
});

test("plain HTTP is accepted only on this machine or a private network, unless explicitly allowed", async () => {
  for (const host of ["127.0.0.1", "localhost", "10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.20", "169.254.3.4", "100.101.102.103", "studio.local", "[::1]", "[fd12:3456::1]"]) {
    assert.equal(isPrivateHost(host.replace(/^\[|\]$/g, "")), true, host);
    await postRecords(`http://${host}:6787/api/ingest`, DEVICE, [record()], { token: TOKEN, fetch: async () => response(receipt(1)) });
  }
  for (const host of ["example.invalid", "172.32.0.1", "8.8.8.8", "192.169.1.1", "100.128.0.1"]) {
    assert.equal(isPrivateHost(host), false, host);
    await assert.rejects(postRecords(`http://${host}/api/ingest`, DEVICE, [record()], { token: TOKEN, fetch: async () => assert.fail("public plain HTTP used") }), safeError);
  }
  assert.deepEqual(await postRecords("http://example.invalid/api/ingest", DEVICE, [record()], { token: TOKEN, allowHttp: true, fetch: async () => response(receipt(1)) }), delivered(1));
});

test("a hub receipt may account for records older than its retention window", async () => {
  const rows = [record("record-1"), record("record-2"), record("record-3")];
  assert.deepEqual(await postRecords(URL, DEVICE, rows, { token: TOKEN, fetch: async () => response({ accepted: 1, duplicate: 1, expired: 1, rejected: [] }) }), delivered(1, 1, [], 1));
  await assert.rejects(postRecords(URL, DEVICE, rows, { token: TOKEN, fetch: async () => response({ accepted: 1, duplicate: 1, expired: 2, rejected: [] }) }), safeError);
});

test("a refused batch keeps its HTTP status so a revoked device can be told apart", async () => {
  await assert.rejects(postRecords(URL, DEVICE, [record()], { token: TOKEN, fetch: async () => ({ status: 401 }) }),
    error => error.code === "ingestion_refused" && error.status === 401);
});
