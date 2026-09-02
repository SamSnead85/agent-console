/**
 * Stall and deadhead detection — idle capacity, named.
 *
 * The owner looked at a fleet of live sessions burning zero tokens per minute
 * and asked why. That question surfaced a real coordination failure: every
 * sub-agent had finished, nobody had dispatched more work, and four paid
 * sessions sat there costing a seat each and producing nothing. Nothing on the
 * screen said so, because every existing alarm fires on activity — a runaway
 * burn, a swarm, a crash. There was no alarm for the opposite condition.
 *
 * There are two of them here and they are different sizes:
 *
 *   STALLED  — a FLEET condition. Sessions are live and the whole fleet has
 *              produced essentially nothing for a sustained window.
 *   DEADHEAD — a SESSION condition. One live process, no sub-agents, no tokens
 *              for a long stretch. Borrowed from the freight term for a vehicle
 *              running with no load.
 *
 * Both are deliberately slow to fire. A model thinking hard between tool calls
 * writes nothing for a minute or two, and an alarm that fires on that is an
 * alarm the operator learns to ignore. Both are computed from measured token
 * deltas only — no inference from process CPU, which says nothing useful about
 * whether an agent is working or waiting on a human.
 */

import { window as seriesWindow, MINUTE } from "./series.js";

/** How long the fleet must be quiet, with sessions live, before STALLED. */
export const STALL_WINDOW_MS = 10 * 60_000;

/**
 * Tokens across the whole stall window that still count as "nothing".
 *
 * Not zero: a heartbeat, a title generation or a single tool result can put a
 * few hundred tokens on the board without any work happening. Measured against
 * this fleet, a genuinely working minute is five to seven figures, so a
 * five-figure floor over ten minutes separates "producing" from "twitching"
 * with three orders of magnitude to spare.
 */
export const STALL_FLOOR_TOKENS = 20_000;

/** How long one session may run empty before it is called out individually. */
export const DEADHEAD_MS = 20 * 60_000;

/** Session states that mean "this is a session somebody is running". */
const RUNNING = new Set(["LIVE", "WARM", "RUN", "STALL"]);

/**
 * How far back this instrument has any token history at all.
 *
 * `window()` returns a DENSE array — it manufactures zero-filled buckets for
 * minutes it never observed — so counting its length can never tell you whether
 * the window was covered. It always is. Asking the series for its earliest real
 * bucket is the only honest way to say "I have ten minutes of evidence", and
 * without it a dashboard started thirty seconds ago would announce a
 * ten-minute stall it could not possibly have seen.
 */
export function coverageMs(series, now) {
  if (!series || !series.buckets || series.buckets.size === 0) return 0;
  let earliest = Infinity;
  for (const minute of series.buckets.keys()) {
    if (minute < earliest) earliest = minute;
  }
  if (!Number.isFinite(earliest)) return 0;
  return Math.max(0, now - earliest * MINUTE);
}

/**
 * Why the fleet is quiet, in the operator's own terms.
 *
 * The cause is READ off the same rows the alarm fired on — it is never a guess
 * dressed as a diagnosis. Where the evidence does not distinguish two causes,
 * the line says which two rather than picking one.
 */
export function stallCause(rows, options) {
  const opts = options || {};
  const running = rows.filter((r) => RUNNING.has(r.state));
  if (opts.quotaRejected) {
    return "the vendor rejected a request for quota — the fleet is rate limited, not idle";
  }
  const silentPid = running.find((r) => r.state === "STALL");
  if (silentPid) {
    return (
      "a live process has written nothing for a long stretch (" +
      silentPid.label +
      ") — this is what awaiting a paste looks like"
    );
  }
  const agentsLive = running.reduce((n, r) => n + (r.agentLive || 0), 0);
  const hadAgents = running.some((r) => (r.agentCount || 0) > 0);
  if (agentsLive === 0 && hadAgents) {
    return (
      "every sub-agent has finished and none was dispatched to replace them — " +
      running.length +
      " session" +
      (running.length === 1 ? "" : "s") +
      " running empty"
    );
  }
  if (agentsLive === 0) {
    return (
      running.length +
      " session" +
      (running.length === 1 ? " is" : "s are") +
      " live with no work in flight — awaiting a prompt, or blocked"
    );
  }
  return (
    agentsLive +
    " sub-agents are marked live but produced no tokens — they are waiting on something, not working"
  );
}

/**
 * Fleet-level stall.
 *
 * @param {object} input
 * @param {object} input.fleetSeries the shared per-minute token series
 * @param {number} input.now
 * @param {Array}  input.rows roster rows, each { state, label, agentLive, agentCount, hot }
 * @param {boolean} [input.quotaRejected]
 * @returns {{stalled: boolean, liveCount: number, windowTokens: number,
 *            windowMs: number, floor: number, cause: string|null}}
 */
export function detectStall(input) {
  const rows = input.rows || [];
  const now = input.now;
  const running = rows.filter((r) => RUNNING.has(r.state));
  const count = Math.round(STALL_WINDOW_MS / 60_000);
  // The current minute is still filling, so it is not evidence either way. Ask
  // for one extra bucket and drop it, exactly as the runaway test does.
  const buckets = input.fleetSeries
    ? seriesWindow(input.fleetSeries, now, count + 1)
    : [];
  if (buckets.length) buckets.pop();
  const windowTokens = buckets.reduce((n, b) => n + b.tokens, 0);
  const observedMs = coverageMs(input.fleetSeries, now);
  const covered = observedMs >= STALL_WINDOW_MS;

  const stalled =
    running.length > 0 && covered && windowTokens < STALL_FLOOR_TOKENS;

  return {
    stalled,
    liveCount: running.length,
    windowTokens,
    windowMs: STALL_WINDOW_MS,
    observedMs,
    covered,
    floor: STALL_FLOOR_TOKENS,
    cause: stalled
      ? stallCause(rows, { quotaRejected: input.quotaRejected })
      : null,
    note:
      "STALLED means live sessions produced under " +
      STALL_FLOOR_TOKENS.toLocaleString() +
      " tokens in " +
      count +
      " minutes. Idle capacity is the expensive failure.",
  };
}

/**
 * Per-session deadhead test.
 *
 * A row is deadheading when a process is joined and alive, no sub-agent is
 * running, and no token has been produced for DEADHEAD_MS. `quietMs` is derived
 * from the row's own last activity timestamp, which is measured, rather than
 * from the state machine's hysteresis, which is not.
 *
 * @returns {{deadhead: boolean, quietMs: number, reason: string|null}}
 */
export function deadheadOf(row, now) {
  const quietMs = row.lastTs ? Math.max(0, now - row.lastTs) : 0;
  // A thread-cumulative row has no live process to run empty, and a row with no
  // pid join is not capacity this machine is holding open.
  if (row.cumulative || row.pidAlive !== true) {
    return { deadhead: false, quietMs, reason: null };
  }
  if ((row.agentLive || 0) > 0) {
    return { deadhead: false, quietMs, reason: null };
  }
  if (!row.lastTs || quietMs < DEADHEAD_MS) {
    return { deadhead: false, quietMs, reason: null };
  }
  return {
    deadhead: true,
    quietMs,
    reason:
      "live process, no sub-agents, no tokens for " +
      Math.round(quietMs / 60_000) +
      "m",
  };
}
