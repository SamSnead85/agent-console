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
 * Nothing is counted twice.
 *
 * SEALED ONCE. The activity counted in one pass is sealed into contributions,
 * one per session and minute, each with a salted id made from this device,
 * the session and the contribution's own sequence number. A resend — a lost
 * answer, a later batch that failed, a restart — carries the same ids, and
 * the console counts each once; more calls in the same minute on a later
 * pass are a new contribution with a new id, and both count.
 *
 * BOUNDED, NEVER SILENTLY. At most OUTBOX_LIMITS of each is kept, none older
 * than its age. Whatever the bound drops is recorded as a loss: a marker with
 * its kind, how many were dropped and the minutes they covered, sent like any
 * pending extra until acknowledged. The console then reads that machine's
 * coverage of those minutes as partial ("outbox-overflow"), never whole.
 *
 * METADATA ONLY. The same shapes as the envelope (lib/collector/transport.js):
 * counts, eight fixed kinds, minutes and salted hashes. A kind is emptied as
 * soon as a run does not share it: that is an opt-out, and the console shows
 * the machine as not sharing, not as a loss.
 */
import { randomBytes } from "node:crypto";
import { alertsFor, activityFor, lostFor } from "./collector/transport.js";
import { STAGE_MINUTES } from "./collector/activity.js";
import { ALERT_HISTORY_MS, ALERT_WINDOW_MS } from "./hub/alerts.js";

const MINUTE = 60_000;
/* At most this many of each are kept, and none older than this. */
export const OUTBOX_LIMITS = Object.freeze({ activity: 1_000, alerts: 100, lost: 20, activityAgeMs: STAGE_MINUTES * MINUTE, alertsAgeMs: ALERT_HISTORY_MS });
/* What one envelope carries at most (lib/collector/transport.js). */
const SEND = { activity: 500, alerts: 100, lost: 20 };
const EPOCH = /^[a-f0-9]{32}$/u;
const KINDS = [["activity", activityFor, OUTBOX_LIMITS.activityAgeMs, OUTBOX_LIMITS.activity], ["alerts", alertsFor, OUTBOX_LIMITS.alertsAgeMs, OUTBOX_LIMITS.alerts]];
const minuteIso = (ms) => new Date(Math.floor(ms / MINUTE) * MINUTE).toISOString();

/* Only entries that pass the envelope's own check survive a restart; the rest are counted. */
function checked(list, validate) {
  const kept = [];
  const ids = new Set();
  let rejected = 0;
  for (const e of Array.isArray(list) ? list : []) {
    let ok = null;
    try { [ok] = validate([e]); } catch { /* not ours */ }
    if (ok && !ids.has(ok.id)) { ids.add(ok.id); kept.push(ok); } else rejected += 1;
  }
  return { kept, rejected };
}
const valid = (saved) => Boolean(saved) && typeof saved === "object" && saved.v === 1 && typeof saved.epoch === "string"
  && EPOCH.test(saved.epoch) && Number.isSafeInteger(saved.seq) && saved.seq >= 0;
const clone = (s) => ({ epoch: s.epoch, seq: s.seq, activity: [...s.activity], alerts: [...s.alerts], lost: [...s.lost] });
const form = (s) => ({ v: 1, epoch: s.epoch, seq: s.seq, activity: s.activity, alerts: s.alerts, lost: s.lost });

/**
 * @param {object} options
 * @param {ReturnType<import("./hub/alerts.js").createAlerts>|null} [options.alerts] this run's alert engine, when it shares alerts
 * @param {ReturnType<import("./collector/activity.js").createActivityBook>|null} [options.activity] this run's activity book, when it shares activity
 * @param {() => number} [options.now]
 */
