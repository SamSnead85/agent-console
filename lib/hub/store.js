/**
 * The hub's usage store: an append-only NDJSON file and an in-memory index.
 *
 * WHY NOT node:sqlite. It is still marked experimental in the Node versions
 * this package supports, and a console whose promise is "zero dependencies,
 * nothing to install" should not print an ExperimentalWarning on every start.
 * The access pattern does not need a database anyway: records arrive in
 * batches, are never updated, and every question the console asks is a sum
 * over a time window no longer than the retention period.
 *
 * WHAT IS KEPT IN MEMORY. Not the records — minute buckets. Each accepted
 * record is priced once, on arrival, and folded into the bucket for its minute,
 * device, session and model. A busy day of one person's agents is tens of
 * thousands of records and a few thousand buckets; the console's aggregation
 * walks the buckets, not the records. Record ids are kept (id → minute) only
 * for deduplication inside the retention window.
 *
 * FIRST WRITER WINS. The same transcript read on two machines produces the same
 * record ids (they are keyed by the organization salt, not by a path), so the
 * second copy is a duplicate: counted as such in the receipt, never added.
 *
 * A RECORD IS NOT A MESSAGE. Claude streams one API response over several
 * transcript lines, and each line whose usage grew is its own record. `n`
 * counts records (what pricing and coverage are about); `messages` counts
 * only records that are not a `continuation` of one already counted. A 0.2.0
 * record has no flag and counts as a message, as it always did.
 *
 * UNKNOWN IS NOT ZERO. A record may carry a token class as null — the tool did
 * not report it. The class sums here add only what was reported, and a
 * separate count says how many records had a class missing, so the screen can
 * say its total is a floor rather than print it as complete.
 */

import fs from "node:fs";
import path from "node:path";
import { priceRecord } from "../collector/pricing.js";

export const MINUTE = 60_000;
export const CLASSES = ["fresh", "output", "cacheWrite", "cacheRead"];
const STORED_KEYS = ["id", "tool", "model", "sessionHash", "parentSessionHash", "isSubagent", "projectHash",
  "engagement", "reportingDevice", "executionOrigin", "at", "fresh", "output", "cacheWrite", "cacheWrite5m",
  "cacheWrite1h", "ttl", "cacheRead", "continuation"];
/** A ceiling on what one hub will index, so a misbehaving reporter cannot exhaust memory. */
export const MAX_INDEXED_RECORDS = 3_000_000;

function emptyBucket(deviceId, sessionHash, model, tool) {
  return {
    deviceId, sessionHash, model, tool,
    n: 0,
    messages: 0,
    fresh: 0, output: 0, cacheWrite: 0, cacheRead: 0,
    // records on which that class was not reported
    unknownFresh: 0, unknownOutput: 0, unknownCacheWrite: 0, unknownCacheRead: 0,
    usd: 0, pricedN: 0, unpricedN: 0, unpricedTokens: 0,
  };
}

const UNKNOWN_KEY = { fresh: "unknownFresh", output: "unknownOutput", cacheWrite: "unknownCacheWrite", cacheRead: "unknownCacheRead" };

/** Sum of the classes that were reported. */
export function reportedTokens(record) {
  let total = 0;
  for (const key of CLASSES) if (Number.isSafeInteger(record[key])) total += record[key];
  return total;
}

/**
 * @param {object} options
 * @param {string|null} options.dir     where records.ndjson lives; null keeps memory only (demo)
 * @param {number} options.retentionMs  how far back anything is kept
 * @param {object} options.prices       the offline price table
 */
