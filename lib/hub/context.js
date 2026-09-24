/** Context and cache signals from already allowlisted usage counts. */
const FIVE_MINUTES = 5 * 60_000;
const valid = (n) => Number.isSafeInteger(n) && n >= 0;

function extraWriteCost(sample, table) {
  const row = table?.rows?.find((r) => r.model === sample.model && r.status === 'verified');
  if (!row || !valid(sample.cacheWrite) || !Number.isFinite(row.usdPerMillion?.cacheRead)) return null;
  const rates = row.usdPerMillion;
  const split = valid(sample.cacheWrite5m) && valid(sample.cacheWrite1h)
    && sample.cacheWrite5m + sample.cacheWrite1h === sample.cacheWrite;
  const write = split
    ? sample.cacheWrite5m * rates.cacheWrite5m + sample.cacheWrite1h * rates.cacheWrite1h
    : sample.cacheWrite * rates.cacheWrite;
  if (!Number.isFinite(write)) return null;
  return Math.max(0, (write - sample.cacheWrite * rates.cacheRead) / 1_000_000);
}

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
    const kind = gap > FIVE_MINUTES ? 'idle-gap' : current.cacheWrite >= previous.tokens / 2 ? 'possible-prefix-rewrite' : null;
    if (!kind) continue;
    breaks.push({ kind, at: current.at, gapMinutes: Math.round(gap / 60_000),
      estimatedExtraUsd: extraWriteCost(current, prices) });
  }
  const bloated = latest >= bloatTokens || (latest >= 80_000 && growth !== null && growth >= 2);
  return {
    status: bloated ? 'bloated' : 'normal', latest, growth,
    samples: ordered.slice(-16).map((s) => ({ at: s.at, tokens: s.tokens })),
    breaks: breaks.slice(-8),
    priceTable: { version: prices?.v ?? null, checkedOn: prices?.inventoryCheckedOn ?? null },
  };
}
