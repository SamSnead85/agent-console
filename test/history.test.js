import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUCKET_MS,
  MAX_SERIES_POINTS,
  addHistorySample,
  assembleHistory,
  createHistoryStore,
  downsample,
  flushHistory,
  loadHistory,
  periodStart,
} from "../lib/history.js";
import { createClaudeStore, scanClaude } from "../lib/claude.js";
import { dayKeyOf } from "../lib/day.js";
import { createSeries } from "../lib/series.js";
import {
  scratchHome,
  removeTree,
  writeJsonl,
  assistantLine,
} from "./helpers.js";

const T = (options) => ({
  in: options.in || 0,
  out: options.out || 0,
  cr: options.cr || 0,
  cw: options.cw || 0,
  cw1h: options.cw1h || 0,
  think: options.think || 0,
});

function scratchDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-hist-" + name + "-"));
}

test("period bucketing: totals are scoped to the selected period, buckets are 5 minutes", () => {
  const now = Date.now();
  const store = createHistoryStore({});

  addHistorySample(
    store,
    now - 30 * 60_000,
    "claude-opus-5",
    "p|s1",
    T({ in: 1000 }),
  );
  addHistorySample(
    store,
    now - 2 * 3600_000,
    "claude-opus-5",
    "p|s1",
    T({ out: 2000 }),
  );
  addHistorySample(
    store,
    now - 30 * 3600_000,
    "claude-opus-5",
    "p|s2",
    T({ cr: 500_000 }),
  );

  const hour = assembleHistory(store, { now, period: "hour" });
  assert.equal(
    hour.totals.total,
    1000,
    "the hour view must hold only the last hour",
  );
  // opus-5 input is $5/M — the class is priced separately, not blended.
  assert.ok(Math.abs(hour.totals.costTotal - 0.005) < 1e-9);

  const day = assembleHistory(store, { now, period: "24h" });
  assert.equal(
    day.totals.total,
    3000,
    "24h must include the 2h-old sample and exclude the 30h-old one",
  );
  assert.equal(day.bySession.length, 1);
  assert.equal(day.bySession[0].total, 3000);

  const days3 = assembleHistory(store, { now, period: "3d" });
  assert.equal(days3.totals.total, 503_000);

  const all = assembleHistory(store, { now, period: "all" });
  assert.equal(all.totals.total, 503_000);
  assert.equal(all.period.fromMs, null, "lifecycle has no lower bound");
  assert.equal(all.byModel[0].model, "claude-opus-5");
  assert.equal(all.byModel[0].total, 503_000);

  // The bucket OVERLAPPING the period start is included, so "last hour" means
  // the last hour, not the last 55-to-60 minutes depending on alignment.
  const edgeStore = createHistoryStore({});
  addHistorySample(
    edgeStore,
    now - 3_599_000,
    "claude-opus-5",
    "p|s",
    T({ in: 7 }),
  );
  assert.equal(
    assembleHistory(edgeStore, { now, period: "hour" }).totals.total,
    7,
  );
});

test("samples in one 5-minute bucket sum; adjacent buckets stay separate points", () => {
  const now = Date.now();
  const t0 = Math.floor(now / BUCKET_MS) * BUCKET_MS - 10 * BUCKET_MS;
  const store = createHistoryStore({});
  addHistorySample(store, t0 + 1000, "claude-opus-5", "p|s", T({ in: 10 }));
  addHistorySample(store, t0 + 2000, "claude-opus-5", "p|s", T({ in: 15 }));
  addHistorySample(
    store,
    t0 + BUCKET_MS + 1000,
    "claude-opus-5",
    "p|s",
    T({ in: 40 }),
  );

  const all = assembleHistory(store, { now, period: "all" });
  const first = all.series.find((p) => p.t === t0);
  const second = all.series.find((p) => p.t === t0 + BUCKET_MS);
  assert.ok(first && second, "each bucket must be its own series point");
  assert.equal(first.total, 25);
  assert.equal(second.total, 40);
  assert.equal(all.totals.total, 65);
});

