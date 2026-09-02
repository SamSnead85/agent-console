/**
 * PRICE TABLE — USD per 1,000,000 tokens. EDIT HERE if rates change.
 *
 * Source: Anthropic published API pricing, verified 2026-09-01.
 * Cache multipliers are the published ratios: 5-minute writes 1.25x input,
 * 1-hour writes 2.00x input, reads 0.10x input.
 *
 * Every dollar figure this program produces is an ESTIMATE derived from this
 * table. Neither vendor writes cost to disk, so there is nothing to read.
 *
 * Entries are effective-dated. A rate that is known to change on a date gets a
 * second row rather than a comment, so the table cannot silently go stale the
 * morning the introductory price ends.
 */

export const PRICE_TABLE_SOURCE = "Anthropic published API pricing";
export const PRICE_TABLE_DATE = "2026-09-01";

/**
 * Review deadline for the table. Anthropic made the Claude Sonnet 5 launch rate
 * ($2/$10 per MTok) its standard rate on 2026-09-01; the previously announced
 * increase did not take effect. The published rates have no scheduled expiry,
 * so the UI requests a fresh primary-source review after 90 days rather than
 * turning yellow the day after verification. Do not move this date without
 * re-verifying every row against the primary source.
 */
export const PRICE_TABLE_EXPIRY = "2026-12-01";

/** True once the local day is past the table's explicit review deadline. */
export function isPriceTableExpired(day) {
  return typeof day === "string" && day > PRICE_TABLE_EXPIRY;
}

/** Cost multipliers relative to the model's own input rate. */
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2.0;
export const CACHE_READ_MULT = 0.1;

/**
 * model -> array of effective-dated rate rows, newest last.
 * `from` is the first local day (YYYY-MM-DD) the row applies to; null = always.
 */
export const PRICES = {
  "claude-fable-5": [{ from: null, input: 10.0, output: 50.0 }],
  "claude-mythos-5": [{ from: null, input: 10.0, output: 50.0 }],
  "claude-opus-5": [{ from: null, input: 5.0, output: 25.0 }],
  "claude-opus-4-8": [{ from: null, input: 5.0, output: 25.0 }],
  "claude-opus-4-7": [{ from: null, input: 5.0, output: 25.0 }],
  "claude-opus-4-6": [{ from: null, input: 5.0, output: 25.0 }],
  "claude-sonnet-5": [{ from: null, input: 2.0, output: 10.0 }],
  "claude-sonnet-4-6": [{ from: null, input: 3.0, output: 15.0 }],
  "claude-sonnet-4-5-20250929": [
    { from: null, input: 3.0, output: 15.0 },
  ],
  "claude-sonnet-4-5": [{ from: null, input: 3.0, output: 15.0 }],
  "claude-opus-4-5-20251101": [{ from: null, input: 5.0, output: 25.0 }],
  "claude-opus-4-5": [{ from: null, input: 5.0, output: 25.0 }],
  "claude-haiku-4-5-20251001": [{ from: null, input: 1.0, output: 5.0 }],
  "claude-haiku-4-5": [{ from: null, input: 1.0, output: 5.0 }],
};

/** Rate row in force for `model` on local calendar day `day` (YYYY-MM-DD). */
export function priceFor(model, day) {
  const rows = PRICES[model];
  if (!rows) return null;
  let chosen = null;
  for (const row of rows) {
    if (row.from === null || (day && day >= row.from)) chosen = row;
  }
  return chosen;
}

/** An empty token bucket. `cw1h` is the 1-hour subset of `cw`, not an addition. */
export function zeroTokens() {
  return { in: 0, out: 0, cr: 0, cw: 0, cw1h: 0, think: 0 };
}

export function addTokens(target, source) {
  target.in += source.in || 0;
  target.out += source.out || 0;
  target.cr += source.cr || 0;
  target.cw += source.cw || 0;
  target.cw1h += source.cw1h || 0;
  target.think += source.think || 0;
  return target;
}

/** Billable total. `cw1h` is a subset of `cw` and is deliberately not summed. */
export function sumTokens(t) {
  return (t.in || 0) + (t.out || 0) + (t.cr || 0) + (t.cw || 0);
}

/**
 * Estimated cost of one token bucket, split by class.
 * Returns null when the model has no entry — an unpriced model is reported as
 * unpriced, never silently valued at zero.
 */
export function costSplit(model, t, day) {
  const p = priceFor(model, day);
  if (!p) return null;
  const cw = t.cw || 0;
  const cw1h = Math.min(t.cw1h || 0, cw);
  const cw5m = cw - cw1h;
  return {
    in: ((t.in || 0) * p.input) / 1e6,
    out: ((t.out || 0) * p.output) / 1e6,
    cw:
      (cw5m * p.input * CACHE_WRITE_5M_MULT +
        cw1h * p.input * CACHE_WRITE_1H_MULT) /
      1e6,
    cr: ((t.cr || 0) * p.input * CACHE_READ_MULT) / 1e6,
  };
}

/** Estimated total cost of one token bucket, or null if the model is unpriced. */
export function costOf(model, t, day) {
  const s = costSplit(model, t, day);
  if (!s) return null;
  return s.in + s.out + s.cw + s.cr;
}

export function zeroCost() {
  return { in: 0, out: 0, cw: 0, cr: 0 };
}

export function addCost(target, source) {
  target.in += source.in;
  target.out += source.out;
  target.cw += source.cw;
  target.cr += source.cr;
  return target;
}
