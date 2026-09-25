import { eventMeasurement } from './measurement.js';
import { MODEL_ID } from './parsers.js';
import { isDeepStrictEqual } from 'node:util';
/**
 * Metadata delivery to an Agent Console hub.
 *
 * No dependency, no transcript access, no cursor mutation: this module only
 * sends an already-allowlisted envelope and insists on a complete receipt.
 * Ported from LockedIn Labs' console collector under this package's MIT
 * licence; a hosted service's endpoints and its interruption back-channel
 * were removed, because a hub is somebody's own machine, not a service.
 */
const LEGACY_RECORD_KEYS = ["id", "tool", "model", "sessionHash", "parentSessionHash", "isSubagent", "projectHash", "engagement", "reportingDevice", "executionOrigin", "at", "fresh", "output", "cacheWrite", "cacheWrite5m", "cacheWrite1h", "ttl", "cacheRead", "observed", "measurement"];
/* 0.2.1 adds `continuation`: true when a record continues an API message that an
   earlier record already counted (Claude streams one response over several
   transcript lines). It lets the hub count messages rather than records. A
   0.2.0 record, without the key, is still accepted and counts as a message. */
const V021_RECORD_KEYS = [...LEGACY_RECORD_KEYS, "continuation"];
/* 0.3.0 adds `tier`: the price tier the response was billed under ("standard",
   "fast", "other", or null when the transcript did not say). Fast mode is
   priced at its own rates (docs/accounting.md §9). Older shapes are accepted
   and price at standard rates, as they always did. */
const RECORD_KEYS = [...V021_RECORD_KEYS, "tier"];
const TIERS = ["standard", "fast", "other", null];
const RETRY_STATUS = new Set([408, 425, 429]);

function fail(code, message) {
  const error = new Error(message);
  error.name = "CollectorTransportError";
  error.code = code;
  return error;
}

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function text(value, max = 200) { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
/* The exact shapes the collector emits. The hub applies the same rules, so a
   record that is not a salted hash, a plain model id or a plain label is
   refused at the door, not stored. */
const HASH = /^[a-f0-9]{64}$/u;
const MODEL = MODEL_ID;
const LABEL = /^[a-z][a-z0-9-]{1,47}$/u;
function timestamp(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value)); }

/**
 * Plain HTTP is accepted for loopback and for private-network addresses — a
 * hub on the same desk or the same office network, reached by an address that
 * cannot route on the public internet. Anywhere else needs HTTPS, unless the
 * operator passes `allowHttp` and has read the warning that comes with it.
 * The bearer credential is never allowed into the URL itself.
 */
export function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((part) => part > 255)) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return host === "::1" || /^f[cd][0-9a-f]{2}:/u.test(host) || /^fe[89ab][0-9a-f]:/u.test(host);
}

export function endpoint(raw, options = {}) {
  let url;
  try { url = new URL(raw); } catch { throw fail("invalid_endpoint", "The hub address is not a valid URL."); }
  const plainAllowed = url.protocol === "http:" && (isPrivateHost(url.hostname) || options.allowHttp === true);
  if ((url.protocol !== "https:" && !plainAllowed) || url.username || url.password || url.hash) {
    throw fail("invalid_endpoint", "Use an HTTPS hub address, or HTTP on this machine or a private network, without credentials or a fragment.");
  }
  return url.href;
}

export function validateRecords(records, device) {
  if (!Array.isArray(records)) throw fail("invalid_metadata", "Collector records must be an array of metadata.");
  const ids = new Set();
  for (const row of records) {
    const current = exactKeys(row, RECORD_KEYS);
    const flagged = current || exactKeys(row, V021_RECORD_KEYS);
    if (!(flagged || exactKeys(row, LEGACY_RECORD_KEYS)) || (flagged && typeof row.continuation !== "boolean")
      || (current && !TIERS.includes(row.tier))
      || !HASH.test(row.id) || ids.has(row.id)
      || !isDeepStrictEqual(row.measurement, eventMeasurement(row))
      || !["claude-code", "codex"].includes(row.tool) || typeof row.model !== "string" || !MODEL.test(row.model)
      || !HASH.test(row.sessionHash) || !(row.parentSessionHash === null || HASH.test(row.parentSessionHash)) || !HASH.test(row.projectHash)
      || row.reportingDevice !== device.id || !(row.executionOrigin === "unknown" || /^[a-f0-9]{64}$/u.test(row.executionOrigin))
      || !(row.engagement === null || (typeof row.engagement === "string" && LABEL.test(row.engagement))) || typeof row.isSubagent !== "boolean" || row.observed !== true
      || typeof row.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/u.test(row.at) || !Number.isFinite(Date.parse(row.at))
      || ![row.fresh, row.output, row.cacheWrite, row.cacheWrite5m, row.cacheWrite1h, row.cacheRead].every(value => value === null || count(value))
      || !["split", "unknown"].includes(row.ttl)
      || (row.ttl === "unknown" && (row.cacheWrite5m !== null || row.cacheWrite1h !== null))
      || (row.ttl === "split" && (!count(row.cacheWrite5m) || !count(row.cacheWrite1h)
        || !count(row.cacheWrite5m + row.cacheWrite1h)
        || row.cacheWrite !== row.cacheWrite5m + row.cacheWrite1h))) {
      throw fail("invalid_metadata", "A collector record is not valid metadata.");
    }
    ids.add(row.id);
  }
}

