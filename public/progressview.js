/*
 * The project-progress strip's reading, decided in one place.
 *
 * The strip carries NO hedge on the percentage — no "estimate" badge, no
 * "declared" badge, no copy calling it a judgement. Everyone reading this
 * screen already knows a completion percentage is somebody's estimate, and
 * saying so on the face of the widget spends the operator's attention to tell
 * them what they knew. The full provenance still exists and is still one click
 * away: the strip's own label carries `data-term="progress"`, which opens the
 * `progress` entry in lib/glossary.js — "a human orchestrator's judgement, read
 * from a file, not measured, and it can go down".
 *
 * That restraint is scoped to THIS number. The cost column keeps its estimated
 * badge, because a dollar figure priced from a bundled API rate table is
 * genuinely misleading without one — it is not anybody's subscription bill.
 *
 * The one rule this file exists to hold: a record that is absent, unavailable
 * or carries an unusable percentage produces NOTHING. A fabricated 0% reads as
 * "nothing done" and a fabricated 100% as "ship it", and an empty strip is
 * better than either. The server refuses the same shapes for the same reason;
 * this is the second refusal, on the surface that actually draws pixels.
 *
 * Dual-environment, exactly like units.js: no import/export and one global, so
 * the browser loads it as a plain script and the node suite imports this very
 * file. The reading the page shows is the reading the test exercises — there is
 * no second implementation for them to drift between.
 */

"use strict";

(function () {
  /** Matches lib/progress.js. Only used when the server sent no verdict. */
  const STALE_MS = 30 * 60_000;

  // No badge words at all. There were two — DECLARED on the percentage and
  // MEASURED on the git counters — and they were removed in that order, for
  // one reason applied twice.
  //
  // DECLARED went first: nobody mistakes a completion percentage for a
  // measurement, so the badge restated an assumption.
  //
  // MEASURED went with it, and the argument for keeping it did not survive
  // losing its partner. "You cannot tell by looking whether 209 came from git
  // or from a person" was true only while a number on the same strip HAD come
  // from a person. With the percentage unbadged, every figure here is measured,
  // so the badge distinguishes nothing — a label with no alternative.
  //
  // The provenance is not gone, only unpriced in pixels: the strip's label
  // carries data-term="progress", and that glossary entry still explains which
  // numbers come from git and which from the orchestrator.

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function usablePercent(value) {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 100
    );
  }

  function hidden(reason) {
    return { visible: false, reason: reason };
  }

  /**
   * Staleness, preferring the server's verdict and falling back to the clock.
   *
   * The server computes this already and its wording is tested there, so it is
   * taken verbatim when present. The fallback exists for a payload that carried
   * a timestamp but no verdict: an unchecked age is not the same as a fresh
   * one, and silently reading it as fresh is the failure this guards.
   */
  function staleness(progress, now) {
    if (typeof progress.stale === "boolean") {
      if (!progress.stale) return { stale: false, note: null };
      const served =
        typeof progress.staleNote === "string" && progress.staleNote.trim()
          ? progress.staleNote.trim()
          : null;
      return { stale: true, note: served || "last updated a while ago" };
    }
    const updatedAt = Number(progress.updatedAt);
    if (!Number.isFinite(updatedAt) || !Number.isFinite(Number(now))) {
      return { stale: false, note: null };
    }
    const ageMs = Math.max(0, Number(now) - updatedAt);
    if (ageMs <= STALE_MS) return { stale: false, note: null };
    return {
      stale: true,
      note: "last updated " + Math.round(ageMs / 60_000) + "m ago",
    };
  }

  /**
   * The trend reading, or null when no history came with the record.
   *
   * `tone` is the whole point of keeping the direction rather than a bare sign:
   * a fall is drawn in the warning hue, and a setback an operator has to squint
   * at is a setback the strip failed to report.
   */
  function trendOf(history) {
    if (!history || typeof history !== "object") return null;
    const count = Number(history.count) || 0;
    const delta = Number(history.delta) || 0;
    const points = Array.isArray(history.points) ? history.points : [];
    const regressed = history.regressed === true;
    const regressedBy = Number(history.regressedBy) || 0;
    const peakPercent = usablePercent(history.peakPercent)
      ? history.peakPercent
      : null;
    return {
      count: count,
      totalObservations: Number(history.totalObservations) || 0,
      delta: delta,
      direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
      tone: delta < 0 ? "down" : "up",
      points: points,
      peakPercent: peakPercent,
      regressed: regressed,
      regressedBy: regressedBy,
      // Short enough to survive the narrowest column the strip ever gets; the
      // sentence form is on the hover.
      deltaText:
        count > 1
          ? (delta > 0 ? "+" : "") + round1(delta) + " pts · " + count + " obs"
          : "1 obs · trend from the next update",
      regressedText:
        regressed && peakPercent !== null
          ? "down " +
            round1(regressedBy) +
            " pts from a peak of " +
            round1(peakPercent) +
            "%"
          : null,
      note: typeof history.note === "string" ? history.note : "",
    };
  }

  /**
   * The whole strip's reading from one served `progress` object.
   *
   * @param {object|null} progress the server's `progress` payload
   * @param {{now?: number}} [options]
   * @returns {object} `{visible: false, reason}` or the full reading
   */
  function progressView(progress, options) {
    const opts = options || {};
    if (!progress || typeof progress !== "object") {
      return hidden("no progress record");
    }
    if (progress.available !== true) {
      return hidden(
        typeof progress.reason === "string" && progress.reason
          ? progress.reason
          : "no progress record",
      );
    }
    // The refusal that matters. Everything below this line is decoration; this
    // line is why the strip is allowed to draw a number at all.
    if (!usablePercent(progress.percent)) {
      return hidden("percent is not a usable number");
    }

    const percent = progress.percent;
    const remaining = Array.isArray(progress.remaining)
      ? progress.remaining.filter(
          (item) => typeof item === "string" && item.trim(),
        )
      : [];
    const age = staleness(progress, opts.now);

    return {
      visible: true,
      percent: percent,
      // One decimal, so 67.5 stays 67.5 and 68 stays 68 rather than "68.0".
      percentText: round1(percent) + "%",
      // The determinate bar is the fastest visual scan of the declared value;
      // adjacent text preserves its exact percentage and source.
      barFraction: percent / 100,
      // No `basis` and no `counterBasis`, on purpose: nothing on this strip
      // carries a badge, so the view model offers the page nothing to render
      // one from.
      summary: typeof progress.summary === "string" ? progress.summary : "",
      remaining: remaining,
      remainingCount: remaining.length,
      remainingLabel: remaining.length
        ? remaining.length + " remaining"
        : "nothing listed as remaining",
      stale: age.stale,
      staleNote: age.note,
      source: typeof progress.source === "string" ? progress.source : "",
      trend: trendOf(progress.history),
    };
  }

  globalThis.FleetProgress = {
    STALE_MS,
    progressView,
  };
})();
