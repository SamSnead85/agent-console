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
  damaged: "a damaged line in this console's own files",
};
const SPARK_BARS = 20;
const SPARK_STEP = 3 * MINUTE;
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
function costStatus(pricedN, unpricedN) {
  return pricedN + unpricedN === 0 ? "none" : unpricedN === 0 ? "estimated" : pricedN === 0 ? "unpriced" : "partial";
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
    models: new Map(), unpricedModels: new Set(), sessions: new Set(), sessionsKnown: true,
  };
}

/** The name an unpriced share goes by: the model, and the tier when that is why. */
const priceName = (bucket) => bucket.model + (bucket.tier === "fast" ? " (fast mode)" : bucket.tier === "other" ? " (service tier)" : "");

function addBucket(agg, bucket, tokens) {
  agg.total += tokens;
  for (const k of CLASSES) agg[k] += bucket[k];
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
    "unknownCacheRead", "n", "messages", "usd", "pricedN", "unpricedN", "unpricedTokens", "pricedMessages", "unpricedMessages"]) dst[k] += a[k];
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

export function buildConsole({ store, registry, names = null, now, hub }) {
  const minuteNow = Math.floor(now / MINUTE) * MINUTE;
  const restart = { startedAt: registry.startedAt, previousRunSeenAt: registry.previousRunSeenAt };
  const devices = registry.list().map((d) => ({ ...d, status: deviceStatus(d, now, restart) }));
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const reporting = new Set(devices.filter((d) => d.status === "reporting").map((d) => d.id));
  const contextPrices = {
    version: store.prices?.v ?? null,
    checkedOn: store.prices?.inventoryCheckedOn ?? null,
    rows: (store.prices?.rows || []).filter((row) => row.status === 'verified')
      .map((row) => ({ model: row.model, ...row.usdPerMillion })),
  };

  // --- periods and series frames -------------------------------------------
  // Each minute period is the whole minutes ending with the current one
  // (docs/accounting.md §6), and its chart is cut from exactly that span, so
  // the bars add up to the headline. A record dated after the current minute
  // (a machine whose clock runs ahead) counts once its minute arrives.
  const ranges = Object.fromEntries(Object.keys(PERIODS).map((key) => [key, periodRange(key, now)]));
  const frames = {};
  for (const [key, w] of Object.entries(WINDOWS)) {
    const count = Math.round(w.span / w.step);
    frames[key] = { step: w.step, start: ranges[key].from, end: ranges[key].to, values: new Array(count).fill(0) };
  }
  const weekStart = ranges["7d"].from;
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
    for (const f of Object.values(frames)) {
      if (minute >= f.start && minute < f.end) f.values[Math.floor((minute - f.start) / f.step)] += tokens;
    }
    for (const key of MINUTE_PERIODS) {
      if (minute < ranges[key].from) continue;
      addBucket(byPeriod[key], bucket, tokens);
      addBucket(deviceAgg(byPeriodDevice[key], bucket.deviceId), bucket, tokens);
    }
    if (minute < dayFrom) return;
    let s = sessionAgg.get(bucket.sessionHash);
    if (!s) { s = { day: 0, hour: 0, fiveMin: 0, firstAt: minute, lastAt: minute, spark: new Array(SPARK_BARS).fill(0) }; sessionAgg.set(bucket.sessionHash, s); }
    s.day += tokens;
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
  store.eachDay?.(month.fromDay, month.toDay, (dayKey, bucket) => {
    const tokens = bucket.fresh + bucket.output + bucket.cacheWrite + bucket.cacheRead;
    const i = Math.round((Date.parse(dayKey + "T00:00:00Z") - month.from) / DAY);
    if (i >= 0 && i < 30) monthValues[i] += tokens;
    addBucket(byPeriod["30d"], bucket, tokens);
    addBucket(deviceAgg(byPeriodDevice["30d"], bucket.deviceId), bucket, tokens);
  });

  // --- lanes: one per top-level session, its subagents folded in -----------
  const treeRows = agentTree([...store.sessions.values()].filter((s) => s.lastAt >= dayFrom - MINUTE)
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
      lane = { top, children: [], lastAt: 0, day: 0, hour: 0, fiveMin: 0, spark: new Array(SPARK_BARS).fill(0) };
      lanes.set(top.sessionHash, lane);
    }
    if (session !== top) lane.children.push(session);
    const s = sessionAgg.get(session.sessionHash);
    if (s) {
      lane.day += s.day; lane.hour += s.hour; lane.fiveMin += s.fiveMin;
      for (let i = 0; i < SPARK_BARS; i += 1) lane.spark[i] += s.spark[i];
    }
    lane.lastAt = Math.max(lane.lastAt, session.lastAt);
  }

  const laneRows = [];
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
      agents: {
        live: lane.children.filter((c) => c.lastAt >= minuteNow - 5 * MINUTE).length,
        total: lane.children.length,
      },
      agentTree: (treeByRoot.get(lane.top.sessionHash) || []).map((agent) => ({ ...agent, modelLabel: modelLabel(agent.model) })),
      context: contextHealth(lane.top.contextSamples || [], contextPrices),
      lastAt: lane.lastAt,
    });
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
  const deviceRows = devices.map((d) => {
    const windows = periodSummaries((key) => byPeriodDevice[key].get(d.id) || emptyAgg());
    return {
      id: d.id, label: d.label, person: d.person || null, local: Boolean(d.local),
      status: d.status, mode: d.mode, joinedVia: d.joinedVia, createdAt: d.createdAt,
      lastContactAt: d.lastContactAt || null, lastObservedAt: d.lastObservedAt || null, revokedAt: d.revokedAt || null, leftAt: d.leftAt || null,
      backlog: d.status === "catching-up" ? d.backlog : null,
      coverage: dropsOf(d.coverage),
      day: windows["24h"],
      week: windows["7d"],
      windows,
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
      day: windows["24h"], week: windows["7d"], windows };
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
  for (const [key, f] of Object.entries(frames)) {
    series[key] = { start: f.start, step: f.step, values: f.values };
  }
  series["30d"] = { start: month.from, step: DAY, values: monthValues, timeZone: "UTC" };

  // One summary per period, each naming its exact range. The 30-day period
  // says from which day the daily rollup is whole.
  const windows = {};
  for (const key of Object.keys(PERIODS)) {
    const r = ranges[key];
    const since = key === "30d" ? store.dailySince ?? null : null;
    windows[key] = { key, label: PERIODS[key].label, basis: r.basis, timeZone: "UTC", from: r.from, to: r.to,
      ...(key === "30d" ? { since, partial: since === null || since > r.fromDay } : {}),
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
    lanes: laneRows.slice(0, 80),
    laneCount: laneRows.length,
    devices: deviceRows,
    people: peopleRows,
    invitations: registry.invitations().filter((i) => i.state === "open" || (i.state === "joined" && Date.parse(i.usedAt) > now - 7 * DAY)),
  };
}
