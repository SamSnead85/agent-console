/** Counts of retained alerts, scoped to the console's local calendar day. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KINDS = ["loop", "spike", "stall"];
const pad = (n) => String(n).padStart(2, "0");

export function localDayOf(ms) {
  const d = new Date(ms);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    from: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() };
}

/**
 * The alert list is bounded and held in memory. Its size cannot establish a
 * complete daily or hourly total, including after a restart. Keep that scope
 * explicit until a durable, idempotent alert ledger is available.
 */
export function alertsTodayOf(rows, now) {
  const day = localDayOf(now);
  let tz;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { tz = "UTC"; }
  const kept = rows.filter((a) => a.at >= day.from && a.at <= now + 2 * MINUTE);
  return { ...day, tz, since: null, count: kept.length, kept: kept.length,
    byKind: Object.fromEntries(KINDS.map((kind) => [kind, kept.filter((a) => a.kind === kind).length])),
    lastHour: rows.filter((a) => !a.historical && a.at >= now - HOUR && a.at <= now + 2 * MINUTE).length,
    exact: false };
}
