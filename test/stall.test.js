import test from "node:test";
import assert from "node:assert/strict";

import {
  DEADHEAD_MS,
  STALL_FLOOR_TOKENS,
  STALL_WINDOW_MS,
  deadheadOf,
  detectStall,
  stallCause,
} from "../lib/stall.js";
import { addSample, createSeries, MINUTE } from "../lib/series.js";
import { masterState } from "../lib/state.js";

const NOW = 1_788_000_000_000;

/** A series with `tokens` spread over the last `minutes` complete minutes. */
function seriesWith(tokens, minutes, now) {
  const series = createSeries();
  const per = tokens / Math.max(1, minutes);
  for (let i = 1; i <= minutes; i += 1) {
    addSample(series, now - i * MINUTE, per, 0);
  }
  return series;
}

const LIVE_ROW = {
  state: "LIVE",
  label: "app · main",
  agentLive: 0,
  agentCount: 4,
  hot: 0,
};

/**
 * A series with a real bucket `minutes` ago, so the instrument can honestly
 * claim to have been watching for that long. Zero-token buckets are real
 * observations; the dense window() view is not.
 */
function observedFor(minutes, now) {
  const series = createSeries();
  addSample(series, now - minutes * MINUTE, 0, 0);
  return series;
}

test("a live fleet producing nothing for ten minutes is STALLED", () => {
  const series = observedFor(20, NOW);
  const verdict = detectStall({
    rows: [LIVE_ROW],
    fleetSeries: series,
    now: NOW,
  });
  assert.equal(verdict.stalled, true);
  assert.equal(verdict.liveCount, 1);
  assert.equal(verdict.windowMs, STALL_WINDOW_MS);
  assert.match(verdict.cause, /every sub-agent has finished/u);
});

/**
 * The counterexample that matters most: a quiet fleet with nothing running is
 * not stalled, it is finished. Firing there would put a permanent alarm on
 * every screen overnight and train the operator to ignore the word.
 */
test("a quiet fleet with no live session is not stalled — it is idle", () => {
  const series = observedFor(20, NOW);
  const verdict = detectStall({
    rows: [{ state: "COLD", label: "x", agentLive: 0, agentCount: 0, hot: 0 }],
    fleetSeries: series,
    now: NOW,
  });
  assert.equal(verdict.stalled, false);
  assert.equal(verdict.cause, null);
});

test("a working fleet is never stalled, however few tokens a single minute holds", () => {
  const series = seriesWith(STALL_FLOOR_TOKENS * 4, 10, NOW);
  const verdict = detectStall({
    rows: [LIVE_ROW],
    fleetSeries: series,
    now: NOW,
  });
  assert.equal(verdict.stalled, false);
});

/**
 * The floor is not zero on purpose. A heartbeat, a title generation or one
 * stray tool result must not read as "the fleet is working".
 *
 * The quantities here are DELIBERATELY absolute rather than expressed against
 * STALL_FLOOR_TOKENS. Writing them as `FLOOR - 10` makes the test move with the
 * constant, so dropping the floor to 1 — which would let a single tool result
 * read as a working fleet — left the suite green.
 */
test("a twitch below the floor still counts as producing nothing", () => {
  // 5,000 tokens spread over ten minutes is a fleet doing nothing.
  const trickle = seriesWith(5_000, 10, NOW);
  assert.equal(
    detectStall({ rows: [LIVE_ROW], fleetSeries: trickle, now: NOW }).stalled,
    true,
    "a 5,000-token trickle over ten minutes was mistaken for work",
  );
  // 100,000 tokens over ten minutes is a fleet doing something.
  const working = seriesWith(100_000, 10, NOW);
  assert.equal(
    detectStall({ rows: [LIVE_ROW], fleetSeries: working, now: NOW }).stalled,
    false,
    "a working fleet was reported as stalled",
  );
  // And the constant itself stays inside the band those two figures bracket.
  assert.ok(
    STALL_FLOOR_TOKENS > 5_000 && STALL_FLOOR_TOKENS < 100_000,
    "the floor moved outside the band this test brackets: " +
      STALL_FLOOR_TOKENS,
  );
});

/**
 * `window()` fabricates zero-filled buckets for minutes it never saw, so its
 * length is always the length asked for and can never report short coverage.
 * A dashboard started thirty seconds ago must not announce a ten-minute stall.
 */
