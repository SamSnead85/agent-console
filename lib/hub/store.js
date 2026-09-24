/**
 * The hub's usage store: one append-only NDJSON file per day, and an index in
 * memory.
 *
 * BOUNDED. Records are written to records-YYYY-MM-DD.ndjson by the UTC day
 * they arrived, and a day's file is deleted whole once it is past retention,
 * so no file grows for ever. Files are read back one line at a time, and a
 * line that is too long or not a well-formed record is skipped, so a damaged
 * or hostile file cannot stop the hub from starting. Each reporting machine
 * may add at most DEVICE_DAILY_RECORDS records a day, and the index as a
 * whole holds at most MAX_INDEXED_RECORDS.
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
/** Records one reporting machine may add per UTC day: several times a heavy first sync. */
export const DEVICE_DAILY_RECORDS = 250_000;
const MAX_LINE_BYTES = 16 * 1024;
const FILE_PATTERN = /^records-(\d{4}-\d{2}-\d{2})\.ndjson$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LABEL = /^[a-z][a-z0-9-]{1,47}$/u;
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/u;
const MINUTE_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/u;
const count = (v) => v === null || (Number.isSafeInteger(v) && v >= 0);

/** The shape every stored record must have; anything else on disk is skipped. */
export function storedRecordValid(r) {
  return Boolean(r) && typeof r === "object" && HASH.test(r.id) && HASH.test(r.sessionHash) && HASH.test(r.projectHash)
    && (r.parentSessionHash === null || HASH.test(r.parentSessionHash))
    && (r.tool === "claude-code" || r.tool === "codex") && MODEL.test(r.model)
    && (r.engagement === null || r.engagement === undefined || LABEL.test(r.engagement))
    && DEVICE.test(r.reportingDevice) && typeof r.isSubagent === "boolean"
    && typeof r.at === "string" && MINUTE_AT.test(r.at) && Number.isFinite(Date.parse(r.at))
    && ["fresh", "output", "cacheWrite", "cacheRead"].every((k) => count(r[k]))
    && (r.continuation === undefined || typeof r.continuation === "boolean");
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Calls onLine(text) for each complete line of a file, never holding more than a chunk and one line. */
function eachLine(file, onLine) {
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let pending = Buffer.alloc(0);
    let skipping = false;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      let data = Buffer.concat([pending, chunk.subarray(0, read)]);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        if (skipping) skipping = false;
        else if (nl - start <= MAX_LINE_BYTES) onLine(data.subarray(start, nl).toString("utf8"));
        start = nl + 1;
      }
      pending = data.subarray(start);
      if (pending.length > MAX_LINE_BYTES) { pending = Buffer.alloc(0); skipping = true; }
    }
  } finally {
    fs.closeSync(fd);
  }
}

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
 * @param {string|null} options.dir     where the daily record files live; null keeps memory only (demo)
 * @param {number} options.retentionMs  how far back anything is kept
 * @param {object} options.prices       the offline price table
 */
