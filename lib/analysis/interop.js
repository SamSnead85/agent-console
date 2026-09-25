/** Separate, privacy-safe views of optional telemetry. No I/O or identity labels. */
const SOURCES = ['otel', 'kong', 'litellm'];
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function summarizeInterop(samples, now = Date.now()) {
  const result = Object.fromEntries(SOURCES.map((source) => [source, { available: false,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, receivedAt: null }]));
  const latest = new Map();
  for (const sample of samples || []) {
    if (!sample || !SOURCES.includes(sample.source) || !KINDS.includes(sample.kind)
      || safeCount(sample.tokens) === null || !Number.isFinite(sample.at)
      || sample.at < now - 86_400_000 || sample.at > now + 60_000) continue;
    const target = result[sample.source];
    target.available = true;
    target.receivedAt = Math.max(target.receivedAt || 0, sample.at);
    if (sample.source === 'otel') target.tokens[sample.kind] += sample.tokens;
    else {
      const key = `${sample.source}|${sample.kind}|${sample.seriesHash || sample.model || ''}`;
      if (!latest.has(key) || latest.get(key).at <= sample.at) latest.set(key, sample);
    }
  }
  for (const sample of latest.values()) result[sample.source].tokens[sample.kind] += sample.tokens;
  for (const [source, value] of Object.entries(result)) {
    value.tokens.total = source === 'otel'
      ? Object.values(value.tokens).reduce((sum, count) => sum + count, 0)
      : value.tokens.input + value.tokens.output;
    if (!value.available) value.tokens = null;
  }
  return result;
}

export function formatInteropMetrics(day, summary) {
  const lines = ['# HELP agent_console_transcript_tokens_last_24h Tokens observed in local and joined transcript reports over 24 hours.',
    '# TYPE agent_console_transcript_tokens_last_24h gauge'];
  for (const [kind, value] of Object.entries({ input: day?.fresh, output: day?.output,
    cache_read: day?.cacheRead, cache_write: day?.cacheWrite })) {
    if (safeCount(value) !== null) lines.push(`agent_console_transcript_tokens_last_24h{kind="${kind}"} ${value}`);
  }
  lines.push('# HELP agent_console_interop_tokens Optional source tokens, kept separate from transcript totals.',
    '# TYPE agent_console_interop_tokens gauge');
  for (const source of SOURCES) {
    const row = summary[source];
    if (!row?.available) continue;
    for (const kind of KINDS) lines.push(`agent_console_interop_tokens{source="${source}",kind="${kind}"} ${row.tokens[kind]}`);
  }
  return lines.join('\n') + '\n';
}
