/**
 * What joined machines send beside their records, by choice: their alerts
 * (--share-alerts) and their tool activity (--share-tool-activity). Counts,
 * kinds, minutes and salted hashes only; checked at the door by
 * lib/collector/transport.js before anything here sees them.
 *
 * COVERAGE IS DECLARED. Every envelope from a current reporter says what its
 * run shares (`share: { alerts, activity }`, each "on" or "off"). That
 * declaration, not the presence of a list, is what the console trusts: a
 * later batch without lists changes nothing, "off" makes that machine's
 * coverage unavailable from that envelope on, and an older reporter that
 * declares nothing is "undeclared" — its silence is unavailable, never zero.
 * Coverage starts when an "on" is heard, never earlier: a run that read the
 * transcripts with sharing off may have moved past lines whose activity
 * nobody counted, and the console cannot tell.
 *
 * LOSS IS DECLARED TOO. A reporter whose bounded outbox had to drop pending
 * extras sends a marker with the minutes they covered (`lost`); those minutes
 * are partial for that machine, never whole.
 *
 * CUSTODY IS PER MACHINE. Each machine has its own activity book, keyed by
 * the authenticated device, so the same session hash on two machines is two
 * readings. A contribution's id is counted once per machine: a resent
 * envelope adds nothing, and two contributions to one minute both count.
 *
 * ONE CLOCK RULE (lib/collector/activity.js): a minute, an alert or a last
 * tool dated later than this clock plus two minutes is refused and counted,
 * never stored.
 *
 * KEPT IN MEMORY: alerts for a day, activity for a quarter of an hour. They
 * are not kept across a console restart, so `startedAt` is said with every
 * reading: what happened before it is unavailable, never zero. A reporter
 * keeps what the console has not acknowledged and sends it again
 * (lib/reporter-outbox.js).
 */

import { createActivityBook, keepEdge, tooFarAhead } from "../collector/activity.js";
import { ALERT_WINDOW_MS, ALERT_HISTORY_MS } from "./alerts.js";

const MAX_PER_DEVICE = 100;
const MAX_GAPS = 100;
const MINUTE = 60_000;

