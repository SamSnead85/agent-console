const TOOLS = new Set(['claude-code', 'codex']);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const freeze = value => {
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};

/** Fixed portable context; reporting device never changes intrinsic identity. */
export function eventMeasurement(record) {
  return freeze({ provenance: 'deviceReported',
    population: { kind: 'usageEvent', recordId: record.id, sessionHash: record.sessionHash },
    window: { kind: 'event', at: record.at },
    source: { kind: 'localTranscript', tool: record.tool } });
}

/** No event IDs, session IDs or paths enter an aggregate descriptor. */
export function usageMeasurement(records, scope = {}) {
  let firstObservedAt = null, lastObservedAt = null;
  const tools = new Set();
  for (const row of records) {
    const at = iso(row?.at);
    if (at !== null && (firstObservedAt === null || at < firstObservedAt)) firstObservedAt = at;
    if (at !== null && (lastObservedAt === null || at > lastObservedAt)) lastObservedAt = at;
    if (TOOLS.has(row?.tool)) tools.add(row.tool);
  }
  return freeze({ provenance: 'deviceReported',
    population: { kind: scope.population?.kind ?? 'suppliedRecords', records: records.length },
    window: scope.window ?? { kind: 'observedEvents', firstObservedAt, lastObservedAt, timeZone: 'UTC' },
    source: { kind: 'localTranscripts', tools: [...tools].sort() } });
}
export function localDayScope(now = new Date()) {
  const from = new Date(now); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 1);
  return freeze({ population: { kind: 'thisDevice' }, window: { kind: 'calendarDay',
    from: from.toISOString(), to: to.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
}
export function estimateMeasurement(records, rates, scope = {}) {
  const usage = usageMeasurement(records, scope);
  const unique = new Map(rates.filter(Boolean).map(rate => [JSON.stringify(rate), rate]));
  return freeze({ provenance: 'estimate', population: usage.population, window: usage.window,
    source: { kind: 'publishedApiRates', basis: 'standard-global-api-equivalent',
      usage: usage.source, rates: [...unique.values()].sort((a, b) => a.model.localeCompare(b.model)) } });
}
export function coverageMeasurement(roots, now = new Date(), enrolled = false) {
  return freeze({ provenance: 'deviceReported',
    population: { kind: 'thisDevice', unit: 'devices reporting', enrolledCount: null },
    window: { kind: 'collectorSnapshot', at: now.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      parserDebt: enrolled ? 'currentCursorHistory' : 'availableLocalHistory' },
    source: { kind: 'localCollectorState', tools: [...new Set(roots.map(root => root.tool).filter(tool => TOOLS.has(tool)))].sort() } });
}
export function syncMeasurement(now = new Date()) {
  return freeze({ provenance: 'deviceReported', population: { kind: 'thisDevice' },
    window: { kind: 'syncAttempt', at: now.toISOString() }, source: { kind: 'localCollectorState' } });
}
