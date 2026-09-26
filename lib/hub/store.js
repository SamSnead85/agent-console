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
 * EXCEPT A RUNNING MAXIMUM. A `cumulative` record carries a Claude message's
 * per-class maximum as its reader saw it, under a message-level id. Readers
 * see a message's lines, and forks' mid-stream copies of them, in different
 * orders, so the hub keeps the largest amount per class it has held for that
 * id and adds only the growth above it, to the minute the id was first held.
 * A lower or equal reading adds nothing, whoever sends it and in any order
 * (docs/accounting.md §2, §8).
 *
 * A RECORD IS NOT A MESSAGE. Claude streams one API response over several
 * transcript lines, and each line whose usage grew is its own record. `n`
 * counts records (what pricing and coverage are about); `messages` counts
 * only records that are not a `continuation` of one already counted. A 0.2.0
 * record has no flag and counts as a message, as it always did.
 *
 * DAILY TOTALS OUTLIVE THE MINUTES. Every accepted record is also added to a
 * per-UTC-day rollup (by machine, model, project and price tier) kept in
 * daily-v1.json for ROLLUP_DAYS, long after its minute buckets are pruned, so
 * "the last 30 days" can be answered with the default 8 days of detail.
 *
 * A FIRST READ FILLS THE MONTH. A machine's first read (this hub's own, or a
 * reporter's first delivery, which says so with `backfill`) goes back
 * BACKFILL_DAYS UTC days, past the minute retention. Records of days wholly
 * before retention go straight into the daily totals, once per machine and
 * day: the first time a read touches that day it REPLACES what the rollup held
 * for that machine and day, and once the read is complete the day is done, so
 * a later re-read of the same history adds nothing. A read interrupted by a
 * restart is rebuilt from the records it wrote to the day files.
 *
 * NOTHING IS DROPPED SILENTLY. A record dated more than a day ahead, one the
 * hub has no room for, and a damaged line on disk are each counted in
 * `dropped`, and the console shows them (docs/accounting.md §3.2).
 *
 * UNKNOWN IS NOT ZERO. A record may carry a token class as null — the tool did
 * not report it. The class sums here add only what was reported, and a
 * separate count says how many records had a class missing, so the screen can
 * say its total is a floor rather than print it as complete.
 */

import fs from "node:fs";
import path from "node:path";
import { priceRecord } from "../collector/pricing.js";
import { MODEL_ID } from "../collector/parsers.js";

export const MINUTE = 60_000;
export const CLASSES = ["fresh", "output", "cacheWrite", "cacheRead"];
const STORED_KEYS = ["id", "tool", "model", "sessionHash", "parentSessionHash", "isSubagent", "projectHash",
  "engagement", "reportingDevice", "executionOrigin", "at", "fresh", "output", "cacheWrite", "cacheWrite5m",
  "cacheWrite1h", "ttl", "cacheRead", "continuation", "tier", "cumulative"];
const RUNNING = ["fresh", "output", "cacheWrite", "cacheRead", "cacheWrite5m", "cacheWrite1h"];
/** How long the per-day rollup is kept: longer than any billing period. */
export const ROLLUP_DAYS = 400;
const TIERS = new Set(["standard", "fast", "other"]);
/** How far back a machine's first read goes: the console's 30-day period. */
export const BACKFILL_DAYS = 30;
const DAY = 86_400_000;
/** A ceiling on what one hub will index, so a misbehaving reporter cannot exhaust memory. */
export const MAX_INDEXED_RECORDS = 3_000_000;
/** Records one reporting machine may add per UTC day: several times a heavy first sync. */
export const DEVICE_DAILY_RECORDS = 250_000;
const MAX_LINE_BYTES = 16 * 1024;
const FILE_PATTERN = /^records-(\d{4}-\d{2}-\d{2})\.ndjson$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MODEL = MODEL_ID;
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
    && (r.continuation === undefined || typeof r.continuation === "boolean")
    && (r.cumulative === undefined || typeof r.cumulative === "boolean")
    && (r.tier === undefined || r.tier === null || TIERS.has(r.tier));
}

/**
 * A session as the store keeps it: one per machine. The same session hash on
 * two machines (a transcript copied, a home folder synced) is two sessions,
 * each with its own machine, lane, tokens and activity; the records they
 * share are still counted once, by id.
 */