test("a window the instrument has not observed yet never fires the alarm", () => {
  const series = createSeries();
  addSample(series, NOW - 2 * MINUTE, 0, 0);
  const verdict = detectStall({
    rows: [LIVE_ROW],
    fleetSeries: series,
    now: NOW,
  });
  assert.equal(verdict.covered, false);
  assert.equal(
    verdict.stalled,
    false,
    "a freshly started dashboard claimed a ten-minute stall it could not have observed",
  );
  assert.ok(verdict.observedMs < STALL_WINDOW_MS);

  // An instrument with no history at all is blind, not idle.
  const blind = detectStall({
    rows: [LIVE_ROW],
    fleetSeries: createSeries(),
    now: NOW,
  });
  assert.equal(blind.covered, false);
  assert.equal(blind.stalled, false);
  assert.equal(blind.observedMs, 0);
});

test("the cause names what the evidence actually shows", () => {
  assert.match(
    stallCause([{ state: "STALL", label: "app · main", agentLive: 0 }], {}),
    /awaiting a paste/u,
  );
  assert.match(
    stallCause([LIVE_ROW], { quotaRejected: true }),
    /rate limited, not idle/u,
  );
  assert.match(
    stallCause(
      [{ state: "LIVE", label: "app", agentLive: 0, agentCount: 0 }],
      {},
    ),
    /awaiting a prompt, or blocked/u,
  );
  assert.match(
    stallCause(
      [{ state: "LIVE", label: "app", agentLive: 3, agentCount: 3 }],
      {},
    ),
    /waiting on something, not working/u,
  );
});

test("STALLED outranks BURNING but never outranks something actually wrong", () => {
  const base = {
    rows: [],
    fleetHot: 0,
    fleetMedianPerMinute: 0,
    liveCount: 2,
    unpriced: false,
  };
  const stall = {
    stalled: true,
    liveCount: 2,
    windowMs: STALL_WINDOW_MS,
    cause: "c",
  };

  assert.equal(masterState({ ...base, stall }).word, "STALLED");
  assert.equal(
    masterState({ ...base, fleetHot: 9_000_000, stall }).word,
    "STALLED",
    "spend outranked idle capacity",
  );
  assert.equal(
    masterState({
      ...base,
      stall,
      rows: [{ state: "RUN", label: "a", hot: 4_000_000, ratio: 3.2 }],
    }).word,
    "ATTENTION",
    "a runaway was outranked by a stall",
  );
  // The default path must be untouched: no stall input, no new behaviour.
  assert.equal(masterState(base).word, "NOMINAL");
  assert.equal(
    masterState({ ...base, stall: { stalled: false } }).word,
    "NOMINAL",
  );
});

test("the stalled cause carries the window and the reason, not just the word", () => {
  const master = masterState({
    rows: [],
    fleetHot: 0,
    fleetMedianPerMinute: 0,
    liveCount: 4,
    unpriced: false,
    stall: {
      stalled: true,
      liveCount: 4,
      windowMs: STALL_WINDOW_MS,
      cause: "every sub-agent has finished",
    },
  });
  assert.equal(master.word, "STALLED");
  assert.match(master.cause, /no output for 10m from 4 live sessions/u);
  assert.match(master.cause, /every sub-agent has finished/u);
  assert.equal(master.glyph, "◻");
});

// ---------------------------------------------------------------- deadhead

test("a live process with no agents and no tokens for twenty minutes is a deadhead", () => {
  const row = {
    pidAlive: true,
    agentLive: 0,
    cumulative: false,
    lastTs: NOW - DEADHEAD_MS - 1000,
  };
  const verdict = deadheadOf(row, NOW);
  assert.equal(verdict.deadhead, true);
  assert.match(
    verdict.reason,
    /live process, no sub-agents, no tokens for 2\dm/u,
  );
});

test("a session with work in flight is never a deadhead, however quiet", () => {
  assert.equal(
    deadheadOf(
      {
        pidAlive: true,
        agentLive: 3,
        cumulative: false,
        lastTs: NOW - 3600_000,
      },
      NOW,
    ).deadhead,
    false,
    "a session with three sub-agents running was called idle capacity",
  );
});

test("a row with no live process is not capacity this machine is holding open", () => {
  for (const row of [
    {
      pidAlive: false,
      agentLive: 0,
      cumulative: false,
      lastTs: NOW - 3600_000,
    },
    { pidAlive: null, agentLive: 0, cumulative: false, lastTs: NOW - 3600_000 },
    { pidAlive: true, agentLive: 0, cumulative: true, lastTs: NOW - 3600_000 },
  ]) {
    assert.equal(deadheadOf(row, NOW).deadhead, false);
  }
});

test("a session quiet for a couple of minutes is thinking, not deadheading", () => {
  assert.equal(
    deadheadOf(
      {
        pidAlive: true,
        agentLive: 0,
        cumulative: false,
        lastTs: NOW - 120_000,
      },
      NOW,
    ).deadhead,
    false,
  );
});
