/** Context and cache signals from privacy-safe usage counts. No I/O. */
const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
const valid = (n) => Number.isSafeInteger(n) && n >= 0;

function lifetimeOf(sample) {
  if (!valid(sample.cacheWrite) || sample.cacheWrite === 0
      || !valid(sample.cacheWrite5m) || !valid(sample.cacheWrite1h)
      || sample.cacheWrite5m + sample.cacheWrite1h !== sample.cacheWrite) return null;
  if (sample.cacheWrite5m > 0 && sample.cacheWrite1h === 0) return FIVE_MINUTES;
  if (sample.cacheWrite1h > 0 && sample.cacheWrite5m === 0) return ONE_HOUR;
  return null;
}

function extraWriteCost(sample, table) {
  const rates = table?.rows?.find((r) => r.model === sample.model);
  if (!rates || !valid(sample.cacheWrite) || !Number.isFinite(rates.cacheRead)) return null;
  const split = valid(sample.cacheWrite5m) && valid(sample.cacheWrite1h)
    && sample.cacheWrite5m + sample.cacheWrite1h === sample.cacheWrite;
  const write = split
    ? sample.cacheWrite5m * rates.cacheWrite5m + sample.cacheWrite1h * rates.cacheWrite1h
    : sample.cacheWrite * rates.cacheWrite;
  if (!Number.isFinite(write)) return null;
  return Math.max(0, (write - sample.cacheWrite * rates.cacheRead) / 1_000_000);
}

/**
 * Analyze ordered session usage samples without reading logs or exposing content.
 * `samples`: {at,tokens,cacheRead,cacheWrite,cacheWrite5m,cacheWrite1h,model}[]
 * `prices`: {version,checkedOn,rows:[{model,cacheRead,cacheWrite,cacheWrite5m,cacheWrite1h}]}
 */
export function contextHealth(samples, prices, { bloatTokens = 160_000 } = {}) {
  const ordered = samples.filter((s) => valid(s.tokens) && valid(s.cacheRead) && valid(s.cacheWrite))
    .slice().sort((a, b) => a.at - b.at);
  if (!ordered.length) return { status: 'unknown', latest: null, growth: null, samples: [], breaks: [], priceTable: null };
  const latest = ordered.at(-1).tokens;
  const first = ordered[0].tokens;
  const growth = ordered.length > 1 && first > 0 ? latest / first : null;
  const breaks = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1], current = ordered[i];
    if (current.cacheWrite === 0 || current.cacheRead >= previous.cacheRead) continue;
    const gap = current.at - previous.at;
    const lifetime = lifetimeOf(previous);
    const kind = lifetime !== null && gap > lifetime ? 'idle-gap'
      : lifetime === null && gap > FIVE_MINUTES ? 'lifetime-unknown'
        : current.cacheWrite >= previous.tokens / 2 ? 'possible-prefix-rewrite' : null;
    if (!kind) continue;
    breaks.push({ kind, at: current.at, gapMinutes: Math.round(gap / 60_000),
      estimatedExtraUsd: extraWriteCost(current, prices) });
  }
  const bloated = latest >= bloatTokens || (latest >= 80_000 && growth !== null && growth >= 2);
  return {
    status: bloated ? 'bloated' : 'normal', latest, growth,
    samples: ordered.slice(-16).map((s) => ({ at: s.at, tokens: s.tokens })),
    breaks: breaks.slice(-8),
    priceTable: { version: prices?.version ?? null, checkedOn: prices?.checkedOn ?? null },
  };
}
