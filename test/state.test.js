import test from "node:test";
import assert from "node:assert/strict";

import {
  acknowledge,
  createTracker,
  masterState,
  rawState,
  runawayCheck,
  step,
  runCause,
  LIVE_MS,
  RUNAWAY_FLOOR_PER_MINUTE,
} from "../lib/state.js";
import { addSample, createSeries, MINUTE } from "../lib/series.js";

const NOW = 1_788_000_000_000;

test("a state must hold two polls before it is shown — nothing flickers", () => {
  const tracker = createTracker();
  step(tracker, "s", "LIVE", NOW, {});
  assert.equal(tracker.rows.get("s").shown, "LIVE");

  step(tracker, "s", "IDLE", NOW + 10_000, {});
  assert.equal(
    tracker.rows.get("s").shown,
    "LIVE",
    "a single poll changed the shown state",
  );

  step(tracker, "s", "IDLE", NOW + 20_000, {});
  assert.equal(
    tracker.rows.get("s").shown,
    "IDLE",
    "two consecutive polls did not settle",
  );
});

test("a flapping candidate never settles", () => {
  const tracker = createTracker();
  step(tracker, "s", "LIVE", NOW, {});
  for (let i = 1; i <= 8; i += 1) {
    step(tracker, "s", i % 2 ? "IDLE" : "WARM", NOW + i * 10_000, {});
  }
  assert.equal(tracker.rows.get("s").shown, "LIVE");
});

test("escalation into RUN or DEAD is immediate and latches once", () => {
  const tracker = createTracker();
  step(tracker, "s", "LIVE", NOW, { label: "app · main" });
  step(tracker, "s", "RUN", NOW + 10_000, { label: "app · main" });
  assert.equal(
    tracker.rows.get("s").shown,
    "RUN",
    "an alarm waited for a second poll",
  );
  assert.equal(tracker.events.length, 1);
  assert.match(tracker.events[0].text, /runaway burn — app · main/u);

  step(tracker, "s", "RUN", NOW + 20_000, { label: "app · main" });
  assert.equal(
    tracker.events.length,
    1,
    "the alarm re-latched while still true",
  );
});

test("a latched alarm survives until it is acknowledged", () => {
  const tracker = createTracker();
  step(tracker, "a", "DEAD", NOW, { label: "one" });
  step(tracker, "b", "DEAD", NOW, { label: "two" });
  assert.equal(tracker.events.length, 2);
  assert.equal(acknowledge(tracker, tracker.events[0].id), 1);
  assert.equal(tracker.events.length, 1);
  assert.equal(acknowledge(tracker, "all"), 1);
  assert.equal(tracker.events.length, 0);
});

test("a DEAD row holds its position for five minutes", () => {
  const tracker = createTracker();
  step(tracker, "s", "DEAD", NOW, { label: "gone" });
  step(tracker, "s", "COLD", NOW + 60_000, {});
  step(tracker, "s", "COLD", NOW + 120_000, {});
  assert.equal(
    tracker.rows.get("s").shown,
    "DEAD",
    "a crash sank out of view too early",
  );
  step(tracker, "s", "COLD", NOW + 6 * 60_000, {});
  step(tracker, "s", "COLD", NOW + 7 * 60_000, {});
  assert.equal(tracker.rows.get("s").shown, "COLD");
});

test("raw state reads the situation the way an operator would", () => {
  const base = {
    mtime: NOW,
    hot: 0,
    agentLive: 0,
    runaway: false,
    pidAlive: null,
    pidVanished: false,
  };
  assert.equal(rawState({ ...base, hot: 10 }, NOW), "LIVE");
  assert.equal(rawState({ ...base }, NOW), "WARM");
  assert.equal(rawState({ ...base, mtime: NOW - 10 * 60_000 }, NOW), "IDLE");
  assert.equal(rawState({ ...base, mtime: NOW - 60 * 60_000 }, NOW), "COLD");
  assert.equal(
    rawState({ ...base, mtime: NOW - 15 * 60_000, pidAlive: true }, NOW),
    "STALL",
    "a live process with a silent transcript is the case worth seeing",
  );
  assert.equal(rawState({ ...base, agentLive: 9 }, NOW), "RUN");
  assert.equal(rawState({ ...base, runaway: true }, NOW), "RUN");
  assert.equal(rawState({ ...base, pidVanished: true }, NOW), "DEAD");
});

test("a stale pid record alone is never read as a crash", () => {
  // ~/.claude/sessions/<pid>.json outlives the process. Only a pid this program
  // watched running and then watched disappear counts.
  const notWatched = {
    mtime: NOW,
    hot: 0,
    agentLive: 0,
    runaway: false,
    pidAlive: false,
    pidVanished: false,
  };
  assert.notEqual(rawState(notWatched, NOW), "DEAD");
});

test("runaway is measured against the session's own median, with a floor", () => {
  const series = createSeries();
  // A quiet hour: 10k tokens a minute.
  for (let m = 70; m >= 4; m -= 1)
    addSample(series, NOW - m * MINUTE, 10_000, 0);
  assert.equal(runawayCheck(series, NOW).runaway, false);

  // Three sustained minutes far above both the median and the floor.
  for (let m = 3; m >= 1; m -= 1) {
    addSample(series, NOW - m * MINUTE, RUNAWAY_FLOOR_PER_MINUTE * 4, 0);
  }
  const check = runawayCheck(series, NOW);
  assert.equal(check.runaway, true, "a sustained spike was not detected");
  assert.ok(check.ratio > 3, "the multiple of normal was not reported");
});