export const sessionKey = (deviceId, sessionHash) => `${deviceId}|${sessionHash}`;

/** The first UTC day of the BACKFILL_DAYS ending today. */
export const firstDay = (t) => new Date(Math.floor(t / DAY) * DAY - (BACKFILL_DAYS - 1) * DAY).toISOString().slice(0, 10);

/* The UTC day of a time. Called for every record a restart reads, and records
   come in runs from the same day, so the last day's text is kept. */
let lastDayNumber = NaN, lastDayText = "";
const dayOf = (ms) => {
  const n = Math.floor(ms / 86_400_000);
  if (n !== lastDayNumber) { lastDayNumber = n; lastDayText = new Date(ms).toISOString().slice(0, 10); }
  return lastDayText;
};

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

/** Recover an interrupted append before any surviving id can be acknowledged. */
function recoverFile(file) {
  const handle = fs.openSync(file, "r+");
  try {
    const size = fs.fstatSync(handle).size;
    let end = size;
    const chunk = Buffer.alloc(64 * 1024);
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const length = fs.readSync(handle, chunk, 0, end - start, start);
      if (length !== end - start) throw new Error("Usage file changed during recovery.");
      const newline = chunk.lastIndexOf(10, length - 1);
      if (newline !== -1) { end = start + newline + 1; break; }
      end = start;
    }
    // A line without its terminating newline was never a complete record.
    if (end !== size) fs.ftruncateSync(handle, end);
    // Even complete lines may have survived an interrupted/failed fsync.
    // Flush them now, before rebuilding the deduplication index from them.
    fs.fsyncSync(handle);
    return end !== size;
  } finally {
    fs.closeSync(handle);
  }
}

