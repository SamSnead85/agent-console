/**
 * Token history — period-scoped aggregation with a persistence layer.
 *
 * "Today" is the wrong mental model for a fleet that runs overnight: 1.8
 * billion tokens spent yesterday looked like a reset this morning because the
 * whole screen was day-scoped. History fixes the model instead of the label:
 * every total on the history surface is scoped to an explicit period the
 * operator selected, and says so.
 *
 * Two sources, merged:
 *
 *  1. SOURCE data. Every transcript line carries its own timestamp, so the
 *     ordinary scan can attribute each de-duplicated token delta to the
 *     five-minute bucket it actually happened in. This is what recovers
 *     yesterday's figures after a restart — nothing is lost just because the
 *     process was not running when the tokens were spent.
 *  2. SNAPSHOTS. Source data only reaches as far back as the transcripts on
 *     disk (the scan window, and whatever log pruning has not yet removed), so
 *     the store is flushed to this console's private history directory about
 *     every five minutes while the dashboard runs. On startup the file is read
 *     back and merged.
 *
 * The merge rule is element-wise MAX per (bucket, model, class) — never sum.
 * A fresh process re-reads the same transcripts the previous run flushed, so
 * the same bucket arrives from both sources with the same underlying spend;
 * summing would double count exactly the way naive usage-line summing did
 * (1.84×, see lib/claude.js). Max is idempotent under re-reading. The one case
 * it undercounts — two runs that each saw a disjoint half of one bucket, with
 * the logs pruned in between — is accepted: this instrument never overcounts.
 *
 * Claude only. Codex counters are thread-cumulative (Σ) and are never added to
 * a period total, for the same reason they are never added to a daily one.
 */

import fs from "node:fs";
import path from "node:path";
import {
  costSplit,
  sumTokens,
  zeroTokens,
  addTokens,
  addCost,
  zeroCost,
} from "./prices.js";
import { dayKeyOf } from "./day.js";
import { resolveProjectSlug, projectLabel } from "./paths.js";
import {
  appendPrivateFile,
  hardenPrivateFile,
  writePrivateAtomic,
} from "./private-state.js";

export const BUCKET_MS = 5 * 60_000;

/** Maximum points a series is downsampled to before it is served. */
export const MAX_SERIES_POINTS = 360;

/** Flush cadence while the server runs. */
export const FLUSH_MS = 5 * 60_000;

/** Compact the history file on load once it grows past this. */
const COMPACT_BYTES = 8 * 1024 * 1024;

/**
 * `all` used to be labelled "project lifecycle", which is two wrong claims in
 * two words: it is not one project — it is every project this machine has a
 * transcript for — and it is not that project's lifetime, it is however far
 * back the transcripts and snapshots on this disk happen to reach. The label
 * now says what the period actually covers, and the coverage line under the
 * chart names the date it starts.
 */
export const PERIODS = {
  hour: { id: "hour", label: "last hour", ms: 3600_000 },
  "24h": { id: "24h", label: "last 24 hours", ms: 24 * 3600_000 },
  "3d": { id: "3d", label: "last 3 days", ms: 3 * 24 * 3600_000 },
  all: { id: "all", label: "everything recorded", ms: null },
};

const CLASSES = ["in", "out", "cr", "cw", "cw1h", "think"];

export function createHistoryStore(config) {
  const dir = config && config.dir;
  return {
    dir: dir || null,
    file: dir ? path.join(dir, "history.jsonl") : null,
    /** Source-derived buckets, filled by the live scan. */
    live: new Map(),
    /** Buckets read back from history.jsonl. */
    persisted: new Map(),
    dirty: new Set(),
    loaded: false,
    badLines: 0,
    loadError: null,
    flushError: null,
    lastFlushAt: 0,
    earliestSourceMs: null,
  };
}

