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
 * 4. COST IS AN ESTIMATE AND MAY BE PARTIAL. Dollars come from the offline
 *    price table. A model the table does not price is excluded from the dollar
 *    figure and the screen says how many tokens that leaves out; it is never
 *    priced at zero.
 */

import { CLASSES, MINUTE } from "./store.js";

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const WINDOWS = {
  "1h": { span: HOUR, step: MINUTE },
  "24h": { span: DAY, step: 15 * MINUTE },
  "7d": { span: 7 * DAY, step: 2 * HOUR },
};
const SPARK_BARS = 20;
const SPARK_STEP = 3 * MINUTE;
const LIVE_WITHIN = 2 * MINUTE;
const BURN_MINUTES = 5;

/** A machine reporting every few seconds is overdue after a minute; an hourly one after two hours. */
export function deviceStatus(device, now) {
  if (device.revokedAt) return "revoked";
  if (!device.lastContactAt) return "waiting";
  const limit = device.mode === "periodic" ? 2 * HOUR : 90_000;
  if (now - device.lastContactAt > limit) return "silent";
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
    unknownFresh: 0, unknownOutput: 0, unknownCacheWrite: 0, unknownCacheRead: 0,
    n: 0, messages: 0, usd: 0, pricedN: 0, unpricedN: 0, unpricedTokens: 0,
    models: new Map(), unpricedModels: new Set(), sessions: new Set(),
  };
}

