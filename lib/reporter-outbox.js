/**
 * A reporter's opt-in extras between reading and receipt: the alerts it
 * raised (--share-alerts) and the tool activity it counted
 * (--share-tool-activity), held until the console acknowledges the envelope
 * that carried them.
 *
 * DURABLE, WITH ITS CURSOR. What is pending lives in the collector's own
 * cursor file (`extras` in cursor-v2.json, mode 600), written in the same
 * atomic step as the transcript positions it was read from
 * (lib/collector/collector.js): after a crash either both the positions and
 * the pending extras are on disk, or neither is and the lines are read again.
 * Nothing is counted twice and nothing read is lost.
 *
 * SEALED ONCE. The activity counted in one pass is sealed into contributions,
 * one per session and minute, each with a salted id made from this device,
 * the session and the contribution's own sequence number. A resend — a lost
 * answer, a later batch that failed, a restart — carries the same ids, and
 * the console counts each once; more calls in the same minute on a later
 * pass are a new contribution with a new id, and both count.
 *
 * METADATA ONLY. The same shapes as the envelope (lib/collector/transport.js):
 * counts, eight fixed kinds, minutes and salted hashes. Bounded by count and
 * by age, and emptied of a kind as soon as a run does not share it.
 */
import { randomBytes } from "node:crypto";
import { alertsFor, activityFor } from "./collector/transport.js";
import { STAGE_MINUTES, tooFarAhead } from "./collector/activity.js";
import { ALERT_HISTORY_MS, ALERT_WINDOW_MS } from "./hub/alerts.js";

const MINUTE = 60_000;
/* At most this many of each are kept, and none older than this. */
export const OUTBOX_LIMITS = Object.freeze({ activity: 1_000, alerts: 100, activityAgeMs: STAGE_MINUTES * MINUTE, alertsAgeMs: ALERT_HISTORY_MS });
/* What one envelope carries at most (lib/collector/transport.js). */
const SEND = { activity: 500, alerts: 100 };
const EPOCH = /^[a-f0-9]{32}$/u;
const minuteIso = (ms) => new Date(Math.floor(ms / MINUTE) * MINUTE).toISOString();

/* Only entries that pass the envelope's own check survive a restart. */
function checked(list, validate) {
  const out = [];
  const ids = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    try { const [ok] = validate([e]); if (!ids.has(ok.id)) { ids.add(ok.id); out.push(ok); } } catch { /* not ours: dropped */ }
  }
  return out;
}
function bounded(state, t) {
  const fresh = (at, age) => { const ms = Date.parse(at); return ms >= t - age && !tooFarAhead(ms, t); };
  state.activity = state.activity.filter((e) => fresh(e.at, OUTBOX_LIMITS.activityAgeMs)).slice(-OUTBOX_LIMITS.activity);
  state.alerts = state.alerts.filter((a) => fresh(a.at, OUTBOX_LIMITS.alertsAgeMs)).slice(-OUTBOX_LIMITS.alerts);
  return state;
}
const copy = (s) => ({ epoch: s.epoch, seq: s.seq, activity: [...s.activity], alerts: [...s.alerts] });

/**
 * @param {object} options
 * @param {ReturnType<import("./hub/alerts.js").createAlerts>|null} [options.alerts] this run's alert engine, when it shares alerts
 * @param {ReturnType<import("./collector/activity.js").createActivityBook>|null} [options.activity] this run's activity book, when it shares activity
 * @param {() => number} [options.now]
 */
