/**
 * Snapshot assembly — everything the browser is allowed to know, in one object.
 *
 * The payload is built here and redacted in server.js immediately before
 * serialization, so a field added to this file is masked without anyone
 * remembering to opt in.
 */

import os from "node:os";
import {
  PRICE_TABLE_DATE,
  PRICE_TABLE_EXPIRY,
  PRICE_TABLE_SOURCE,
  CACHE_READ_MULT,
  CACHE_WRITE_1H_MULT,
  CACHE_WRITE_5M_MULT,
  addCost,
  addTokens,
  costSplit,
  isPriceTableExpired,
  sumTokens,
  zeroCost,
  zeroTokens,
} from "./prices.js";
import { dayKeyOf } from "./day.js";
import { medianPerMinute, window as seriesWindow, MINUTE } from "./series.js";
import {
  AGENT_SWARM,
  masterState,
  rawState,
  runCause,
  reap,
  runawayCheck,
  step,
  STATES,
} from "./state.js";
import { deadheadOf, detectStall } from "./stall.js";
import { buildRoster } from "./roster.js";
import { glossaryPayload } from "./glossary.js";

export { dayKeyOf };

const BURN_MINUTES = 60;
const SPARK_MINUTES = 30;

function mapRows(map, limit) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit || 12)
    .map(([name, count]) => ({ name, count }));
}

/**
 * Codex's cumulative counters, rearranged into the same disjoint four classes
 * the roster columns mean. `cached` and `cacheWrite` are carved OUT of the
 * input figure rather than added beside it, so in + out + cr + cw === total.
 * `think` (reasoning) is a subset of output and, like cw1h, is never summed.
 */
export function codexTokens(t) {
  const cachedIn = t.cachedIn || 0;
  const cw = t.cw || 0;
  const fresh = Math.max(0, (t.in || 0) - cachedIn - cw);
  return {
    in: fresh,
    out: t.out || 0,
    cr: cachedIn,
    cw,
    cw1h: 0,
    think: t.reasoning || 0,
  };
}

function sparkOf(series, now) {
  if (!series) return [];
  return seriesWindow(series, now, SPARK_MINUTES).map((b) => b.tokens);
}