export function createFleetSignals({ now = () => Date.now(), startedAt = now(), firstStart = false } = {}) {
  let started = startedAt;
  // deviceId -> { book, alerts: Map(id -> alert), share: { alerts, activity }, rejectedFuture }
  const devices = new Map();
  const deviceFor = (deviceId) => {
    let d = devices.get(deviceId);
    if (!d) {
      d = { book: createActivityBook({ now }), alerts: new Map(), share: { alerts: null, activity: null }, gaps: new Map(), rejectedFuture: 0 };
      devices.set(deviceId, d);
    }
    return d;
  };
  /* A change of declaration starts a new interval, from the envelope that said it. */
  const declare = (d, kind, state, seenAt) => {
    if (d.share[kind]?.state === state) return;
    // `after`: what this console heard the machine declare before, since it started (null: nothing).
    d.share[kind] = { state, since: seenAt, after: d.share[kind]?.state ?? null };
  };

  return {
    get startedAt() { return started; },
    /** True on this console's very first start (a new state directory): nothing ran before it. */
    firstStart: Boolean(firstStart),
    /**
     * One machine's envelope, as validated: `share` (undefined from an older
     * reporter), `alerts` and `activity` (each possibly undefined). Returns
     * what was refused or already counted.
     */
    accept(deviceId, { share, alerts, activity: entries, lost } = {}, seenAt = now()) {
      const d = deviceFor(deviceId);
      declare(d, "alerts", share ? share.alerts : "undeclared", seenAt);
      declare(d, "activity", share ? share.activity : "undeclared", seenAt);
      const out = { alerts: { accepted: 0, duplicate: 0, future: 0 }, activity: { accepted: 0, duplicate: 0, future: 0, expired: 0 },
        lost: { accepted: 0, duplicate: 0, future: 0 } };
      if (Array.isArray(lost)) {
        for (const m of lost) {
          const from = Date.parse(m.from), to = Date.parse(m.to);
          if (tooFarAhead(to, seenAt)) { out.lost.future += 1; continue; }
          if (d.gaps.has(m.id)) { out.lost.duplicate += 1; continue; }
          d.gaps.set(m.id, { kind: m.kind, from, to, count: m.count });
          out.lost.accepted += 1;
        }
      }
      // A loss matters while its minutes can still be shown: activity for the kept quarter hour, alerts for the day.
      for (const [id, g] of d.gaps) if (g.to < (g.kind === "activity" ? keepEdge(seenAt) : seenAt - ALERT_HISTORY_MS)) d.gaps.delete(id);
      while (d.gaps.size > MAX_GAPS) d.gaps.delete(d.gaps.keys().next().value);
      if (Array.isArray(alerts)) {
        for (const a of alerts) {
          const at = Date.parse(a.at);
          if (tooFarAhead(at, seenAt)) { out.alerts.future += 1; continue; }
          if (d.alerts.has(a.id)) { out.alerts.duplicate += 1; continue; }
          d.alerts.set(a.id, { id: a.id, kind: a.kind, at, seenAt, backfill: a.historical === true,
            sessionHash: a.sessionHash, count: a.count, deviceId });
          out.alerts.accepted += 1;
        }
        const edge = seenAt - ALERT_HISTORY_MS;
        for (const [id, a] of d.alerts) if (a.at < edge) d.alerts.delete(id);
        while (d.alerts.size > MAX_PER_DEVICE) d.alerts.delete(d.alerts.keys().next().value);
      }
      if (Array.isArray(entries)) out.activity = d.book.merge(entries, seenAt);
      d.rejectedFuture += out.alerts.future + out.activity.future + out.lost.future;
      return out;
    },
    /** Every joined machine's alerts of the last day, newest first; `historical` ones are not "now". */
    alerts(t = now()) {
      const out = [];
      for (const d of devices.values()) {
        for (const a of d.alerts.values()) {
          if (a.at < t - ALERT_HISTORY_MS || a.at > t + MINUTE) continue;
          out.push({ id: a.id, kind: a.kind, at: a.at, seenAt: a.seenAt, historical: a.backfill || a.at < t - ALERT_WINDOW_MS,
            sessionHash: a.sessionHash, count: a.count, tokens: a.count, deviceId: a.deviceId });
        }
      }
      return out.sort((a, b) => b.at - a.at);
    },
    /**
     * A machine's declaration for `kind` ("alerts" | "activity"), since when,
     * and the minutes its outbox reported lost: `{ state, since, gaps: [{ from, to, count }] }`,
     * or null if unheard since start.
     */
    coverage: (deviceId, kind) => {
      const d = devices.get(deviceId);
      if (!d?.share[kind]) return null;
      return { ...d.share[kind], gaps: [...d.gaps.values()].filter((g) => g.kind === kind).map(({ from, to, count }) => ({ from, to, count })) };
    },
    /** A machine's own activity book, or null. */
    bookFor: (deviceId) => devices.get(deviceId)?.book ?? null,
    /** Entries this machine sent dated past the clock rule, refused since the console started. */
    rejectedFuture: (deviceId) => devices.get(deviceId)?.rejectedFuture ?? 0,
    /** Demo only: a synthetic machine's declarations ("on" | "off" | "undeclared") since `since`. */
    markDemo(deviceId, { alerts = "off", activity = "off" } = {}, since = now()) {
      const d = deviceFor(deviceId);
      d.share = { alerts: { state: alerts, since }, activity: { state: activity, since } };
      return d.book;
    },
    /** Demo only: the synthetic console has been running since `since`. */
    markDemoStart(since) { started = since; },
    forget(deviceId) { devices.delete(deviceId); },
  };
}
