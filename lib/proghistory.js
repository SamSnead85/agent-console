/**
 * Progress history — the trend behind the orchestrator's percentage.
 *
 * The percentage in progress.json is a human estimate and this console never
 * computes one. But whether that estimate is MOVING is not an estimate: it is
 * an observation, and observing it is free. Every time a distinct (percent,
 * updatedAt) pair is seen, it is appended here with the wall-clock time it was
 * observed, and the widget draws the line.
 *
 * The line is allowed to go DOWN. An orchestrator that discovers the remaining
 * work is larger than it thought should be able to say so, and a console that
 * quietly took a high-water mark would turn an honest correction into a lie.
 * Nothing here monotonizes anything.
 *
 * De-duplication is by the record's own updatedAt, not by the observation time.
 * The dashboard polls every ten seconds and the orchestrator writes every merge
 * round, so stamping each poll would produce thousands of identical points and
 * a chart with no information in it.
 */

import fs from "node:fs";
import path from "node:path";
import { appendPrivateFile, hardenPrivateFile } from "./private-state.js";

export const PROGRESS_HISTORY_FILE = "progress-history.jsonl";

/** Points kept in memory and served. Enough for months of merge rounds. */
export const MAX_POINTS = 2000;

export function createProgressHistory(config) {
  const dir = config && config.dir;
  return {
    dir: dir || null,
    file: dir ? path.join(dir, PROGRESS_HISTORY_FILE) : null,
    points: [],
    loaded: false,
    badLines: 0,
    loadError: null,
    writeError: null,
    writes: 0,
  };
}

function sortAndCap(store) {
  store.points.sort((a, b) => a.at - b.at);
  if (store.points.length > MAX_POINTS) {
    store.points.splice(0, store.points.length - MAX_POINTS);
  }
}

/** Read the append-only file back. A torn last line is counted, never fatal. */
export function loadProgressHistory(store) {
  store.loaded = true;
  if (!store.file) return { points: 0 };
  let raw;
  try {
    hardenPrivateFile(store.file);
    raw = fs.readFileSync(store.file, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      store.loadError = String(error.message);
    }
    return { points: 0 };
  }
  // Seeded from what is already held, not just from this file. The file is
  // append-only and the same record legitimately appears on several lines, so
  // de-duplication has to be against the STORE — otherwise a second load (a
  // reload, a test, a future caller) silently doubles the observation count and
  // with it the "N updates" reading beside the trend.
  const seen = new Set(store.points.map((p) => p.updatedAt + "|" + p.percent));
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      store.badLines += 1;
      continue;
    }
    const percent = Number(d && d.percent);
    const at = Number(d && d.at);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      store.badLines += 1;
      continue;
    }
    if (!Number.isFinite(at) || at <= 0) {
      store.badLines += 1;
      continue;
    }
    const updatedAt = Number(d.updatedAt);
    const key = (Number.isFinite(updatedAt) ? updatedAt : at) + "|" + percent;
    if (seen.has(key)) continue;
    seen.add(key);
    store.points.push({
      at,
      percent,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : at,
    });
  }
  sortAndCap(store);
  return { points: store.points.length };
}

/**
 * Record one observation if it is new.
 *
 * @returns {{recorded: boolean, reason?: string}}
 */
export function observeProgress(store, progress, now) {
  if (!progress || !progress.available) {
    return { recorded: false, reason: "no progress record to observe" };
  }
  const percent = Number(progress.percent);
  const updatedAt = Number(progress.updatedAt);
  if (!Number.isFinite(percent) || !Number.isFinite(updatedAt)) {
    return { recorded: false, reason: "record is not observable" };
  }
  const last = store.points[store.points.length - 1];
  // The same claim, restated. The orchestrator has not moved, so neither does
  // the chart — a flat line made of 4,000 identical points is not history.
  if (last && last.updatedAt === updatedAt && last.percent === percent) {
    return { recorded: false, reason: "unchanged since the last observation" };
  }
  const point = { at: now, percent, updatedAt };
  store.points.push(point);
  sortAndCap(store);
  if (store.file) {
    try {
      appendPrivateFile(store.file, JSON.stringify({ v: 1, ...point }) + "\n");
      store.writes += 1;
      store.writeError = null;
    } catch (error) {
      store.writeError = String(error.message);
    }
  }
  return { recorded: true, point };
}

/**
 * The series the widget draws, plus the honest reading of its direction.
 *
 * `fromMs` scopes the line to the selected period. The point immediately BEFORE
 * the window is carried in as the opening value, or a chart of the last hour
 * would start at whatever happened to be observed inside it and imply the
 * project began there.
 */
export function progressSeries(store, options) {
  const opts = options || {};
  const fromMs = opts.fromMs === undefined ? null : opts.fromMs;
  const all = store.points;
  let opening = null;
  const inWindow = [];
  for (const p of all) {
    if (fromMs !== null && p.at < fromMs) {
      opening = p;
      continue;
    }
    inWindow.push(p);
  }
  let points = opening
    ? [{ ...opening, carried: true }, ...inWindow]
    : inWindow;
  // A cap on what is SERVED, not on what is kept. The oldest points are the
  // ones dropped, and the reading below is taken from what is served so the
  // chart and the "since X" line can never disagree with each other.
  const max = Number(opts.max) || 0;
  if (max > 0 && points.length > max)
    points = points.slice(points.length - max);
  const first = points[0] || null;
  const last = points[points.length - 1] || null;
  const delta = first && last ? last.percent - first.percent : 0;
  let peak = null;
  for (const p of points) if (!peak || p.percent > peak.percent) peak = p;
  const regressed = !!(peak && last && last.percent < peak.percent);

  return {
    points: points.map((p) => ({
      t: p.at,
      percent: p.percent,
      carried: !!p.carried,
    })),
    count: points.length,
    totalObservations: all.length,
    firstAt: first ? first.at : null,
    delta,
    // Stated as a direction rather than left for the reader to infer from a
    // sign, because the whole point of the widget is that a setback is visible.
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
    peakPercent: peak ? peak.percent : null,
    regressed,
    regressedBy: regressed ? peak.percent - last.percent : 0,
    file: store.file,
    badLines: store.badLines,
    writeError: store.writeError,
    note: "Each distinct percentage the orchestrator wrote, stamped when this console first saw it. The value may fall; a setback shown honestly is the point.",
  };
}
