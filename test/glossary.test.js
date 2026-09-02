import test from "node:test";
import assert from "node:assert/strict";

import { KINDS, buildGlossary, glossaryPayload } from "../lib/glossary.js";
import {
  AGENT_SWARM,
  FLEET_BURN_FLOOR,
  LIVE_MS,
  RUNAWAY_MINUTES,
  RUNAWAY_MULTIPLE,
  STALL_MS,
} from "../lib/state.js";
import {
  STALL_FLOOR_TOKENS,
  STALL_WINDOW_MS,
  DEADHEAD_MS,
} from "../lib/stall.js";
import {
  CACHE_READ_MULT,
  PRICE_TABLE_DATE,
  PRICE_TABLE_EXPIRY,
} from "../lib/prices.js";
import { livenessRule } from "../lib/liveness.js";
import { REGISTRY_STALE_MS } from "../lib/ingest.js";

/** Everything the page can point at must resolve to a definition. */
const REFERENCED_BY_THE_PAGE = [
  "liveness",
  "UNKNOWN",
  "STALE",
  "health",
  "NOMINAL",
  "BURNING",
  "ATTENTION",
  "STALLED",
  "DEADHEAD",
  "cost",
  "cache-read",
  "cache-write",
  "input",
  "output",
  "classes",
  "5m",
  "sigma",
  "burn-units",
  "period",
  "dedup",
  "progress",
  "attribution",
  "authorship",
  "roster",
  "cold",
  "redaction",
];

test("every term the page points at exists, exactly once", () => {
  const g = buildGlossary({});
  const ids = g.entries.map((e) => e.id);
  for (const id of REFERENCED_BY_THE_PAGE) {
    assert.ok(
      ids.includes(id),
      "the page can point at " + id + " and nothing defines it",
    );
  }
  assert.equal(new Set(ids).size, ids.length, "a term is defined twice");
});

test("every entry has a term, a kind, a one-line answer and a derivation", () => {
  for (const entry of buildGlossary({}).entries) {
    // "Σ" is one character and is a perfectly good term.
    assert.ok(entry.term && entry.term.length >= 1, entry.id + " has no term");
    assert.ok(
      KINDS[entry.kind],
      entry.id + " has an unknown kind: " + entry.kind,
    );
    assert.ok(
      entry.short && entry.short.length > 20,
      entry.id + " has no short answer",
    );
    assert.ok(
      entry.body && entry.body.length > 40,
      entry.id + " has no derivation",
    );
  }
});

/**
 * The rule that keeps this honest. Prose that restates a threshold drifts away
 * from the code the day someone tunes the constant, so every threshold quoted
 * here is interpolated from the module that enforces it — and these assertions
 * fail the moment the two disagree.
 */
test("the health-banner definition quotes the constants that actually enforce it", () => {
  const health = buildGlossary({ fleetThreshold: 750_000 }).entries.find(
    (e) => e.id === "health",
  );
  assert.match(
    health.body,
    new RegExp(String(Math.round(LIVE_MS / 60_000)) + " minutes", "u"),
  );
  assert.match(
    health.body,
    new RegExp(String(Math.round(STALL_WINDOW_MS / 60_000)) + " minutes", "u"),
  );
  assert.match(health.body, /750k tokens per 5 minutes/u);
  // A live threshold is a short, readable figure, not a raw division: the
  // reference quoted "22.955036M tokens per 5 minutes" on screen.
  const live = buildGlossary({ fleetThreshold: 22_955_036 }).entries.find(
    (e) => e.id === "health",
  );
  assert.match(live.body, /22\.96M tokens per 5 minutes/u);
  assert.match(
    health.body,
    new RegExp(String(FLEET_BURN_FLOOR / 1e3) + "k", "u"),
  );
  // All five words the banner can show are defined in one place.
  for (const word of ["ATTENTION", "STALLED", "BURNING", "NOMINAL", "IDLE"]) {
    assert.match(
      health.body,
      new RegExp("^" + word + " —", "mu"),
      word + " is undefined",
    );
  }
});

/**
 * LIVE is a primary roster state, so its measurement rule must be discoverable
 * from the state header and sourced from the same implementation that enforces
 * it.
 */
test("the liveness rule is in the glossary, interpolated from its own constants", () => {
  const g = buildGlossary({});
  const entry = g.entries.find((e) => e.id === "liveness");
  const rule = livenessRule();
  assert.equal(entry.short, rule.short, "the glossary paraphrased the rule");
  assert.equal(entry.body, rule.body);
  assert.match(
    entry.body,
    new RegExp(
      "written to within " + String(Math.round(LIVE_MS / 60_000)) + " minutes",
      "u",
    ),
  );
  // Every word the STATE column can print is defined in the one entry.
  for (const word of ["LIVE", "WARM", "UNKNOWN", "STALE", "COLD"]) {
    assert.match(
      entry.body,
      new RegExp("^" + word + " —", "mu"),
      word + " is undefined",
    );
  }
  assert.match(entry.body, /Only the measured states/u);

  // STALE and STALL are one letter apart and mean opposite things; the entry
  // that could be misread has to say so itself.
  const stale = g.entries.find((e) => e.id === "STALE");
  assert.equal(stale.kind, "declared");
  assert.match(stale.body, /STALE is not STALL/u);
  assert.match(
    stale.body,
    new RegExp(
      String(Math.round(REGISTRY_STALE_MS / 60_000)) + " minutes",
      "u",
    ),
  );

  const unknown = g.entries.find((e) => e.id === "UNKNOWN");
  assert.equal(unknown.kind, "declared");
  assert.match(unknown.short, /not measured/u);
  assert.match(unknown.body, /never promoted to this column/u);
});