function bucketStartOf(ts) {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

function emptyBucket() {
  return { models: new Map(), sessions: new Map(), projects: new Map() };
}

/** The project slug a session key belongs to. */
export function slugOfSessionKey(key) {
  return String(key).split("|")[0];
}

/**
 * Record one de-duplicated token delta at the timestamp it was PARSED FROM,
 * never the wall clock — stamping "now" would pile every recovered historical
 * line into the current bucket and the whole point is recovering yesterday.
 */
export function addHistorySample(store, ts, model, sessionKey, delta) {
  if (!Number.isFinite(ts)) return;
  const start = bucketStartOf(ts);
  let bucket = store.live.get(start);
  if (!bucket) {
    bucket = emptyBucket();
    store.live.set(start, bucket);
  }
  let tokens = bucket.models.get(model);
  if (!tokens) {
    tokens = zeroTokens();
    bucket.models.set(model, tokens);
  }
  addTokens(tokens, delta);
  if (sessionKey) {
    bucket.sessions.set(
      sessionKey,
      (bucket.sessions.get(sessionKey) || 0) + sumTokens(delta),
    );
    // Per-project class split, recorded at ingest. Without it a bucket in which
    // two projects were both active can only ever report each project's TOTAL
    // (from the session keys), never its cost — and a project-scoped dollar
    // figure that silently covered only the single-project buckets would be an
    // undercount presented as a total. See projectSplitOf().
    const slug = slugOfSessionKey(sessionKey);
    let perProject = bucket.projects.get(slug);
    if (!perProject) {
      perProject = new Map();
      bucket.projects.set(slug, perProject);
    }
    let perModel = perProject.get(model);
    if (!perModel) {
      perModel = zeroTokens();
      perProject.set(model, perModel);
    }
    addTokens(perModel, delta);
  }
  store.dirty.add(start);
  if (store.earliestSourceMs === null || ts < store.earliestSourceMs) {
    store.earliestSourceMs = ts;
  }
}

/** Element-wise max of two token class objects, in place on `target`. */
function maxTokens(target, source) {
  for (const k of CLASSES) {
    const v = Number(source[k]) || 0;
    if (v > (target[k] || 0)) target[k] = v;
  }
}

/**
 * Merge one serialized bucket into a bucket map, de-duplicating by time bucket:
 * the same bucket seen twice keeps the element-wise HIGH-WATER value per model
 * and per session, never the sum of the sightings.
 */
export function mergeBucket(map, start, incoming) {
  let bucket = map.get(start);
  if (!bucket) {
    bucket = emptyBucket();
    map.set(start, bucket);
  }
  if (incoming.models) {
    for (const [model, tokens] of entriesOf(incoming.models)) {
      let mine = bucket.models.get(model);
      if (!mine) {
        mine = zeroTokens();
        bucket.models.set(model, mine);
      }
      maxTokens(mine, tokens);
    }
  }
  if (incoming.sessions) {
    for (const [key, total] of entriesOf(incoming.sessions)) {
      const v = Number(total) || 0;
      if (v > (bucket.sessions.get(key) || 0)) bucket.sessions.set(key, v);
    }
  }
  // Same high-water rule one level deeper. A history file written before this
  // field existed simply has no `projects` key, and merges unchanged.
  if (incoming.projects) {
    for (const [slug, models] of entriesOf(incoming.projects)) {
      let mineProject = bucket.projects.get(slug);
      if (!mineProject) {
        mineProject = new Map();
        bucket.projects.set(slug, mineProject);
      }
      for (const [model, tokens] of entriesOf(models)) {
        let mine = mineProject.get(model);
        if (!mine) {
          mine = zeroTokens();
          mineProject.set(model, mine);
        }
        maxTokens(mine, tokens);
      }
    }
  }
}

/**
 * How one bucket's tokens divide between projects.
 *
 * Three cases, and the caller is told which one it got:
 *
 *  - the bucket carries a recorded per-project split — exact, with models, so
 *    cost is computable;
 *  - it does not, but every session key in it belongs to ONE project, so the
 *    whole bucket demonstrably belongs to that project — also exact, and this
 *    is what makes months of already-persisted history usable;
 *  - it does not and more than one project was active, so only each project's
 *    TOTAL is recoverable. `models` is null and no cost is claimed for it.
 */
export function projectSplitOf(bucket) {
  const byProject = new Map();
  if (bucket.projects && bucket.projects.size) {
    for (const [slug, models] of bucket.projects) {
      let total = 0;
      for (const tokens of models.values()) total += sumTokens(tokens);
      byProject.set(slug, { models, total });
    }
    return { byProject, exact: true, source: "recorded" };
  }
  const slugTotals = new Map();
  for (const [key, total] of bucket.sessions) {
    const slug = slugOfSessionKey(key);
    slugTotals.set(slug, (slugTotals.get(slug) || 0) + (Number(total) || 0));
  }
  if (slugTotals.size === 1) {
    const slug = slugTotals.keys().next().value;
    let total = 0;
    for (const tokens of bucket.models.values()) total += sumTokens(tokens);
    byProject.set(slug, { models: bucket.models, total });
    return { byProject, exact: true, source: "single-project bucket" };
  }
  for (const [slug, total] of slugTotals) {
    byProject.set(slug, { models: null, total });
  }
  return {
    byProject,
    exact: slugTotals.size === 0,
    source: "session keys only",
  };
}

function entriesOf(value) {
  return value instanceof Map ? value.entries() : Object.entries(value);
}

function serializeBucket(bucket) {
  const models = {};
  for (const [model, tokens] of bucket.models) {
    models[model] = { ...tokens };
  }
  const sessions = {};
  for (const [key, total] of bucket.sessions) sessions[key] = total;
  const projects = {};
  for (const [slug, perModel] of bucket.projects || []) {
    const out = {};
    for (const [model, tokens] of perModel) out[model] = { ...tokens };
    projects[slug] = out;
  }
  return { models, sessions, projects };
}

/** The merged (live ∪ persisted, by max) view of one bucket, or null. */
function mergedBucket(store, start) {
  const live = store.live.get(start);
  const persisted = store.persisted.get(start);
  if (!live && !persisted) return null;
  if (!persisted) return live;
  if (!live) return persisted;
  const map = new Map();
  mergeBucket(map, start, live);
  mergeBucket(map, start, persisted);
  return map.get(start);
}

function allBucketStarts(store) {
  const keys = new Set(store.live.keys());
  for (const k of store.persisted.keys()) keys.add(k);
  return Array.from(keys).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Load history.jsonl into the persisted map. Malformed lines are counted and
 * skipped, never fatal — the file is append-only and a crash mid-append leaves
 * at most one torn line at the end.
 */
export function loadHistory(store) {
  store.loaded = true;
  if (!store.file) return { buckets: 0, badLines: 0 };
  let raw;
  let size = 0;
  try {
    hardenPrivateFile(store.file);
    const stat = fs.statSync(store.file);
    size = stat.size;
    raw = fs.readFileSync(store.file, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      store.loadError = String(error.message);
    }
    return { buckets: 0, badLines: 0 };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      store.badLines += 1;
      continue;
    }
    if (!d || !Array.isArray(d.buckets)) {
      store.badLines += 1;
      continue;
    }
    for (const b of d.buckets) {
      const start = Number(b && b.b);
      if (!Number.isFinite(start) || start <= 0) continue;
      mergeBucket(store.persisted, start, b);
    }
  }
  if (size > COMPACT_BYTES) compact(store);
  return { buckets: store.persisted.size, badLines: store.badLines };
}

/** Rewrite the file as the merged view, one line per 500 buckets. */
function compact(store) {
  try {
    const starts = Array.from(store.persisted.keys()).sort((a, b) => a - b);
    const lines = [];
    for (let i = 0; i < starts.length; i += 500) {
      const slice = starts.slice(i, i + 500).map((start) => ({
        b: start,
        ...serializeBucket(store.persisted.get(start)),
      }));
      lines.push(JSON.stringify({ v: 1, at: Date.now(), buckets: slice }));
    }
    writePrivateAtomic(
      store.file,
      lines.length ? lines.join("\n") + "\n" : "",
    );
  } catch (error) {
    store.loadError = "compact failed: " + String(error.message);
  }
}

/**
 * Append the buckets touched since the last flush. Synchronous on purpose so it
 * is safe to call from an exit handler. Values written are the MERGED view of
 * each dirty bucket, so a compacted file is self-contained.
 */
export function flushHistory(store, now) {
  if (!store.file || store.dirty.size === 0) return { written: 0 };
  const buckets = [];
  for (const start of Array.from(store.dirty).sort((a, b) => a - b)) {
    const merged = mergedBucket(store, start);
    if (merged) buckets.push({ b: start, ...serializeBucket(merged) });
  }
  const line =
    JSON.stringify({
      v: 1,
      at: now === undefined ? Date.now() : now,
      buckets,
    }) + "\n";
  try {
    appendPrivateFile(store.file, line);
    store.dirty.clear();
    store.flushError = null;
    store.lastFlushAt = now === undefined ? Date.now() : now;
    return { written: buckets.length };
  } catch (error) {
    store.flushError = String(error.message);
    return { written: 0, error: store.flushError };
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Start of the period, or null for the whole of history. */
export function periodStart(periodId, now) {
  const period = PERIODS[periodId];
  if (!period) return undefined;
  return period.ms === null ? null : now - period.ms;
}

const labelCache = new Map();

/** Readable project name for a transcript-directory slug. Cached; never fatal. */
export function labelOfSlug(slug) {
  const cached = labelCache.get(slug);
  if (cached) return cached;
  const label = projectLabel(resolveProjectSlug(slug).path) || slug;
  labelCache.set(slug, label);
  return label;
}

/** Absolute path a slug resolves to, or null when the filesystem disagrees. */
export function pathOfSlug(slug) {
  const resolved = resolveProjectSlug(slug);
  return resolved.path || null;
}

function sessionLabel(key) {
  return labelOfSlug(slugOfSessionKey(key));
}

/**
 * Everything the history surface renders for one period, computed from the
 * merged bucket view. Cost uses the price row in force on each BUCKET's own
 * local day, so an effective-dated rate change (lib/prices.js) applies to the
 * tokens spent after it and not to the ones spent before.
 */
export function assembleHistory(store, options) {
  const now = options.now;
  const periodId = PERIODS[options.period] ? options.period : "24h";
  const fromMs = periodStart(periodId, now);
  const toMs = now;
  const names = options.sessionNames || new Map();
  // A project slug, or null for the whole machine. Scoping is applied to the
  // totals, the series, the model split and the session split alike — a screen
  // where one panel is scoped and its neighbour is not is worse than no scope.
  const scope =
    typeof options.project === "string" && options.project
      ? options.project
      : null;

  const totals = zeroTokens();
  const cost = zeroCost();
  let unpriced = false;
  const byModel = new Map();
  const bySession = new Map();
  const projectTotals = new Map();
  let scopeUnattributed = 0;
  const rawSeries = [];
  let earliestMs = null;
  let persistedFromMs = null;
  for (const start of store.persisted.keys()) {
    if (persistedFromMs === null || start < persistedFromMs)
      persistedFromMs = start;
  }

  for (const start of allBucketStarts(store)) {
    if (earliestMs === null) earliestMs = start;
    // A bucket belongs to the period when it OVERLAPS it: the bucket holding
    // fromMs is included, so "last hour" means the last hour and not the last
    // 55-to-60 minutes depending on alignment.
    if (fromMs !== null && start + BUCKET_MS <= fromMs) continue;
    if (start > toMs) continue;
    const bucket = mergedBucket(store, start);
    if (!bucket) continue;

    const point = {
      t: start,
      in: 0,
      out: 0,
      cr: 0,
      cw: 0,
      total: 0,
      cost: 0,
      unpriced: false,
    };
    const day = dayKeyOf(start);

    // The project ledger for the whole machine is built from every bucket in
    // the period, scope or no scope: it is what populates the selector, and a
    // selector that only lists the project already selected is not a selector.
    const split = projectSplitOf(bucket);
    for (const [slug, share] of split.byProject) {
      let entry = projectTotals.get(slug);
      if (!entry) {
        entry = { total: 0, attributed: 0, unattributed: 0 };
        projectTotals.set(slug, entry);
      }
      entry.total += share.total;
      if (share.models) entry.attributed += share.total;
      else entry.unattributed += share.total;
    }

    // Which models this bucket contributes, under the current scope.
    let contribution = bucket.models;
    if (scope) {
      const share = split.byProject.get(scope);
      if (!share) contribution = null;
      else if (share.models) contribution = share.models;
      else {
        // The tokens are known, the class split is not. Counted where it can be
        // seen rather than folded into a total that would then be wrong.
        contribution = null;
        scopeUnattributed += share.total;
      }
    }

    for (const [model, tokens] of contribution || []) {
      addTokens(totals, tokens);
      let m = byModel.get(model);
      if (!m) {
        m = zeroTokens();
        byModel.set(model, m);
      }
      addTokens(m, tokens);
      point.in += tokens.in || 0;
      point.out += tokens.out || 0;
      point.cr += tokens.cr || 0;
      point.cw += tokens.cw || 0;
      const priced = costSplit(model, tokens, day);
      if (priced) {
        addCost(cost, priced);
        point.cost += priced.in + priced.out + priced.cw + priced.cr;
      } else {
        unpriced = true;
        point.unpriced = true;
      }
    }
    point.total = point.in + point.out + point.cr + point.cw;
    for (const [key, total] of bucket.sessions) {
      if (scope && slugOfSessionKey(key) !== scope) continue;
      bySession.set(key, (bySession.get(key) || 0) + total);
    }
    rawSeries.push(point);
  }

  const models = Array.from(byModel.entries())
    .map(([model, tokens]) => {
      // Model cost across the period is re-derived per bucket above only in
      // aggregate; per-model dollars here use the period's end day, labelled an
      // estimate like every other dollar on this screen.
      const split = costSplit(model, tokens, dayKeyOf(toMs));
      return {
        model,
        tokens,
        total: sumTokens(tokens),
        cost: split ? split.in + split.out + split.cw + split.cr : null,
      };
    })
    .sort((a, b) => b.total - a.total);

  const sessions = Array.from(bySession.entries())
    .map(([key, total]) => ({
      key,
      short: String(key).split("|")[1]
        ? String(key).split("|")[1].slice(0, 8)
        : key,
      project: names.get(key) || sessionLabel(key),
      total,
    }))
    .sort((a, b) => b.total - a.total);
  const TOP = 10;
  const shownSessions = sessions.slice(0, TOP);
  const restTotal = sessions.slice(TOP).reduce((n, s) => n + s.total, 0);
  if (restTotal > 0) {
    shownSessions.push({
      key: "(other)",
      short: "",
      project: sessions.length - TOP + " more sessions",
      total: restTotal,
    });
  }

  const projects = Array.from(projectTotals.entries())
    .map(([slug, entry]) => ({
      slug,
      label: labelOfSlug(slug),
      path: pathOfSlug(slug),
      total: entry.total,
      // Tokens whose class split is recoverable, and therefore whose cost is.
      attributed: entry.attributed,
      unattributed: entry.unattributed,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    period: { id: periodId, label: PERIODS[periodId].label, fromMs, toMs },
    bucketMs: BUCKET_MS,
    // Null means the whole machine. When a project IS selected, every figure in
    // this payload is scoped to it, and `unattributed` states how many of that
    // project's tokens could not be split by class and are therefore missing
    // from the cost — never silently dropped, never silently averaged in.
    scope: scope
      ? {
          slug: scope,
          label: labelOfSlug(scope),
          path: pathOfSlug(scope),
          unattributed: scopeUnattributed,
          note: scopeUnattributed
            ? scopeUnattributed.toLocaleString() +
              " tokens in this period are known to be this project's but predate per-project class recording, so they are excluded from its cost"
            : null,
        }
      : null,
    projects,
    projectCount: projects.length,
    totals: {
      tokens: totals,
      total: sumTokens(totals),
      cost,
      costTotal: cost.in + cost.out + cost.cw + cost.cr,
      unpriced,
    },
    byModel: models,
    bySession: shownSessions,
    sessionCount: sessions.length,
    series: downsample(rawSeries, MAX_SERIES_POINTS),
    coverage: {
      sourceFromMs: store.earliestSourceMs,
      persistedFromMs,
      earliestMs,
      snapshotFile: store.file,
      lastFlushAt: store.lastFlushAt || null,
      flushError: store.flushError,
      loadError: store.loadError,
      badLines: store.badLines,
      note: "Claude tokens only, scoped to the selected period and — when one is chosen — to the selected project. Codex Σ counters are thread-cumulative and are never added to a period total. Source data reaches as far back as the transcripts on disk; snapshots extend it past log pruning.",
      // "everything recorded" means every project on this machine, back to the
      // first bucket on this line. Saying "project lifecycle" implied one
      // project and its whole life, and both halves were false.
      scopeNote:
        "every project on this machine" +
        (earliestMs
          ? ", from " + new Date(earliestMs).toISOString().slice(0, 10)
          : ""),
    },
  };
}

/** Merge adjacent points until the series fits; totals are preserved exactly. */
export function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const factor = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += factor) {
    const merged = {
      t: points[i].t,
      in: 0,
      out: 0,
      cr: 0,
      cw: 0,
      total: 0,
      cost: 0,
      unpriced: false,
    };
    for (let j = i; j < Math.min(points.length, i + factor); j += 1) {
      const p = points[j];
      merged.in += p.in;
      merged.out += p.out;
      merged.cr += p.cr;
      merged.cw += p.cw;
      merged.total += p.total;
      merged.cost += p.cost;
      if (p.unpriced) merged.unpriced = true;
    }
    out.push(merged);
  }
  return out;
}
