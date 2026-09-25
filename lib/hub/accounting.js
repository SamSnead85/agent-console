/**
 * Exact token accounting for a window: the figures a platform team reconciles.
 *
 * docs/accounting.md is the rule book; this module is its reading of the
 * hub's store. It adds nothing the store does not hold and keeps nothing: it
 * walks the minute buckets once and sums them into the same totals five ways
 * — the team, each person, each machine, each model and each session — so
 * that every one of those ways adds up to the same team total.
 *
 * - WINDOWS ARE HALF-OPEN WHOLE MINUTES. [from, to) on UTC instants. An event
 *   is dated by the minute its API response began (§2), so a minute is the
 *   finest boundary that means anything.
 * - A PERSON IS WHO THE REPORTING MACHINE IS ENROLLED TO (§7). A machine
 *   enrolled to nobody is "Unassigned", never guessed.
 * - A SESSION'S OWN TOTAL EXCLUDES ITS SUBAGENTS; its tree total adds each
 *   descendant exactly once (§3.6).
 * - UNKNOWN IS NOT ZERO. A record that did not report a class adds nothing to
 *   it and is counted, so a total can be marked a floor (§3).
 */

import { createHash } from "node:crypto";
import { MINUTE } from "./store.js";
import { dropsOf, DROP_REASONS } from "./aggregate.js";

export const UNASSIGNED = "Unassigned";
const SUMMED = ["fresh", "output", "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h", "cacheWriteUnknownTtl",
  "records", "messages", "usd", "pricedRecords", "unpricedRecords", "pricedMessages", "unpricedMessages", "unpricedTokens", "unknownClassRecords"];

export function emptyTotals() {
  return { total: 0, fresh: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0,
    cacheWriteUnknownTtl: 0, records: 0, messages: 0, usd: 0, pricedRecords: 0, unpricedRecords: 0,
    pricedMessages: 0, unpricedMessages: 0, unpricedTokens: 0, unknownClassRecords: 0 };
}

function addBucket(totals, bucket) {
  totals.fresh += bucket.fresh;
  totals.output += bucket.output;
  totals.cacheRead += bucket.cacheRead;
  totals.cacheWrite += bucket.cacheWrite;
  totals.cacheWrite5m += bucket.cacheWrite5m ?? 0;
  totals.cacheWrite1h += bucket.cacheWrite1h ?? 0;
  totals.cacheWriteUnknownTtl += bucket.cacheWriteUnknownTtl ?? 0;
  totals.total += bucket.fresh + bucket.output + bucket.cacheRead + bucket.cacheWrite;
  totals.records += bucket.n;
  totals.messages += bucket.messages;
  totals.usd += bucket.usd;
  totals.pricedRecords += bucket.pricedN;
  totals.unpricedRecords += bucket.unpricedN;
  totals.pricedMessages += bucket.pricedMessages ?? 0;
  totals.unpricedMessages += bucket.unpricedMessages ?? 0;
  totals.unpricedTokens += bucket.unpricedTokens;
  totals.unknownClassRecords += bucket.unknownFresh + bucket.unknownOutput + bucket.unknownCacheWrite + bucket.unknownCacheRead;
}

function addTotals(target, source) {
  for (const key of ["total", ...SUMMED]) target[key] += source[key];
}

const at = (map, key) => {
  let totals = map.get(key);
  if (!totals) { totals = emptyTotals(); map.set(key, totals); }
  return totals;
};
const sorted = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** A stable name for the price table the dollars came from (§9). */
export function priceTableVersion(prices) {
  if (!prices) return null;
  return {
    basis: prices.basis ?? null,
    inventoryCheckedOn: prices.inventoryCheckedOn ?? null,
    sha256: createHash("sha256").update(JSON.stringify(prices)).digest("hex"),
  };
}

/** The person a machine is enrolled to, or Unassigned. */
export function personOf(device) {
  return device && typeof device.person === "string" && device.person.trim() ? device.person : UNASSIGNED;
}

/**
 * Roots of each session's tree: follow the parent link while the parent is a
 * session the store holds. A cycle or a missing parent ends the walk there.
 */