export function createStore({ dir = null, retentionMs, prices, now = () => Date.now() }) {
  const ids = new Map();            // record id -> minute ms
  const addedToday = new Map();     // deviceId -> records accepted on the current UTC day
  let today = dayOf(now());
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
        contextSamples: [],
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
    // A response's reported input is the context carried into that call.
    // Continuation records are token deltas for the same response, not turns.
    if (record.continuation !== true && [record.fresh, record.cacheWrite, record.cacheRead].every(Number.isSafeInteger)) {
      session.contextSamples ??= [];
      session.contextSamples.push({ at, tokens: record.fresh + record.cacheWrite + record.cacheRead,
        cacheRead: record.cacheRead, cacheWrite: record.cacheWrite,
        cacheWrite5m: record.cacheWrite5m, cacheWrite1h: record.cacheWrite1h,
        model: record.model });
      session.contextSamples.sort((a, b) => a.at - b.at);
      if (session.contextSamples.length > 128) session.contextSamples.splice(0, session.contextSamples.length - 128);
    }
  }

  function prune(force = false) {
    const t = now();
    if (!force && t - lastPrune < 60_000) return;
    lastPrune = t;
    const edge = horizon(t);
    for (const minute of minutes.keys()) if (minute < edge) minutes.delete(minute);
    for (const [id, minute] of ids) if (minute < edge) ids.delete(id);
    for (const [hash, session] of sessions) if (session.lastAt < edge) sessions.delete(hash);
    // A day's file goes once every record in it is past retention. Records may
    // be dated up to a day ahead of their arrival, hence the extra day.
    if (dir) {
      const oldest = dayOf(edge - 86_400_000);
      for (const name of safeList()) {
        const m = FILE_PATTERN.exec(name);
        if (m && m[1] < oldest) fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  }

  function safeList() {
    try { return fs.readdirSync(dir).sort(); } catch { return []; }
  }

  function rollDay() {
    const d = dayOf(now());
    if (d !== today) { today = d; addedToday.clear(); }
  }

  /** Records this machine may still add today. The hub's own machine has no quota. */
  function quotaLeft(deviceId) {
    rollDay();
    return Math.max(0, DEVICE_DAILY_RECORDS - (addedToday.get(deviceId) || 0));
  }

  function compactRecord(record) {
    const out = {};
    for (const key of STORED_KEYS) out[key] = record[key];
    return out;
  }

  function readFile(file, onRecord) {
    const edge = new Date(horizon()).toISOString();
    const tally = { loaded: 0, expired: 0, damaged: 0 };
    eachLine(file, (line) => {
      if (!line) return;
      let record;
      try { record = JSON.parse(line); } catch { tally.damaged += 1; return; }
      if (!storedRecordValid(record)) { tally.damaged += 1; return; }
      if (record.at < edge) { tally.expired += 1; return; }
      if (ids.has(record.id) || ids.size >= MAX_INDEXED_RECORDS) return;
      index(record, record.reportingDevice);
      tally.loaded += 1;
      onRecord(record, line);
    });
    return tally;
  }

  /** Reads the day files back, keeping what is still inside the retention window. */
  function load() {
    if (!dir) return { loaded: 0, expired: 0, damaged: 0 };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const total = { loaded: 0, expired: 0, damaged: 0 };
    const add = (t) => { for (const k of Object.keys(total)) total[k] += t[k]; };
    rollDay();
    for (const name of safeList()) {
      const m = FILE_PATTERN.exec(name);
      if (!m) continue;
      add(readFile(path.join(dir, name), (record) => {
        if (m[1] === today) addedToday.set(record.reportingDevice, (addedToday.get(record.reportingDevice) || 0) + 1);
      }));
    }
    // 0.2.0 kept everything in one records.ndjson. It is read the same way,
    // what is still in the window moves into today's file, and it is removed.
    const legacy = path.join(dir, "records.ndjson");
    if (fs.existsSync(legacy)) {
      const lines = [];
      add(readFile(legacy, (_record, line) => { lines.push(line); }));
      if (lines.length) append(lines);
      fs.rmSync(legacy, { force: true });
    }
    prune(true);
    return total;
  }

  function append(lines) {
    // Durable before the receipt goes back: the reporter advances its cursor
    // on this answer, so an acknowledged record must survive a crash.
    const handle = fs.openSync(path.join(dir, `records-${dayOf(now())}.ndjson`), "a", 0o600);
    try {
      for (let i = 0; i < lines.length; i += 5000) fs.writeSync(handle, lines.slice(i, i + 5000).join("\n") + "\n");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }

  /**
   * Accepts already-validated records from one device. Returns the receipt the
   * reporter checks: every record is accepted, a duplicate, or expired.
   */
  function ingest(deviceId, records) {
    prune();
    rollDay();
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
    addedToday.set(deviceId, (addedToday.get(deviceId) || 0) + receipt.accepted);
    if (dir && lines.length) append(lines);
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
    quotaLeft,
    eachBucket,
    sessions,
    prices,
    get recordCount() { return ids.size; },
    get retentionMs() { return retentionMs; },
    prune: () => prune(true),
  };
}
