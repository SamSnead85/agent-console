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

import { createActivityBook, tooFarAhead } from "../collector/activity.js";
import { ALERT_WINDOW_MS, ALERT_HISTORY_MS } from "./alerts.js";

const MAX_PER_DEVICE = 100;
const MINUTE = 60_000;

export function createFleetSignals({ now = () => Date.now(), startedAt = now() } = {}) {
  let started = startedAt;
  // deviceId -> { book, alerts: Map(id -> alert), share: { alerts, activity }, rejectedFuture }
  const devices = new Map();
  const deviceFor = (deviceId) => {
    let d = devices.get(deviceId);
    if (!d) {
      d = { book: createActivityBook({ now }), alerts: new Map(), share: { alerts: null, activity: null }, rejectedFuture: 0 };
      devices.set(deviceId, d);
    }
    return d;
  };
  /*
   * A change of declaration starts a new interval. The first envelope this
   * console has from a machine that shares covers everything since this
   * console started (the reporter resends whatever it has not had
   * acknowledged); a machine that turns sharing on later is covered from then.
   */
  const declare = (d, kind, state, seenAt, first) => {
    if (d.share[kind]?.state === state) return;
    d.share[kind] = { state, since: first && state === "on" ? started : seenAt };
  };

  return {
    get startedAt() { return started; },
    /**
     * One machine's envelope, as validated: `share` (undefined from an older
     * reporter), `alerts` and `activity` (each possibly undefined). Returns
     * what was refused or already counted.
     */
    accept(deviceId, { share, alerts, activity: entries } = {}, seenAt = now()) {
      const first = !devices.has(deviceId);
      const d = deviceFor(deviceId);
      declare(d, "alerts", share ? share.alerts : "undeclared", seenAt, first);
      declare(d, "activity", share ? share.activity : "undeclared", seenAt, first);
      const out = { alerts: { accepted: 0, duplicate: 0, future: 0 }, activity: { accepted: 0, duplicate: 0, future: 0, expired: 0 } };
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
      d.rejectedFuture += out.alerts.future + out.activity.future;
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
    /** A machine's declaration for `kind` ("alerts" | "activity") and since when: `{ state, since }`, or null if unheard since start. */
    coverage: (deviceId, kind) => devices.get(deviceId)?.share[kind] ?? null,
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
