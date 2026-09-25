/**
 * Everything the console screen shows, computed from the store in one pass.
 *
 * The rules this module keeps, each against a misleading figure:
 *
 * 1. EVERY FIGURE NAMES ITS DEVICE. Totals roll up machines, but each machine
 *    and each person is also listed with its own share, so a big number can
 *    always be taken apart.
 * 2. A SILENT MACHINE IS NOT A QUIET ONE. A machine that stopped reporting has
 *    its last contact time on it, is left out of "right now" (and named as left
 *    out), and its lanes show an unknown five-minute figure — never a zero.
 * 3. THE CACHE SHARE IS OF ALL TOKENS. Cache read % and cache write % are each
 *    class divided by the sum of the four disjoint classes. That is a different
 *    number from "cache hit rate on input", and the screen says which it is.
 * 3a. A MACHINE STILL SENDING ITS BACKLOG IS NOT COMPLETE. A reporter working
 *    through a large first upload is "catching up · N of M": its figures are
 *    partial, it is left out of "right now", and it is never shown as
 *    "Reporting · now" until everything has arrived.
 * 3b. ONE PERIOD, EVERY VIEW. The headline, the chart, Team and Projects all
 *    answer for the same period: 1 hour, 24 hours or 7 days are that many whole
 *    minutes ending with the current one; 30 days are the last 30 UTC days,
 *    read from the daily rollup that outlives the minute buckets. The chart's
 *    bars are cut from the same span, so they add up to the headline.
 * 3c. WHAT COULD NOT BE COUNTED IS SHOWN. Every record a collector or this hub
 *    dropped is counted by reason and listed beside the figures.
 * 4. COST IS AN ESTIMATE AND MAY BE PARTIAL. Dollars come from the offline
 *    price table. A model the table does not price is excluded from the dollar
 *    figure and the screen says how many tokens that leaves out; it is never
 *    priced at zero.
 */

import { CLASSES, MINUTE } from "./store.js";
import { contextHealth, agentTree } from "../analysis/index.js";
import { priceRecord } from "../collector/pricing.js";
import { ACTIVITY_KINDS } from "../collector/activity.js";

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const WINDOWS = {
  "1h": { span: HOUR, step: MINUTE },
  "24h": { span: DAY, step: 15 * MINUTE },
  "7d": { span: 7 * DAY, step: 2 * HOUR },
};
/** The periods every view offers (docs/accounting.md §6). */
export const PERIODS = {
  "1h": { label: "last hour", short: "1 h" },
  "24h": { label: "last 24 hours", short: "24 h" },
  "7d": { label: "last 7 days", short: "7 days" },
  "30d": { label: "last 30 days", short: "30 days", days: 30 },
};
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * A period's exact range. Minute periods are half-open [from, to) on whole
 * minutes, ending with the current minute. "30d" is the last 30 UTC calendar
 * days, today included, as whole days of the daily rollup.
 */
export function periodRange(key, now) {
  const to = Math.floor(now / MINUTE) * MINUTE + MINUTE;
  if (key === "30d") {
    const toDay = utcDay(now);
    const from = Date.parse(toDay + "T00:00:00Z") - 29 * DAY;
    return { basis: "utc-days", timeZone: "UTC", from, to: from + 30 * DAY, fromDay: utcDay(from), toDay };
  }
  const w = WINDOWS[key];
  if (!w) throw new RangeError("unknown period");
  return { basis: "minutes", timeZone: "UTC", from: to - w.span, to };
}

/**
 * Reasons a record could not be counted (docs/accounting.md §3.2), in words.
 * Anything a collector reports that is not listed here is informational.
 */
export const DROP_REASONS = {
  missingTimestamp: "no readable time",
  missingProject: "no project folder",
  missingIdentity: "no message or session identity",
  sidechainWithoutAgent: "a subagent line without its agent id",
  changedFinalUsage: "usage changed after the response was counted",
  noFinalUsage: "a response that never finished",
  missingReplayOrdinal: "a forked Codex line without its position",
  unboundedReplay: "a forked Codex thread without a history boundary",
  counterReset: "a Codex total that went back without a restart",
  ambiguousEventIdentity: "two Codex readings with one identity",
  lateUsageRecord: "a Codex per-response record after its running total",
  oversizedLine: "a line too long to read",
  revisedDown: "a line rewritten with lower usage",
  unreadableLine: "a line that is not valid JSON",
  future: "dated more than a day ahead of this console's clock",
  hubFull: "this console's record limit was reached",
  pastRetention: "sent after its day passed this console's minute retention",
  damaged: "a damaged line in this console's own files",
};
const SPARK_BARS = 20;
/* Lanes sent for rendering; laneTotals counts every one. */
export const LANES_SHOWN = 80;
/* "× normal" for a spike or a stall: the session's tokens in the five minutes
   ending with the alert's minute, against the median of its own active
   five-minute spans over the day before. */