test("two loud minutes are not a runaway; three are", () => {
  const series = createSeries();
  for (let m = 70; m >= 3; m -= 1)
    addSample(series, NOW - m * MINUTE, 10_000, 0);
  for (let m = 2; m >= 1; m -= 1) {
    addSample(series, NOW - m * MINUTE, RUNAWAY_FLOOR_PER_MINUTE * 4, 0);
  }
  assert.equal(runawayCheck(series, NOW).runaway, false);
});

test("a brand-new session is not a runaway just because its median is zero", () => {
  const series = createSeries();
  for (let m = 3; m >= 1; m -= 1) addSample(series, NOW - m * MINUTE, 1000, 0);
  assert.equal(
    runawayCheck(series, NOW).runaway,
    false,
    "the floor did not hold",
  );
});

test("master precedence is strict: trouble beats spend beats normal", () => {
  const quiet = {
    fleetHot: 0,
    fleetMedianPerMinute: 0,
    liveCount: 0,
    unpriced: false,
  };
  assert.equal(masterState({ ...quiet, rows: [] }).word, "IDLE");
  assert.equal(
    masterState({ ...quiet, rows: [], liveCount: 2 }).word,
    "NOMINAL",
  );
  assert.equal(
    masterState({ ...quiet, rows: [], liveCount: 2, fleetHot: 900_000 }).word,
    "BURNING",
  );
  const attention = masterState({
    ...quiet,
    liveCount: 2,
    fleetHot: 9_000_000,
    rows: [{ state: "RUN", label: "app · main", hot: 4_100_000, ratio: 3.2 }],
  });
  assert.equal(
    attention.word,
    "ATTENTION",
    "a runaway was outranked by mere spend",
  );
  assert.match(
    attention.cause,
    /run · app · main · 4\.10M\/5m · 3\.2× normal/u,
  );
});

test("an unpriced model raises attention rather than quietly under-reporting", () => {
  const master = masterState({
    rows: [],
    fleetHot: 0,
    fleetMedianPerMinute: 0,
    liveCount: 1,
    unpriced: true,
  });
  assert.equal(master.word, "ATTENTION");
  assert.deepEqual(master.secondary, ["unpriced model in use"]);
});

test("the burning threshold calibrates to the fleet's own median", () => {
  const busy = masterState({
    rows: [],
    fleetHot: 3_000_000,
    fleetMedianPerMinute: 1_000_000,
    liveCount: 3,
    unpriced: false,
  });
  // 1.5 x 5 x 1M = 7.5M, so 3M is normal here even though it exceeds the floor.
  assert.equal(busy.word, "NOMINAL");
  assert.equal(busy.fleetThreshold, 7_500_000);
});

/**
 * RUN has two independent triggers: a sustained burn above the session's own
 * baseline, and more than AGENT_SWARM live sub-agents. They are different
 * conditions and they need different words. Both were rendered as "runaway
 * burn", and the master cause then appended the burn multiple regardless — so a
 * live eight-agent swarm produced "▲ runaway burn" beside "1.4× normal", a
 * figure well under the documented 3× threshold, which reads as a false alarm.
 */
test("a swarm is named a swarm, and never carries a burn multiple", () => {
  assert.equal(runCause({ runaway: false, agentLive: 8 }), "swarm");
  assert.equal(runCause({ runaway: true, agentLive: 1 }), "burn");
  assert.equal(runCause({ runaway: false, agentLive: 2 }), null);

  const swarm = masterState({
    rows: [
      {
        state: "RUN",
        label: "app · main",
        hot: 12_580_000,
        ratio: 1.4,
        cause: "swarm",
        agentLive: 8,
      },
    ],
    fleetHot: 12_580_000,
    fleetMedianPerMinute: 0,
    liveCount: 1,
    unpriced: false,
  });
  assert.equal(swarm.word, "ATTENTION");
  assert.match(swarm.cause, /8 sub-agents live/u);
  assert.ok(
    !/× normal/u.test(swarm.cause),
    "a swarm alarm claimed a burn multiple: " + swarm.cause,
  );
});

test("the latched alarm text says which condition fired", () => {
  const swarm = createTracker();
  step(swarm, "a", "RUN", 1000, {
    label: "app · main",
    cause: "swarm",
    agentLive: 8,
  });
  assert.match(swarm.events[0].text, /agent swarm — 8 sub-agents live/u);

  const burn = createTracker();
  step(burn, "b", "RUN", 1000, { label: "app · main", cause: "burn" });
  assert.match(burn.events[0].text, /runaway burn/u);
});

test("the idle cause names the window the idle test actually uses", () => {
  const master = masterState({
    rows: [{ state: "IDLE", label: "app · main", hot: 205_000, ratio: 0 }],
    fleetHot: 205_000,
    fleetMedianPerMinute: 0,
    liveCount: 0,
    unpriced: false,
  });
  assert.equal(master.word, "IDLE");
  // IDLE is selected on liveCount === 0, and a row is live while its transcript
  // has been touched within LIVE_MS. The line claimed five minutes while the
  // roster's own 5M column, on the same screen, showed 205.0k.
  assert.match(
    master.cause,
    new RegExp("last " + Math.round(LIVE_MS / 60_000) + " minutes", "u"),
  );
  assert.ok(
    !/last 5 minutes/u.test(master.cause),
    "the cause still claims a window the test does not use: " + master.cause,
  );
});