export function createExtrasOutbox({ alerts = null, activity = null, now = () => Date.now() } = {}) {
  const shared = (kind) => Boolean(kind === "activity" ? activity : alerts);
  let state = null;        // { epoch, seq, activity: [], alerts: [], lost: [] }: what is pending, as last committed
  let context = null;      // { hashIdentity, deviceId }, from the collector
  let tentative = null;    // { next, drained }: sealed by prepare(), kept by commit()
  let carried = [];        // alerts drained by a pass that failed, offered again
  let taken = null;        // the ids in the envelope in flight
  let changed = false;

  const nextId = (s, what, value) => { s.seq += 1; return context.hashIdentity(what, `${context.deviceId}|${s.epoch}|${value}${s.seq}`); };

  /* A loss is a marker, never a silence. Markers are bounded too: two of a kind merge into one wider one. */
  function recordLoss(s, kind, count, fromMs, toMs) {
    s.lost.push({ id: nextId(s, "extras-lost", ""), kind, count, from: minuteIso(fromMs), to: minuteIso(toMs) });
    while (s.lost.length > OUTBOX_LIMITS.lost) {
      const i = s.lost.findIndex((m, k) => s.lost.some((o, l) => l > k && o.kind === m.kind));
      const j = s.lost.findIndex((o, l) => l > i && o.kind === s.lost[i].kind);
      const [a, b] = [s.lost[i], s.lost[j]];
      const merged = { id: nextId(s, "extras-lost", ""), kind: a.kind, count: a.count === null || b.count === null ? null : a.count + b.count,
        from: a.from < b.from ? a.from : b.from, to: a.to > b.to ? a.to : b.to };
      s.lost.splice(j, 1);
      s.lost.splice(i, 1, merged);
    }
  }
  /* The bound by age and by count; whatever it drops becomes a loss marker. */
  function bound(s, t) {
    for (const [kind, , age, max] of KINDS) {
      const keep = [], dropped = [];
      for (const e of s[kind]) (Date.parse(e.at) >= t - age ? keep : dropped).push(e);
      while (keep.length > max) dropped.push(keep.shift());
      s[kind] = keep;
      if (dropped.length) {
        const times = dropped.map((e) => Date.parse(e.at));
        recordLoss(s, kind, dropped.length, Math.min(...times), Math.min(t, Math.max(...times)));
      }
    }
    return s;
  }
  /* Pending extras as kept in the cursor, for the kinds this run shares. */
  function load(saved, t) {
    const s = { epoch: saved.epoch, seq: saved.seq, activity: [], alerts: [],
      lost: checked(saved.lost, lostFor).kept.filter((m) => shared(m.kind)) };
    for (const [kind, validate, age] of KINDS) {
      if (!shared(kind)) continue;
      const { kept, rejected } = checked(saved[kind], validate);
      s[kind] = kept;
      // An entry that no longer reads as ours is lost, somewhere in the span the outbox keeps.
      if (rejected) recordLoss(s, kind, rejected, t - age, t);
    }
    return bound(s, t);
  }

  const journal = {
    /**
     * The pending extras saved with the cursor. Read once per run; after that
     * the disk is adopted only if it is ahead of this process (a cursor write
     * that landed although this process saw it fail).
     */
    restore(saved, ctx) {
      context = ctx;
      const t = now();
      if (state) {
        if (valid(saved) && saved.epoch === state.epoch && saved.seq > state.seq) {
          state = load(saved, t);
          const kept = new Set(state.alerts.map((a) => a.id));
          carried = carried.filter((a) => !kept.has(a.id));
          tentative = null;
          changed = true;
        }
        return;
      }
      if (valid(saved)) state = load(saved, t);
      else {
        // A new epoch whenever nothing valid was kept, so a new sequence can never repeat an old id.
        state = { epoch: randomBytes(16).toString("hex"), seq: 0, activity: [], alerts: [], lost: [] };
        // Something was kept and cannot be read: whatever it held is lost, over the span it could hold.
        if (saved !== null && saved !== undefined) for (const [kind, , age] of KINDS) if (shared(kind)) recordLoss(state, kind, null, t - age, t);
      }
      changed = true;
    },
    /** One transcript read whole (`true`), or abandoned to be read again (`false`). */
    file(ok) { activity?.fileRead(ok); },
    /** Seals this pass's counts and alerts; the result is written with the cursor. */
    prepare() {
      if (!state || !context) return null;
      const next = clone(state);
      for (const c of activity ? activity.passCells() : []) {
        next.activity.push({
          id: nextId(next, "activity-contribution", `${c.sessionHash}|`),
          sessionHash: c.sessionHash, at: minuteIso(c.minute), calls: c.calls, results: { ok: c.ok, error: c.error },
          lastTool: c.lastTool ? { kind: c.lastTool.kind, at: minuteIso(c.lastTool.at) } : null,
        });
      }
      const drained = [...carried, ...(alerts ? alerts.drain() : [])];
      carried = [];
      next.alerts.push(...drained);
      bound(next, now());
      tentative = { next, drained };
      if (next.seq !== state.seq || drained.length) changed = true;
      return form(clone(next));
    },
    get changed() { return changed; },
    /** The cursor carrying them is on disk: the sealed extras are pending, and the lines count. */
    commit() {
      if (tentative) state = tentative.next;
      tentative = null;
      changed = false;
      activity?.commitPass();
    },
    /** The pass failed before its cursor was written: its lines are read again; its alerts are offered again. */
    abort() {
      if (tentative) carried = tentative.drained;
      tentative = null;
      activity?.abortPass();
    },
  };

  return {
    journal,
    /** What the next envelope carries: the oldest pending, at most one envelope's worth of each, and every loss marker. */
    take() {
      if (!state) return {};
      const t = now();
      const act = state.activity.slice(0, SEND.activity);
      const al = state.alerts.slice(0, SEND.alerts)
        .map((a) => ({ ...a, historical: a.historical || Date.parse(a.at) < t - ALERT_WINDOW_MS }));
      const lost = state.lost.slice(0, SEND.lost);
      taken = new Set([...act, ...al, ...lost].map((e) => e.id));
      return { ...(alerts ? { alerts: al } : {}), ...(activity ? { activity: act } : {}), ...(lost.length ? { lost } : {}) };
    },
    /** The console acknowledged the envelope: its extras leave the outbox. True when something left. */
    ack() {
      if (!taken || !state) return false;
      const before = state.activity.length + state.alerts.length + state.lost.length;
      for (const key of ["activity", "alerts", "lost"]) state[key] = state[key].filter((e) => !taken.has(e.id));
      taken = null;
      const left = before !== state.activity.length + state.alerts.length + state.lost.length;
      if (left) changed = true;
      return left;
    },
    /** What is pending now, in the form kept in the cursor file. */
    saved() { return state ? form(clone(state)) : null; },
  };
}