const MEDIAN_SPANS = 288;
function magnitude(minutes, at) {
  if (!minutes || !Number.isFinite(at)) return { tokens5m: null, median5m: null, factor: null };
  const m = Math.floor(at / MINUTE) * MINUTE;
  const span = (end) => { let t = 0; for (let k = 0; k < 5; k += 1) t += minutes.get(end - k * MINUTE) || 0; return t; };
  const tokens5m = span(m);
  const spans = [];
  for (let k = 1; k <= MEDIAN_SPANS; k += 1) { const t = span(m - k * 5 * MINUTE); if (t > 0) spans.push(t); }
  spans.sort((a, b) => a - b);
  const median5m = spans.length ? (spans.length % 2 ? spans[(spans.length - 1) / 2] : (spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2) : null;
  return { tokens5m, median5m, factor: median5m ? Math.round((tokens5m / median5m) * 10) / 10 : null };
}
const SPARK_STEP = 3 * MINUTE;
const UNKNOWN_CLASS = { fresh: "unknownFresh", output: "unknownOutput", cacheWrite: "unknownCacheWrite", cacheRead: "unknownCacheRead" };
const zeroClasses = () => ({ fresh: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const LIVE_WITHIN = 2 * MINUTE;
/* A lane's "tokens · 5 min" is what it did just now. The burn is a rate, and a
   rate over five minutes of agent traffic swings with every burst, so it is the
   plain average of the last fifteen whole minutes. */
const LANE_MINUTES = 5;
const BURN_MINUTES = 15;
/* How long after the console starts a machine that was reporting when it
   stopped is "reconnecting" rather than "silent": longer than a reporter's
   longest back-off. */
export const RECONNECT_GRACE_MS = 2 * MINUTE;

/**
 * A machine reporting every few seconds is overdue after a minute; one
 * reporting periodically after two hours. `restart` is { startedAt,
 * previousRunSeenAt } from the registry: for a short while after the console
 * restarts, a machine that was reporting when it stopped is waiting out its
 * back-off, not gone.
 */
export function deviceStatus(device, now, restart = null) {
  if (device.revokedAt) return "revoked";
  if (!device.lastContactAt) return "waiting";
  const limit = device.mode === "periodic" ? 2 * HOUR : 90_000;
  if (now - device.lastContactAt > limit) {
    if (restart && Number.isFinite(restart.startedAt) && Number.isFinite(restart.previousRunSeenAt)
      && now - restart.startedAt < RECONNECT_GRACE_MS && device.lastContactAt < restart.startedAt
      && restart.previousRunSeenAt - device.lastContactAt <= limit) return "reconnecting";
    return "silent";
  }
  return device.backlog && device.backlog.delivered < device.backlog.total ? "catching-up" : "reporting";
}

/** Burn cost standing: a rate on models with no verified price is unpriced, never $0. */
export function costStatus(pricedN, unpricedN) {
  return pricedN + unpricedN === 0 ? "none" : unpricedN === 0 ? "estimated" : pricedN === 0 ? "unpriced" : "partial";
}

/**
 * The same standing in the words the Projects and Team payloads use:
 * "priced" when every contributing message had a verified price, "partial"
 * when some did not (the dollars are a floor), "unpriced" when none did, and
 * "none" when there was nothing to price.
 */
export function priceStatus(pricedN, unpricedN) {
  const s = costStatus(pricedN, unpricedN);
  return s === "estimated" ? "priced" : s;
}

/* The resolution of each period's stacked series (docs/accounting.md §6): the
   same span as the headline, cut into these steps, so the bands add up to it. */
export const STACK_STEPS = { "1h": 3 * MINUTE, "24h": 15 * MINUTE, "7d": 2 * HOUR, "30d": DAY };
const STACK_BANDS = 4;

/**
 * A stacked series from per-key step arrays: the top four keys by total as
 * bands, everything else summed as `rest`, with how many keys `rest` holds.
 * `key` is the band's id field (deviceId, projectHash).
 */
export function stackOf(frame, perKey, key) {
  const ranked = [...perKey.entries()].map(([id, tokens]) => ({ id, tokens, total: tokens.reduce((a, n) => a + n, 0) }))
    .filter((r) => r.total > 0).sort((a, b) => b.total - a.total || (a.id < b.id ? -1 : 1));
  const rest = new Array(frame.steps).fill(0);
  for (const r of ranked.slice(STACK_BANDS)) for (let i = 0; i < frame.steps; i += 1) rest[i] += r.tokens[i];
  return { frame, bands: ranked.slice(0, STACK_BANDS).map((r) => ({ [key]: r.id, tokens: r.tokens })), rest,
    restCount: Math.max(0, ranked.length - STACK_BANDS) };
}

export function vendorOf(model) {
  if (/^claude-/u.test(model)) return "anthropic";
  if (/^(gpt-|codex-|o\d)/u.test(model)) return "openai";
  return null;
}

/** Short name for a model row; the full id stays in the payload. */
export function modelLabel(model) {
  if (model === "unknown") return "unknown model";
  return model.replace(/^claude-/u, "").replace(/-\d{8}$/u, "");
}

function emptyAgg() {
  return {
    total: 0, fresh: 0, output: 0, cacheWrite: 0, cacheRead: 0,
    cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknownTtl: 0,
    unknownFresh: 0, unknownOutput: 0, unknownCacheWrite: 0, unknownCacheRead: 0,
    n: 0, messages: 0, usd: 0, pricedN: 0, unpricedN: 0, unpricedTokens: 0, pricedMessages: 0, unpricedMessages: 0,
    // The dollars by token class, from buckets whose every record was priced
    // (one model, one tier, so the split is exact); the rest is "unsplit".
    classUsd: { fresh: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, classUsdUnsplit: 0,
    models: new Map(), unpricedModels: new Set(), sessions: new Set(), sessionsKnown: true,
  };
}

/**
 * A fully priced bucket's dollars, by class. Pricing is linear in tokens
 * (lib/collector/pricing.js), so a bucket of one model and one tier splits
 * exactly when the rates still reconcile with its saved estimate. A bucket
 * with an unpriced record or an older price basis returns null; its dollars
 * stay whole instead of being redistributed using today's rates.
 * `rates(model, tier)` gives the per-million rate of each class, or null.
 */
function classUsdOf(bucket, rates) {
  if (!bucket.pricedN || bucket.unpricedN) return null;
  const r = rates(bucket.model, bucket.tier ?? null);
  if (!r) return null;
  const parts = [["fresh", bucket.fresh, r.fresh], ["output", bucket.output, r.output], ["cacheRead", bucket.cacheRead, r.cacheRead],
    ["cacheWrite", bucket.cacheWrite5m ?? 0, r.cacheWrite5m], ["cacheWrite", bucket.cacheWrite1h ?? 0, r.cacheWrite1h],
    ["cacheWrite", bucket.cacheWriteUnknownTtl ?? 0, r.cacheWrite]];
  const out = { fresh: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const [key, tokens, rate] of parts) {
    if (!tokens) continue;
    if (rate === null) return null;
    out[key] += tokens * rate / 1_000_000;
  }
  const sum = CLASSES.reduce((total, k) => total + out[k], 0);
  // Daily rollups outlive their source records and retain the original USD.
  // Allow summation rounding, not a different price table's allocation.
  const tolerance = 1e-9 * Math.max(Math.abs(sum), Math.abs(bucket.usd), Number.EPSILON);
  return Number.isFinite(sum) && Math.abs(sum - bucket.usd) <= tolerance ? out : null;
}

/** The per-million rate of each class for a model and tier, read once from the price table. */
function classRates(prices) {
  const cache = new Map();
  return (model, tier) => {
    const key = model + "|" + tier;
    if (cache.has(key)) return cache.get(key);
    const probe = (fields) => {
      const p = priceRecord({ model, tier, fresh: 0, output: 0, cacheRead: 0, cacheWrite: 0, ttl: "unknown", ...fields }, prices, { measurement: false });
      return p.status === "estimated" ? p.usd : null;   // one million tokens: the dollars are the rate
    };
    const r = { fresh: probe({ fresh: 1_000_000 }), output: probe({ output: 1_000_000 }), cacheRead: probe({ cacheRead: 1_000_000 }),
      cacheWrite: probe({ cacheWrite: 1_000_000 }),
      cacheWrite5m: probe({ cacheWrite: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 0, ttl: "split" }),
      cacheWrite1h: probe({ cacheWrite: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 1_000_000, ttl: "split" }) };
    if (cache.size < 1000) cache.set(key, r);
    return r;
  };
}

/** The name an unpriced share goes by: the model, and the tier when that is why. */
const priceName = (bucket) => bucket.model + (bucket.tier === "fast" ? " (fast mode)" : bucket.tier === "other" ? " (service tier)" : "");

function addBucket(agg, bucket, tokens, split = null) {
  agg.total += tokens;
  for (const k of CLASSES) agg[k] += bucket[k];
  if (split) for (const k of CLASSES) agg.classUsd[k] += split[k];
  else agg.classUsdUnsplit += bucket.usd;
  agg.cacheWrite5m += bucket.cacheWrite5m ?? 0;
  agg.cacheWrite1h += bucket.cacheWrite1h ?? 0;
  agg.cacheWriteUnknownTtl += bucket.cacheWriteUnknownTtl ?? 0;
  agg.pricedMessages += bucket.pricedMessages ?? 0;
  agg.unpricedMessages += bucket.unpricedMessages ?? 0;
  agg.unknownFresh += bucket.unknownFresh;
  agg.unknownOutput += bucket.unknownOutput;
  agg.unknownCacheWrite += bucket.unknownCacheWrite;
  agg.unknownCacheRead += bucket.unknownCacheRead;
  agg.n += bucket.n;
  agg.messages += bucket.messages;
  agg.usd += bucket.usd;
  agg.pricedN += bucket.pricedN;
  agg.unpricedN += bucket.unpricedN;
  agg.unpricedTokens += bucket.unpricedTokens;
  let m = agg.models.get(bucket.model);
  if (!m) { m = { tokens: 0, usd: 0, n: 0, messages: 0, unpricedN: 0, unpricedMessages: 0 }; agg.models.set(bucket.model, m); }
  m.tokens += tokens; m.usd += bucket.usd; m.n += bucket.n; m.messages += bucket.messages; m.unpricedN += bucket.unpricedN;
  m.unpricedMessages += bucket.unpricedMessages ?? 0;
  if (bucket.unpricedN) addName(agg.unpricedModels, priceName(bucket));
  if (bucket.sessionHash) agg.sessions.add(bucket.sessionHash);
  else agg.sessionsKnown = false;
}

function mergeAgg(dst, a) {
  for (const k of ["total", ...CLASSES, "cacheWrite5m", "cacheWrite1h", "cacheWriteUnknownTtl", "unknownFresh", "unknownOutput", "unknownCacheWrite",
    "unknownCacheRead", "n", "messages", "usd", "pricedN", "unpricedN", "unpricedTokens", "pricedMessages", "unpricedMessages", "classUsdUnsplit"]) dst[k] += a[k];
  for (const k of CLASSES) dst.classUsd[k] += a.classUsd[k];
  for (const [model, m] of a.models) {
    let t = dst.models.get(model);
    if (!t) { t = { tokens: 0, usd: 0, n: 0, messages: 0, unpricedN: 0, unpricedMessages: 0 }; dst.models.set(model, t); }
    for (const k of Object.keys(t)) t[k] += m[k];
  }
  for (const m of a.unpricedModels) addName(dst.unpricedModels, m);
  for (const s of a.sessions) dst.sessions.add(s);
  if (!a.sessionsKnown) dst.sessionsKnown = false;
}

const share = (part, whole) => (whole > 0 ? part / whole : null);

/* Model names come from reporting machines, so the lists of unpriced ones are capped. */
const MAX_NAMED_MODELS = 20;
function addName(set, name) {
  if (set.size < MAX_NAMED_MODELS) set.add(name);
}

/** The public shape of an aggregate: numbers, shares, and what they leave out. */
function summarize(agg, { topModels = 6, whole = null } = {}) {
  const models = [...agg.models.entries()]
    .map(([model, m]) => ({
      model,
      label: modelLabel(model),
      vendor: vendorOf(model),
      tokens: m.tokens,
      share: share(m.tokens, agg.total),
      messages: m.messages,
      records: m.n,
      usd: m.unpricedN === m.n ? null : m.usd,
      unpricedMessages: m.unpricedMessages,
      unpricedRecords: m.unpricedN,
    }))
    .sort((a, b) => b.tokens - a.tokens);
  return {
    // "fresh" is uncached input only. The cache-write lifetimes are parts of
    // cacheWrite, never added to it again.
    tokens: { total: agg.total, fresh: agg.fresh, output: agg.output, cacheWrite: agg.cacheWrite, cacheRead: agg.cacheRead,
      cacheWrite5m: agg.cacheWrite5m, cacheWrite1h: agg.cacheWrite1h, cacheWriteUnknownTtl: agg.cacheWriteUnknownTtl },
    shares: {
      cacheRead: share(agg.cacheRead, agg.total),
      cacheWrite: share(agg.cacheWrite, agg.total),
      output: share(agg.output, agg.total),
      fresh: share(agg.fresh, agg.total),
      // of the input side only (fresh + cache write + cache read) — the other common reading
      cacheHitOnInput: share(agg.cacheRead, agg.fresh + agg.cacheWrite + agg.cacheRead),
    },
    unknown: {
      fresh: agg.unknownFresh, output: agg.unknownOutput,
      cacheWrite: agg.unknownCacheWrite, cacheRead: agg.unknownCacheRead,
    },
    // Distinct API messages, not transcript records (see store.js).
    messages: agg.messages,
    records: agg.n,
    // Unknown (null) for a period read from the daily rollup, which keeps no sessions.
    sessions: agg.sessionsKnown ? agg.sessions.size : null,
    shareOfWhole: whole === null ? null : share(agg.total, whole),
    cost: {
      usd: agg.pricedN ? agg.usd : null,
      status: agg.n === 0 ? "none" : agg.unpricedN === 0 ? "estimated" : agg.pricedN === 0 ? "unpriced" : "partial",
      // Records and messages are different counts (a streamed response is
      // one message over several records); each is named for what it counts.
      pricedRecords: agg.pricedN,
      unpricedRecords: agg.unpricedN,
      pricedMessages: agg.pricedMessages,
      unpricedMessages: agg.unpricedMessages,
      unpricedTokens: agg.unpricedTokens,
      unpricedModels: [...agg.unpricedModels].sort(),
      // The estimate by token class (docs/accounting.md §9): exact for the
      // records in buckets of one model and tier; `unsplitUsd` is the rest of
      // the estimate, which could not be told apart by class. Null until
      // something is priced — unknown, never $0.
      byClass: agg.pricedN ? { ...agg.classUsd, unsplitUsd: agg.classUsdUnsplit } : null,
    },
    models: models.slice(0, topModels),
    modelCount: models.length,
  };
}

/**
 * @param {object} input
 * @param {object} input.store       createStore()
 * @param {object} input.registry    createRegistry()
 * @param {object} [input.names]     local-only names for the hub's own machine
 * @param {number} input.now
 * @param {object} input.hub         { version, demo, listen, retentionDays, ... }
 */
/** A collector's coverage debt as drops, by reason; the rest is informational. */
export function dropsOf(debt) {
  const reasons = [];
  let recovered = 0;
  for (const [kind, n] of Object.entries(debt && typeof debt === "object" ? debt : {})) {
    if (!Number.isSafeInteger(n) || n <= 0) continue;
    if (kind === "oversizedLineRecovered") recovered += n;
    else if (DROP_REASONS[kind]) reasons.push({ kind, count: n, label: DROP_REASONS[kind] });
  }
  reasons.sort((a, b) => b.count - a.count);
  return { dropped: reasons.reduce((a, r) => a + r.count, 0), reasons, recovered };
}

/**
 * `alerts`: the raw alerts of this machine and of every joined machine that
 * shares them, each with its `deviceId` (lib/hub/alerts.js, lib/hub/fleet.js).
 * `signals`: { activity(sessionHashes, device) -> snapshot|null,
 * activityShared(device) -> boolean, alertsWatched(device) -> boolean }.
 */
export function buildConsole({ store, registry, names = null, now, hub, alerts = [], signals = null }) {
  const minuteNow = Math.floor(now / MINUTE) * MINUTE;
  const restart = { startedAt: registry.startedAt, previousRunSeenAt: registry.previousRunSeenAt };
  const devices = registry.list().map((d) => ({ ...d, status: deviceStatus(d, now, restart) }));
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const reporting = new Set(devices.filter((d) => d.status === "reporting").map((d) => d.id));
  const contextPrices = {
    version: store.prices?.v ?? null,
    checkedOn: store.prices?.inventoryCheckedOn ?? null,
    rows: (store.prices?.rows || []).filter((row) => row.status === 'verified')
      .map((row) => ({ model: row.model, ...row.usdPerMillion }))
      .concat((store.prices?.aliases || []).map((alias) => {
        const target = (store.prices?.rows || []).find((row) => row.model === alias?.aliasOf && row.status === 'verified');
        return target ? { model: alias.model, ...target.usdPerMillion } : null;
      }).filter(Boolean)),
  };

  // --- periods and series frames -------------------------------------------
  // Each minute period is the whole minutes ending with the current one
  // (docs/accounting.md §6), and its chart is cut from exactly that span, so
  // the bars add up to the headline. A record dated after the current minute
  // (a machine whose clock runs ahead) counts once its minute arrives.
  const ranges = Object.fromEntries(Object.keys(PERIODS).map((key) => [key, periodRange(key, now)]));
  const frames = {};
  const classFrame = (count) => Object.fromEntries(CLASSES.map((k) => [k, new Array(count).fill(0)]));
  for (const [key, w] of Object.entries(WINDOWS)) {
    const count = Math.round(w.span / w.step);
    frames[key] = { step: w.step, start: ranges[key].from, end: ranges[key].to, values: new Array(count).fill(0), classes: classFrame(count) };
  }
  const rates = classRates(store.prices);
  const weekStart = ranges["7d"].from;

  // Stacked series by machine (every period, the class-flow resolutions) and
  // the week by this console's local calendar day.
  const stackFrames = Object.fromEntries(Object.keys(PERIODS).map((key) => {
    const r = ranges[key];
    return [key, { start: r.from, step: STACK_STEPS[key], steps: Math.round((r.to - r.from) / STACK_STEPS[key]) }];
  }));
  const byDeviceSteps = Object.fromEntries(Object.keys(PERIODS).map((key) => [key, new Map()]));
  const stackAdd = (key, id, index, tokens) => {
    let a = byDeviceSteps[key].get(id);
    if (!a) { a = new Array(stackFrames[key].steps).fill(0); byDeviceSteps[key].set(id, a); }
    if (index >= 0 && index < a.length) a[index] += tokens;
  };
  // Sessions and tokens by tool, machine and person for every period, so the
  // period control moves Team's counts too. A minute period counts the lanes
  // (top-level sessions, subagents folded in) with usage inside it; 30 days
  // read tokens from the daily rollup, which keeps no sessions.
  const rootCache = new Map();
  const laneRootOf = (hash) => {
    if (rootCache.has(hash)) return rootCache.get(hash);
    let h = hash;
    for (let guard = 0; guard < 32; guard += 1) {
      const row = store.sessions.get(h);
      if (!row || !row.parentSessionHash || row.parentSessionHash === h || !store.sessions.has(row.parentSessionHash)) break;
      h = row.parentSessionHash;
    }
    rootCache.set(hash, h);
    return h;
  };
  const personOf = (id) => deviceById.get(id)?.person || "Unassigned";
  const periodTally = Object.fromEntries(Object.keys(PERIODS).map((key) => [key, { lanes: new Set(), byTool: new Map(), byDevice: new Map(), byPerson: new Map() }]));
  const tallyPeriod = (key, bucket, tokens) => {
    const t = periodTally[key];
    const root = bucket.sessionHash ? laneRootOf(bucket.sessionHash) : null;
    if (root) t.lanes.add(root);
    for (const [map, id] of [[t.byTool, bucket.tool || "unknown"], [t.byDevice, bucket.deviceId], [t.byPerson, personOf(bucket.deviceId)]]) {
      let e = map.get(id);
      if (!e) { e = { lanes: new Set(), tokens: 0 }; map.set(id, e); }
      e.tokens += tokens;
      if (root) e.lanes.add(root);
    }
  };
  const dayStarts = [];
  {
    const today = new Date(now);
    for (let i = 6; i >= -1; i -= 1) dayStarts.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime());
  }
  const localDayTokens = new Array(7).fill(0);
  // Per-minute tokens of the sessions an alert names, for "× normal" (H02).
  const alertSessions = new Set(alerts.filter((a) => a && a.kind !== "loop").map((a) => a.sessionHash));
  const alertMinutes = new Map();
  const dayFrom = ranges["24h"].from;
  const hourFrom = minuteNow - (SPARK_BARS - 1) * SPARK_STEP - (minuteNow % SPARK_STEP);
  const burnFrom = minuteNow - (BURN_MINUTES - 1) * MINUTE;
  const laneFrom = minuteNow - (LANE_MINUTES - 1) * MINUTE;

  // --- aggregates ----------------------------------------------------------
  const MINUTE_PERIODS = Object.keys(WINDOWS);
  const byPeriod = Object.fromEntries(Object.keys(PERIODS).map((key) => [key, emptyAgg()]));
  const byPeriodDevice = Object.fromEntries(Object.keys(PERIODS).map((key) => [key, new Map()]));
  const day = byPeriod["24h"];
  const dayByDevice = byPeriodDevice["24h"];
  const weekByDevice = byPeriodDevice["7d"];
  const sessionAgg = new Map();   // sessionHash -> { day, hour, spark[], fiveMin }
  let burnTokens = 0, burnUsd = 0, burnPricedN = 0, burnUnpricedN = 0, burnUnpricedTokens = 0;
  const burnUnpricedModels = new Set();

  const deviceAgg = (map, id) => { let a = map.get(id); if (!a) { a = emptyAgg(); map.set(id, a); } return a; };

  store.eachBucket(weekStart, minuteNow + MINUTE, (minute, bucket) => {
    const tokens = bucket.fresh + bucket.output + bucket.cacheWrite + bucket.cacheRead;
    const split = classUsdOf(bucket, rates);
    for (const f of Object.values(frames)) {
      if (minute >= f.start && minute < f.end) {
        const i = Math.floor((minute - f.start) / f.step);
        f.values[i] += tokens;
        for (const k of CLASSES) f.classes[k][i] += bucket[k];
      }
    }
    for (const key of MINUTE_PERIODS) {
      if (minute < ranges[key].from) continue;
      addBucket(byPeriod[key], bucket, tokens, split);
      addBucket(deviceAgg(byPeriodDevice[key], bucket.deviceId), bucket, tokens, split);
      if (minute < ranges[key].to) {
        stackAdd(key, bucket.deviceId, Math.floor((minute - stackFrames[key].start) / stackFrames[key].step), tokens);
        tallyPeriod(key, bucket, tokens);
      }
    }
    if (minute >= dayStarts[0]) {
      for (let d = 0; d < 7; d += 1) if (minute < dayStarts[d + 1]) { localDayTokens[d] += tokens; break; }
    }
    if (alertSessions.has(bucket.sessionHash)) {
      let m = alertMinutes.get(bucket.sessionHash);
      if (!m) { m = new Map(); alertMinutes.set(bucket.sessionHash, m); }
      m.set(minute, (m.get(minute) || 0) + tokens);
    }
    if (minute < dayFrom) return;
    let s = sessionAgg.get(bucket.sessionHash);
    if (!s) {
      s = { day: 0, hour: 0, fiveMin: 0, firstAt: minute, lastAt: minute, spark: new Array(SPARK_BARS).fill(0),
        classes: zeroClasses(), unknown: zeroClasses(), usd: 0, pricedN: 0, unpricedN: 0 };
      sessionAgg.set(bucket.sessionHash, s);
    }
    s.day += tokens;
    for (const k of CLASSES) {
      s.classes[k] += bucket[k];
      s.unknown[k] += bucket[UNKNOWN_CLASS[k]];
    }
    s.usd += bucket.usd; s.pricedN += bucket.pricedN; s.unpricedN += bucket.unpricedN;
    s.firstAt = Math.min(s.firstAt, minute);
    s.lastAt = Math.max(s.lastAt, minute);
    if (minute >= hourFrom) {
      s.hour += tokens;
      const i = Math.floor((minute - hourFrom) / SPARK_STEP);
      if (i >= 0 && i < SPARK_BARS) s.spark[i] += tokens;
    }
    if (minute >= laneFrom) s.fiveMin += tokens;
    if (minute >= burnFrom) {
      if (reporting.has(bucket.deviceId)) {
        burnTokens += tokens; burnUsd += bucket.usd;
        burnPricedN += bucket.pricedN; burnUnpricedN += bucket.unpricedN; burnUnpricedTokens += bucket.unpricedTokens;
        if (bucket.unpricedN) addName(burnUnpricedModels, priceName(bucket));
      }
    }
  });

  // 30 days: whole UTC days from the daily rollup, which outlives the minutes.
  const month = ranges["30d"];
  const monthValues = new Array(30).fill(0);
  const monthClasses = classFrame(30);
  store.eachDay?.(month.fromDay, month.toDay, (dayKey, bucket) => {
    const tokens = bucket.fresh + bucket.output + bucket.cacheWrite + bucket.cacheRead;
    const split = classUsdOf(bucket, rates);
    const i = Math.round((Date.parse(dayKey + "T00:00:00Z") - month.from) / DAY);
    if (i >= 0 && i < 30) {
      monthValues[i] += tokens;
      for (const k of CLASSES) monthClasses[k][i] += bucket[k];
    }
    addBucket(byPeriod["30d"], bucket, tokens, split);
    addBucket(deviceAgg(byPeriodDevice["30d"], bucket.deviceId), bucket, tokens, split);
    stackAdd("30d", bucket.deviceId, i, tokens);
    tallyPeriod("30d", bucket, tokens);
  });

  // --- lanes: one per top-level session, its subagents folded in -----------
  // A subagent's root is found through every session the console still
  // keeps, even one that last reported more than a day ago, so a subagent of
  // an old session is folded under it and never becomes a lane of its own.
  const inWindow = [...store.sessions.values()].filter((s) => s.lastAt >= dayFrom - MINUTE);
  const treeInput = new Map(inWindow.map((s) => [s.sessionHash, s]));
  for (const s of inWindow) {
    let parent = s.parentSessionHash;
    for (let guard = 0; parent && !treeInput.has(parent) && guard < 32; guard += 1) {
      const row = store.sessions.get(parent);
      if (!row) break;
      treeInput.set(parent, row);
      parent = row.parentSessionHash;
    }
  }
  const treeRows = agentTree([...treeInput.values()]
    .map((session) => ({
      sessionHash: session.sessionHash, parentSessionHash: session.parentSessionHash,
      model: session.model, firstAt: sessionAgg.get(session.sessionHash)?.firstAt,
      lastAt: sessionAgg.get(session.sessionHash)?.lastAt,
      tokens: sessionAgg.get(session.sessionHash)?.day ?? null,
      outcome: 'unknown',
    })));
  const rootBySession = new Map(treeRows.map((row) => [row.sessionHash, row.rootSessionHash]));
  const treeByRoot = new Map();
  for (const row of treeRows) {
    if (!treeByRoot.has(row.rootSessionHash)) treeByRoot.set(row.rootSessionHash, []);
    treeByRoot.get(row.rootSessionHash).push(row);
  }
  const lanes = new Map();
  for (const session of store.sessions.values()) {
    if (session.lastAt < dayFrom - MINUTE) continue;
    const top = store.sessions.get(rootBySession.get(session.sessionHash)) || session;
    let lane = lanes.get(top.sessionHash);
    if (!lane) {
      lane = { top, children: [], lastAt: 0, day: 0, hour: 0, fiveMin: 0, spark: new Array(SPARK_BARS).fill(0),
        classes: zeroClasses(), unknown: zeroClasses(), usd: 0, pricedN: 0, unpricedN: 0 };
      lanes.set(top.sessionHash, lane);
    }
    if (session !== top) lane.children.push(session);
    const s = sessionAgg.get(session.sessionHash);
    if (s) {
      lane.day += s.day; lane.hour += s.hour; lane.fiveMin += s.fiveMin;
      for (let i = 0; i < SPARK_BARS; i += 1) lane.spark[i] += s.spark[i];
      for (const k of CLASSES) {
        lane.classes[k] += s.classes[k];
        lane.unknown[k] += s.unknown[k];
      }
      lane.usd += s.usd; lane.pricedN += s.pricedN; lane.unpricedN += s.unpricedN;
    }
    lane.lastAt = Math.max(lane.lastAt, session.lastAt);
  }

  const laneRows = [];
  const laneMeta = new Map();
  function laneActivity(lane, device) {
    const shared = signals ? Boolean(signals.activityShared(device)) : false;
    // A machine that shares activity and sent none for this lane made no tool call: zero, known.
    const snap = shared ? signals.activity([lane.top.sessionHash, ...lane.children.map((c) => c.sessionHash)], device)
      ?? { window: "5m", calls: Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, 0])), results: { ok: 0, error: 0 }, lastTool: null } : null;
    return { activity: snap ? { window: snap.window, calls: snap.calls, results: snap.results } : null,
      lastTool: snap?.lastTool ?? null, activityShared: shared };
  }
  for (const lane of lanes.values()) {
    const device = deviceById.get(lane.top.deviceId) || { id: lane.top.deviceId, label: "Unknown machine", person: null, status: "silent" };
    const local = names && device.local ? names.project(lane.top.projectHash) : null;
    const project = local
      ? { name: local, source: "local" }
      : lane.top.engagement
        ? { name: lane.top.engagement, source: "label" }
        : { name: "project " + lane.top.projectHash.slice(0, 6), source: "hash" };
    const unavailable = device.status !== "reporting";
    const state = unavailable ? (["revoked", "catching-up", "reconnecting"].includes(device.status) ? device.status : "silent")
      : lane.lastAt >= minuteNow - LIVE_WITHIN ? "live" : "idle";
    laneRows.push({
      key: lane.top.sessionHash.slice(0, 16),
      state,
      project,
      branch: names && device.local ? names.branch(lane.top.sessionHash) : null,
      tool: lane.top.tool,
      model: lane.top.model,
      modelLabel: modelLabel(lane.top.model),
      device: { id: device.id, label: device.label, person: device.person || null, local: Boolean(device.local), status: device.status, lastContactAt: device.lastContactAt || null, backlog: device.backlog || null },
      spark: lane.spark,
      tokens5m: unavailable ? null : lane.fiveMin,
      tokensHour: lane.hour,
      tokensDay: lane.day,
      // The day's tokens by class, and its list-price estimate: the session's
      // own buckets plus its subagents', each counted once (docs/accounting.md §3.6).
      tokensDayByClass: lane.classes,
      // Counts of records missing each class: the numeric sums above are
      // floors whenever one is nonzero, including folded-in subagents.
      tokensDayUnknown: lane.unknown,
      costDay: { usd: lane.pricedN ? lane.usd : null, status: costStatus(lane.pricedN, lane.unpricedN) },
      agents: {
        live: lane.children.filter((c) => c.lastAt >= minuteNow - 5 * MINUTE).length,
        total: lane.children.length,
      },
      agentTree: (treeByRoot.get(lane.top.sessionHash) || []).map((agent) => ({ ...agent, modelLabel: modelLabel(agent.model),
        // Tool results the session reported, ok and error (counts only), when its machine shares them.
        results: signals?.results?.(agent.sessionHash, device) ?? null })),
      context: contextHealth(lane.top.contextSamples || [], contextPrices),
      lastAt: lane.lastAt,
      // Tool activity in the last five minutes, by kind, and the last tool's
      // kind and time — counts only, from this machine's own transcripts or a
      // machine run with --share-tool-activity. `activityShared` false means
      // the machine does not send it: unknown, not idle.
      ...laneActivity(lane, device),
    });
    laneMeta.set(laneRows.at(-1).key, { children: lane.children.length, deviceId: device.id, person: device.person || "Unassigned",
      local: Boolean(device.local), projectHash: lane.top.projectHash, tokensDay: lane.day, spark: lane.spark });
  }
  const rank = { live: 0, idle: 1, "catching-up": 2, reconnecting: 2, silent: 2, revoked: 3 };
  laneRows.sort((a, b) => rank[a.state] - rank[b.state]
    || (b.tokens5m ?? -1) - (a.tokens5m ?? -1) || b.lastAt - a.lastAt);

  // --- machines and people -------------------------------------------------
  const wholes = Object.fromEntries(Object.keys(PERIODS).map((key) => [key, byPeriod[key].total]));
  const periodSummaries = (source, id) => Object.fromEntries(Object.keys(PERIODS).map((key) => {
    const agg = source(key, id);
    if (key === "30d" && !agg.n) agg.sessionsKnown = false;
    return [key, summarize(agg, { whole: wholes[key], topModels: 4 })];
  }));
  // A row's activity over each period, at the period's stacked-series
  // resolution (1 h: 3 min, 24 h: 15 min, 7 d: 2 h, 30 d: day), so a Team
  // row's sparkline follows the period control like the chart above it.
  const sparkOf = (key, ids) => {
    const f = stackFrames[key];
    const tokens = new Array(f.steps).fill(0);
    for (const id of ids) { const a = byDeviceSteps[key].get(id); if (a) for (let i = 0; i < f.steps; i += 1) tokens[i] += a[i]; }
    return { start: f.start, step: f.step, tokens };
  };
  const sparksOf = (ids) => Object.fromEntries(Object.keys(PERIODS).map((key) => [key, sparkOf(key, ids)]));
  const deviceRows = devices.map((d) => {
    const windows = periodSummaries((key) => byPeriodDevice[key].get(d.id) || emptyAgg());
    return {
      id: d.id, label: d.label, person: d.person || null, local: Boolean(d.local),
      status: d.status, mode: d.mode, joinedVia: d.joinedVia, createdAt: d.createdAt,
      lastContactAt: d.lastContactAt || null, lastObservedAt: d.lastObservedAt || null, revokedAt: d.revokedAt || null, leftAt: d.leftAt || null,
      backlog: d.status === "catching-up" ? d.backlog : null,
      // `reported` false: this machine's reporter version never said what it
      // could not count, so its drops are unknown (null), never 0.
      coverage: d.coverage ? { ...dropsOf(d.coverage), reported: true, since: Number.isFinite(d.coverageSince) ? d.coverageSince : null }
        : { ...dropsOf(null), dropped: null, reported: false, since: null },
      day: windows["24h"],
      week: windows["7d"],
      windows,
      sparks: sparksOf([d.id]),
    };
  });
  const people = new Map();
  for (const d of devices) {
    const who = d.person || "Unassigned";
    const key = who.toLowerCase();
    let p = people.get(key);
    if (!p) { p = { person: who, devices: [], periods: Object.fromEntries(Object.keys(PERIODS).map((k) => [k, emptyAgg()])), reporting: 0, lastContactAt: null }; people.set(key, p); }
    p.devices.push(d.id);
    if (d.status === "reporting") p.reporting += 1;
    if (d.lastContactAt && (!p.lastContactAt || d.lastContactAt > p.lastContactAt)) p.lastContactAt = d.lastContactAt;
    for (const key of Object.keys(PERIODS)) {
      const a = byPeriodDevice[key].get(d.id);
      if (a) mergeAgg(p.periods[key], a);
    }
  }
  const peopleRows = [...people.values()].map((p) => {
    const windows = periodSummaries((key) => p.periods[key]);
    return { person: p.person, devices: p.devices, reporting: p.reporting, lastContactAt: p.lastContactAt,
      day: windows["24h"], week: windows["7d"], windows, sparks: sparksOf(p.devices) };
  }).sort((a, b) => b.day.tokens.total - a.day.tokens.total || b.week.tokens.total - a.week.tokens.total);

  // --- gaps --------------------------------------------------------------------
  // A removed machine is not silent: it was taken off on purpose, so it does
  // not make the chart "incomplete" or get named as left out of the burn.
  const silent = deviceRows.filter((d) => d.status === "silent");
  const catchingUp = deviceRows.filter((d) => d.status === "catching-up" || d.status === "reconnecting");
  const silentSince = silent
    .map((d) => d.lastContactAt)
    .filter((t) => t && t > weekStart)
    .sort((a, b) => a - b)[0] || null;
  const elapsed = (BURN_MINUTES - 1) + (now - minuteNow) / MINUTE;

  const series = {};
  // `classes` splits each step's value by token class; the four add up to it.
  for (const [key, f] of Object.entries(frames)) {
    series[key] = { start: f.start, step: f.step, values: f.values, classes: f.classes };
  }
  series["30d"] = { start: month.from, step: DAY, values: monthValues, classes: monthClasses, timeZone: "UTC" };
  // Every period stacked by machine: the top four machines as bands, the rest
  // summed, over the same span as the headline, so the bands add up to it.
  for (const key of Object.keys(PERIODS)) series[key].byDevice = stackOf(stackFrames[key], byDeviceSteps[key], "deviceId");
  // The week by this console's own calendar day, so the busiest day is a
  // real day in a named zone. Today is in progress; a day older than the
  // minute detail kept is partial.
  {
    const kept = Number.isFinite(store.retentionMs) ? now - store.retentionMs : null;
    const pad = (n) => String(n).padStart(2, "0");
    const dateOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    series["7d"].byLocalDay = {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      days: localDayTokens.map((tokens, d) => ({ date: dateOf(dayStarts[d]), tokens,
        partial: d === 6 || (kept !== null && dayStarts[d] < kept) })),
    };
  }

  // --- counts over every lane, not only the 80 sent ------------------------
  const laneTotals = { total: laneRows.length, shown: Math.min(LANES_SHOWN, laneRows.length), byTool: {}, byDevice: {}, byPerson: {},
    byLocalProject: {}, subagentCount: 0, cold: { sessions: 0, tokensDay: 0 } };
  const tally = (map, id, row) => {
    const t = map[id] ??= { sessions: 0, live: 0, tokensDay: 0 };
    t.sessions += 1; if (row.state === "live") t.live += 1; t.tokensDay += row.tokensDay;
  };
  for (const row of laneRows) {
    const meta = laneMeta.get(row.key);
    tally(laneTotals.byTool, row.tool, row);
    tally(laneTotals.byDevice, meta.deviceId, row);
    tally(laneTotals.byPerson, meta.person, row);
    laneTotals.subagentCount += meta.children;
    // The rows the lane list folds away: not live or idle within the hour.
    if (!((row.state === "live" || row.state === "idle") && minuteNow - row.lastAt < HOUR)) {
      laneTotals.cold.sessions += 1; laneTotals.cold.tokensDay += row.tokensDay;
    }
    if (meta.local) {
      const p = laneTotals.byLocalProject[meta.projectHash] ??= { sessions: 0, live: 0, hourSpark: new Array(SPARK_BARS).fill(0) };
      p.sessions += 1; if (row.state === "live") p.live += 1;
      for (let i = 0; i < SPARK_BARS; i += 1) p.hourSpark[i] += meta.spark[i];
    }
  }

  // The same counts for every period. Sessions are null where the period is
  // read from the daily rollup, with the reason, never the day's count under
  // a month's caption.
  const tallyOut = (map, kept) => Object.fromEntries([...map.entries()].map(([id, e]) => [id, { sessions: kept ? e.lanes.size : null, tokens: e.tokens }]));
  laneTotals.periods = Object.fromEntries(Object.keys(PERIODS).map((key) => {
    const t = periodTally[key];
    const kept = ranges[key].basis === "minutes";
    return [key, { basis: ranges[key].basis, sessionsKept: kept,
      reason: kept ? null : "Sessions are kept with the minute detail, not with the daily rollup",
      sessions: kept ? t.lanes.size : null,
      byTool: tallyOut(t.byTool, kept), byDevice: tallyOut(t.byDevice, kept), byPerson: tallyOut(t.byPerson, kept) }];
  }));

  // --- per machine: a denominator that is named ------------------------------
  // Over the machines heard from within the period (not removed), from their
  // own figures — never the whole team's total divided by them.
  const current = devices.filter((d) => d.status !== "revoked");
  const perMachine = {};
  for (const key of Object.keys(PERIODS)) {
    const heard = current.filter((d) => d.lastContactAt && d.lastContactAt >= ranges[key].from);
    let usd = 0, priced = 0, unpriced = 0;
    for (const d of heard) {
      const a = byPeriodDevice[key].get(d.id);
      if (a) { usd += a.usd; priced += a.pricedN; unpriced += a.unpricedN; }
    }
    const status = heard.length === 0 ? "none" : priceStatus(priced, unpriced) === "none" ? "priced" : priceStatus(priced, unpriced);
    const usdReporting = heard.length === 0 || status === "unpriced" ? null : usd;
    perMachine[key] = { reporting: heard.length, current: current.length, usdReporting,
      usdPerMachine: usdReporting === null ? null : usdReporting / heard.length, status };
  }

  // --- alerts: dated by their own line, named by their lane ------------------
  const rootOf = (hash) => {
    let h = hash;
    for (let guard = 0; guard < 32; guard += 1) {
      const row = store.sessions.get(h);
      if (!row || !row.parentSessionHash || row.parentSessionHash === h || !store.sessions.has(row.parentSessionHash)) return h;
      h = row.parentSessionHash;
    }
    return h;
  };
  const alertRows = alerts.filter(Boolean).map((a) => {
    const root = rootOf(a.sessionHash);
    const top = store.sessions.get(root) || store.sessions.get(a.sessionHash) || null;
    const deviceId = a.deviceId ?? top?.deviceId ?? null;
    const device = deviceId ? deviceById.get(deviceId) : null;
    const projectHash = top?.projectHash ?? a.projectHash ?? null;
    const displayName = device?.local && names && projectHash ? names.project(projectHash) || null : top?.engagement || null;
    const lane = top ? { key: root.slice(0, 16), projectHash, deviceId, ...(displayName ? { displayName } : {}) } : null;
    const out = { id: a.id, kind: a.kind, at: a.at, seenAt: a.seenAt ?? null, historical: Boolean(a.historical),
      sessionHash: a.sessionHash, laneHash: top ? root : a.laneHash ?? null, projectHash, deviceId, count: a.count ?? a.tokens ?? null,
      tokens: a.tokens ?? a.count ?? null, lane };
    if (a.kind === "spike" || a.kind === "stall") Object.assign(out, magnitude(alertMinutes.get(a.sessionHash), a.at));
    return out;
  }).sort((x, y) => y.at - x.at);
  const watched = current.filter((d) => signals?.alertsWatched?.(d));
  const alertsCoverage = { watched: watched.length, unwatched: current.length - watched.length,
    unwatchedDevices: current.filter((d) => !signals?.alertsWatched?.(d)).map((d) => d.id) };

  // One summary per period, each naming its exact range. The 30-day period
  // says from which day the daily rollup is whole.
  const windows = {};
  for (const key of Object.keys(PERIODS)) {
    const r = ranges[key];
    const since = key === "30d" ? store.dailySince ?? null : null;
    // A minute period longer than the minute retention (--retention-days
    // below 7) covers only the days still kept: it says so and from when.
    const kept = Number.isFinite(store.retentionMs) ? Math.floor((now - store.retentionMs) / MINUTE) * MINUTE : null;
    const short = r.basis === "minutes" && kept !== null && kept > r.from;
    // Usage that arrived after its day passed the minute retention is not in
    // the daily totals either (counted as pastRetention): the 30 days are partial.
    const late = key === "30d" && (store.dropped?.pastRetention ?? 0) > 0;
    windows[key] = { key, label: PERIODS[key].label, basis: r.basis, timeZone: "UTC", from: r.from, to: r.to,
      ...(key === "30d" ? { since, partial: since === null || since > r.fromDay || late } : {}),
      ...(short ? { since: new Date(kept).toISOString(), partial: true } : {}),
      ...summarize(byPeriod[key], { topModels: 8 }) };
    if (key === "30d" && !byPeriod[key].n) windows[key].sessions = null;
  }

  // What could not be counted: each machine's collector, and this hub.
  const hubDrops = store.dropped ? { ...store.dropped } : {};
  const reasons = new Map();
  const machineDrops = [];
  for (const d of deviceRows) {
    if (!d.coverage.dropped) continue;
    machineDrops.push({ id: d.id, label: d.label, dropped: d.coverage.dropped });
    for (const r of d.coverage.reasons) reasons.set(r.kind, (reasons.get(r.kind) || 0) + r.count);
  }
  for (const [kind, n] of Object.entries(hubDrops)) if (n > 0 && DROP_REASONS[kind]) reasons.set(kind, (reasons.get(kind) || 0) + n);
  const coverage = {
    dropped: [...reasons.values()].reduce((a, n) => a + n, 0),
    reasons: [...reasons.entries()].map(([kind, count]) => ({ kind, count, label: DROP_REASONS[kind] })).sort((a, b) => b.count - a.count),
    devices: machineDrops,
    hub: hubDrops,
    recovered: deviceRows.reduce((a, d) => a + d.coverage.recovered, 0),
  };

  const burnCost = costStatus(burnPricedN, burnUnpricedN);
  return {
    v: 2,
    now,
    // When every section of this payload was computed: one clock.
    asOf: now,
    alertsAsOf: now,
    hub,
    day: { from: dayFrom, to: now, ...summarize(day, { topModels: 8 }) },
    windows,
    coverage,
    series,
    silentSince,
    burn: {
      windowMinutes: BURN_MINUTES,
      tokensPerMinute: burnTokens / elapsed,
      // null when nothing in the window has a verified price: unknown, not $0.
      usdPerMinute: burnCost === "unpriced" ? null : burnUsd / elapsed,
      cost: {
        status: burnCost,
        unpricedTokensPerMinute: burnUnpricedTokens / elapsed,
        unpricedModels: [...burnUnpricedModels].sort(),
      },
      reporting: reporting.size,
      excluded: [...silent, ...catchingUp].map((d) => ({ id: d.id, label: d.label, lastContactAt: d.lastContactAt, status: d.status })),
    },
    lanes: laneRows.slice(0, LANES_SHOWN),
    laneCount: laneRows.length,
    laneTotals,
    devices: deviceRows,
    people: peopleRows,
    team: { perMachine },
    alerts: alertRows,
    alertsCoverage,
    invitations: registry.invitations().filter((i) => i.state === "open" || (i.state === "joined" && Date.parse(i.usedAt) > now - 7 * DAY)),
  };
}
