import { usageMeasurement, estimateMeasurement } from './measurement.js';
const CLASSES = Object.freeze(["fresh", "output", "cacheWrite", "cacheRead"]);
const TOKEN_FIELDS = Object.freeze([...CLASSES, "cacheWrite5m", "cacheWrite1h"]);
const BASIS = "standard-global-api-equivalent";
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const rate = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const emptyTokens = () => Object.fromEntries(TOKEN_FIELDS.map((key) => [key, 0]));

/*
 * Which row prices a model, and whether that row is usable, depends only on
 * the table and the model id, so it is worked out once per table and model
 * rather than once per record. A loaded table is never modified.
 */
const rowCache = new WeakMap();
function rowFor(priceTable, model) {
  let byModel = rowCache.get(priceTable);
  if (!byModel) { byModel = new Map(); rowCache.set(priceTable, byModel); }
  const cached = byModel.get(model);
  if (cached) return cached;
  let found;
  const matches = priceTable.rows.filter((row) => row?.model === model);
  const row = matches[0];
  if (matches.length === 0) found = { reason: "unknown-model" };
  else if (matches.length !== 1) found = { reason: "ambiguous-price-row" };
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(row.verifiedOn ?? "") ||
      typeof row.source !== "string" || !row.source.startsWith("https://") ||
      !["verified", "unpriced"].includes(row.status) ||
      !TOKEN_FIELDS.every((key) => row.usdPerMillion?.[key] === null || rate(row.usdPerMillion?.[key])) ||
      !fastRowValid(row.fast)) {
    found = { reason: "invalid-price-row" };
  } else found = { row };
  // Model ids come from reporting machines; the cache stays small whatever they send.
  if (byModel.size < 1000) byModel.set(model, found);
  return found;
}

/*
 * Fast mode (docs/accounting.md §9) has its own verified rates, or is billed at
 * the standard rates (`billedAs: "standard"`) where the vendor says so. A row
 * without a `fast` entry leaves fast-mode usage unpriced, never at standard.
 */
function fastRowValid(fast) {
  if (fast === undefined) return true;
  if (!fast || typeof fast !== "object" || !/^\d{4}-\d{2}-\d{2}$/.test(fast.verifiedOn ?? "")
      || typeof fast.source !== "string" || !fast.source.startsWith("https://")) return false;
  if (fast.billedAs === "standard") return fast.usdPerMillion === undefined;
  return fast.billedAs === undefined && TOKEN_FIELDS.every((key) => fast.usdPerMillion?.[key] === null || rate(fast.usdPerMillion?.[key]));
}

/**
 * An offline estimate against an exact published model id; never an invoice.
 * `measurement: false` leaves out the per-record descriptor, for a caller that
 * keeps only the status and the dollars (the hub's store, once per record).
 */