export function createStore({ dir = null, retentionMs, prices, now = () => Date.now() }) {
  const file = dir ? path.join(dir, "records.ndjson") : null;
  const ids = new Map();            // record id -> minute ms
  const minutes = new Map();        // minute ms -> Map(key -> bucket)
  const sessions = new Map();       // sessionHash -> session facts
  let lastPrune = 0;

  function horizon(t = now()) {
    return Math.floor((t - retentionMs) / MINUTE) * MINUTE;
  }

  function index(record, deviceId) {
    const at = Date.parse(record.at);
    const minute = Math.floor(at / MINUTE) * MINUTE;
    ids.set(record.id, minute);
    let bucketMap = minutes.get(minute);
    if (!bucketMap) { bucketMap = new Map(); minutes.set(minute, bucketMap); }
    const key = deviceId + "|" + record.sessionHash + "|" + record.model;
    let bucket = bucketMap.get(key);
    if (!bucket) { bucket = emptyBucket(deviceId, record.sessionHash, record.model, record.tool); bucketMap.set(key, bucket); }
    bucket.n += 1;
    if (record.continuation !== true) bucket.messages += 1;
    for (const k of CLASSES) {
      if (Number.isSafeInteger(record[k])) bucket[k] += record[k];
      else bucket[UNKNOWN_KEY[k]] += 1;
    }
    const price = priceRecord(record, prices);
    if (price.status === "estimated") { bucket.usd += price.usd; bucket.pricedN += 1; }
    else { bucket.unpricedN += 1; bucket.unpricedTokens += reportedTokens(record); }

    let session = sessions.get(record.sessionHash);
    if (!session) {
      session = {
        sessionHash: record.sessionHash,
        deviceId,
        tool: record.tool,
        parentSessionHash: record.parentSessionHash,
        isSubagent: record.isSubagent,
        projectHash: record.projectHash,
        engagement: record.engagement,
        firstAt: at,
        lastAt: at,
        model: record.model,
      };
      sessions.set(record.sessionHash, session);
    }
    if (at >= session.lastAt) {
      session.lastAt = at;
      session.model = record.model;
      session.deviceId = deviceId;
      if (record.engagement) session.engagement = record.engagement;
    }
    if (at < session.firstAt) session.firstAt = at;
  }

  function prune(force = false) {
    const t = now();
    if (!force && t - lastPrune < 60_000) return;
    lastPrune = t;
    const edge = horizon(t);
    for (const minute of minutes.keys()) if (minute < edge) minutes.delete(minute);
    for (const [id, minute] of ids) if (minute < edge) ids.delete(id);
    for (const [hash, session] of sessions) if (session.lastAt < edge) sessions.delete(hash);
  }

  function compactRecord(record) {
    const out = {};
    for (const key of STORED_KEYS) out[key] = record[key];
    return out;
  }

  /** Reads the file back, keeping what is still inside the retention window. */
  function load() {
    if (!file) return { loaded: 0, expired: 0 };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch (error) {
      if (error.code === "ENOENT") return { loaded: 0, expired: 0 };
      throw error;
    }
    const edge = new Date(horizon()).toISOString();
    const kept = [];
    let loaded = 0, expired = 0, damaged = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { damaged += 1; continue; }
      if (!record || typeof record.id !== "string" || typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) { damaged += 1; continue; }
      if (record.at < edge) { expired += 1; continue; }
      if (ids.has(record.id)) continue;
      index(record, record.reportingDevice);
      kept.push(line);
      loaded += 1;
    }
    // Rewrite only when it pays: a quarter of the file is past its keep-by date.
    if (expired + damaged > 0 && (expired + damaged) * 4 >= loaded + expired + damaged) {
      const temporary = file + ".compact.tmp";
      fs.writeFileSync(temporary, kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
    return { loaded, expired, damaged };
  }

  /**
   * Accepts already-validated records from one device. Returns the receipt the
   * reporter checks: every record is accepted, a duplicate, or expired.
   */
  function ingest(deviceId, records) {
    prune();
    const edge = new Date(horizon()).toISOString();
    // Outside the window either way: older than retention, or more than a day
    // ahead of this hub's clock (a machine whose clock is badly wrong).
    const future = new Date(now() + 24 * 60 * MINUTE).toISOString();
    const receipt = { accepted: 0, duplicate: 0, expired: 0, rejected: [] };
    const lines = [];
    for (const record of records) {
      if (ids.has(record.id)) { receipt.duplicate += 1; continue; }
      if (record.at < edge || record.at > future) { receipt.expired += 1; continue; }
      if (ids.size >= MAX_INDEXED_RECORDS) { receipt.rejected.push({ id: record.id, because: "hub_full" }); continue; }
      index(record, deviceId);
      lines.push(JSON.stringify(compactRecord(record)));
      receipt.accepted += 1;
    }
    if (file && lines.length) {
      // Durable before the receipt goes back: the reporter advances its cursor
      // on this answer, so an acknowledged record must survive a crash.
      const handle = fs.openSync(file, "a", 0o600);
      try {
        fs.writeSync(handle, lines.join("\n") + "\n");
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    }
    return receipt;
  }

  /** Calls fn(minuteMs, bucket) for every bucket in [fromMs, toMs). */
  function eachBucket(fromMs, toMs, fn) {
    prune();
    for (const [minute, bucketMap] of minutes) {
      if (minute < fromMs || minute >= toMs) continue;
      for (const bucket of bucketMap.values()) fn(minute, bucket);
    }
  }

  return {
    load,
    ingest,
    eachBucket,
    sessions,
    get recordCount() { return ids.size; },
    get retentionMs() { return retentionMs; },
    prune: () => prune(true),
  };
}
