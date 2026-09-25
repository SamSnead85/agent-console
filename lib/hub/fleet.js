/**
 * What joined machines send beside their records, by choice: their alerts
 * (--share-alerts) and their tool activity (--share-tool-activity). Counts,
 * kinds, minutes and salted hashes only; checked at the door by
 * lib/collector/transport.js before anything here sees them.
 *
 * A machine WATCHES for alerts when its last envelope carried an `alerts`
 * list, even an empty one; a 0.3 reporter, or one run without the option,
 * sends none, and the console says that machine is not watched rather than
 * showing its silence as "no alert". The same holds for activity.
 *
 * Kept in memory: alerts for a day, activity for a quarter of an hour. A
 * console restart forgets them until each machine's next report, seconds later.
 */

import { createActivityBook } from "../collector/activity.js";
import { ALERT_WINDOW_MS, ALERT_HISTORY_MS } from "./alerts.js";

const MAX_PER_DEVICE = 100;

export function createFleetSignals({ now = () => Date.now() } = {}) {
  const alertsByDevice = new Map();   // deviceId -> Map(id -> alert)
  const watchAlerts = new Map();      // deviceId -> first envelope with alerts (ms)
  const shareActivity = new Map();    // deviceId -> first envelope with activity (ms)
  const activity = createActivityBook({ now });

  return {
    activity,
    /** One machine's envelope: `alerts` and `activity` as validated, either possibly undefined. */
    accept(deviceId, { alerts, activity: entries } = {}, seenAt = now()) {
      if (Array.isArray(alerts)) {
        if (!watchAlerts.has(deviceId)) watchAlerts.set(deviceId, seenAt);
        let held = alertsByDevice.get(deviceId);
        if (!held) { held = new Map(); alertsByDevice.set(deviceId, held); }
        for (const a of alerts) {
          if (held.has(a.id)) continue;
          held.set(a.id, { id: a.id, kind: a.kind, at: Date.parse(a.at), seenAt, backfill: a.historical === true,
            sessionHash: a.sessionHash, count: a.count, deviceId });
        }
        const edge = seenAt - ALERT_HISTORY_MS;
        for (const [id, a] of held) if (a.at < edge) held.delete(id);
        while (held.size > MAX_PER_DEVICE) held.delete(held.keys().next().value);
      }
      if (Array.isArray(entries)) {
        if (!shareActivity.has(deviceId)) shareActivity.set(deviceId, seenAt);
        activity.merge(entries);
      }
    },
    /** Every joined machine's alerts of the last day, newest first; `historical` ones are not "now". */
    alerts(t = now()) {
      const out = [];
      for (const held of alertsByDevice.values()) {
        for (const a of held.values()) {
          if (a.at < t - ALERT_HISTORY_MS || a.at > t + 60_000) continue;
          out.push({ id: a.id, kind: a.kind, at: a.at, seenAt: a.seenAt, historical: a.backfill || a.at < t - ALERT_WINDOW_MS,
            sessionHash: a.sessionHash, count: a.count, tokens: a.count, deviceId: a.deviceId });
        }
      }
      return out.sort((a, b) => b.at - a.at);
    },
    watchesAlerts: (deviceId) => watchAlerts.has(deviceId),
    sharesActivity: (deviceId) => shareActivity.has(deviceId),
    /** Demo only: mark a synthetic machine as watching or sharing. */
    markDemo(deviceId, { alerts = false, activity: act = false } = {}) {
      if (alerts) watchAlerts.set(deviceId, now());
      if (act) shareActivity.set(deviceId, now());
    },
    forget(deviceId) {
      alertsByDevice.delete(deviceId); watchAlerts.delete(deviceId); shareActivity.delete(deviceId);
    },
  };
}
