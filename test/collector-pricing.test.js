import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { aggregatePricing, priceRecord } from "../lib/collector/pricing.js";
import { estimateMeasurement, usageMeasurement } from "../lib/collector/measurement.js";

const prices = JSON.parse(await readFile(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const record = (changes = {}) => ({ model: "claude-opus-4-6", fresh: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 1_000_000, ...changes });

test("all four disjoint token classes contribute at their own rates", () => {
  assert.deepEqual(priceRecord(record(), prices), { status: "estimated", usd: 36.75, model: "claude-opus-4-6", verifiedOn: "2026-09-20", assumptions: ["Cache-write lifetime was not reported; five-minute writes are assumed."], measurement: estimateMeasurement([record()], [{model:"claude-opus-4-6", verifiedOn:"2026-09-20", source:"https://platform.claude.com/docs/en/about-claude/pricing"}]) });
  assert.equal(priceRecord(record({ fresh: 0, output: 0, cacheWrite: 0 }), prices).usd, 0.5);
});

test("an internal, unknown, or near-matching model is never priced as a public model", () => {
  for (const model of ["synthetic-internal-model", "claude-opus-4-6-custom", "CLAUDE-OPUS-4-6", "claude-opus-4-6 ", null]) {
    const result = priceRecord(record({ model }), prices);
    assert.equal(result.status, "unpriced");
    assert.equal(result.usd, null);
  }
});

test("unreported, negative, fractional and unsafe usage never becomes zero", () => {
  for (const cacheWrite of [null, undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0"]) {
    const result = priceRecord(record({ cacheWrite }), prices);
    assert.equal(result.status, "unpriced");
    assert.equal(result.reason, "unknown-token-class");
    assert.equal(result.usd, null);
  }
});

test("known zero usage remains an estimated zero, distinct from unknown", () => {
  assert.equal(priceRecord(record({ fresh: 0, output: 0, cacheWrite: 0, cacheRead: 0 }), prices).usd, 0);
  assert.equal(priceRecord(record({ fresh: 0, output: 0, cacheWrite: 0, cacheRead: 0, model: "unlisted" }), prices).usd, null);
});

test("a missing rate or ambiguous table fails closed", () => {
  const opus = prices.rows.find(row => row.model === "claude-opus-4-6");
  for (const table of [null, { ...prices, currency: "EUR" }, { ...prices, rows: [...prices.rows, opus] }, { ...prices, rows: [{ ...opus, usdPerMillion: { fresh: 5, output: 25, cacheRead: 0.5 } }] }]) {
    assert.equal(priceRecord(record(), table).status, "unpriced");
  }
});

test("mixed aggregates preserve priced subtotal and the unpriced stratum", () => {
  const result = aggregatePricing([record(), record({ model: "unlisted" })], prices);
  assert.equal(result.status, "partial");
  assert.equal(result.total, null);
  assert.equal(result.priced.usd, 36.75);
  assert.equal(result.priced.records, 1);
  assert.equal(result.unpriced.records, 1);
  assert.deepEqual(result.unpriced.models, ["unlisted"]);
  assert.equal(result.unpriced.tokens.cacheRead, 1_000_000);
  assert.deepEqual(result.assumptions, [{ assumption: "Cache-write lifetime was not reported; five-minute writes are assumed.", records: 1, measurement: usageMeasurement([record()]) }]);
});

test("null usage stays unknown through aggregation and grouping", () => {
  const result = aggregatePricing([record({ cacheWrite: null }), record({ cacheWrite: 4, model: "unlisted" })], prices);
  assert.equal(result.status, "unpriced");
  assert.equal(result.total, null);
  assert.equal(result.unpriced.tokens.cacheWrite, null);
  assert.equal(result.unpriced.tokens.output, 2_000_000);
  assert.deepEqual(result.unpriced.models, ["claude-opus-4-6", "unlisted"]);
});

test("fully priced aggregation totals estimates without rounding each event", () => {
  const result = aggregatePricing([record({ fresh: 1, output: 0, cacheWrite: 0, cacheRead: 0 }), record({ fresh: 1, output: 0, cacheWrite: 0, cacheRead: 0 })], prices);
  assert.equal(result.status, "estimated");
  assert.equal(result.total, 0.00001);
  assert.equal(result.unpriced.records, 0);
});

test("every bundled row names its verification date and exact public source", () => {
  for (const row of prices.rows) {
    assert.match(row.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(row.source, /^https:\/\/(platform\.claude\.com|developers\.openai\.com)\//);
    if (row.status === "unpriced") {
      assert.ok(Object.values(row.usdPerMillion).every(value => value === null));
      assert.equal(priceRecord(record({ model: row.model }), prices).status, "unpriced");
    } else assert.equal(priceRecord(record({ model: row.model, cacheWrite: 0 }), prices).status, "estimated");
  }
});

test("Fable 5.1 uses its own cache-read price instead of the older 10 percent rule", () => {
  const onlyReads = { fresh: 0, output: 0, cacheWrite: 0, cacheRead: 1_000_000 };
  assert.equal(priceRecord(record({ ...onlyReads, model: "claude-fable-5-1" }), prices).usd, 0.25);
  assert.equal(priceRecord(record({ ...onlyReads, model: "claude-fable-5" }), prices).usd, 1);
});

test("reported lifetime components replace the total charge and never add to it", () => {
  const split = record({ fresh: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite5m: 400_000, cacheWrite1h: 600_000, ttl: "split" });
  const result = priceRecord(split, prices);
  assert.equal(result.usd, 8.5);
  assert.deepEqual(result.assumptions, []);
  const aggregate = aggregatePricing([split, split], prices);
  assert.equal(aggregate.total, 17);
  assert.equal(aggregate.priced.tokens.cacheWrite, 2_000_000);
  assert.equal(aggregate.priced.tokens.cacheWrite1h, 1_200_000);
});

test("invalid and partially known lifetime splits are never silently clamped or downgraded", () => {
  for (const changes of [
    { ttl: "split", cacheWrite5m: null, cacheWrite1h: 0 },
    { ttl: "split", cacheWrite5m: 1_000_000, cacheWrite1h: 1 },
    { ttl: "split", cacheWrite5m: -1, cacheWrite1h: 1_000_001 },
    { ttl: "unknown", cacheWrite5m: null, cacheWrite1h: 50 },
    { ttl: "invented" },
  ]) assert.equal(priceRecord(record(changes), prices).status, "unpriced");
});

test("OpenAI uses verified standard cache writes and labels context assumptions", () => {
  const result = priceRecord(record({ model: "gpt-5.6-sol" }), prices);
  assert.equal(result.usd, 29.4);
  assert.ok(result.assumptions.some(value => value.includes("Short-context")));
  assert.ok(result.assumptions.some(value => value.includes("published standard cache-write")));
  const unsupportedLifetime = priceRecord(record({ model: "gpt-5.6-sol", ttl: "split", cacheWrite5m: 1_000_000, cacheWrite1h: 0 }), prices);
  assert.equal(unsupportedLifetime.status, "unpriced");
  assert.equal(unsupportedLifetime.reason, "unverified-token-rate");
});

test("a missing public token rate is distinct from a known zero usage class", () => {
  assert.equal(priceRecord(record({ model: "gpt-5.5", cacheWrite: 0 }), prices).usd, 35.5);
  assert.equal(priceRecord(record({ model: "gpt-5.5", cacheWrite: 1 }), prices).reason, "unverified-token-rate");
  assert.equal(priceRecord(record({ model: "gpt-5.5", cacheWrite: null }), prices).reason, "unknown-token-class");
});

test("Claude Opus 5.5 is priced from Anthropic's published page: $4 in, $20 out, $5/$8 writes, $0.20 hits", () => {
  const row = prices.rows.find((r) => r.model === "claude-opus-5-5");
  assert.equal(row.source, "https://platform.claude.com/docs/en/about-claude/pricing");
  assert.equal(row.verifiedOn, "2026-09-22");
  const million = record({ model: "claude-opus-5-5", fresh: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000,
    ttl: "split", cacheWrite5m: 500_000, cacheWrite1h: 500_000 });
  assert.equal(priceRecord(million, prices).usd, 4 + 20 + 0.2 + 2.5 + 4);
});

test("the complete checked local model inventory has one explicit price standing per id", () => {
  const inventory = [
    "claude-fable-5", "claude-fable-5-1", "claude-haiku-4-5-20251001", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-sonnet-5",
    "codex-auto-review", "gpt-5.2", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-sol", "gpt-reserve",
  ];
  assert.deepEqual(prices.rows.map(row => row.model).sort(), inventory.sort());
  assert.deepEqual(prices.rows.filter(row => row.status === "unpriced").map(row => row.model).sort(), ["codex-auto-review", "gpt-5.3-codex-spark", "gpt-reserve"]);
  for (const row of prices.rows.filter(row => row.status === "unpriced")) {
    assert.equal(priceRecord(record({ model: row.model, fresh: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), prices).usd, null);
  }
});
