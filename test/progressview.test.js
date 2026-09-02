import test from "node:test";
import assert from "node:assert/strict";

// The SAME file the page loads, not a copy of its logic: public/progressview.js
// contains no import/export and assigns one global, so it is a classic script in
// the browser and an importable module here. The reading the strip draws is the
// reading these tests exercise.
await import("../public/progressview.js");
const { progressView, STALE_MS } = globalThis.FleetProgress;

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

/** What the server sends when the orchestrator's file is well-formed. */
function served(overrides) {
  return {
    available: true,
    percent: 68,
    summary: "16 PRs merged today. Command center, draggable canvases.",
    remaining: ["restore the progress strip", "show both burn units"],
    remainingCount: 2,
    updatedAt: NOW - 60_000,
    ageMs: 60_000,
    stale: false,
    staleNote: null,
    source: "/home/x/.sprintloop-fleet-dashboard/progress.json",
    history: {
      points: [
        { t: NOW - 300_000, percent: 60, carried: false },
        { t: NOW - 120_000, percent: 74, carried: false },
        { t: NOW - 60_000, percent: 68, carried: false },
      ],
      count: 3,
      totalObservations: 3,
      delta: 8,
      direction: "up",
      peakPercent: 74,
      regressed: true,
      regressedBy: 6,
      note: "Each distinct percentage the orchestrator wrote.",
    },
    ...overrides,
  };
}

test("the strip renders from a served record: percent, determinate bar, summary, list", () => {
  const v = progressView(served(), { now: NOW });
  assert.equal(v.visible, true);
  assert.equal(v.percent, 68);
  assert.equal(v.percentText, "68%");
  // The bar is the percentage and nothing else — the owner reads it first.
  assert.equal(v.barFraction, 0.68);
  assert.match(v.summary, /^16 PRs merged today\./u);
  assert.equal(v.remainingCount, 2);
  assert.equal(v.remainingLabel, "2 remaining");
  assert.deepEqual(v.remaining, [
    "restore the progress strip",
    "show both burn units",
  ]);
  assert.equal(v.stale, false);
  assert.equal(v.staleNote, null);
});

test("the strip carries NO badges at all — neither is reintroduced", () => {
  const v = progressView(served(), { now: NOW });

  // A completion percentage is already understood as an orchestrator's
  // judgement; a redundant badge spends attention without adding a distinction.
  assert.equal(v.basis, undefined, "the percentage must carry no badge word");
  assert.equal(
    globalThis.FleetProgress.PERCENT_BASIS,
    undefined,
    "there must be no exported badge word for the page to render",
  );

  // And the counters lost theirs too. MEASURED was information only while a
  // number on the SAME strip had come from a person; with the percentage
  // unbadged, every figure here is measured and the badge distinguishes
  // nothing. A label with no alternative is noise.
  assert.equal(v.counterBasis, undefined, "the counters carry no badge word");
  assert.equal(
    globalThis.FleetProgress.COUNTER_BASIS,
    undefined,
    "there must be no exported counter badge for the page to render",
  );

  // Nothing the CONSOLE writes may hand the page a badge to print. This catches
  // either one smuggled back in under a different field name. The orchestrator's
  // own words pass through untouched and are excluded — if he writes "estimate"
  // in his summary, that is his sentence to write.
  const authored = { ...v, summary: "", remaining: [], source: "" };
  if (authored.trend) authored.trend = { ...authored.trend, note: "" };
  const flat = JSON.stringify(authored).toLowerCase();
  for (const word of [
    "declared",
    "estimate",
    "judgement",
    "judgment",
    "measured",
  ]) {
    assert.ok(
      !flat.includes(word),
      "the view model must not author the word '" + word + "': " + flat,
    );
  }

  // What the strip still owes the reader is provenance ON DEMAND, not on every
  // paint: the label carries data-term="progress" and lib/glossary.js still
  // explains which numbers come from git and which from the orchestrator. That
  // entry is asserted in glossary.test.js and is the reason this one can be
  // this strict.
});

test("a fractional estimate keeps one decimal and a whole one grows no false precision", () => {
  assert.equal(
    progressView(served({ percent: 67.5 }), { now: NOW }).percentText,
    "67.5%",
  );
  assert.equal(
    progressView(served({ percent: 68 }), { now: NOW }).percentText,
    "68%",
  );
  assert.equal(
    progressView(served({ percent: 0 }), { now: NOW }).percentText,
    "0%",
  );
  assert.equal(
    progressView(served({ percent: 100 }), { now: NOW }).percentText,
    "100%",
  );
  // The bar tracks the number at both ends of the range.
  assert.equal(
    progressView(served({ percent: 0 }), { now: NOW }).barFraction,
    0,
  );
  assert.equal(
    progressView(served({ percent: 100 }), { now: NOW }).barFraction,
    1,
  );
});

test("a stale record carries the staleness label, taken verbatim from the server", () => {
  const v = progressView(
    served({ stale: true, staleNote: "last updated 47m ago" }),
    { now: NOW },
  );
  assert.equal(v.visible, true, "a stale estimate is shown, not suppressed");
  assert.equal(v.stale, true);
  assert.equal(
    v.staleNote,
    "last updated 47m ago",
    "the server's wording is tested in progress.test.js; the strip must not restate it in its own words",
  );
});

