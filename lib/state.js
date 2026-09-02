/**
 * Session state machine, hysteresis, and the latched-event list.
 *
 * Two rules make this an instrument rather than a status blob:
 *
 *  - A state must hold for two consecutive polls before it is rendered, so
 *    nothing flickers on a screen that is watched all day. Escalation into RUN
 *    or DEAD is exempt: an alarm that waits is an alarm that is missed.
 *
 *  - Alarms LATCH on the server. A crash that happened while the operator was
 *    looking elsewhere is still on the rail when they look back, and a browser
 *    refresh cannot drop it.
 */

import { medianPerMinute, window as seriesWindow, MINUTE } from "./series.js";

/**
 * The whole state vocabulary, in one place.
 *
 * The first seven are MEASURED: this program read the transcript off this disk
 * and applied the rule in lib/liveness.js. The last two can only be produced by
 * a DECLARATION about a machine this console cannot scan, and exist so that
 * "somebody says a session is running over there" has a word of its own instead
 * of borrowing LIVE. See lib/liveness.js for the rule that assigns them.
 */
export const STATES = {
  LIVE: { glyph: "●", word: "LIVE", rank: 3, edge: 2 },
  WARM: { glyph: "◐", word: "WARM", rank: 4, edge: 2 },
  IDLE: { glyph: "○", word: "IDLE", rank: 5, edge: 2 },
  COLD: { glyph: "·", word: "COLD", rank: 6, edge: 0 },
  STALL: { glyph: "◇", word: "STALL", rank: 1, edge: 3 },
  RUN: { glyph: "▲", word: "RUN", rank: 0, edge: 3 },
  DEAD: { glyph: "✕", word: "DEAD", rank: 2, edge: 3 },
  // Declared only. Never produced by the scanner, never counted as live.
  UNKNOWN: { glyph: "?", word: "UNKNOWN", rank: 5.4, edge: 1 },
  STALE: { glyph: "⋯", word: "STALE", rank: 5.6, edge: 0 },
};

export const LIVE_MS = 2 * 60_000;
export const IDLE_MS = 30 * 60_000;
export const STALL_MS = 10 * 60_000;
export const DEAD_HOLD_MS = 5 * 60_000;

/**
 * Floor under the runaway test. A session's own median is the baseline, but a
 * session that has just started has a median of zero, and 3x zero would make
 * every first minute a runaway.
 */
export const RUNAWAY_FLOOR_PER_MINUTE = 250_000;
export const RUNAWAY_MULTIPLE = 3;
export const RUNAWAY_MINUTES = 3;
export const AGENT_SWARM = 6;

export const FLEET_BURN_FLOOR = 500_000; // tokens in five minutes
export const FLEET_BURN_MULTIPLE = 1.5;

export function createTracker() {
  return { rows: new Map(), events: [], nextEventId: 1 };
}

function immediate(state) {
  return state === "RUN" || state === "DEAD";
}

/**
 * Sustained-burn test: the last RUNAWAY_MINUTES complete minutes must each
 * exceed the session's own baseline. Reported with the ratio so the cause line
 * can say "3.2x normal" rather than just "high".
 */
export function runawayCheck(series, now) {
  if (!series) return { runaway: false, ratio: 0, baseline: 0 };
  const baseline = medianPerMinute(series, now, 60);
  const threshold = Math.max(
    baseline * RUNAWAY_MULTIPLE,
    RUNAWAY_FLOOR_PER_MINUTE,
  );
  const buckets = seriesWindow(series, now, RUNAWAY_MINUTES + 1);
  buckets.pop(); // the current minute is incomplete
  if (buckets.length < RUNAWAY_MINUTES)
    return { runaway: false, ratio: 0, baseline };
  let sustained = true;
  let peak = 0;
  for (const b of buckets) {
    if (b.tokens < threshold) sustained = false;
    if (b.tokens > peak) peak = b.tokens;
  }
  const ratio = baseline > 0 ? peak / baseline : 0;
  return { runaway: sustained, ratio, baseline, threshold, peak };
}

/**
 * Raw state for one session, before hysteresis.
 *
 * `pidVanished` is only true when THIS process watched the pid running and then
 * watched it disappear. A stale ~/.claude/sessions/<pid>.json record is not
 * evidence of a crash — those files outlive the process — so a session that had
 * already finished before the dashboard started is never reported as DEAD.
 */
/**
 * Why a row is in RUN.
 *
 * RUN has two independent triggers and they are not the same event. Calling
 * both of them "runaway burn" produced a rail that read "▲ runaway burn" beside
 * a master cause of "1.4× normal" — a multiple well under the documented 3×
 * threshold, which reads as "not actually a problem" and trains the operator to
 * ignore the alarm. An eight-agent swarm is a real condition; it is just a
 * different one, and it is named.
 */
export function runCause(row) {
  if (row.runaway) return "burn";
  if (row.agentLive > AGENT_SWARM) return "swarm";
  return null;
}

export function rawState(row, now) {
  const since = now - row.mtime;
  if (row.pidVanished && since < IDLE_MS) return "DEAD";
  if (row.runaway || row.agentLive > AGENT_SWARM) return "RUN";
  if (row.pidAlive === true && since > STALL_MS) return "STALL";
  if (since <= LIVE_MS) return row.hot > 0 ? "LIVE" : "WARM";
  if (since <= IDLE_MS) return "IDLE";
  return "COLD";
}

