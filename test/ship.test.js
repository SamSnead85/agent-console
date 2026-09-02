import test from "node:test";
import assert from "node:assert/strict";

import { createShipStore, refreshShipped } from "../lib/ship.js";
import { dayKeyOf, isSameDay } from "../lib/day.js";

/**
 * The drawer is titled "shipped today" and its summary line reads
 * "N commits · M merges · P PRs opened from this machine".
 *
 * Commits were scoped with `git log --since=midnight`. The PR figure was every
 * `pr-link` record still reachable in the 36-hour file window, accumulated for
 * the life of the process and never decayed — so one sentence carried two
 * different meanings of "today". Measured here: 67 reported against 51 real,
 * including a PR from six weeks earlier whose transcript file had merely been
 * touched, and a number that only ever climbed while the process ran.
 */

function prLinks(entries) {
  const map = new Map();
  for (const [number, ts] of entries) {
    map.set(String(number), { number, url: null, repo: "acme/app", ts });
  }
  return map;
}

test("the PR count is scoped to the same local day as the commit count", async () => {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const links = prLinks([
    [201, now - 60_000],
    [202, now - 3 * 3600 * 1000],
    [203, now - 6 * 7 * day], // six weeks old, still in a touched transcript
    [204, now - 2 * day],
    [205, 0], // no usable timestamp
  ]);
  // Only the two that fall on today's local calendar day are today's.
  const expected = [201, 202].filter((n) =>
    isSameDay(links.get(String(n)).ts, now),
  ).length;

  const data = await refreshShipped(createShipStore(), [], links, now);
  assert.equal(
    data.prCount,
    expected,
    "the PR count is not scoped to today: " +
      JSON.stringify(data.prs.map((p) => p.number)),
  );
  assert.ok(
    !data.prs.some((p) => p.number === 203),
    "a six-week-old PR was reported as shipped today",
  );
  assert.ok(
    !data.prs.some((p) => p.number === 205),
    "a record with no timestamp was counted as today",
  );
  assert.equal(
    data.prCountWindow,
    5,
    "the drawer must still be able to say what it left out",
  );
});

test("a day boundary is local, matching git log --since=midnight", () => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const justAfterMidnight = new Date(now);
  justAfterMidnight.setHours(0, 0, 30, 0);
  const justBeforeMidnight = new Date(now);
  justBeforeMidnight.setHours(0, 0, 0, 0);
  justBeforeMidnight.setTime(justBeforeMidnight.getTime() - 30_000);

  assert.equal(isSameDay(justAfterMidnight.getTime(), now.getTime()), true);
  assert.equal(isSameDay(justBeforeMidnight.getTime(), now.getTime()), false);
  assert.equal(dayKeyOf(now.getTime()), dayKeyOf(justAfterMidnight.getTime()));
});

test("a PR count never grows just because the process has been running longer", async () => {
  const now = Date.now();
  const links = prLinks([[301, now - 30 * 24 * 3600 * 1000]]);
  const first = await refreshShipped(createShipStore(), [], links, now);
  // Same records, a later poll: the stale record must not appear either time.
  const later = await refreshShipped(
    createShipStore(),
    [],
    links,
    now + 3600 * 1000,
  );
  assert.equal(first.prCount, 0);
  assert.equal(later.prCount, 0);
});