test("the live threshold in force is stated numerically, not described", () => {
  const burning = buildGlossary({ fleetThreshold: 17_240_133 }).entries.find(
    (e) => e.id === "BURNING",
  );
  assert.match(burning.body, /17,240,133 tokens per 5 minutes/u);
});

test("ATTENTION names every one of its triggers with its own threshold", () => {
  const entry = buildGlossary({}).entries.find((e) => e.id === "ATTENTION");
  assert.match(
    entry.body,
    new RegExp(RUNAWAY_MULTIPLE + "× its own median", "u"),
  );
  assert.match(
    entry.body,
    new RegExp(RUNAWAY_MINUTES + " consecutive minutes", "u"),
  );
  assert.match(
    entry.body,
    new RegExp("more than " + AGENT_SWARM + " sub-agents", "u"),
  );
  assert.match(
    entry.body,
    new RegExp(String(STALL_MS / 60_000) + " minutes", "u"),
  );
});

test("STALLED and DEADHEAD quote their own floors and windows", () => {
  const g = buildGlossary({});
  const stalled = g.entries.find((e) => e.id === "STALLED");
  assert.match(
    stalled.body,
    new RegExp(STALL_FLOOR_TOKENS.toLocaleString(), "u"),
  );
  const deadhead = g.entries.find((e) => e.id === "DEADHEAD");
  assert.match(
    deadhead.body,
    new RegExp(String(DEADHEAD_MS / 60_000) + " minutes", "u"),
  );
});

/**
 * The three questions the owner asked out loud. Each answer must be present and
 * must be the ANSWER, not a restatement of the label.
 */
test("cache read explains why it is most of the tokens and little of the cost", () => {
  const entry = buildGlossary({}).entries.find((e) => e.id === "cache-read");
  assert.equal(entry.kind, "measured");
  assert.match(
    entry.short,
    new RegExp(CACHE_READ_MULT + "× the input rate", "u"),
  );
  assert.match(entry.body, /largest token class/u);
  assert.match(entry.body, /smallest cost classes/u);
  assert.match(entry.body, /cache WORKING, not a leak/u);
});

test("cost says outright that it is not the subscription bill", () => {
  const entry = buildGlossary({}).entries.find((e) => e.id === "cost");
  assert.equal(entry.kind, "estimated");
  assert.match(entry.short, /NOT your subscription bill/u);
  assert.match(entry.body, new RegExp(PRICE_TABLE_DATE, "u"));
  assert.match(entry.body, new RegExp(PRICE_TABLE_EXPIRY, "u"));
  assert.match(entry.body, /not for reconciling an invoice/u);
});

test("the progress percentage is labelled a judgement and allowed to fall", () => {
  const entry = buildGlossary({}).entries.find((e) => e.id === "progress");
  assert.equal(entry.kind, "declared");
  assert.match(entry.short, /Not measured, and it can go down/u);
  assert.match(entry.body, /never computes it/u);
  assert.match(entry.body, /moved backwards/u);
});

test("Σ says both what it means and why it is never summed", () => {
  const entry = buildGlossary({}).entries.find((e) => e.id === "sigma");
  assert.match(entry.short, /never added into a period or daily total/u);
  assert.match(entry.body, /Σ no table/u);
});

test("the payload is plain JSON — no functions survive serialization", () => {
  const payload = glossaryPayload({ fleetThreshold: 1 });
  const round = JSON.parse(JSON.stringify(payload));
  assert.deepEqual(
    round,
    payload,
    "something in the glossary did not survive JSON",
  );
  assert.ok(round.entries.length >= REFERENCED_BY_THE_PAGE.length);
  assert.deepEqual(Object.keys(round.kinds).sort(), Object.keys(KINDS).sort());
});

/**
 * Called with no live instrument at all — which is what the very first paint
 * after a restart looks like. A definition that reads "the threshold is NaN"
 * is worse than no definition, because it makes the whole panel look broken.
 */
test("a missing threshold degrades to the floor rather than printing NaN", () => {
  for (const entry of buildGlossary().entries) {
    for (const field of ["short", "body"]) {
      assert.ok(
        !/\b(?:NaN|Infinity)\b/u.test(entry[field]),
        entry.id + "." + field + ": " + entry[field],
      );
    }
  }
  const health = buildGlossary().entries.find((e) => e.id === "health");
  assert.match(health.body, /no median yet, so the floor applies/u);
  assert.match(health.body, /0 tokens per 5 minutes/u);
});