function rootOf(sessions, hash) {
  const seen = new Set([hash]);
  let current = hash;
  for (;;) {
    const parent = sessions.get(current)?.parentSessionHash;
    if (!parent || !sessions.has(parent) || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
}

/**
 * @param {object} input
 * @param {object} input.store     createStore()
 * @param {object} input.registry  createRegistry()
 * @param {number} input.from      window start, ms, a whole minute (inclusive)
 * @param {number} input.to        window end, ms, a whole minute (exclusive)
 * @param {object} [input.prices]  the price table, to name its version
 */
export function accountingReport({ store, registry, from, to, prices = null }) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from % MINUTE || to % MINUTE || to <= from) {
    throw new RangeError("An accounting window is a non-empty range of whole minutes.");
  }
  const devices = new Map(registry.list().map((device) => [device.id, device]));
  const team = emptyTotals();
  const people = new Map(), byDevice = new Map(), models = new Map(), sessions = new Map();
  store.eachBucket(from, to, (_minute, bucket) => {
    addBucket(team, bucket);
    addBucket(at(people, personOf(devices.get(bucket.deviceId))), bucket);
    addBucket(at(byDevice, bucket.deviceId), bucket);
    addBucket(at(models, bucket.model), bucket);
    addBucket(at(sessions, bucket.sessionHash), bucket);
  });
  const trees = new Map();
  for (const [hash, totals] of sessions) addTotals(at(trees, rootOf(store.sessions, hash)), totals);
  const sessionFacts = {};
  for (const hash of [...sessions.keys()].sort()) {
    const facts = store.sessions.get(hash);
    sessionFacts[hash] = {
      tool: facts?.tool ?? null,
      parentSessionHash: facts?.parentSessionHash ?? null,
      root: rootOf(store.sessions, hash),
      deviceId: facts?.deviceId ?? null,
      person: personOf(devices.get(facts?.deviceId)),
    };
  }
  return {
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), timeZone: "UTC" },
    prices: priceTableVersion(prices),
    coverage: coverageReport({ store, devices: [...devices.values()] }),
    team,
    people: sorted(people),
    devices: sorted(byDevice),
    models: sorted(models),
    sessions: sorted(sessions),
    sessionTrees: sorted(trees),
    sessionFacts,
  };
}

/**
 * What could not be counted (§3.2): per machine, by reason, as its collector
 * last reported it, and what this hub itself dropped. Not windowed: a
 * collector counts what it could not read in the transcripts it still reads.
 */
export function coverageReport({ store, devices }) {
  const byDevice = {};
  let dropped = 0;
  for (const device of devices) {
    const d = dropsOf(device.coverage);
    if (!d.dropped) continue;
    byDevice[device.id] = Object.fromEntries(d.reasons.map((r) => [r.kind, r.count]));
    dropped += d.dropped;
  }
  const hub = Object.fromEntries(Object.entries(store.dropped ?? {}).filter(([kind, n]) => DROP_REASONS[kind] && n > 0));
  dropped += Object.values(hub).reduce((a, n) => a + n, 0);
  return { dropped, devices: byDevice, hub };
}

/**
 * Team totals per UTC day from the hub's daily rollup, which is kept long
 * after the minute buckets are pruned. [fromDay, toDay] inclusive.
 */
export function rollupDailyTotals({ store, fromDay, toDay }) {
  const days = new Map();
  store.eachDay(fromDay, toDay, (day, bucket) => addBucket(at(days, day), bucket));
  return { timeZone: "UTC", since: store.dailySince ?? null, days: sorted(days) };
}

/** The calendar day of an instant in a named IANA time zone, as YYYY-MM-DD. */
export function calendarDay(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Team totals per calendar day in one named time zone, over [from, to). */
export function dailyTotals({ store, from, to, timeZone = "UTC" }) {
  const days = new Map();
  store.eachBucket(from, to, (minute, bucket) => addBucket(at(days, calendarDay(minute, timeZone)), bucket));
  return { timeZone, days: sorted(days) };
}