/**
 * How far a catch-up has got: records acknowledged so far (this batch included)
 * of the records this machine had to send. Counts only. Optional; a 0.2.0
 * reporter does not send it.
 */
export function backlogFor(value) {
  if (value === undefined) return undefined;
  if (!exactKeys(value, ["delivered", "total"]) || !count(value.delivered) || !count(value.total) || value.delivered > value.total) {
    throw fail("invalid_backlog", "Collector backlog metadata is invalid.");
  }
  return { delivered: value.delivered, total: value.total };
}

/**
 * What the collector could not count, by reason: counts only (docs/accounting.md
 * §3.2). Optional; a 0.2 reporter does not send it.
 */
export function coverageFor(value) {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).length > 32
    || !Object.entries(value).every(([key, n]) => /^[a-z][A-Za-z]{1,39}$/u.test(key) && count(n))) {
    throw fail("invalid_coverage", "Collector coverage metadata is invalid.");
  }
  return { ...value };
}

export function freshnessFor(value, records) {
  const freshness = value === undefined ? {
    lastObservedAt: records.reduce((latest, row) => latest === null || Date.parse(row.at) > Date.parse(latest) ? row.at : latest, null),
    lastSyncedAt: null,
    mode: "periodic",
  } : value;
  if (!exactKeys(freshness, ["lastObservedAt", "lastSyncedAt", "mode"])
    || !["live", "periodic"].includes(freshness.mode)
    || ![freshness.lastObservedAt, freshness.lastSyncedAt].every(value => value === null || timestamp(value))) {
    throw fail("invalid_freshness", "Collector freshness metadata is invalid.");
  }
  return { ...freshness };
}