export function step(tracker, key, candidate, now, meta) {
  let entry = tracker.rows.get(key);
  if (!entry) {
    entry = {
      shown: candidate,
      pending: candidate,
      count: 2,
      changedAt: now,
      // A row whose very first observed state is DEAD still gets the hold, or a
      // crash noticed on the poll after a restart would vanish immediately.
      deadAt: candidate === "DEAD" ? now : 0,
    };
    tracker.rows.set(key, entry);
    if (immediate(candidate)) latch(tracker, candidate, key, now, meta);
    return entry;
  }
  if (candidate === entry.shown) {
    entry.pending = candidate;
    entry.count = 2;
    return entry;
  }
  if (immediate(candidate) && candidate !== entry.shown) {
    entry.shown = candidate;
    entry.pending = candidate;
    entry.count = 2;
    entry.changedAt = now;
    if (candidate === "DEAD") entry.deadAt = now;
    latch(tracker, candidate, key, now, meta);
    return entry;
  }
  // A DEAD row holds its position for a while so a crash that was missed is
  // still where the operator would look for it.
  if (entry.shown === "DEAD" && now - entry.deadAt < DEAD_HOLD_MS) return entry;
  if (candidate === entry.pending) {
    entry.count += 1;
    if (entry.count >= 2) {
      entry.shown = candidate;
      entry.changedAt = now;
    }
  } else {
    entry.pending = candidate;
    entry.count = 1;
  }
  return entry;
}

function latch(tracker, kind, key, now, meta) {
  const label = meta && meta.label ? meta.label : key;
  const cause = meta && meta.cause;
  const text =
    kind === "DEAD"
      ? "session ended unexpectedly — " + label
      : cause === "swarm"
        ? "agent swarm — " +
          ((meta && meta.agentLive) || "many") +
          " sub-agents live — " +
          label
        : "runaway burn — " + label;
  tracker.events.unshift({
    id: tracker.nextEventId++,
    at: now,
    kind,
    key,
    text,
  });
  if (tracker.events.length > 20) tracker.events.length = 20;
}

export function acknowledge(tracker, id) {
  if (id === "all") {
    const n = tracker.events.length;
    tracker.events.length = 0;
    return n;
  }
  const index = tracker.events.findIndex((e) => e.id === Number(id));
  if (index === -1) return 0;
  tracker.events.splice(index, 1);
  return 1;
}

/** Drop tracker rows for sessions that no longer appear at all. */
export function reap(tracker, liveKeys) {
  for (const key of Array.from(tracker.rows.keys())) {
    if (!liveKeys.has(key)) tracker.rows.delete(key);
  }
}

/**
 * The master readout. Precedence is strict and deliberate: anything wrong beats
 * anything expensive, and anything expensive beats anything normal.
 */
export function masterState(input) {
  const secondary = [];
  let word = "IDLE";
  let cause = null;

  const trouble = input.rows.filter(
    (r) => r.state === "RUN" || r.state === "DEAD" || r.state === "STALL",
  );
  if (input.scanError) secondary.push("scan error");
  if (input.unpriced) secondary.push("unpriced model in use");
  if (input.quotaRejected) secondary.push("rate limit reached");

  const fleetThreshold = Math.max(
    FLEET_BURN_FLOOR,
    input.fleetMedianPerMinute * FLEET_BURN_MULTIPLE * 5,
  );

  if (trouble.length > 0 || input.scanError || input.unpriced) {
    word = "ATTENTION";
    const worst =
      trouble.find((r) => r.state === "RUN") ||
      trouble.find((r) => r.state === "DEAD") ||
      trouble[0];
    if (worst) {
      // The multiple is only shown when the burn test is what fired. Appending
      // it to a swarm alarm attaches a number under the runaway threshold to a
      // word that claims the threshold was crossed.
      const tail =
        worst.cause === "swarm"
          ? " · " + (worst.agentLive || 0) + " sub-agents live"
          : worst.ratio > 0
            ? " · " + worst.ratio.toFixed(1) + "× normal"
            : "";
      cause =
        worst.state.toLowerCase() +
        " · " +
        worst.label +
        " · " +
        formatTokens(worst.hot) +
        "/5m" +
        tail;
    } else {
      cause = secondary[0] || "check the instrument strip";
    }
  } else if (input.stall && input.stall.stalled) {
    // Above BURNING on purpose. Spending a lot is a condition to watch; paying
    // for four live sessions that produce nothing is a condition to FIX, and it
    // is the one the operator will not notice on their own — there is no motion
    // to catch the eye, which is exactly why it needs a word.
    word = "STALLED";
    cause =
      "no output for " +
      Math.round(input.stall.windowMs / 60_000) +
      "m from " +
      input.stall.liveCount +
      " live session" +
      (input.stall.liveCount === 1 ? "" : "s") +
      " · " +
      input.stall.cause;
  } else if (input.fleetHot >= fleetThreshold) {
    word = "BURNING";
    const top = input.rows.slice().sort((a, b) => b.hot - a.hot)[0];
    cause = top
      ? "top burner · " + top.label + " · " + formatTokens(top.hot) + "/5m"
      : formatTokens(input.fleetHot) + " tokens in the last 5 minutes";
  } else if (input.liveCount > 0) {
    word = "NOMINAL";
    cause = input.liveCount + " live · " + formatTokens(input.fleetHot) + "/5m";
  } else {
    word = "IDLE";
    // The window named here is the one the test actually uses: a row counts as
    // live while its transcript has been touched within LIVE_MS. The line used
    // to claim five minutes while the roster's own 5M column showed tokens.
    cause =
      "no session has been active in the last " +
      Math.round(LIVE_MS / 60_000) +
      " minutes";
  }

  return {
    word,
    glyph: {
      IDLE: "○",
      NOMINAL: "●",
      BURNING: "◆",
      ATTENTION: "▲",
      STALLED: "◻",
    }[word],
    cause,
    secondary,
    fleetThreshold,
  };
}

export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(Math.round(v));
}

export { MINUTE };
