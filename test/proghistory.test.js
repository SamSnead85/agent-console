import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PROGRESS_HISTORY_FILE,
  createProgressHistory,
  loadProgressHistory,
  observeProgress,
  progressSeries,
} from "../lib/proghistory.js";

const NOW = 1_788_000_000_000;
const MIN = 60_000;

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-prog-"));
}

function record(percent, updatedAt) {
  return { available: true, percent, updatedAt };
}

test("only a changed record is recorded — a ten-second poll makes no history", () => {
  const store = createProgressHistory({});
  assert.equal(observeProgress(store, record(80, NOW), NOW).recorded, true);
  for (let i = 1; i <= 30; i += 1) {
    assert.equal(
      observeProgress(store, record(80, NOW), NOW + i * 10_000).recorded,
      false,
      "an unchanged record was recorded again",
    );
  }
  assert.equal(store.points.length, 1);
  assert.equal(
    observeProgress(store, record(82, NOW + MIN), NOW + MIN).recorded,
    true,
  );
  assert.equal(store.points.length, 2);
});

/**
 * The same percentage written again by the orchestrator IS news: it is a fresh
 * assertion at a new time, and the widget's "last updated" reading depends on
 * it. Only a restatement of the identical record is ignored.
 */
test("the same percentage at a new updatedAt is a new observation", () => {
  const store = createProgressHistory({});
  observeProgress(store, record(80, NOW), NOW);
  assert.equal(
    observeProgress(store, record(80, NOW + MIN), NOW + MIN).recorded,
    true,
  );
  assert.equal(store.points.length, 2);
});

test("an absent or unusable progress record is never invented into a point", () => {
  const store = createProgressHistory({});
  assert.equal(observeProgress(store, null, NOW).recorded, false);
  assert.equal(
    observeProgress(store, { available: false, reason: "no file" }, NOW)
      .recorded,
    false,
  );
  assert.equal(
    observeProgress(store, { available: true, percent: "80" }, NOW).recorded,
    false,
  );
  assert.equal(store.points.length, 0);
});

/**
 * The whole point of the widget. An orchestrator that discovers the remaining
 * work is larger than it thought must be able to say so, and a console that
 * quietly kept a high-water mark would turn an honest correction into a lie.
 */
test("the line may go down, and the fall is reported rather than smoothed", () => {
  const store = createProgressHistory({});
  observeProgress(store, record(60, NOW), NOW);
  observeProgress(store, record(88, NOW + MIN), NOW + MIN);
  observeProgress(store, record(71, NOW + 2 * MIN), NOW + 2 * MIN);

  const series = progressSeries(store, {});
  assert.deepEqual(
    series.points.map((p) => p.percent),
    [60, 88, 71],
    "a setback was smoothed away",
  );
  assert.equal(series.delta, 11);
  assert.equal(series.direction, "up");
  assert.equal(series.peakPercent, 88);
  assert.equal(series.regressed, true);
  assert.equal(series.regressedBy, 17);
});

test("a net fall is named a fall", () => {
  const store = createProgressHistory({});
  observeProgress(store, record(88, NOW), NOW);
  observeProgress(store, record(71, NOW + MIN), NOW + MIN);
  const series = progressSeries(store, {});
  assert.equal(series.delta, -17);
  assert.equal(series.direction, "down");
});

/**
 * A chart of the last hour that begins at whatever happened to be observed
 * inside it implies the project began there. The last point BEFORE the window
 * is carried in as the opening value.
 */
test("the point before the window is carried in as the opening value", () => {
  const store = createProgressHistory({});
  observeProgress(store, record(40, NOW), NOW);
  observeProgress(store, record(50, NOW + 10 * MIN), NOW + 10 * MIN);
  observeProgress(store, record(55, NOW + 90 * MIN), NOW + 90 * MIN);

  const scoped = progressSeries(store, { fromMs: NOW + 60 * MIN });
  assert.equal(scoped.points.length, 2);
  assert.equal(scoped.points[0].percent, 50);
  assert.equal(
    scoped.points[0].carried,
    true,
    "the opening value was not carried",
  );
  assert.equal(scoped.delta, 5);
});

test("the served cap trims the oldest points and the reading follows what is served", () => {
  const store = createProgressHistory({});
  for (let i = 0; i < 12; i += 1) {
    observeProgress(store, record(i, NOW + i * MIN), NOW + i * MIN);
  }
  const capped = progressSeries(store, { max: 4 });
  assert.equal(capped.points.length, 4);
  assert.deepEqual(
    capped.points.map((p) => p.percent),
    [8, 9, 10, 11],
  );
  assert.equal(capped.delta, 3, "the reading disagreed with the points drawn");
  assert.equal(capped.totalObservations, 12);
});

test("history survives a restart, and a torn line is counted not fatal", () => {
  const dir = scratch();
  const store = createProgressHistory({ dir });
  observeProgress(store, record(60, NOW), NOW);
  observeProgress(store, record(70, NOW + MIN), NOW + MIN);
  const file = path.join(dir, PROGRESS_HISTORY_FILE);
  fs.appendFileSync(file, '{"v":1,"at":123, TORN\n');
  fs.appendFileSync(
    file,
    JSON.stringify({ v: 1, at: NOW + 2 * MIN, percent: 500 }) + "\n",
  );

  const reloaded = createProgressHistory({ dir });
  loadProgressHistory(reloaded);
  assert.equal(
    reloaded.points.length,
    2,
    "a valid point was lost to a torn neighbour",
  );
  assert.equal(reloaded.badLines, 2, "an out-of-range percent was accepted");
  assert.deepEqual(
    reloaded.points.map((p) => p.percent),
    [60, 70],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The file is append-only and the process re-reads it on every start, so the
 * same observation arrives twice. Two identical points would double the
 * apparent number of updates the orchestrator made.
 */
test("reloading twice does not duplicate an observation", () => {
  const dir = scratch();
  const store = createProgressHistory({ dir });
  observeProgress(store, record(60, NOW), NOW);
  observeProgress(store, record(60, NOW), NOW + 1000);

  const reloaded = createProgressHistory({ dir });
  loadProgressHistory(reloaded);
  loadProgressHistory(reloaded);
  assert.equal(reloaded.points.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with no directory configured the trend still works in memory", () => {
  const store = createProgressHistory({});
  observeProgress(store, record(10, NOW), NOW);
  assert.equal(store.file, null);
  assert.equal(store.writeError, null);
  assert.equal(progressSeries(store, {}).count, 1);
});

test("a single observation is a level, not a trend, and says so", () => {
  const store = createProgressHistory({});
  observeProgress(store, record(80, NOW), NOW);
  const series = progressSeries(store, {});
  assert.equal(series.count, 1);
  assert.equal(series.delta, 0);
  assert.equal(series.direction, "flat");
  assert.equal(series.regressed, false);
});