export function priceRecord(record, priceTable, { measurement = true } = {}) {
  const model = typeof record?.model === "string" ? record.model : null;
  const unknown = (reason, verifiedOn = null) => ({ status: "unpriced", usd: null, model, verifiedOn, reason, assumptions: [],
    measurement: measurement ? estimateMeasurement([record ?? {}], []) : null });
  if (!model) return unknown("unknown-model");
  if (priceTable?.v !== 1 || priceTable.currency !== "USD" || priceTable.basis !== BASIS || !Array.isArray(priceTable.rows)) {
    return unknown("invalid-price-table");
  }
  const found = rowFor(priceTable, model);
  if (!found.row) return unknown(found.reason);
  const row = found.row;
  if (row.status === "unpriced") return unknown("unverified-model-rate", row.verifiedOn);
  // The tier the response was billed under: fast mode has its own rates; any
  // other service tier has none in this table and stays unpriced.
  const tier = record.tier ?? null;
  if (tier === "other") return unknown("unverified-service-tier", row.verifiedOn);
  if (tier === "fast" && !row.fast) return unknown("unverified-fast-rate", row.verifiedOn);
  const rates = tier === "fast" && row.fast.billedAs !== "standard" ? row.fast.usdPerMillion : row.usdPerMillion;
  const verifiedOn = tier === "fast" ? row.fast.verifiedOn : row.verifiedOn;
  if (!CLASSES.every((key) => count(record[key]))) return unknown("unknown-token-class", row.verifiedOn);
  if (!Array.isArray(row.assumptions) || !row.assumptions.every((item) => typeof item === "string") ||
      !["5m-assumed", "published-standard"].includes(row.cacheWriteBasis)) return unknown("invalid-price-row", row.verifiedOn);
  const assumptions = [...row.assumptions];
  const components = ["fresh", "output", "cacheRead"].map((key) => [key, record[key]]);
  // Lifetime counters are subsets of cacheWrite, never additional usage.
  const ttl = record.ttl ?? "unknown";
  if (ttl === "split") {
    if (!count(record.cacheWrite5m) || !count(record.cacheWrite1h) ||
        record.cacheWrite5m + record.cacheWrite1h !== record.cacheWrite) return unknown("invalid-cache-split", row.verifiedOn);
    components.push(["cacheWrite5m", record.cacheWrite5m], ["cacheWrite1h", record.cacheWrite1h]);
  } else if (ttl === "unknown") {
    if (record.cacheWrite5m != null || record.cacheWrite1h != null) return unknown("invalid-cache-split", row.verifiedOn);
    components.push(["cacheWrite", record.cacheWrite]);
    if (record.cacheWrite > 0) assumptions.push(row.cacheWriteBasis === "5m-assumed"
      ? "Cache-write lifetime was not reported; five-minute writes are assumed."
      : "Cache-write lifetime was not reported; the published standard cache-write rate is used.");
  } else return unknown("invalid-cache-ttl", row.verifiedOn);
  if (components.some(([key, tokens]) => tokens > 0 && !rate(rates[key]))) return unknown("unverified-token-rate", verifiedOn);
  const usd = components.reduce((sum, [key, tokens]) => sum + (tokens === 0 ? 0 : tokens * rates[key] / 1_000_000), 0);
  if (!Number.isFinite(usd)) return unknown("estimate-overflow", verifiedOn);
  if (tier === "fast") assumptions.push(row.fast.billedAs === "standard" ? "Fast mode is billed at standard rates for this model." : "Fast-mode rates.");
  return { status: "estimated", usd, model, verifiedOn, assumptions,
    measurement: measurement ? estimateMeasurement([record], [{ model, verifiedOn, source: tier === "fast" ? row.fast.source : row.source }]) : null };
}

function addTokens(target, record) {
  for (const key of TOKEN_FIELDS) {
    const next = target[key] === null || !count(record?.[key]) ? null : target[key] + record[key];
    target[key] = next !== null && Number.isSafeInteger(next) ? next : null;
  }
}

/** Input records must already be deduplicated by their ingestion id. */
export function aggregatePricing(records, priceTable, scope = {}) {
  const pricedRecords = [], unpricedRecords = [], rates = new Map();
  const priced = { records: 0, usd: 0, tokens: emptyTokens() };
  const unpriced = { records: 0, models: [], tokens: emptyTokens() };
  const models = new Set();
  const assumptions = new Map();
  for (const record of records) {
    const result = priceRecord(record, priceTable);
    const group = result.status === "estimated" ? priced : unpriced;
    (result.status === "estimated" ? pricedRecords : unpricedRecords).push(record);
    group.records += 1;
    addTokens(group.tokens, record);
    if (result.status === "estimated") {
      priced.usd += result.usd;
      for (const rate of result.measurement.source.rates) rates.set(JSON.stringify(rate), rate);
      for (const assumption of new Set(result.assumptions)) {
        const applicable = assumptions.get(assumption) ?? [];
        applicable.push(record);
        assumptions.set(assumption, applicable);
      }
    }
    else models.add(result.model ?? "unknown");
  }
  unpriced.models = [...models].sort();
  if (!Number.isFinite(priced.usd)) priced.usd = null;
  return {
    status: unpriced.records ? (priced.records ? "partial" : "unpriced") : "estimated",
    total: unpriced.records ? null : priced.usd,
    measurement: estimateMeasurement(records, [...rates.values()], scope),
    priced: { ...priced, measurement: usageMeasurement(pricedRecords, scope), usdMeasurement: estimateMeasurement(pricedRecords, [...rates.values()], scope) },
    unpriced: { ...unpriced, measurement: usageMeasurement(unpricedRecords, scope) },
    assumptions: [...assumptions].sort(([left], [right]) => left.localeCompare(right)).map(([assumption, records]) => ({ assumption, records: records.length, measurement: usageMeasurement(records, scope) })),
  };
}