export function createExtrasOutbox({ alerts = null, activity = null, now = () => Date.now() } = {}) {
  let state = null;        // { epoch, seq, activity: [], alerts: [] }: what is pending, as last committed
  let context = null;      // { hashIdentity, deviceId }, from the collector
  let tentative = null;    // sealed by prepare(), kept by commit()
  let carried = [];        // alerts drained by a pass that failed, offered again
  let taken = null;        // the ids in the envelope in flight
  let changed = false;

  const form = (s) => ({ v: 1, epoch: s.epoch, seq: s.seq, activity: s.activity, alerts: s.alerts });

  const journal = {
    /** The pending extras saved with the cursor, read once per run. A kind this run does not share is dropped. */
    restore(saved, ctx) {
      context = ctx;
      if (state) return;
      const valid = saved && typeof saved === "object" && saved.v === 1 && typeof saved.epoch === "string" && EPOCH.test(saved.epoch)
        && Number.isSafeInteger(saved.seq) && saved.seq >= 0;
      // A new epoch whenever nothing valid was kept, so a new sequence can never repeat an old id.
      state = valid
        ? { epoch: saved.epoch, seq: saved.seq, activity: activity ? checked(saved.activity, activityFor) : [], alerts: alerts ? checked(saved.alerts, alertsFor) : [] }
        : { epoch: randomBytes(16).toString("hex"), seq: 0, activity: [], alerts: [] };
      bounded(state, now());
      changed = true;
    },
    /** One transcript read whole (`true`), or abandoned to be read again (`false`). */
    file(ok) { activity?.fileRead(ok); },
    /** Seals this pass's counts and alerts; the result is written with the cursor. */
    prepare() {
      if (!state || !context) return null;
      let seq = state.seq;
      const sealed = [];
      for (const c of activity ? activity.passCells() : []) {
        seq += 1;
        sealed.push({
          id: context.hashIdentity("activity-contribution", `${context.deviceId}|${state.epoch}|${c.sessionHash}|${seq}`),
          sessionHash: c.sessionHash, at: minuteIso(c.minute), calls: c.calls, results: { ok: c.ok, error: c.error },
          lastTool: c.lastTool ? { kind: c.lastTool.kind, at: minuteIso(c.lastTool.at) } : null,
        });
      }
      const drained = [...carried, ...(alerts ? alerts.drain() : [])];
      carried = [];
      tentative = { seq, activity: sealed, alerts: drained };
      if (sealed.length || drained.length) changed = true;
      const next = bounded({ epoch: state.epoch, seq, activity: [...state.activity, ...sealed], alerts: [...state.alerts, ...drained] }, now());
      return form(next);
    },
    get changed() { return changed; },
    /** The cursor carrying them is on disk: the sealed extras are pending, and the lines count. */
    commit() {
      if (state && tentative) {
        state = bounded({ epoch: state.epoch, seq: tentative.seq, activity: [...state.activity, ...tentative.activity],
          alerts: [...state.alerts, ...tentative.alerts] }, now());
      }
      tentative = null;
      changed = false;
      activity?.commitPass();
    },
    /** The pass failed before its cursor was written: its lines are read again; its alerts are offered again. */
    abort() {
      if (tentative) carried = tentative.alerts;
      tentative = null;
      activity?.abortPass();
    },
  };

  return {
    journal,
    /** What the next envelope carries: the oldest pending, at most one envelope's worth of each. */
    take() {
      if (!state) return {};
      const t = now();
      bounded(state, t);
      const act = state.activity.slice(0, SEND.activity);
      const al = state.alerts.slice(0, SEND.alerts)
        .map((a) => ({ ...a, historical: a.historical || Date.parse(a.at) < t - ALERT_WINDOW_MS }));
      taken = { activity: new Set(act.map((e) => e.id)), alerts: new Set(al.map((a) => a.id)) };
      return { ...(alerts ? { alerts: al } : {}), ...(activity ? { activity: act } : {}) };
    },
    /** The console acknowledged the envelope: its extras leave the outbox. True when something left. */
    ack() {
      if (!taken || !state) return false;
      const before = state.activity.length + state.alerts.length;
      state.activity = state.activity.filter((e) => !taken.activity.has(e.id));
      state.alerts = state.alerts.filter((a) => !taken.alerts.has(a.id));
      taken = null;
      const left = before !== state.activity.length + state.alerts.length;
      if (left) changed = true;
      return left;
    },
    /** What is pending now, in the form kept in the cursor file. */
    saved() { return state ? form(copy(state)) : null; },
  };
}