function addBucket(agg, bucket, tokens) {
  agg.total += tokens;
  for (const k of CLASSES) agg[k] += bucket[k];
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
  if (!m) { m = { tokens: 0, usd: 0, n: 0, messages: 0, unpricedN: 0 }; agg.models.set(bucket.model, m); }
  m.tokens += tokens; m.usd += bucket.usd; m.n += bucket.n; m.messages += bucket.messages; m.unpricedN += bucket.unpricedN;
  if (bucket.unpricedN) addName(agg.unpricedModels, bucket.model);
  agg.sessions.add(bucket.sessionHash);
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
      unpricedMessages: m.unpricedN,
    }))
    .sort((a, b) => b.tokens - a.tokens);
  return {
    tokens: { total: agg.total, fresh: agg.fresh, output: agg.output, cacheWrite: agg.cacheWrite, cacheRead: agg.cacheRead },
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
    sessions: agg.sessions.size,
    shareOfWhole: whole === null ? null : share(agg.total, whole),
    cost: {
      usd: agg.pricedN ? agg.usd : null,
      status: agg.n === 0 ? "none" : agg.unpricedN === 0 ? "estimated" : agg.pricedN === 0 ? "unpriced" : "partial",
      pricedMessages: agg.pricedN,
      unpricedMessages: agg.unpricedN,
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
export function buildConsole({ store, registry, names = null, now, hub }) {
  const minuteNow = Math.floor(now / MINUTE) * MINUTE;
  const devices = registry.list().map((d) => ({ ...d, status: deviceStatus(d, now) }));
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const reporting = new Set(devices.filter((d) => d.status === "reporting").map((d) => d.id));

  // --- series frames ----------------------------------------------------
  const frames = {};
  for (const [key, w] of Object.entries(WINDOWS)) {
    const end = Math.floor(now / w.step) * w.step + w.step;   // the current (partial) step is the last bar
    const count = Math.round(w.span / w.step);
    frames[key] = { step: w.step, start: end - count * w.step, end, values: new Array(count).fill(0) };
  }
  const weekStart = frames["7d"].start;
  const dayFrom = now - DAY;
  const hourFrom = minuteNow - (SPARK_BARS - 1) * SPARK_STEP - (minuteNow % SPARK_STEP);
  const burnFrom = minuteNow - (BURN_MINUTES - 1) * MINUTE;

  // --- aggregates ----------------------------------------------------------
  const day = emptyAgg();
  const dayByDevice = new Map();
  const weekByDevice = new Map();
  const sessionAgg = new Map();   // sessionHash -> { day, hour, spark[], fiveMin }
  let burnTokens = 0, burnUsd = 0, burnPricedN = 0, burnUnpricedN = 0, burnUnpricedTokens = 0;
  const burnUnpricedModels = new Set();

  const deviceAgg = (map, id) => { let a = map.get(id); if (!a) { a = emptyAgg(); map.set(id, a); } return a; };

  store.eachBucket(Math.min(weekStart, dayFrom), now + DAY, (minute, bucket) => {
    const tokens = bucket.fresh + bucket.output + bucket.cacheWrite + bucket.cacheRead;
    for (const f of Object.values(frames)) {
      if (minute >= f.start && minute < f.end) f.values[Math.floor((minute - f.start) / f.step)] += tokens;
    }
    if (minute >= weekStart) addBucket(deviceAgg(weekByDevice, bucket.deviceId), bucket, tokens);
    if (minute < dayFrom - MINUTE) return;
    addBucket(day, bucket, tokens);
    addBucket(deviceAgg(dayByDevice, bucket.deviceId), bucket, tokens);
    let s = sessionAgg.get(bucket.sessionHash);
    if (!s) { s = { day: 0, hour: 0, fiveMin: 0, spark: new Array(SPARK_BARS).fill(0) }; sessionAgg.set(bucket.sessionHash, s); }
    s.day += tokens;
    if (minute >= hourFrom) {
      s.hour += tokens;
      const i = Math.floor((minute - hourFrom) / SPARK_STEP);
      if (i >= 0 && i < SPARK_BARS) s.spark[i] += tokens;
    }
    if (minute >= burnFrom) {
      s.fiveMin += tokens;
      if (reporting.has(bucket.deviceId)) {
        burnTokens += tokens; burnUsd += bucket.usd;
        burnPricedN += bucket.pricedN; burnUnpricedN += bucket.unpricedN; burnUnpricedTokens += bucket.unpricedTokens;
        if (bucket.unpricedN) addName(burnUnpricedModels, bucket.model);
      }
    }
  });

  // --- lanes: one per top-level session, its subagents folded in -----------
  const lanes = new Map();
  for (const session of store.sessions.values()) {
    if (session.lastAt < dayFrom - MINUTE) continue;
    const parent = session.isSubagent && session.parentSessionHash && store.sessions.get(session.parentSessionHash);
    const top = parent || session;
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
    const state = unavailable ? (device.status === "revoked" ? "revoked" : device.status === "catching-up" ? "catching-up" : "silent")
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
      lastAt: lane.lastAt,
    });
  }
  const rank = { live: 0, idle: 1, "catching-up": 2, silent: 2, revoked: 3 };
  laneRows.sort((a, b) => rank[a.state] - rank[b.state]
    || (b.tokens5m ?? -1) - (a.tokens5m ?? -1) || b.lastAt - a.lastAt);

  // --- machines and people -------------------------------------------------
  const dayWhole = day.total;
  const weekWhole = [...weekByDevice.values()].reduce((sum, a) => sum + a.total, 0);
  const deviceRows = devices.map((d) => ({
    id: d.id, label: d.label, person: d.person || null, local: Boolean(d.local),
    status: d.status, mode: d.mode, joinedVia: d.joinedVia, createdAt: d.createdAt,
    lastContactAt: d.lastContactAt || null, lastObservedAt: d.lastObservedAt || null, revokedAt: d.revokedAt || null,
    backlog: d.status === "catching-up" ? d.backlog : null,
    day: summarize(dayByDevice.get(d.id) || emptyAgg(), { whole: dayWhole, topModels: 4 }),
    week: summarize(weekByDevice.get(d.id) || emptyAgg(), { whole: weekWhole, topModels: 4 }),
  }));
  const people = new Map();
  for (const d of devices) {
    const who = d.person || "Unassigned";
    const key = who.toLowerCase();
    let p = people.get(key);
    if (!p) { p = { person: who, devices: [], day: emptyAgg(), week: emptyAgg(), reporting: 0, lastContactAt: null }; people.set(key, p); }
    p.devices.push(d.id);
    if (d.status === "reporting") p.reporting += 1;
    if (d.lastContactAt && (!p.lastContactAt || d.lastContactAt > p.lastContactAt)) p.lastContactAt = d.lastContactAt;
    for (const [src, dst] of [[dayByDevice, p.day], [weekByDevice, p.week]]) {
      const a = src.get(d.id);
      if (!a) continue;
      for (const k of ["total", ...CLASSES, "unknownFresh", "unknownOutput", "unknownCacheWrite", "unknownCacheRead", "n", "messages", "usd", "pricedN", "unpricedN", "unpricedTokens"]) dst[k] += a[k];
      for (const [model, m] of a.models) {
        let t = dst.models.get(model);
        if (!t) { t = { tokens: 0, usd: 0, n: 0, messages: 0, unpricedN: 0 }; dst.models.set(model, t); }
        t.tokens += m.tokens; t.usd += m.usd; t.n += m.n; t.messages += m.messages; t.unpricedN += m.unpricedN;
      }
      for (const m of a.unpricedModels) addName(dst.unpricedModels, m);
      for (const s of a.sessions) dst.sessions.add(s);
    }
  }
  const peopleRows = [...people.values()].map((p) => ({
    person: p.person,
    devices: p.devices,
    reporting: p.reporting,
    lastContactAt: p.lastContactAt,
    day: summarize(p.day, { whole: dayWhole, topModels: 4 }),
    week: summarize(p.week, { whole: weekWhole, topModels: 4 }),
  })).sort((a, b) => b.day.tokens.total - a.day.tokens.total || b.week.tokens.total - a.week.tokens.total);

  // --- gaps --------------------------------------------------------------------
  const silent = deviceRows.filter((d) => d.status === "silent" || d.status === "revoked");
  const catchingUp = deviceRows.filter((d) => d.status === "catching-up");
  const silentSince = silent
    .map((d) => d.lastContactAt)
    .filter((t) => t && t > weekStart)
    .sort((a, b) => a - b)[0] || null;
  const elapsed = (BURN_MINUTES - 1) + (now - minuteNow) / MINUTE;

  const series = {};
  for (const [key, f] of Object.entries(frames)) {
    series[key] = { start: f.start, step: f.step, values: f.values };
  }

  const burnCost = costStatus(burnPricedN, burnUnpricedN);
  return {
    v: 2,
    now,
    hub,
    day: { from: dayFrom, to: now, ...summarize(day, { topModels: 8 }) },
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
