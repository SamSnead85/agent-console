import test from "node:test";
import assert from "node:assert/strict";

// The SAME file the page loads, not a copy of its logic: public/units.js
// contains no import/export and assigns one global, so it is a classic script
// in the browser and an importable module here. If the conversion the page
// shows ever drifts from the conversion this file tests, there is no second
// implementation for them to drift between.
await import("../public/units.js");
const {
  BURN_UNITS,
  sanitizeBurnUnit,
  nextBurnUnit,
  burnRate,
  burnUnitSuffix,
  burnPair,
} = globalThis.FleetUnits;

test("tok/s is the per-minute measurement divided by 60 — a unit, not a new metric", () => {
  assert.equal(burnRate(6_470_000, "min"), 6_470_000);
  assert.equal(burnRate(6_470_000, "sec"), 6_470_000 / 60);
  // The dollar line follows the same unit as the token line.
  assert.ok(Math.abs(burnRate(7.93, "sec") - 0.1321666) < 1e-4);
  assert.equal(burnRate(0, "sec"), 0);
  assert.equal(burnRate(null, "sec"), 0, "a missing rate is zero, not NaN");
  assert.equal(burnUnitSuffix("min"), "min");
  assert.equal(burnUnitSuffix("sec"), "s");
});

test("persistence round-trip: stored units reload, garbage falls back to the native tok/min", () => {
  // What `u` writes is what a reload reads.
  for (const unit of BURN_UNITS) {
    assert.equal(sanitizeBurnUnit(unit), unit);
  }
  // A corrupted or legacy localStorage value must not wedge the display in an
  // unknown unit: anything unrecognised is the default, and the default is
  // the NATIVE per-minute measurement.
  assert.equal(sanitizeBurnUnit("furlongs"), "min");
  assert.equal(sanitizeBurnUnit(null), "min");
  assert.equal(sanitizeBurnUnit(undefined), "min");
  // The `u` key cycles both ways and never leaves the two known units.
  assert.equal(nextBurnUnit("min"), "sec");
  assert.equal(nextBurnUnit("sec"), "min");
  assert.equal(
    nextBurnUnit("garbage"),
    "sec",
    "cycling from garbage starts at the default",
  );
});

test("both units are on screen at once — one measurement, two faces of it", () => {
  // The toggle was undiscoverable, so the console shows both readings and `u`
  // only decides which is large. Both faces come from ONE per-minute figure.
  const pair = burnPair(4_752_000, "min");
  assert.equal(pair.primary.unit, "min");
  assert.equal(pair.primary.suffix, "min");
  assert.equal(pair.primary.value, 4_752_000);
  assert.equal(pair.secondary.unit, "sec");
  assert.equal(pair.secondary.suffix, "s");
  assert.equal(pair.secondary.value, 4_752_000 / 60);

  // The two faces are never the same unit — that is the whole point of showing
  // both, and a pair that agreed with itself would silently render one figure
  // twice and look like corroboration.
  assert.notEqual(pair.primary.unit, pair.secondary.unit);
  assert.notEqual(pair.primary.suffix, pair.secondary.suffix);

  // And they are exactly 60 apart, because they are one measurement in two
  // units and never two metrics.
  assert.equal(pair.primary.value / pair.secondary.value, 60);
});

test("`u` swaps which unit is primary without changing either reading", () => {
  const perMinute = 4_752_000;
  const asMin = burnPair(perMinute, "min");
  const asSec = burnPair(perMinute, "sec");

  assert.equal(asSec.primary.unit, "sec");
  assert.equal(asSec.secondary.unit, "min");

  // Swapping the emphasis must not change a single number: the per-second
  // figure is the same whether it is the big one or the small one.
  assert.equal(asSec.primary.value, asMin.secondary.value);
  assert.equal(asSec.secondary.value, asMin.primary.value);
  assert.equal(asSec.primary.suffix, asMin.secondary.suffix);

  // The dollar line follows the same pair, so the cost can never be labelled
  // with one unit while carrying the other's value.
  const cost = burnPair(1.53, "min");
  assert.equal(cost.primary.suffix, "min");
  assert.equal(cost.secondary.suffix, "s");
  assert.ok(Math.abs(cost.secondary.value - 0.0255) < 1e-9);

  // An unknown stored unit still yields a complete, well-formed pair.
  const garbage = burnPair(perMinute, "furlongs");
  assert.equal(garbage.primary.unit, "min");
  assert.equal(garbage.secondary.unit, "sec");
  // A missing rate is zero in both faces, not NaN in either.
  const empty = burnPair(null, "min");
  assert.equal(empty.primary.value, 0);
  assert.equal(empty.secondary.value, 0);
});
