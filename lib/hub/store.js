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
 * DAILY TOTALS OUTLIVE THE MINUTES. Every accepted record is also added to a
 * per-UTC-day rollup (by machine, model, project and price tier) kept in
 * daily-v1.json for ROLLUP_DAYS, long after its minute buckets are pruned, so
 * "the last 30 days" can be answered with the default 8 days of detail.
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
  "cacheWrite1h", "ttl", "cacheRead", "continuation", "tier"];
/** How long the per-day rollup is kept: longer than any billing period. */
export const ROLLUP_DAYS = 400;
const TIERS = new Set(["standard", "fast", "other"]);
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
    && (r.tier === undefined || r.tier === null || TIERS.has(r.tier));
}

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
  const ids = new Map();            // record id -> minute ms
  const addedToday = new Map();     // deviceId -> records accepted on the current UTC day
  let today = dayOf(now());
  const minutes = new Map();        // minute ms -> Map(key -> bucket)
  const sessions = new Map();       // sessionHash -> session facts
  const daily = new Map();          // UTC day -> Map(device|model|project|tier -> bucket without a session)
  let dailySince = null;            // the first UTC day the rollup holds whole
  let dailyDirty = false, dailySavedAt = 0;
  const dropped = { future: 0, hubFull: 0, damaged: 0 };
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
    const tier = TIERS.has(record.tier) ? record.tier : null;
    const key = deviceId + "|" + record.sessionHash + "|" + record.model + "|" + tier;
    let bucket = bucketMap.get(key);
    if (!bucket) { bucket = emptyBucket(deviceId, record.sessionHash, record.model, record.tool, tier); bucketMap.set(key, bucket); }
    const price = priceRecord(record, prices, { measurement: false });
    addRecord(bucket, record, price);
    addDaily(dayOf(minute), deviceId, record, tier, price);

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
    return { days, since: typeof saved.since === "string" ? saved.since : null };
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
    fs.writeFileSync(temporary, JSON.stringify({ v: 1, timeZone: "UTC", since: dailySince, days }), { mode: 0o600 });
    fs.renameSync(temporary, dailyFile());
  }

  function prune(force = false) {
    const t = now();
    if (!force && t - lastPrune < 60_000) return;
    lastPrune = t;
    const edge = horizon(t);
    for (const minute of minutes.keys()) if (minute < edge) minutes.delete(minute);
    for (const [id, minute] of ids) if (minute < edge) ids.delete(id);
    for (const [hash, session] of sessions) if (session.lastAt < edge) sessions.delete(hash);
    const oldestDay = dayOf(t - rollupDays * 86_400_000);
    for (const day of daily.keys()) if (day < oldestDay) { daily.delete(day); dailyDirty = true; }
    if (dailySince !== null && dailySince < oldestDay) dailySince = oldestDay;
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
      try { record = JSON.parse(line); } catch { tally.damaged += 1; dropped.damaged += 1; return; }
      if (!storedRecordValid(record)) { tally.damaged += 1; dropped.damaged += 1; return; }
      if (record.at < edge) { tally.expired += 1; return; }
      if (ids.has(record.id)) return;
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
      if (record.at < edge) { receipt.expired += 1; continue; }
      if (record.at > future) { receipt.expired += 1; dropped.future += 1; continue; }
      if (ids.size >= MAX_INDEXED_RECORDS) { receipt.rejected.push({ id: record.id, because: "hub_full" }); dropped.hubFull += 1; continue; }
      index(record, deviceId);
      lines.push(JSON.stringify(compactRecord(record)));
      receipt.accepted += 1;
    }
    addedToday.set(deviceId, (addedToday.get(deviceId) || 0) + receipt.accepted);
    if (dir && lines.length) append(lines);
    saveDaily();
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
    eachBucket,
    eachDay,
    seedDaily,
    /** The first UTC day the rollup holds whole; days before it are partial or absent. */
    get dailySince() { return dailySince; },
    set dailySince(day) { if (!dir) dailySince = day; },
    /** Records this hub could not count, by reason, since it started. */
    dropped,
    flush: () => saveDaily(true),
    sessions,
    prices,
    get recordCount() { return ids.size; },
    get retentionMs() { return retentionMs; },
    prune: () => prune(true),
  };
}