test("a payload with a timestamp but no verdict is aged against the clock, not assumed fresh", () => {
  // Past the threshold there is a label. An age nobody checked is not the same
  // as a fresh one, and reading it as fresh is the failure this guards.
  const old = progressView(
    {
      available: true,
      percent: 40,
      summary: "x",
      updatedAt: NOW - 47 * 60_000,
    },
    { now: NOW },
  );
  assert.equal(old.stale, true);
  assert.equal(old.staleNote, "last updated 47m ago");

  // Inside the threshold there is none.
  const fresh = progressView(
    { available: true, percent: 40, summary: "x", updatedAt: NOW - 5 * 60_000 },
    { now: NOW },
  );
  assert.equal(fresh.stale, false);
  assert.equal(fresh.staleNote, null);

  // The boundary is the same 30 minutes the server uses.
  assert.equal(STALE_MS, 30 * 60_000);
  const onTheLine = progressView(
    { available: true, percent: 40, summary: "x", updatedAt: NOW - STALE_MS },
    { now: NOW },
  );
  assert.equal(
    onTheLine.stale,
    false,
    "exactly at the threshold is not yet stale",
  );
});

test("an absent or unavailable record draws NOTHING — never a fabricated 0%", () => {
  for (const [label, payload] of [
    ["null", null],
    ["undefined", undefined],
    ["not an object", "progress"],
    [
      "explicitly unavailable",
      { available: false, reason: "no progress file" },
    ],
    ["available omitted", { percent: 68, summary: "x" }],
    ["available is truthy but not true", { available: 1, percent: 68 }],
  ]) {
    const v = progressView(payload, { now: NOW });
    assert.equal(v.visible, false, label + " must not render");
    // The specific failure this guards: an empty strip is better than a number
    // nobody wrote. 0% reads as "nothing done"; 100% reads as "ship it".
    assert.equal(v.percent, undefined, label + " must carry no percentage");
    assert.equal(
      v.percentText,
      undefined,
      label + " must carry no percent text",
    );
    assert.equal(v.barFraction, undefined, label + " must carry no bar");
    assert.equal(typeof v.reason, "string");
  }
});

test("a malformed percentage draws nothing, whatever else the record carries", () => {
  const shapes = [
    ["missing", undefined],
    ["null", null],
    ["a string that looks like a number", "68"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["over 100", 101],
    ["a boolean", true],
  ];
  for (const [label, percent] of shapes) {
    const v = progressView(served({ percent }), { now: NOW });
    assert.equal(v.visible, false, label + " must not render");
    assert.equal(v.barFraction, undefined, label + " must not draw a bar");
  }
  // Out-of-range is REFUSED, never clamped: clamping 140 to 100 would fabricate
  // the exact figure the strip exists not to invent.
  assert.equal(
    progressView(served({ percent: 140 }), { now: NOW }).visible,
    false,
  );
});

test("an unavailable record passes the server's reason through instead of inventing one", () => {
  const v = progressView(
    { available: false, reason: "progress file is not JSON" },
    { now: NOW },
  );
  assert.equal(v.reason, "progress file is not JSON");
});

test("a setback is reported, on the bar and in words", () => {
  const v = progressView(served(), { now: NOW });
  assert.equal(v.trend.regressed, true);
  assert.equal(v.trend.peakPercent, 74);
  assert.equal(
    v.trend.regressedText,
    "down 6 pts from a peak of 74%",
    "the fall is spelled out; a setback the operator has to infer is one the strip failed to report",
  );
});

test("a falling line is toned as a fall, and the direction is stated not inferred", () => {
  const down = progressView(
    served({
      history: {
        ...served().history,
        delta: -12,
        direction: "down",
        regressed: true,
        regressedBy: 12,
      },
    }),
    { now: NOW },
  );
  assert.equal(down.trend.direction, "down");
  assert.equal(down.trend.tone, "down", "a fall is drawn in the warning hue");
  assert.equal(down.trend.deltaText, "-12 pts · 3 obs");

  const up = progressView(served(), { now: NOW });
  assert.equal(up.trend.direction, "up");
  assert.equal(up.trend.tone, "up");
  assert.equal(up.trend.deltaText, "+8 pts · 3 obs", "a rise carries its sign");

  const flat = progressView(
    served({ history: { ...served().history, delta: 0 } }),
    { now: NOW },
  );
  assert.equal(flat.trend.direction, "flat");
  assert.equal(flat.trend.tone, "up", "flat is not a warning");
});

test("one observation is a level, not a trend, and says so", () => {
  const v = progressView(
    served({
      history: {
        points: [{ t: NOW, percent: 68, carried: false }],
        count: 1,
        totalObservations: 1,
        delta: 0,
        direction: "flat",
        peakPercent: 68,
        regressed: false,
        regressedBy: 0,
        note: "n",
      },
    }),
    { now: NOW },
  );
  assert.equal(v.trend.deltaText, "1 obs · trend from the next update");
  assert.equal(v.trend.regressedText, null);
});

test("a record with no history still shows its percentage — the trend is extra, not a gate", () => {
  const v = progressView(served({ history: undefined }), { now: NOW });
  assert.equal(v.visible, true);
  assert.equal(v.percentText, "68%");
  assert.equal(
    v.trend,
    null,
    "no history means no trend, not a fabricated one",
  );
});

test("a missing or junk remaining list degrades to no list, never to a wrong count", () => {
  for (const remaining of [undefined, null, "not an array", 7, {}]) {
    const v = progressView(served({ remaining }), { now: NOW });
    assert.equal(v.visible, true);
    assert.equal(v.remainingCount, 0);
    assert.deepEqual(v.remaining, []);
    assert.equal(v.remainingLabel, "nothing listed as remaining");
  }
  // Blank and non-string entries are dropped, and the count follows the list
  // that is actually rendered rather than the raw array's length.
  const mixed = progressView(
    served({ remaining: ["real item", "", "   ", null, 42, "second item"] }),
    { now: NOW },
  );
  assert.deepEqual(mixed.remaining, ["real item", "second item"]);
  assert.equal(mixed.remainingCount, 2);
  assert.equal(mixed.remainingLabel, "2 remaining");
});
