import { usageMeasurement, estimateMeasurement } from './measurement.js';
const CLASSES = Object.freeze(["fresh", "output", "cacheWrite", "cacheRead"]);
const TOKEN_FIELDS = Object.freeze([...CLASSES, "cacheWrite5m", "cacheWrite1h"]);
const BASIS = "standard-global-api-equivalent";
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const rate = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const emptyTokens = () => Object.fromEntries(TOKEN_FIELDS.map((key) => [key, 0]));

/** An offline estimate against an exact published model id; never an invoice. */
export function priceRecord(record, priceTable) {
  const model = typeof record?.model === "string" ? record.model : null;
  const unknown = (reason, verifiedOn = null) => ({ status: "unpriced", usd: null, model, verifiedOn, reason, assumptions: [],
    measurement: estimateMeasurement([record ?? {}], []) });
  if (!model) return unknown("unknown-model");
  if (priceTable?.v !== 1 || priceTable.currency !== "USD" || priceTable.basis !== BASIS || !Array.isArray(priceTable.rows)) {
    return unknown("invalid-price-table");
  }
  const matches = priceTable.rows.filter((row) => row?.model === model);
  if (matches.length === 0) return unknown("unknown-model");
  if (matches.length !== 1) return unknown("ambiguous-price-row");
  const row = matches[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.verifiedOn ?? "") ||
      typeof row.source !== "string" || !row.source.startsWith("https://") ||
      !["verified", "unpriced"].includes(row.status) ||
      !TOKEN_FIELDS.every((key) => row.usdPerMillion?.[key] === null || rate(row.usdPerMillion?.[key]))) {
    return unknown("invalid-price-row");
  }
  if (row.status === "unpriced") return unknown("unverified-model-rate", row.verifiedOn);
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
  if (components.some(([key, tokens]) => tokens > 0 && !rate(row.usdPerMillion[key]))) return unknown("unverified-token-rate", row.verifiedOn);
  const usd = components.reduce((sum, [key, tokens]) => sum + (tokens === 0 ? 0 : tokens * row.usdPerMillion[key] / 1_000_000), 0);
  if (!Number.isFinite(usd)) return unknown("estimate-overflow", row.verifiedOn);
  return { status: "estimated", usd, model, verifiedOn: row.verifiedOn, assumptions,
    measurement: estimateMeasurement([record], [{ model, verifiedOn: row.verifiedOn, source: row.source }]) };
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
