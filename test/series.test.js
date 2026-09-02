import test from "node:test";
import assert from "node:assert/strict";

import {
  addSample,
  createSeries,
  MINUTE,
  window,
} from "../lib/series.js";

const NOW = 1_788_000_000_000;

test("an unpriced sample makes that minute's cost unknown, never zero", () => {
  const series = createSeries();
  addSample(series, NOW, 1_000, null);
  const [minute] = window(series, NOW, 1);
  assert.equal(minute.tokens, 1_000);
  assert.equal(minute.cost, null);
});

test("mixed priced and unpriced work remains unknown while tokens still add", () => {
  const series = createSeries();
  addSample(series, NOW, 1_000, 0.25);
  addSample(series, NOW + 10_000, 2_000, null);
  addSample(series, NOW + 20_000, 3_000, 0.5);
  const [minute] = window(series, NOW, 1);
  assert.equal(minute.tokens, 6_000);
  assert.equal(minute.cost, null);
});

test("a minute with only verified prices retains its cost", () => {
  const series = createSeries();
  addSample(series, NOW, 1_000, 0.25);
  addSample(series, NOW + 10_000, 2_000, 0.5);
  const [minute] = window(series, NOW, 1);
  assert.equal(minute.tokens, 3_000);
  assert.equal(minute.cost, 0.75);

  const [empty] = window(series, NOW + MINUTE, 1);
  assert.equal(empty.tokens, 0);
  assert.equal(empty.cost, 0);
});
