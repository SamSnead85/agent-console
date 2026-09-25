/** Stateful alert rules as a pure reducer over sanitized, count-only events. */
const MINUTE = 60_000;

export function emptyAlertState() {
  return { repeated: null, repeatCount: 0, usage: [], firstSpendAt: null,
    lastSuccessAt: null, spentSinceSuccess: 0, lastStallAt: null };
}

/**
 * `event`: {kind,sessionHash,at,sourceAt,callHash?,tokens?}.
 * `sessionHash` and `callHash` must be salted hashes made by the caller.
 * Returns a new state and zero or more count-only signals, without I/O.
 */
export function analyzeAlertEvent(previous, event, { repeat = 5, spikeFactor = 3, stallMinutes = 5 } = {}) {
  const state = {
    repeated: previous.repeated, repeatCount: previous.repeatCount,
    usage: previous.usage.slice(), firstSpendAt: previous.firstSpendAt,
    lastSuccessAt: previous.lastSuccessAt, spentSinceSuccess: previous.spentSinceSuccess,
    lastStallAt: previous.lastStallAt,
  };
  const signals = [];
  const signal = (kind, tokens) => signals.push({ kind, sessionHash: event.sessionHash,
    at: event.at, sourceAt: event.sourceAt ?? null, tokens });
  if (event.kind === 'call' && typeof event.callHash === 'string') {
    state.repeatCount = state.repeated === event.callHash ? state.repeatCount + 1 : 1;
    state.repeated = event.callHash;
    if (state.repeatCount >= repeat && state.repeatCount % repeat === 0) signal('loop', state.repeatCount);
  } else if (event.kind === 'success') {
    state.lastSuccessAt = event.at;
    state.spentSinceSuccess = 0;
  } else if (event.kind === 'usage' && Number.isSafeInteger(event.tokens) && event.tokens > 0) {
    if (state.firstSpendAt === null) state.firstSpendAt = event.at;
    const prior = state.usage.slice(-10).sort((a, b) => a - b);
    const baseline = prior.length >= 5 ? prior[Math.floor(prior.length / 2)] : null;
    if (baseline && event.tokens >= 50_000 && event.tokens >= baseline * spikeFactor) signal('spike', event.tokens);
    state.usage.push(event.tokens);
    if (state.usage.length > 32) state.usage.shift();
    state.spentSinceSuccess += event.tokens;
    const since = state.lastSuccessAt ?? state.firstSpendAt;
    if (event.at - since >= stallMinutes * MINUTE && state.spentSinceSuccess >= 500_000
      && (state.lastStallAt === null || event.at - state.lastStallAt >= stallMinutes * MINUTE)) {
      state.lastStallAt = event.at;
      signal('stall', state.spentSinceSuccess);
    }
  }
  return { state, signals };
}
