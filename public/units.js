/*
 * Burn-rate display units.
 *
 * The per-minute figure is the NATIVE measurement — the series is a ring of
 * one-minute buckets, so tok/min is read, not derived. tok/s is the same
 * measurement divided by 60 for display: a different unit, never a different
 * metric, and the labels say which unit is in force everywhere the rate
 * appears (the burn number, its dollar line, and the median).
 *
 * This file is deliberately dual-environment: it contains no import/export
 * and only assigns one global, so the browser loads it as a plain script
 * (before app.js) and the node test suite imports the very same file — the
 * conversion the page shows is the conversion the test exercises, not a copy.
 */

"use strict";

(function () {
  const BURN_UNITS = ["min", "sec"];

  /** A stored/loaded unit, or the default for anything unrecognised. */
  function sanitizeBurnUnit(value) {
    return value === "sec" ? "sec" : "min";
  }

  /** The other unit — the `u` key's cycle. */
  function nextBurnUnit(unit) {
    return sanitizeBurnUnit(unit) === "min" ? "sec" : "min";
  }

  /** A per-minute measurement expressed in `unit`. Display division only. */
  function burnRate(perMinute, unit) {
    const v = Number(perMinute) || 0;
    return sanitizeBurnUnit(unit) === "sec" ? v / 60 : v;
  }

  /** The suffix the labels carry: "min" or "s". */
  function burnUnitSuffix(unit) {
    return sanitizeBurnUnit(unit) === "sec" ? "s" : "min";
  }

  /**
   * BOTH units of one measurement, primary first.
   *
   * Both units remain visible. `u` changes their visual priority without
   * turning either measurement into a hidden keyboard-only mode.
   *
   * Both readings come from the SAME `perMinute` argument. They are one
   * measurement in two units — never two metrics — and that is enforced here by
   * construction rather than promised in the copy.
   */
  function burnPair(perMinute, primaryUnit) {
    const primary = sanitizeBurnUnit(primaryUnit);
    const secondary = nextBurnUnit(primary);
    const face = (unit) => ({
      unit,
      suffix: burnUnitSuffix(unit),
      value: burnRate(perMinute, unit),
    });
    return { primary: face(primary), secondary: face(secondary) };
  }

  globalThis.FleetUnits = {
    BURN_UNITS,
    sanitizeBurnUnit,
    nextBurnUnit,
    burnRate,
    burnUnitSuffix,
    burnPair,
  };
})();