function emptyBucket(deviceId, sessionHash, model, tool, tier = null, projectHash = null) {
  return {
    deviceId, sessionHash, model, tool, tier, projectHash,
    n: 0,
    messages: 0,
    // Distinct messages (not records) whose price was, and was not, known.
    pricedMessages: 0, unpricedMessages: 0,
    fresh: 0, output: 0, cacheWrite: 0, cacheRead: 0,
    // The cache-write class by lifetime (docs/accounting.md §3): the 5-minute
    // and 1-hour parts of split records, and the writes whose lifetime was not
    // reported. The three add up to cacheWrite; none is ever added to it again.
    cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknownTtl: 0,
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
/** Adds one record to a bucket: classes, lifetimes, messages and its price. */
function addRecord(bucket, record, price) {
  bucket.n += 1;
  const message = record.continuation !== true;
  if (message) bucket.messages += 1;
  for (const k of CLASSES) {
    if (Number.isSafeInteger(record[k])) bucket[k] += record[k];
    else bucket[UNKNOWN_KEY[k]] += 1;
  }
  if (record.ttl === "split" && Number.isSafeInteger(record.cacheWrite5m) && Number.isSafeInteger(record.cacheWrite1h)
      && record.cacheWrite5m + record.cacheWrite1h === record.cacheWrite) {
    bucket.cacheWrite5m += record.cacheWrite5m;
    bucket.cacheWrite1h += record.cacheWrite1h;
  } else if (Number.isSafeInteger(record.cacheWrite)) {
    bucket.cacheWriteUnknownTtl += record.cacheWrite;
  }
  if (price.status === "estimated") { bucket.usd += price.usd; bucket.pricedN += 1; if (message) bucket.pricedMessages += 1; }
  else { bucket.unpricedN += 1; bucket.unpricedTokens += reportedTokens(record); if (message) bucket.unpricedMessages += 1; }
}

const ROLLUP_SUMS = ["n", "messages", "pricedMessages", "unpricedMessages", "fresh", "output", "cacheWrite", "cacheRead",
  "cacheWrite5m", "cacheWrite1h", "cacheWriteUnknownTtl", "unknownFresh", "unknownOutput", "unknownCacheWrite", "unknownCacheRead",
  "usd", "pricedN", "unpricedN", "unpricedTokens"];

export function createStore({ dir = null, retentionMs, prices, now = () => Date.now(), rollupDays = ROLLUP_DAYS }) {
  const ids = new Map();            // record id -> minute ms, or { minute, max } for a running maximum
  const addedToday = new Map();     // deviceId -> records accepted on the current UTC day
  let today = dayOf(now());
  const minutes = new Map();        // minute ms -> Map(key -> bucket)
  const sessions = new Map();       // deviceId|sessionHash -> session facts (sessionKey)
  const latestByHash = new Map();   // sessionHash -> the key of the machine that reported it last, for readers that know only a hash
  const daily = new Map();          // UTC day -> Map(device|model|project|tier -> bucket without a session)
  let dailySince = null;            // the first UTC day the rollup holds whole
  let dailyDirty = false, dailySavedAt = 0;
  const dropped = { future: 0, hubFull: 0, damaged: 0, pastRetention: 0 };
  // First reads (see the header): days done per machine, and reads under way.
  const backfillDone = new Set();   // "device|day"
  const backfillOpen = new Map();   // device -> { from, edgeDay, startedAt, days: Set(day), seen: Map(idKey -> null | held) }
  let lastPrune = 0;
  let appendFailure = null;

  function horizon(t = now()) {
    return Math.floor((t - retentionMs) / MINUTE) * MINUTE;
  }

  /**
   * A running maximum for an id already held: the growth above what the hub
   * holds, as a record of its own dated to the held minute, or null when it
   * adds nothing. The held maximum moves up either way.
   */
  function growthOf(record, held = ids.get(record.id)) {
    if (record.cumulative !== true || !held || typeof held !== "object") return null;
    const grown = {};
    for (let k = 0; k < RUNNING.length; k += 1) {
      const key = RUNNING[k];
      const value = Number.isSafeInteger(record[key]) ? record[key] : null;
      const before = held.max[k];
      grown[key] = value === null ? 0 : before === null ? value : Math.max(0, value - before);
      if (value !== null && (before === null || value > before)) held.max[k] = value;
    }
    if (!CLASSES.some((key) => grown[key] > 0)) return null;
    const split = record.ttl === "split" && grown.cacheWrite5m + grown.cacheWrite1h === grown.cacheWrite;
    return { ...record, at: new Date(held.minute).toISOString(), fresh: grown.fresh, output: grown.output,
      cacheWrite: grown.cacheWrite, cacheRead: grown.cacheRead, cacheWrite5m: split ? grown.cacheWrite5m : null,
      cacheWrite1h: split ? grown.cacheWrite1h : null, ttl: split ? "split" : "unknown", continuation: true };
  }

  function index(record, deviceId, growth = false, withDaily = true) {
    // The first reading the hub holds of a running maximum is the message.
    if (!growth && record.cumulative === true && record.continuation === true) record = { ...record, continuation: false };
    const at = Date.parse(record.at);
    const minute = Math.floor(at / MINUTE) * MINUTE;
    if (!growth) {
      ids.set(record.id, record.cumulative === true
        ? { minute, max: [record.fresh, record.output, record.cacheWrite, record.cacheRead, record.cacheWrite5m, record.cacheWrite1h]
            .map((value) => (Number.isSafeInteger(value) ? value : null)) }
        : minute);
    }
    let bucketMap = minutes.get(minute);
    if (!bucketMap) { bucketMap = new Map(); minutes.set(minute, bucketMap); }
    const tier = TIERS.has(record.tier) ? record.tier : null;
    const key = deviceId + "|" + record.sessionHash + "|" + record.model + "|" + tier;
    let bucket = bucketMap.get(key);
    if (!bucket) { bucket = emptyBucket(deviceId, record.sessionHash, record.model, record.tool, tier); bucketMap.set(key, bucket); }
    const price = priceRecord(record, prices, { measurement: false });
    addRecord(bucket, record, price);
    if (withDaily) addDaily(dayOf(minute), deviceId, record, tier, price);

    const skey = sessionKey(deviceId, record.sessionHash);
    let session = sessions.get(skey);
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
      sessions.set(skey, session);
    }
    if (at >= session.lastAt) {
      session.lastAt = at;
      session.model = record.model;
      if (record.engagement) session.engagement = record.engagement;
    }
    if (at < session.firstAt) session.firstAt = at;
    const latest = sessions.get(latestByHash.get(record.sessionHash));
    if (!latest || session.lastAt >= latest.lastAt) latestByHash.set(record.sessionHash, skey);
    // A response's reported input is the context carried into that call.
    // Continuation records are token deltas for the same response, not turns.
    if (record.continuation !== true && [record.fresh, record.cacheWrite, record.cacheRead].every(Number.isSafeInteger)) {
      const samples = (session.contextSamples ??= []);
      const sample = { at, tokens: record.fresh + record.cacheWrite + record.cacheRead,
        cacheRead: record.cacheRead, cacheWrite: record.cacheWrite,
        cacheWrite5m: record.cacheWrite5m, cacheWrite1h: record.cacheWrite1h,
        model: record.model };
      // Kept in time order. Records nearly always arrive in order, so this is
      // an append; a late one is slid back into place (stable, like a sort),
      // instead of re-sorting the list for every record a restart reads.
      let i = samples.length;
      while (i > 0 && samples[i - 1].at > at) i -= 1;
      if (i === samples.length) samples.push(sample); else samples.splice(i, 0, sample);
      if (samples.length > 128) samples.shift();
    }
  }

  function addDaily(day, deviceId, record, tier, price) {
    let entries = daily.get(day);
    if (!entries) { entries = new Map(); daily.set(day, entries); }
    const key = deviceId + "|" + record.model + "|" + record.projectHash + "|" + tier;
    let bucket = entries.get(key);
    if (!bucket) { bucket = emptyBucket(deviceId, null, record.model, record.tool, tier, record.projectHash); entries.set(key, bucket); }
    addRecord(bucket, record, price);
    dailyDirty = true;
  }

  const dailyFile = () => path.join(dir, "daily-v1.json");
  function readDaily() {
    if (!dir) return null;
    let saved;
    try { saved = JSON.parse(fs.readFileSync(dailyFile(), "utf8")); } catch { return null; }
    if (!saved || saved.v !== 1 || typeof saved.days !== "object") return null;
    const days = new Map();
    for (const [day, rows] of Object.entries(saved.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Array.isArray(rows)) continue;
      const entries = new Map();
      for (const row of rows) {
        if (!row || typeof row !== "object" || !DEVICE.test(row.deviceId) || !MODEL.test(row.model) || !HASH.test(row.projectHash)
          || !(row.tier === null || TIERS.has(row.tier)) || !ROLLUP_SUMS.every((k) => Number.isFinite(row[k]) && row[k] >= 0)) { dropped.damaged += 1; continue; }
        const bucket = emptyBucket(row.deviceId, null, row.model, row.tool === "codex" ? "codex" : "claude-code", row.tier, row.projectHash);
        for (const k of ROLLUP_SUMS) bucket[k] = row[k];
        entries.set(row.deviceId + "|" + row.model + "|" + row.projectHash + "|" + row.tier, bucket);
      }
      days.set(day, entries);
    }
    const backfill = saved.backfill && typeof saved.backfill === "object" ? saved.backfill : {};
    const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/u;
    const done = (Array.isArray(backfill.done) ? backfill.done : []).filter((k) => typeof k === "string" && /^[A-Za-z0-9_-]{1,64}\|\d{4}-\d{2}-\d{2}$/u.test(k));
    const open = [];
    for (const [device, s] of Object.entries(backfill.open && typeof backfill.open === "object" ? backfill.open : {})) {
      if (!DEVICE.test(device) || !s || !DAY_TEXT.test(s.from) || !DAY_TEXT.test(s.edgeDay) || !Number.isFinite(s.startedAt) || !Array.isArray(s.days)) continue;
      open.push([device, { from: s.from, edgeDay: s.edgeDay, startedAt: s.startedAt, days: new Set(s.days.filter((d) => DAY_TEXT.test(d))), seen: new Map() }]);
    }
    return { days, since: typeof saved.since === "string" ? saved.since : null, backfill: { done, open } };
  }

  /** Writes the rollup, at most every ten seconds unless forced. */
  function saveDaily(force = false) {
    if (!dir || !dailyDirty) return;
    const t = now();
    if (!force && t - dailySavedAt < 10_000) return;
    dailySavedAt = t; dailyDirty = false;
    const days = {};
    for (const [day, entries] of [...daily.entries()].sort()) {
      days[day] = [...entries.values()].map((b) => {
        const row = { deviceId: b.deviceId, model: b.model, tool: b.tool, projectHash: b.projectHash, tier: b.tier };
        for (const k of ROLLUP_SUMS) row[k] = b[k];
        return row;
      });
    }
    const temporary = dailyFile() + ".tmp";
    const backfill = { done: [...backfillDone].sort(),
      open: Object.fromEntries([...backfillOpen].map(([device, b]) => [device, { from: b.from, edgeDay: b.edgeDay, startedAt: b.startedAt, days: [...b.days].sort() }])) };
    fs.writeFileSync(temporary, JSON.stringify({ v: 1, timeZone: "UTC", since: dailySince, days, backfill }), { mode: 0o600 });
    fs.renameSync(temporary, dailyFile());
  }

  function prune(force = false) {
    const t = now();
    if (!force && t - lastPrune < 60_000) return;
    lastPrune = t;
    const edge = horizon(t);
    for (const minute of minutes.keys()) if (minute < edge) minutes.delete(minute);
    for (const [id, held] of ids) if ((typeof held === "number" ? held : held.minute) < edge) ids.delete(id);
    for (const [key, session] of sessions) {
      if (session.lastAt >= edge) continue;
      sessions.delete(key);
      if (latestByHash.get(session.sessionHash) === key) latestByHash.delete(session.sessionHash);
    }
    const oldestDay = dayOf(t - rollupDays * 86_400_000);
    for (const day of daily.keys()) if (day < oldestDay) { daily.delete(day); dailyDirty = true; }
    if (dailySince !== null && dailySince < oldestDay) dailySince = oldestDay;
    for (const key of backfillDone) if (key.slice(-10) < oldestDay) backfillDone.delete(key);
    // A first read that stopped for longer than retention will not be rebuilt
    // whole from the day files: what it delivered stands, and its days are done.
    for (const [device, b] of backfillOpen) if (b.startedAt < t - retentionMs) closeBackfill(device, { whole: false });
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

  function readFile(file, onRecord, onValid = null) {
    const edge = new Date(horizon()).toISOString();
    const tally = { loaded: 0, expired: 0, damaged: 0 };
    eachLine(file, (line) => {
      if (!line) return;
      let record;
      try { record = JSON.parse(line); } catch { tally.damaged += 1; dropped.damaged += 1; return; }
      if (!storedRecordValid(record)) { tally.damaged += 1; dropped.damaged += 1; return; }
      onValid?.(record);
      if (ids.has(record.id)) {
        const growth = growthOf(record);
        if (growth) { index(growth, record.reportingDevice, true); onRecord(record, line); }
        return;
      }
      if (record.at < edge) { tally.expired += 1; return; }
      if (ids.size >= MAX_INDEXED_RECORDS) { dropped.hubFull += 1; return; }
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
    const saved = readDaily();
    const total = { loaded: 0, expired: 0, damaged: 0 };
    const add = (t) => { for (const k of Object.keys(total)) total[k] += t[k]; };
    rollDay();
    if (saved) {
      for (const key of saved.backfill.done) backfillDone.add(key);
      for (const [device, b] of saved.backfill.open) backfillOpen.set(device, b);
    }
    // A first read under way when the hub stopped: its days are rebuilt from
    // the records it wrote, not from a rollup that may lag them.
    const rebuild = [];
    const inOpenRead = (record) => {
      const b = backfillOpen.get(record.reportingDevice);
      const day = record.at.slice(0, 10);
      if (b && b.days.has(day) && day <= b.edgeDay) rebuild.push(record);
    };
    for (const name of safeList()) {
      const m = FILE_PATTERN.exec(name);
      if (!m) continue;
      const file = path.join(dir, name);
      if (recoverFile(file)) { total.damaged += 1; dropped.damaged += 1; }
      add(readFile(file, (record) => {
        if (m[1] === today) addedToday.set(record.reportingDevice, (addedToday.get(record.reportingDevice) || 0) + 1);
      }, backfillOpen.size ? inOpenRead : null));
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
    // Days still wholly inside retention are rebuilt from the records just
    // read; the day at the retention edge and every older day come from the
    // saved rollup, because their records are gone.
    const edgeDay = dayOf(horizon());
    if (saved) {
      for (const [day, entries] of saved.days) {
        if (day <= edgeDay || !daily.has(day)) daily.set(day, entries);
      }
      dailySince = saved.since;
    }
    for (const [device, b] of backfillOpen) {
      for (const day of b.days) clearDaily(device, day);
      applyBackfill(device, b, rebuild.filter((r) => r.reportingDevice === device), { replay: true });
    }
    if (dailySince === null) {
      // A first start: the rollup is whole from the first day retention holds whole.
      const next = new Date(Date.parse(edgeDay + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
      dailySince = next;
    }
    dailyDirty = true;
    prune(true);
    saveDaily(true);
    return total;
  }

  function append(lines, day = dayOf(now())) {
    // Durable before the receipt goes back: the reporter advances its cursor
    // on this answer, so an acknowledged record must survive a crash.
    if (appendFailure) throw appendFailure;
    // Windows append-only handles cannot be truncated during rollback. The
    // hub owns this directory exclusively, so write at the saved end using a
    // seekable writable handle instead; O_CREAT does not truncate the file.
    const handle = fs.openSync(path.join(dir, `records-${day}.ndjson`), fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600);
    let originalSize;
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile()) throw Object.assign(new Error("The usage destination is not a regular file."), { code: "EISDIR" });
      originalSize = stat.size;
      let position = originalSize;
      for (let i = 0; i < lines.length; i += 5000) {
        const chunk = Buffer.from(lines.slice(i, i + 5000).join("\n") + "\n");
        let offset = 0;
        while (offset < chunk.length) {
          const written = fs.writeSync(handle, chunk, offset, chunk.length - offset, position);
          if (written === 0) throw new Error("Writing usage records made no progress.");
          offset += written;
          position += written;
        }
      }
      fs.fsyncSync(handle);
    } catch (error) {
      // A torn line would otherwise consume the first record of the retry.
      // Keep earlier batches intact and make the failed batch safe to retry.
      if (originalSize !== undefined) {
        try {
          fs.ftruncateSync(handle, originalSize);
          fs.fsyncSync(handle);
        } catch (rollbackError) {
          appendFailure = new AggregateError([error, rollbackError], "Could not persist or roll back usage records.");
          throw appendFailure;
        }
      }
      throw error;
    } finally {
      fs.closeSync(handle);
    }
  }

  /**
   * Accepts already-validated records from one device. Returns the receipt the
   * reporter checks: every record is accepted, a duplicate, or expired.
   */
  /** A machine's first read, opened on its first batch; `from` is the first UTC day it covers. */
  function openBackfill(deviceId, from) {
    let b = backfillOpen.get(deviceId);
    if (!b) {
      const t = now();
      const floor = firstDay(t);
      b = { from: typeof from === "string" && from > floor ? from : floor, edgeDay: dayOf(horizon(t)), startedAt: t, days: new Set(), seen: new Map() };
      backfillOpen.set(deviceId, b);
      dailyDirty = true;
    }
    return b;
  }

  /** A machine's first read is complete: every day it covered is done. */
  function closeBackfill(deviceId, { whole = true } = {}) {
    const b = backfillOpen.get(deviceId);
    if (!b) return;
    for (const day of b.days) backfillDone.add(deviceId + "|" + day);
    if (whole) {
      // Every day of the range was read, including days with nothing on them.
      for (let day = b.from; day <= b.edgeDay; day = dayOf(Date.parse(day + "T00:00:00Z") + DAY)) backfillDone.add(deviceId + "|" + day);
      if (dailySince === null || b.from < dailySince) dailySince = b.from;
    }
    backfillOpen.delete(deviceId);
    dailyDirty = true;
    saveDaily(true);
  }

  function clearDaily(deviceId, day) {
    const entries = daily.get(day);
    if (!entries) return;
    for (const [key, bucket] of entries) if (bucket.deviceId === deviceId) entries.delete(key);
    dailyDirty = true;
  }

  const idKey = (id) => parseInt(id.slice(0, 13), 16);

  /**
   * Adds a first read's records of whole past days: the first record of a day
   * replaces what the rollup held for this machine and day; a record already
   * held in this read adds only a running maximum's growth. `stage` (true
   * while ingesting) only decides; the records are applied after they are on
   * disk. Returns the ones to add, and the receipt's counts.
   */
  function applyBackfill(deviceId, b, records, { replay = false, stage = false } = {}) {
    const staged = new Map();
    const out = [];
    let duplicate = 0;
    const horizonMs = horizon();
    for (const record of records) {
      const key = idKey(record.id);
      const day = record.at.slice(0, 10);
      const prior = staged.has(key) ? staged.get(key) : b.seen.get(key);
      let add = record;
      if (prior !== undefined) {
        const held = prior && typeof prior === "object" ? { minute: prior.minute, max: [...prior.max] } : null;
        add = held ? growthOf(record, held) : null;
        if (!add) { duplicate += 1; continue; }
        staged.set(key, held);
      } else {
        const minute = Math.floor(Date.parse(record.at) / MINUTE) * MINUTE;
        staged.set(key, record.cumulative === true ? { minute, max: RUNNING.map((k) => (Number.isSafeInteger(record[k]) ? record[k] : null)) } : null);
      }
      out.push({ record: add, day, growth: add !== record, original: record });
    }
    if (stage) return { out, staged, duplicate };
    commitBackfill(deviceId, b, out, staged, horizonMs, replay);
    return { out, staged, duplicate };
  }

  function commitBackfill(deviceId, b, out, staged, horizonMs, replay = false) {
    for (const { record, day, growth } of out) {
      if (!b.days.has(day)) { if (!replay) clearDaily(deviceId, day); b.days.add(day); }
      const tier = TIERS.has(record.tier) ? record.tier : null;
      addDaily(day, deviceId, record, tier, priceRecord(record, prices, { measurement: false }));
      // Inside minute retention too (the edge day's later hours): kept as minutes, without adding the day again.
      if (!replay && Date.parse(record.at) >= horizonMs) {
        if (!growth && !ids.has(record.id)) index(record, deviceId, false, false);
        else if (growth) index(record, deviceId, true, false);
      }
    }
    for (const [key, held] of staged) b.seen.set(key, held);
  }

  /** Records that count against a machine's daily allowance: those inside minute retention. */
  function quotaNeeded(records) {
    const edge = new Date(horizon()).toISOString();
    let n = 0;
    for (const r of records) if (typeof r?.at === "string" && r.at >= edge) n += 1;
    return n;
  }

  function ingest(deviceId, records, { backfill = null } = {}) {
    if (appendFailure) throw appendFailure;
    prune();
    rollDay();
    const b = backfill ? openBackfill(deviceId, backfill) : null;
    const toBackfill = [];
    const edge = new Date(horizon()).toISOString();
    // Outside the window either way: older than retention, or more than a day
    // ahead of this hub's clock (a machine whose clock is badly wrong).
    const future = new Date(now() + 24 * 60 * MINUTE).toISOString();
    const month = new Date(Math.floor(now() / 86_400_000) * 86_400_000 - 29 * 86_400_000).toISOString();
    const receipt = { accepted: 0, duplicate: 0, expired: 0, rejected: [] };
    const pending = [];
    // Running maxima are staged too: an append failure must not make a retry
    // look like a duplicate or change the totals the console displays.
    const pendingIds = new Map();
    let newIds = 0;
    const lines = [];
    let recent = 0;
    for (const record of records) {
      // A first read's record of a whole past day not yet done: the rollup, once (above).
      const day = record.at.slice(0, 10);
      if (b && day >= b.from && day <= b.edgeDay && !backfillDone.has(deviceId + "|" + day)) { toBackfill.push(record); continue; }
      if (ids.has(record.id) || pendingIds.has(record.id)) {
        const previous = pendingIds.get(record.id) ?? ids.get(record.id);
        const held = typeof previous === "object" ? { minute: previous.minute, max: [...previous.max] } : previous;
        const growth = growthOf(record, held);
        if (!growth) { receipt.duplicate += 1; continue; }
        pendingIds.set(record.id, held);
        pending.push({ record: growth, growth: true });
        // The reading itself is kept, so a restart takes the same maximum.
        lines.push(JSON.stringify(compactRecord(record)));
        receipt.accepted += 1;
        continue;
      }
      if (record.at < edge) {
        receipt.expired += 1;
        // Inside the 30-day period but past minute retention: neither the
        // minutes nor the daily totals can take it without its id, so it is
        // counted as a drop and the 30 days say they are partial — unless a
        // first read already made this machine's day whole.
        if (record.at >= month && !backfillDone.has(deviceId + "|" + day)) dropped.pastRetention += 1;
        continue;
      }
      if (record.at > future) { receipt.expired += 1; dropped.future += 1; continue; }
      if (ids.size + newIds >= MAX_INDEXED_RECORDS) { receipt.rejected.push({ id: record.id, because: "hub_full" }); dropped.hubFull += 1; continue; }
      pending.push({ record, growth: false });
      const minute = Math.floor(Date.parse(record.at) / MINUTE) * MINUTE;
      pendingIds.set(record.id, record.cumulative === true
        ? { minute, max: RUNNING.map(key => Number.isSafeInteger(record[key]) ? record[key] : null) }
        : minute);
      newIds += 1;
      lines.push(JSON.stringify(compactRecord(record)));
      receipt.accepted += 1;
      recent += 1;
    }
    let staged = null;
    if (b && toBackfill.length) {
      staged = applyBackfill(deviceId, b, toBackfill, { stage: true });
      receipt.duplicate += staged.duplicate;
      receipt.accepted += staged.out.length;
      // The reading itself is written, so a restart can rebuild the day.
      for (const { original } of staged.out) lines.push(JSON.stringify(compactRecord(original)));
    }
    if (dir && lines.length) append(lines, today);
    for (const { record, growth } of pending) index(record, deviceId, growth);
    for (const [id, held] of pendingIds) ids.set(id, held);
    if (staged) commitBackfill(deviceId, b, staged.out, staged.staged, horizon());
    addedToday.set(deviceId, (addedToday.get(deviceId) || 0) + recent);
    // A first read's days are saved as they fill: its records are acknowledged now.
    saveDaily(Boolean(staged && staged.out.length));
    return receipt;
  }

  /**
   * Calls fn(day, bucket) for each rollup bucket on the UTC days [fromDay, toDay]
   * (YYYY-MM-DD, inclusive). A rollup bucket has no session.
   */
  function eachDay(fromDay, toDay, fn) {
    prune();
    for (const [day, entries] of daily) {
      if (day < fromDay || day > toDay) continue;
      for (const bucket of entries.values()) fn(day, bucket);
    }
  }

  /**
   * Demo only: adds a synthetic record to the daily rollup without indexing
   * it, for days older than the demo's minute retention.
   */
  function seedDaily(deviceId, record) {
    const tier = TIERS.has(record.tier) ? record.tier : null;
    addDaily(record.at.slice(0, 10), deviceId, record, tier, priceRecord(record, prices, { measurement: false }));
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
    quotaNeeded,
    /** A machine's first read: `beginBackfill` is implied by the first `ingest(…, { backfill })`. */
    endBackfill: (deviceId) => closeBackfill(deviceId),
    backfilling: (deviceId) => backfillOpen.has(deviceId),
    backfillDone: (deviceId, day) => backfillDone.has(deviceId + "|" + day),
    eachBucket,
    eachDay,
    seedDaily,
    /** The first UTC day the rollup holds whole; days before it are partial or absent. */
    get dailySince() { return dailySince; },
    set dailySince(day) { if (!dir) dailySince = day; },
    /** Records this hub could not count, by reason, since it started. */
    dropped,
    flush: () => saveDaily(true),
    /** Sessions by `sessionKey(deviceId, sessionHash)`: one per machine. */
    sessions,
    /** One machine's session, or undefined. */
    session: (deviceId, sessionHash) => sessions.get(sessionKey(deviceId, sessionHash)),
    /** The session under a hash that last reported, whichever machine: for readers that know only a hash. */
    sessionByHash(sessionHash) {
      const held = sessions.get(latestByHash.get(sessionHash));
      if (held) return held;
      let best;
      for (const s of sessions.values()) if (s.sessionHash === sessionHash && (!best || s.lastAt > best.lastAt)) best = s;
      return best;
    },
    prices,
    get recordCount() { return ids.size; },
    get retentionMs() { return retentionMs; },
    prune: () => prune(true),
  };
}
