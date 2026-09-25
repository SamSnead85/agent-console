/** Correlate observed spend and local Git counts in the same time window. */
export function costPerOutcome({ usd, pricedMessages, unpricedMessages, commits, defaultMerges }) {
  const priced = Number.isSafeInteger(pricedMessages) && pricedMessages >= 0 ? pricedMessages : 0;
  const unpriced = Number.isSafeInteger(unpricedMessages) && unpricedMessages >= 0 ? unpricedMessages : 0;
  const status = priced + unpriced === 0 ? 'no-usage'
    : unpriced > 0 ? (priced > 0 ? 'partial' : 'unpriced') : 'estimated';
  const amount = status === 'estimated' && Number.isFinite(usd) && usd >= 0 ? usd : null;
  const ratio = (count) => amount !== null && Number.isSafeInteger(count) && count > 0 ? amount / count : null;
  return {
    status,
    perCommitUsd: ratio(commits),
    perDefaultMergeUsd: ratio(defaultMerges),
    defaultMerges: Number.isSafeInteger(defaultMerges) && defaultMerges >= 0 ? defaultMerges : null,
  };
}
