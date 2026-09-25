/**
 * Two figures that read higher or lower than the truth in 0.2.0:
 *
 * - "messages" counted transcript records. Claude streams one API response over
 *   several lines, and each line whose usage grew is its own record, so the
 *   count ran 64% high for Claude. It now counts distinct messages.
 * - The burn panel printed "$0.00/hour est." when everything in the last five
 *   minutes ran on a model with no verified price. That is unknown, not free.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import crypto from "node:crypto";

import { parseLine } from "../lib/collector/parsers.js";
import { createStore } from "../lib/hub/store.js";
import { createRegistry } from "../lib/hub/registry.js";
import { buildConsole } from "../lib/hub/aggregate.js";
import { validateRecords } from "../lib/collector/transport.js";
import { eventMeasurement } from "../lib/collector/measurement.js";

const PRICES = JSON.parse(fs.readFileSync(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const CONSOLE_JS = fs.readFileSync(new URL("../public/console.js", import.meta.url), "utf8");
const DAY = 86_400_000;
const h = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const context = {
  hashIdentity: (kind, value) => h(kind + "|" + value),
  recordId: (tool, session, message) => h(tool + "|" + session + "|" + message),
  reportingDevice: "device-a",
};

function streamed(uuid, output, at = "2026-09-22T11:59:10.000Z") {
  return JSON.stringify({ type: "assistant", uuid, sessionId: "session-1", cwd: "/synthetic/project", timestamp: at, isSidechain: false,
    message: { id: "msg-1", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 90 } } });
}

test("one streamed Claude response is one message, however many records its lines become", () => {
  let state = {};
  const records = [];
  // Three content blocks of one response; output grows on each line.
  for (const [uuid, output] of [["line-1", 5], ["line-2", 40], ["line-3", 120]]) {
    const parsed = parseLine("claude-code", streamed(uuid, output), context, state);
    state = parsed.state;
    records.push(...parsed.records);
  }
  // A second response in the same session.
  const next = parseLine("claude-code", JSON.stringify({ type: "assistant", uuid: "line-4", sessionId: "session-1", cwd: "/synthetic/project",
    timestamp: "2026-09-22T11:59:20.000Z", isSidechain: false,
    message: { id: "msg-2", model: "claude-sonnet-5", usage: { input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 99 } } }), context, state);
  records.push(...next.records);
  assert.equal(records.length, 4, "the collector reports every line that grew a message, so no token is lost");
  assert.deepEqual(records.map((r) => r.continuation), [false, true, true, false]);
  assert.deepEqual(records.map((r) => r.output), [5, 40, 120, 9], "each is the message's running maximum");

  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const registry = createRegistry({ dir: null, now: () => now });
  registry.addSynthetic({ id: "device-a", label: "Laptop", person: "You", createdAt: new Date(now - DAY).toISOString() });
  registry.touch("device-a", { at: now, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null } });
  store.ingest("device-a", records);
  const view = buildConsole({ store, registry, now, hub: {} });
  assert.equal(view.day.messages, 2, "two API responses, not four records");
  assert.equal(view.day.tokens.output, 129, "the hub adds each reading's growth once: 120 + 9");
  assert.equal(view.day.records, 4);
  assert.equal(view.day.models[0].messages, 2);
  assert.equal(view.devices[0].day.messages, 2);
  assert.equal(view.people[0].day.messages, 2);
});

test("a 0.2.0 record without the flag is still accepted, and counts as a message as it always did", () => {
  const legacy = { id: h("legacy"), tool: "codex", model: "gpt-5.6-sol", sessionHash: h("s"), parentSessionHash: null, isSubagent: false,
    projectHash: h("p"), engagement: null, reportingDevice: "device-a", executionOrigin: "unknown", at: "2026-09-22T11:59:00.000Z",
    fresh: 1, output: 1, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 1, observed: true };
  legacy.measurement = eventMeasurement(legacy);
  assert.doesNotThrow(() => validateRecords([legacy], { id: "device-a" }));
  assert.throws(() => validateRecords([{ ...legacy, continuation: "yes" }], { id: "device-a" }), /not valid metadata/u);
  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const registry = createRegistry({ dir: null, now: () => now });
  store.ingest("device-a", [legacy]);
  assert.equal(buildConsole({ store, registry, now, hub: {} }).day.messages, 1);
});

function usageRecord(i, model, at) {
  const r = { id: h("u" + i), tool: "claude-code", model, sessionHash: h("s" + i), parentSessionHash: null, isSubagent: false,
    projectHash: h("p"), engagement: null, reportingDevice: "device-a", executionOrigin: "unknown", at: new Date(Math.floor(at / 60_000) * 60_000).toISOString(),
    fresh: 1000, output: 1000, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 1000, observed: true, continuation: false };
  r.measurement = eventMeasurement(r);
  return r;
}

test("burn on an unpriced model has no dollar rate at all, never $0.00", () => {
  const now = Date.UTC(2026, 8, 22, 12);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => now });
  const registry = createRegistry({ dir: null, now: () => now });
  registry.addSynthetic({ id: "device-a", label: "Laptop", person: "You", createdAt: new Date(now - DAY).toISOString() });
  registry.touch("device-a", { at: now, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null } });
  store.ingest("device-a", [usageRecord(1, "some-unlisted-model", now - 60_000)]);
  let view = buildConsole({ store, registry, now, hub: {} });
  assert.ok(view.burn.tokensPerMinute > 0);
  assert.equal(view.burn.usdPerMinute, null, "unknown, not zero");
  assert.equal(view.burn.cost.status, "unpriced");
  assert.deepEqual(view.burn.cost.unpricedModels, ["some-unlisted-model"]);

  // Add a priced model: now a partial estimate that names what it leaves out.
  store.ingest("device-a", [usageRecord(2, "claude-sonnet-5", now - 60_000)]);
  view = buildConsole({ store, registry, now, hub: {} });
  assert.equal(view.burn.cost.status, "partial");
  assert.ok(view.burn.usdPerMinute > 0);
  assert.ok(view.burn.cost.unpricedTokensPerMinute > 0);

  // The screen draws a void with "unpriced" for a null rate, and never passes null to money().
  assert.match(CONSOLE_JS, /D\.burn\.usdPerMinute === null\s*\?\s*"—" \+ per \+ " · unpriced"/u);
});

test("a machine's uncounted lines are said on the Team row, on a line of their own", () => {
  // Counted by reason and shown, never dropped silently; on its own line so the
  // machine column does not push the row's Remove button out of view.
  assert.match(CONSOLE_JS, /const lost = d\.coverage && d\.coverage\.dropped \? `<span class="sub"><b title=/u);
  assert.ok(CONSOLE_JS.includes('" by link" : "")}</span>${lost}</td>'), "the note follows the joined line");
});

test("the Team totals name the selected period and keep sessions apart from subagents", () => {
  assert.match(CONSOLE_JS, /const label = PERIOD_TEXT\[period\]\[1\];\s*\$\("teamTotals"\)/u);
  assert.match(CONSOLE_JS, /period === "24h" \? sessionWords\(\)/u);
  assert.match(CONSOLE_JS, /plural\(whole\.sessions, "session or subagent", "sessions and subagents"\)/u);
});
