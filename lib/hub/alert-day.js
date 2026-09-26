/**
 * The day's alert count, exact.
 *
 * The console keeps a bounded list of recent alerts to show (lib/hub/alerts.js
 * keeps 100 for this machine, lib/hub/fleet.js 100 per joined machine). The
 * length of that list is not how many alerts there were today: on a busy day
 * it stops at its cap. This counter is. Every alert this console raises or
 * accepts is counted once here, by the calendar day of its own time on this
 * console's clock, whatever the list still holds.
 *
 * KEPT WITH THE STATE. The count is written to the console's state directory
 * (`alerts-today.json`, mode 0600), at most once a second and on stop, so a
 * restart keeps the day's count. The transcript reader resumes from its
 * cursor and the reporters resend what the console had not acknowledged, so
 * nothing raised while the console was down is lost from the count either.
 *
 * `since` says from when the count is whole: today's midnight when this
 * console has counted since then (or read the transcripts from the start),
 * otherwise the moment counting began — before it, today's alerts are
 * unavailable, never zero.
 */

import fs from "node:fs";
import path from "node:path";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KINDS = ["loop", "spike", "stall"];
const WRITE_EVERY_MS = 1_000;
const MAX_LIVE = 50_000;

const pad = (n) => String(n).padStart(2, "0");
/** The calendar day of `ms` on this console's clock: its date and its midnight. */
export function localDayOf(ms) {
  const d = new Date(ms);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    from: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() };
}
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const emptyKinds = () => Object.fromEntries(KINDS.map((k) => [k, 0]));
const whole = (n) => Number.isSafeInteger(n) && n >= 0;

function readSaved(file) {
  if (!file) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved?.v !== 1 || typeof saved.date !== "string" || !whole(saved.count)) return null;
    return saved;
  } catch { return null; }
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {string|null} [options.file]   where the count is kept; null keeps it in memory only
 * @param {boolean} [options.fromMidnight] true when this console's first read covers the whole day
 *   (a fresh transcript reader starts from the beginning), so a count begun now is still whole
 */
export function createAlertDay({ now = () => Date.now(), file = null, fromMidnight = false } = {}) {
  const startedAt = now();
  const saved = readSaved(file);
  const today = localDayOf(startedAt);
  // A count kept from an earlier run is continuous: what happened while the
  // console was down is read or resent after it, and counted then.
  let state;
  if (saved && saved.date === today.date) {
    state = { date: saved.date, from: today.from, count: saved.count,
      byKind: { ...emptyKinds(), ...Object.fromEntries(KINDS.map((k) => [k, whole(saved.byKind?.[k]) ? saved.byKind[k] : 0])) },
      since: Number.isFinite(saved.since) ? Math.max(saved.since, today.from) : today.from };
  } else {
    state = { date: today.date, from: today.from, count: 0, byKind: emptyKinds(),
      since: saved || fromMidnight ? today.from : startedAt };
  }
  // Live alerts (dated within the hour, not replayed history), by time: exact, never the list's length.
  let live = [];
  let lastWrite = 0, timer = null, dirty = false;

  const write = () => {
    timer = null;
    if (!file || !dirty) return;
    dirty = false;
    lastWrite = now();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + "." + process.pid + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify({ v: 1, date: state.date, count: state.count, byKind: state.byKind, since: state.since }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch { dirty = true; /* kept in memory; the next alert tries again */ }
  };
  const save = () => {
    dirty = true;
    if (!file || timer) return;
    const wait = WRITE_EVERY_MS - (now() - lastWrite);
    if (wait <= 0) { write(); return; }
    timer = setTimeout(write, wait);
    timer.unref?.();
  };
  // A new calendar day while running: counted from its midnight.
  const roll = (t) => {
    const day = localDayOf(t);
    if (day.date === state.date || day.from < state.from) return;
    state = { date: day.date, from: day.from, count: 0, byKind: emptyKinds(), since: day.from };
    save();
  };

  return {
    /** Count one alert, raised here or accepted from a joined machine: `{ kind, at, historical }`. */
    add(alert, t = now()) {
      roll(t);
      if (!alert || !Number.isFinite(alert.at)) return;
      if (alert.at < state.from || alert.at > t + 2 * MINUTE) return;   // another day's, or past the clock rule
      state.count += 1;
      if (KINDS.includes(alert.kind)) state.byKind[alert.kind] += 1;
      if (!alert.historical && !alert.backfill && alert.at >= t - HOUR) {
        live.push(alert.at);
        if (live.length > MAX_LIVE) live = live.slice(-MAX_LIVE);
      }
      save();
    },
    /**
     * `{ date, tz, from, since, count, byKind, lastHour, exact: true }`:
     * the alerts of this console's calendar day, and the live ones of the last
     * hour, counted as they came.
     */
    read(t = now()) {
      roll(t);
      live = live.filter((at) => at >= t - HOUR);
      return { date: state.date, tz: zone(), from: state.from, since: state.since, count: state.count,
        byKind: { ...state.byKind }, lastHour: live.length, exact: true };
    },
    flush() { if (timer) clearTimeout(timer); write(); },
    stop() { if (timer) clearTimeout(timer); write(); },
  };
}

/**
 * The day's figure for /api/console: the counter's reading with how many of
 * those alerts the list still holds. Without a counter (an embedding that
 * keeps none) the count is the list's, and says so (`exact: false`).
 */
export function alertsTodayOf(reading, rows, now) {
  const day = reading ?? { ...localDayOf(now), tz: zone(), since: null, count: null, byKind: null, lastHour: null, exact: false };
  const kept = rows.filter((a) => a.at >= day.from && a.at <= now + 2 * MINUTE);
  // What the list holds today was counted too: the count is never below it.
  const out = { date: day.date, tz: day.tz, from: day.from, since: day.since, count: Math.max(day.count ?? 0, kept.length), kept: kept.length,
    byKind: day.byKind, lastHour: day.lastHour, exact: day.exact };
  if (!out.exact) {
    out.count = kept.length;
    out.byKind = Object.fromEntries(KINDS.map((k) => [k, kept.filter((a) => a.kind === k).length]));
    out.lastHour = kept.filter((a) => !a.historical && a.at >= now - HOUR).length;
  }
  return out;
}
