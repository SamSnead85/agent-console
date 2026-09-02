/**
 * Per-minute token/cost ring buffer.
 *
 * The burn band and every "N x normal" threshold need history, and the raw
 * event list is pruned to a few minutes. This bucket store is filled at ingest
 * from the timestamp already parsed off each line, so it costs one map lookup
 * per response and no second pass over the transcripts. Cost is nullable:
 * once any contributing sample lacks a trustworthy rate, that minute is
 * explicitly unpriced instead of letting an unknown contribution masquerade
 * as zero dollars.
 *
 * Buckets are keyed by absolute minute number so a bucket is never mistaken for
 * a neighbouring one across a restart or a clock change.
 */

export const MINUTE = 60_000;
const DEFAULT_SLOTS = 180; // three hours

export function createSeries(slots) {
  return { slots: slots || DEFAULT_SLOTS, buckets: new Map() };
}

export function addSample(series, timestampMs, tokens, costUsd) {
  const minute = Math.floor(timestampMs / MINUTE);
  let bucket = series.buckets.get(minute);
  if (!bucket) {
    bucket = { minute, tokens: 0, cost: 0, costKnown: true };
    series.buckets.set(minute, bucket);
    if (series.buckets.size > series.slots * 2) prune(series, minute);
  }
  bucket.tokens += tokens || 0;
  if (Number.isFinite(costUsd)) bucket.cost += costUsd;
  else bucket.costKnown = false;
}

function prune(series, newestMinute) {
  const oldest = newestMinute - series.slots;
  for (const key of series.buckets.keys()) {
    if (key < oldest) series.buckets.delete(key);
  }
}

/** Dense array of the last `count` minutes ending at the minute containing `now`. */
export function window(series, now, count) {
  const end = Math.floor(now / MINUTE);
  const out = [];
  for (let m = end - count + 1; m <= end; m += 1) {
    const b = series.buckets.get(m);
    out.push({
      minute: m,
      tokens: b ? b.tokens : 0,
      cost: b ? (b.costKnown ? b.cost : null) : 0,
    });
  }
  return out;
}

/** Tokens in the trailing `ms` milliseconds, from whole minute buckets. */
export function recent(series, now, ms) {
  const count = Math.max(1, Math.round(ms / MINUTE));
  let total = 0;
  for (const b of window(series, now, count)) total += b.tokens;
  return total;
}

export function median(values) {
  const list = values
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (list.length === 0) return 0;
  const mid = list.length >> 1;
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** Median of the last `count` complete minutes — the self-calibrating baseline. */
export function medianPerMinute(series, now, count) {
  const buckets = window(series, now, count + 1);
  buckets.pop(); // the current minute is still filling; it is not a sample yet
  return median(buckets.map((b) => b.tokens));
}