export function assemble(input) {
  const {
    now,
    day,
    sessions,
    codexThreads,
    codexAvailable,
    codexReason,
    procs,
    ship,
    tracker,
    fleetSeries,
    scan,
    dedupSpanMax,
    config,
    fleet,
    progress,
    muster,
    registry,
    projects,
  } = input;

  const alivePids = new Set(procs.map((p) => p.pid));
  const byPid = new Map(procs.map((p) => [p.pid, p]));

  // ---- per-model totals and the two-bar spend spectrum ---------------------
  const byModel = new Map();
  for (const s of sessions) {
    for (const [model, tokens] of s.models) {
      let bucket = byModel.get(model);
      if (!bucket) {
        bucket = zeroTokens();
        byModel.set(model, bucket);
      }
      addTokens(bucket, tokens);
    }
  }

  const grandTokens = zeroTokens();
  const grandCost = zeroCost();
  let unpriced = false;
  const models = [];
  for (const [model, tokens] of byModel) {
    const split = costSplit(model, tokens, day);
    if (!split) unpriced = true;
    else addCost(grandCost, split);
    addTokens(grandTokens, tokens);
    models.push({
      model,
      tokens,
      total: sumTokens(tokens),
      cost: split ? split.in + split.out + split.cw + split.cr : null,
      costSplit: split,
    });
  }
  models.sort((a, b) => (b.cost || 0) - (a.cost || 0) || b.total - a.total);

  const costTotal = grandCost.in + grandCost.out + grandCost.cw + grandCost.cr;

  // ---- roster rows --------------------------------------------------------
  const rows = [];
  const liveKeys = new Set();
  let quotaRejected = null;

  for (const s of sessions) {
    const check = runawayCheck(s.series, now);
    const pidAlive = s.pid === undefined ? null : alivePids.has(s.pid);
    const prior = tracker.rows.get(s.key);
    // A crash is only claimed when this process saw the pid running on an
    // earlier poll and then saw it gone. Anything weaker misreads the stale
    // pid records that Claude Code leaves behind after a clean exit.
    const pidVanished = !!(prior && prior.sawPidAlive && pidAlive === false);
    const candidate = rawState(
      {
        mtime: s.mtime,
        hot: s.hot,
        agentLive: s.agentLive,
        runaway: check.runaway,
        pidAlive,
        pidVanished,
      },
      now,
    );
    const label = s.project + (s.branch ? " · " + s.branch : "");
    const cause = runCause({ runaway: check.runaway, agentLive: s.agentLive });
    const entry = step(tracker, s.key, candidate, now, {
      label,
      cause,
      agentLive: s.agentLive,
    });
    // Latching DEAD consumes the evidence, so the alarm fires exactly once.
    entry.sawPidAlive =
      pidAlive === true
        ? true
        : entry.shown === "DEAD"
          ? false
          : !!(prior && prior.sawPidAlive);
    liveKeys.add(s.key);
    if (s.quota && s.quota.status === "rejected") {
      if (!quotaRejected || s.quota.at > quotaRejected.at)
        quotaRejected = s.quota;
    }
    rows.push({
      key: s.key,
      vendor: "claude",
      id: s.id,
      short: String(s.id).slice(0, 8),
      name: s.name,
      project: s.project,
      path: s.path,
      pathExact: s.pathExact,
      branch: s.branch,
      version: s.version,
      state: entry.shown,
      stateSince: entry.changedAt,
      glyph: STATES[entry.shown].glyph,
      edge: STATES[entry.shown].edge,
      rank: STATES[entry.shown].rank,
      models: s.modelList,
      tok: s.tokens,
      total: s.total,
      cost: s.costTotal,
      costSplit: s.cost,
      unpriced: s.unpriced,
      // Derived, never asserted. Hardcoding this true meant a model with no
      // rate row rendered as $0.00 on the roster — the largest token producer
      // on the screen shown as free, bar-scaled as free, and left out of the
      // fleet total. lib/prices.js returns null for exactly that case so it can
      // be reported, not valued at zero.
      priced: !s.unpriced,
      runCause: cause,
      cumulative: false,
      hot: s.hot,
      spark: sparkOf(s.series, now),
      ratio: check.ratio,
      baseline: check.baseline,
      lastTs: s.mtime || s.lastTs,
      startedAt: s.startedAt || null,
      agentCount: s.agentCount,
      agentLive: s.agentLive,
      swarm: s.agentLive > AGENT_SWARM,
      agents: s.agents.slice(0, 40),
      last: s.last,
      pid: s.pid === undefined ? null : s.pid,
      pidAlive,
      killable:
        s.pid !== undefined && byPid.has(s.pid)
          ? byPid.get(s.pid).killable
          : false,
      fingerprint:
        s.pid !== undefined && byPid.has(s.pid)
          ? byPid.get(s.pid).fingerprint
          : null,
      responses: s.responses,
      usageLines: s.usageLines,
      // PRs this session opened, read from its own `pr-link` transcript
      // records. It is the ONE piece of shipped work a transcript can own —
      // a merged PR belongs to a branch and a repository, not to a session —
      // so it is the denominator the attribution panel uses per session.
      prsOpened: s.prLinks.size,
      retries: s.retries,
      hookErrors: s.hookErrors,
      errors: mapRows(s.errorCodes, 4),
      tools: mapRows(s.tools, 8),
      cacheMiss: mapRows(s.cacheMiss, 5),
      serverTools: s.serverTools,
      compactions: s.compactions.slice(-4),
      contextPeak: s.contextPeak,
      quota: s.quota,
      bad: s.bad,
    });
  }

  for (const t of codexThreads) {
    const candidate = rawState(
      {
        mtime: t.mtime,
        hot: t.hot,
        agentLive: t.agentLive,
        runaway: false,
        pidAlive: null,
        pidVanished: false,
      },
      now,
    );
    const label =
      t.project + (t.git && t.git.branch ? " · " + t.git.branch : "");
    const entry = step(tracker, "codex|" + t.id, candidate, now, { label });
    liveKeys.add("codex|" + t.id);
    rows.push({
      key: "codex|" + t.id,
      vendor: "codex",
      id: t.id,
      short: String(t.id).slice(0, 8),
      name: null,
      project: t.project,
      path: t.path,
      pathExact: !!t.cwd,
      branch: t.git ? t.git.branch : null,
      version: t.cliVersion,
      state: entry.shown,
      stateSince: entry.changedAt,
      glyph: STATES[entry.shown].glyph,
      edge: STATES[entry.shown].edge,
      rank: STATES[entry.shown].rank,
      models: t.model ? [t.model] : [],
      effort: t.effort,
      // Exact, read from the rollout log — and cumulative for the whole thread,
      // not scoped to today. Never summed into a daily figure, never priced.
      //
      // Decomposed so the four columns are DISJOINT and sum to the row's own
      // total, which is what the shared column headers promise. Codex reports
      // `cached_input_tokens` and `cache_write_input_tokens` as SUBSETS of
      // `input_tokens` — verified on this disk, where total_tokens is exactly
      // input_tokens + output_tokens — the opposite of Anthropic's disjoint
      // classes. Copied across unchanged, the row's four cells added up to
      // 1.45B against a stated total of 728.94M.
      tok: codexTokens(t.tokens),
      total: t.tokens.total,
      cost: null,
      costSplit: null,
      unpriced: false,
      priced: false,
      cumulative: true,
      hot: t.hot,
      spark: sparkOf(t.series, now),
      ratio: 0,
      baseline: 0,
      runCause: null,
      lastTs: t.mtime || t.lastTs,
      startedAt: t.startedAt || null,
      agentCount: t.agentCount,
      agentLive: t.agentLive,
      swarm: t.agentLive > AGENT_SWARM,
      agents: t.agents.slice(0, 40),
      last: t.patches
        ? t.patches + " patches applied · " + t.fileCount + " files touched"
        : null,
      pid: null,
      pidAlive: null,
      killable: false,
      fingerprint: null,
      rateLimits: t.rateLimits
        ? {
            usedPercent: t.rateLimits.primary
              ? t.rateLimits.primary.used_percent
              : null,
            windowMinutes: t.rateLimits.primary
              ? t.rateLimits.primary.window_minutes
              : null,
            resetsAt: t.rateLimits.primary
              ? t.rateLimits.primary.resets_at * 1000
              : null,
            planType: t.rateLimits.plan_type || null,
          }
        : null,
      contextWindow: t.contextWindow,
      patches: t.patches,
      patchFailures: t.patchFailures,
      filesTouched: t.filesTouched,
      calls: t.calls,
      bad: t.bad,
    });
  }

  reap(tracker, liveKeys);

  // Trouble first, then five-minute burn — the one axis on which the two
  // vendors are honestly comparable, because both are a measured token delta
  // over the same wall-clock window.
  rows.sort((a, b) => a.rank - b.rank || b.hot - a.hot || b.total - a.total);

  // Idle capacity, per row. A session running empty costs exactly as much as a
  // session working, and nothing else on this screen would say so.
  for (const row of rows) {
    const dead = deadheadOf(row, now);
    row.deadhead = dead.deadhead;
    row.deadheadReason = dead.reason;
    row.quietMs = dead.quietMs;
  }

  const fleetHot = rows.reduce((sum, r) => sum + r.hot, 0);
  const fleetMedian = medianPerMinute(fleetSeries, now, BURN_MINUTES);
  const liveCount = rows.filter(
    (r) => r.state === "LIVE" || r.state === "WARM",
  ).length;

  const masterRows = rows.map((r) => ({
    state: r.state,
    label: r.project + (r.branch ? " · " + r.branch : ""),
    hot: r.hot,
    ratio: r.ratio,
    cause: r.runCause || null,
    agentLive: r.agentLive,
    agentCount: r.agentCount,
  }));

  const stall = detectStall({
    rows: masterRows,
    fleetSeries,
    now,
    quotaRejected: !!quotaRejected,
  });

  const master = masterState({
    rows: masterRows,
    fleetHot,
    fleetMedianPerMinute: fleetMedian,
    liveCount,
    unpriced,
    scanError: scan.error || null,
    quotaRejected: !!quotaRejected,
    stall,
  });

  const burn = seriesWindow(fleetSeries, now, BURN_MINUTES);
  const burnTokensPerMinute = burn.length
    ? burn[burn.length - 2 >= 0 ? burn.length - 2 : 0].tokens
    : 0;
  const burnCostPerMinute = burn.length
    ? burn[burn.length - 2 >= 0 ? burn.length - 2 : 0].cost
    : 0;

  const responses = sessions.reduce((n, s) => n + s.responses, 0);
  const usageLines = sessions.reduce((n, s) => n + s.usageLines, 0);
  const badLines = rows.reduce((n, r) => n + (r.bad || 0), 0);

  const priceTableExpired = isPriceTableExpired(day);
  const host = os.hostname();

  // One list of sessions from three kinds of evidence, grouped by machine and
  // labelled with which kind each row came from. See lib/roster.js.
  // The GitHub ledger is the only place three of these sessions have said
  // anything today, so its identity headers are handed to the roster as
  // LAST MENTIONED evidence. See lib/roster.js for why the word is weaker than
  // "declared" and why an ambiguous identity is attached to nothing.
  const roster = buildRoster({
    rows,
    registry,
    muster,
    host,
    now,
    ledgerIdentities: (fleet && fleet.assignments) || [],
  });

  return {
    meta: {
      now,
      day,
      host,
      platform: process.platform,
      scan,
      pollMs: config.pollMs,
      killEnabled: config.killEnabled,
      // State exactly which optional readers may contact a remote. Local
      // transcript/process/Git telemetry is never product analytics, but a
      // Muster status refresh may fetch the configured coordination remote.
      network: config.githubEnabled
        ? config.musterEnabled
          ? "read-only hosted-forge checks and Muster ledger refresh may contact configured remotes; no product telemetry"
          : "read-only hosted-forge checks may contact the configured remote; no product telemetry"
        : config.musterEnabled
          ? "Muster ledger refresh may contact the configured origin; no product telemetry"
          : "no outbound integration enabled; no product telemetry",
    },
    master,
    header: {
      tokens: grandTokens,
      total: sumTokens(grandTokens),
      cost: grandCost,
      costTotal,
      unpriced,
      models,
      sessionCount: rows.length,
      liveCount,
      fleetHot,
      fleetMedianPerMinute: fleetMedian,
    },
    burn: {
      minutes: burn.map((b) => ({ m: b.minute, t: b.tokens, c: b.cost })),
      median: fleetMedian,
      tokensPerMinute: burnTokensPerMinute,
      costPerMinute: burnCostPerMinute,
      minuteMs: MINUTE,
    },
    rows,
    procs,
    ship,
    fleet: fleet || { enabled: false, available: false, reason: "not wired" },
    progress: progress || { available: false, reason: "not wired" },
    muster: muster || { enabled: false, available: false, reason: "not wired" },
    roster,
    stall,
    projects: projects || { available: false, reason: "not wired" },
    registry: registry
      ? {
          count: registry.sessions.length,
          badFiles: registry.badFiles,
          dir: registry.dir,
          error: registry.error,
        }
      : { count: 0, badFiles: 0, dir: null, error: "not wired" },
    // Every term on the screen, defined against the constant that enforces it.
    // Served rather than hardcoded in the page so a threshold and its
    // explanation cannot drift apart. See lib/glossary.js.
    glossary: glossaryPayload({
      fleetThreshold: master.fleetThreshold,
      fleetMedianPerMinute: fleetMedian,
    }),
    events: tracker.events,
    codex: {
      available: codexAvailable,
      reason: codexReason || null,
      threadCount: codexThreads.length,
      note: "Exact token counts, per-thread cumulative, never day-scoped. No OpenAI price table is bundled here, so no cost is claimed.",
    },
    instrument: {
      responses,
      usageLines,
      dedupRatio: responses > 0 ? usageLines / responses : 1,
      dedupSpanMax,
      badLines,
      priceTableDate: PRICE_TABLE_DATE,
      priceTableSource: PRICE_TABLE_SOURCE,
      priceTableExpiry: PRICE_TABLE_EXPIRY,
      priceTableExpired,
      // Rendered verbatim wherever a dollar appears once the table's last
      // verified day is behind us. The rates are NOT guessed forward; the
      // number stays and this label makes it suspect.
      priceTableWarning: priceTableExpired
        ? "price table dated " + PRICE_TABLE_DATE + " — estimate drift possible"
        : null,
      cacheWrite5m: CACHE_WRITE_5M_MULT,
      cacheWrite1h: CACHE_WRITE_1H_MULT,
      cacheRead: CACHE_READ_MULT,
      estimateNote:
        "Every dollar figure is an ESTIMATE computed on this machine from the bundled price table. Neither vendor writes cost to disk.",
    },
  };
}