function validateReceipt(receipt, rows, token) {
  const invalid = () => fail("invalid_receipt", "The ingestion receipt did not account for this batch. No cursor can advance.");
  // `expired` is the hub's count of records older than its retention window:
  // accounted for, deliberately not stored. A receipt may omit it.
  const withExpired = exactKeys(receipt, ["accepted", "duplicate", "expired", "rejected"]);
  if (!(withExpired || exactKeys(receipt, ["accepted", "duplicate", "rejected"])) || !count(receipt.accepted)
    || !count(receipt.duplicate) || (withExpired && !count(receipt.expired)) || !Array.isArray(receipt.rejected)
    || receipt.accepted + receipt.duplicate + (withExpired ? receipt.expired : 0) + receipt.rejected.length !== rows.length) throw invalid();
  const sent = new Set(rows.map(row => row.id));
  const rejected = new Set();
  for (const row of receipt.rejected) {
    if (!exactKeys(row, ["id", "because"]) || !sent.has(row.id) || rejected.has(row.id)
      || !text(row.because, 240) || row.because.includes(token)) throw invalid();
    rejected.add(row.id);
  }
  return receipt;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/*
 * A 429 or 503 that names its wait is flow control, not failure: the hub is
 * pacing a large first upload. That wait is honoured up to `retryAfterCapMs`
 * (two minutes by default) rather than cut to the short backoff used for
 * network errors, which is what made a big backlog retry forever.
 */
function retryDelay(response, fallback, maximum, now, retryAfterCap) {
  if (response?.status !== 429 && response?.status !== 503) return Math.min(maximum, fallback);
  let requested = 0;
  try {
    const header = response.headers?.get("retry-after");
    if (typeof header === "string") {
      const value = header.trim();
      const milliseconds = /^\d+$/u.test(value) ? Number(value) * 1000 : Date.parse(value) - now();
      if (!Number.isNaN(milliseconds) && milliseconds > 0) requested = milliseconds;
    }
  } catch { /* An unreadable retry header does not replace the bounded backoff. */ }
  return requested > 0 ? Math.min(retryAfterCap, Math.max(fallback, requested)) : Math.min(maximum, fallback);
}

/**
 * POST batches of at most 500 records and require a complete receipt for each.
 * A failure throws a fixed, non-sensitive error carrying the last HTTP status
 * (null when the hub could not be reached at all). This function never moves a
 * cursor itself: `onBatch(receipt, { delivered, total })` is awaited after each
 * acknowledged batch so the caller can record that progress, and a batch that
 * is replayed later is safe because the hub counts a known record id as a
 * duplicate. Rejected records are returned for the caller to retain and resolve.
 * `backlog: { delivered, total }` describes a catch-up that began before this
 * call; each envelope then says how far it has got.
 * `token` is an injection seam for tests; production callers use the environment.
 */
export async function postRecords(url, device, records, options = {}) {
  const target = endpoint(url, { allowHttp: options.allowHttp });
  const token = options.token ?? process.env.AGENT_CONSOLE_TOKEN;
  if (!text(token, 8192) || /\s/u.test(token)) throw fail("missing_device_token", "This machine has no device credential for the hub. Join it first.");
  if (target.includes(token)) throw fail("invalid_endpoint", "A device credential cannot appear in the endpoint URL.");
  if (!exactKeys(device, ["id", "label"]) || !text(device.id, 128) || !text(device.label, 120)) {
    throw fail("invalid_device", "The collector device needs an ID and a label.");
  }
  validateRecords(records, device);
  const freshness = freshnessFor(options.freshness, records);
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  const retryAfterCapMs = options.retryAfterCapMs ?? 120_000;
  const timeoutMs = options.timeoutMs ?? 15000;
  const onBatch = options.onBatch ?? null;
  const before = backlogFor(options.backlog);
  const coverage = coverageFor(options.coverage);
  if (typeof fetchRequest !== "function" || typeof sleep !== "function" || typeof now !== "function"
    || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8
    || !count(baseDelayMs) || !count(maxDelayMs) || maxDelayMs < baseDelayMs || maxDelayMs > 60000
    || !count(retryAfterCapMs) || retryAfterCapMs > 600_000
    || (onBatch !== null && typeof onBatch !== "function")
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw fail("invalid_transport_options", "Collector retry and timeout options are invalid.");
  }

  const totals = { accepted: 0, duplicate: 0, expired: 0, rejected: [] };
  const deliveryLength = records.length || (options.freshness === undefined ? 0 : 1);
  for (let start = 0; start < deliveryLength; start += 500) {
    const rows = records.slice(start, start + 500);
    const envelope = { v: 1, device, freshness, records: rows, ...(coverage ? { coverage } : {}) };
    if (before) envelope.backlog = { delivered: before.delivered + start + rows.length, total: Math.max(before.total, before.delivered + records.length) };
    const body = JSON.stringify(envelope);
    let receipt;
    let lastStatus = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetchRequest(target, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Network exceptions can contain the URL or headers. Never retain them.
        response = null;
      }
      lastStatus = response ? response.status : null;
      if (response && response.status >= 200 && response.status < 300) {
        let value;
        try { value = await response.json(); } catch { throw fail("invalid_receipt", "The ingestion response was not a valid receipt. No cursor can advance."); }
        receipt = validateReceipt(value, rows, token);
        break;
      }
      if (response && !(RETRY_STATUS.has(response.status) || (response.status >= 500 && response.status <= 599))) {
        // The status is kept (it is a number, never a body) so a reporter can
        // tell a revoked device (401) from a malformed batch (400).
        const refused = fail("ingestion_refused", "The ingestion endpoint refused this batch. No cursor can advance.");
        refused.status = response.status;
        throw refused;
      }
      if (attempt + 1 === maxAttempts) {
        const unavailable = fail("ingestion_unavailable", "The ingestion endpoint did not acknowledge this batch after bounded retries. Acknowledged batches are kept.");
        // null: nothing answered. 429: the hub is pacing uploads. 5xx: the hub failed.
        unavailable.status = lastStatus;
        throw unavailable;
      }
      try { await sleep(retryDelay(response, baseDelayMs * 2 ** attempt, maxDelayMs, now, retryAfterCapMs)); }
      catch { throw fail("retry_interrupted", "The ingestion retry was interrupted. No cursor can advance."); }
    }
    totals.accepted += receipt.accepted;
    totals.duplicate += receipt.duplicate;
    totals.expired += receipt.expired ?? 0;
    totals.rejected.push(...receipt.rejected);
    if (onBatch) await onBatch(receipt, { delivered: Math.min(records.length, start + 500), total: records.length });
  }
  return totals;
}
