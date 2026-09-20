import test from "node:test";
import assert from "node:assert/strict";

import {
  costOf,
  costSplit,
  isPriceTableExpired,
  priceFor,
  sumTokens,
  zeroTokens,
  CACHE_READ_MULT,
  CACHE_WRITE_1H_MULT,
  CACHE_WRITE_5M_MULT,
  PRICE_TABLE_EXPIRY,
} from "../lib/prices.js";

const DAY = "2026-08-30";

test("the four token classes are priced separately, each at its own rate", () => {
  const tokens = {
    in: 1_000_000,
    out: 1_000_000,
    cr: 1_000_000,
    cw: 1_000_000,
    cw1h: 0,
  };
  const split = costSplit("claude-opus-5", tokens, DAY);
  // opus-5: $5.00 input, $25.00 output per million.
  assert.equal(split.in, 5);
  assert.equal(split.out, 25);
  assert.equal(split.cw, 5 * CACHE_WRITE_5M_MULT);
  assert.equal(split.cr, 5 * CACHE_READ_MULT);
  assert.equal(costOf("claude-opus-5", tokens, DAY), 5 + 25 + 6.25 + 0.5);
});

test("a blended rate would be wrong: cache reads are most of the tokens and a minority of the cost", () => {
  // A representative cache-heavy usage shape.
  const tokens = {
    in: 19_358,
    out: 8_211_914,
    cr: 1_827_950_835,
    cw: 24_725_710,
    cw1h: 0,
  };
  const split = costSplit("claude-opus-5", tokens, DAY);
  const total = split.in + split.out + split.cw + split.cr;
  const readShareOfTokens = tokens.cr / sumTokens(tokens);
  const readShareOfCost = split.cr / total;
  assert.ok(readShareOfTokens > 0.97, "fixture is not representative");
  assert.ok(
    readShareOfCost < 0.85 && readShareOfCost > 0.6,
    "cost share moved unexpectedly",
  );
  // A single blended number would misstate this by a factor of several.
  const blended = (sumTokens(tokens) * 5) / 1e6;
  assert.ok(blended > total * 3, "the blended figure should be badly wrong");
});

test("one-hour cache writes bill at 2.0x input, not the 1.25x of five-minute writes", () => {
  const all5m = { in: 0, out: 0, cr: 0, cw: 1_000_000, cw1h: 0 };
  const all1h = { in: 0, out: 0, cr: 0, cw: 1_000_000, cw1h: 1_000_000 };
  const five = costOf("claude-opus-5", all5m, DAY);
  const hour = costOf("claude-opus-5", all1h, DAY);
  assert.equal(five, 5 * CACHE_WRITE_5M_MULT);
  assert.equal(hour, 5 * CACHE_WRITE_1H_MULT);
  assert.ok(hour > five, "the 1h rate must cost more than the 5m rate");

  // A real mix: today's measured split across models was ~12% one-hour.
  const mixed = { in: 0, out: 0, cr: 0, cw: 24_921_371, cw1h: 2_939_275 };
  const aware = costOf("claude-opus-5", mixed, DAY);
  const flat = (mixed.cw * 5 * CACHE_WRITE_5M_MULT) / 1e6;
  assert.ok(aware > flat, "the ephemeral split made no difference — it should");
});

test("cw1h is a subset of cw and is never added to the token total twice", () => {
  const tokens = { in: 0, out: 0, cr: 0, cw: 1000, cw1h: 1000 };
  assert.equal(sumTokens(tokens), 1000);
});

test("a cw1h larger than cw is clamped rather than trusted", () => {
  const tokens = { in: 0, out: 0, cr: 0, cw: 100, cw1h: 5000 };
  const split = costSplit("claude-opus-5", tokens, DAY);
  assert.equal(split.cw, (100 * 5 * CACHE_WRITE_1H_MULT) / 1e6);
});

test("Sonnet 5 keeps the launch rate Anthropic made standard", () => {
  assert.deepEqual(priceFor("claude-sonnet-5", "2026-08-31"), {
    from: null,
    input: 2,
    output: 10,
  });
  assert.deepEqual(priceFor("claude-sonnet-5", "2026-09-01"), {
    from: null,
    input: 2,
    output: 10,
  });
  const tokens = { in: 1_000_000, out: 0, cr: 0, cw: 0, cw1h: 0 };
  assert.equal(costOf("claude-sonnet-5", tokens, "2026-08-31"), 2);
  assert.equal(costOf("claude-sonnet-5", tokens, "2026-09-01"), 2);
});

test("canonical dated 4.5 IDs are priced as well as their aliases", () => {
  const tokens = { in: 1_000_000, out: 1_000_000, cr: 0, cw: 0, cw1h: 0 };
  assert.equal(costOf("claude-haiku-4-5-20251001", tokens, DAY), 6);
  assert.equal(costOf("claude-haiku-4-5", tokens, DAY), 6);
  assert.equal(costOf("claude-sonnet-4-5-20250929", tokens, DAY), 18);
  assert.equal(costOf("claude-opus-4-5-20251101", tokens, DAY), 30);
});

test("an unpriced model reports null, never a silent zero", () => {
  const tokens = { in: 1_000_000, out: 1_000_000, cr: 0, cw: 0, cw1h: 0 };
  assert.equal(priceFor("claude-something-unreleased", DAY), null);
  assert.equal(costOf("claude-something-unreleased", tokens, DAY), null);
  assert.equal(costSplit("claude-something-unreleased", tokens, DAY), null);
});

test("an empty bucket costs nothing and sums to nothing", () => {
  const zero = zeroTokens();
  assert.equal(sumTokens(zero), 0);
  assert.equal(costOf("claude-opus-5", zero, DAY), 0);
});

test("the table warns only after its scheduled review date", () => {
  assert.equal(PRICE_TABLE_EXPIRY, "2026-12-01");
  assert.equal(isPriceTableExpired("2026-09-01"), false);
  assert.equal(isPriceTableExpired("2026-12-01"), false);
  assert.equal(isPriceTableExpired("2026-12-02"), true);
  assert.equal(isPriceTableExpired("2027-01-01"), true);
  assert.equal(isPriceTableExpired(null), false, "no day is not an expiry");
});


test("Fable and Mythos 5.1 use their own lower cache-read rate", () => {
  const tokens = { in: 1e6, out: 1e6, cr: 1e6, cw: 1e6, cw1h: 0 };
  for (const model of ["claude-fable-5-1", "claude-mythos-5-1"]) {
    assert.deepEqual(costSplit(model, tokens, "2026-09-20"), {
      in: 10, out: 50, cr: 0.25, cw: 12.5,
    });
    assert.equal(costOf(model, tokens, "2026-09-20"), 72.75);
  }
  assert.equal(costSplit("claude-fable-5", tokens, "2026-09-20").cr, 1);
});