test("snapshot merge de-duplicates by time bucket: re-reading the same source never double counts", () => {
  const dir = scratchDir("merge");
  const now = Date.now();
  const t0 = Math.floor(now / BUCKET_MS) * BUCKET_MS - 4 * BUCKET_MS;

  // First run: observes the bucket, flushes, observes more, flushes again —
  // the file now holds the SAME bucket on two lines with growing values.
  const runA = createHistoryStore({ dir });
  addHistorySample(
    runA,
    t0 + 500,
    "claude-opus-5",
    "p|s1",
    T({ in: 100, out: 50 }),
  );
  assert.equal(flushHistory(runA, now).written, 1);
  addHistorySample(runA, t0 + 900, "claude-opus-5", "p|s1", T({ in: 20 }));
  assert.equal(flushHistory(runA, now + 1000).written, 1);
  const lines = fs
    .readFileSync(path.join(dir, "history.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.equal(lines.length, 2, "each flush appends one line");

  // Second run: loads the snapshots AND re-derives the same spend from source.
  const runB = createHistoryStore({ dir });
  loadHistory(runB);
  addHistorySample(
    runB,
    t0 + 500,
    "claude-opus-5",
    "p|s1",
    T({ in: 100, out: 50 }),
  );
  addHistorySample(runB, t0 + 900, "claude-opus-5", "p|s1", T({ in: 20 }));
  const merged = assembleHistory(runB, { now, period: "all" });
  assert.equal(
    merged.totals.total,
    170,
    "the same bucket seen from source and from two snapshot lines must count once: " +
      merged.totals.total,
  );
  assert.equal(merged.bySession[0].total, 170);

  removeTree(dir);
});

test("history survives log pruning: a fresh process with no source data still has the snapshots", () => {
  const dir = scratchDir("prune");
  const now = Date.now();
  const runA = createHistoryStore({ dir });
  addHistorySample(
    runA,
    now - 3 * BUCKET_MS,
    "claude-sonnet-5",
    "p|gone",
    T({ in: 4000, out: 300 }),
  );
  flushHistory(runA, now);

  const runB = createHistoryStore({ dir });
  loadHistory(runB);
  const view = assembleHistory(runB, { now, period: "24h" });
  assert.equal(view.totals.total, 4300, "pruned logs must not erase history");
  assert.ok(view.coverage.persistedFromMs !== null);
  removeTree(dir);
});

test("historical figures are recovered from the SOURCE timestamps, not stamped at scan time", () => {
  const home = scratchHome("hist-recover");
  const now = Date.now();
  const yesterday = now - 20 * 3600_000;
  // Two JSONL lines, one message id — the 1.84x de-duplication case — written
  // with yesterday's timestamps into a file whose mtime is now.
  writeJsonl(path.join(home, ".claude", "projects", "-tmp-h", "s.jsonl"), [
    assistantLine({
      id: "msg_y",
      at: yesterday,
      in: 10,
      out: 20,
      cr: 1000,
      cw: 100,
    }),
    assistantLine({
      id: "msg_y",
      at: yesterday,
      in: 10,
      out: 37,
      cr: 1000,
      cw: 100,
    }),
  ]);
  const history = createHistoryStore({});
  const store = createClaudeStore({
    root: path.join(home, ".claude", "projects"),
    sessionsDir: path.join(home, ".claude", "sessions"),
    windowMs: 72 * 3600 * 1000,
    fleetSeries: createSeries(),
    history,
  });
  scanClaude(store, now, dayKeyOf);

  const day = assembleHistory(history, { now, period: "24h" });
  assert.equal(
    day.totals.total,
    10 + 37 + 1000 + 100,
    "yesterday's spend must land in the 24h period, de-duplicated by message id",
  );
  const hour = assembleHistory(history, { now, period: "hour" });
  assert.equal(
    hour.totals.total,
    0,
    "a 20-hour-old line must NOT appear in the last hour — history must use the line's own timestamp",
  );
  removeTree(home);
});

test("a long series is downsampled without losing a single token", () => {
  const now = Date.now();
  const store = createHistoryStore({});
  const t0 = Math.floor(now / BUCKET_MS) * BUCKET_MS - 1000 * BUCKET_MS;
  for (let i = 0; i < 1000; i += 1) {
    addHistorySample(
      store,
      t0 + i * BUCKET_MS,
      "claude-opus-5",
      "p|s",
      T({ in: i + 1 }),
    );
  }
  const all = assembleHistory(store, { now, period: "all" });
  assert.ok(
    all.series.length <= MAX_SERIES_POINTS,
    "series must be capped: " + all.series.length,
  );
  const seriesSum = all.series.reduce((n, p) => n + p.total, 0);
  assert.equal(
    seriesSum,
    all.totals.total,
    "downsampling must preserve the total",
  );
  assert.equal(all.totals.total, (1000 * 1001) / 2);
});

test("downsample is the identity when the series already fits", () => {
  const points = [
    { t: 0, in: 1, out: 0, cr: 0, cw: 0, total: 1, cost: 0, unpriced: false },
  ];
  assert.equal(downsample(points, 10), points);
});

test("malformed snapshot lines are counted and skipped, never fatal", () => {
  const dir = scratchDir("bad");
  const good = JSON.stringify({
    v: 1,
    at: Date.now(),
    buckets: [
      {
        b: 1_700_000_000_000,
        models: { "claude-opus-5": T({ in: 9 }) },
        sessions: {},
      },
    ],
  });
  fs.writeFileSync(
    path.join(dir, "history.jsonl"),
    'not json at all\n{"v":1,"buckets":"wrong"}\n' + good + "\n",
  );
  const store = createHistoryStore({ dir });
  const result = loadHistory(store);
  assert.equal(store.badLines, 2);
  assert.equal(result.buckets, 1, "the good line must still load");
  removeTree(dir);
});

test("periodStart maps ids to window starts and rejects the unknown", () => {
  const now = 1_000_000_000_000;
  assert.equal(periodStart("hour", now), now - 3600_000);
  assert.equal(periodStart("24h", now), now - 24 * 3600_000);
  assert.equal(periodStart("3d", now), now - 3 * 24 * 3600_000);
  assert.equal(periodStart("all", now), null);
  assert.equal(periodStart("fortnight", now), undefined);
});
