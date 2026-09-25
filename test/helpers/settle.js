/**
 * What a receiver keeps from a stream of collector records (docs/accounting.md
 * §2): the first record for an id, except a `cumulative` record, whose amounts
 * are a message's running per-class maximum: for those the largest reading per
 * class is kept. The result is one row per id, with `continuation` false on the
 * first reading of each message.
 */
const RUNNING = ['fresh', 'output', 'cacheWrite', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

export function settle(records) {
  const kept = new Map();
  for (const record of records) {
    const held = kept.get(record.id);
    if (!held) { kept.set(record.id, { ...record, continuation: record.cumulative === true ? false : record.continuation }); continue; }
    if (record.cumulative !== true) continue;
    for (const key of RUNNING) {
      if (Number.isSafeInteger(record[key]) && (!Number.isSafeInteger(held[key]) || record[key] > held[key])) held[key] = record[key];
    }
  }
  return [...kept.values()];
}

export function totals(records) {
  const rows = settle(records);
  const sum = (key) => rows.reduce((a, r) => a + (r[key] ?? 0), 0);
  return { fresh: sum('fresh'), output: sum('output'), cacheWrite: sum('cacheWrite'), cacheRead: sum('cacheRead'),
    messages: rows.filter((r) => !r.continuation).length };
}
