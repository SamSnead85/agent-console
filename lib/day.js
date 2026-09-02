/**
 * The local calendar day, in one place.
 *
 * "Today" has to mean the same thing to every part of this program. It did not:
 * commits were scoped with `git log --since=midnight` (local midnight) while the
 * PR list in the same sentence was every `pr-link` record in the 36-hour file
 * window, undecayed for the life of the process. The drawer titled "shipped
 * today" reported 67 PRs on a day whose real figure was 51, including one from
 * six weeks earlier, and the number only ever climbed.
 */

/** Local calendar day of an epoch-millisecond timestamp, as YYYY-MM-DD. */
export function dayKeyOf(ms) {
  const d = new Date(ms);
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

/** True when `ms` falls on the same local day as `now`. A zero stamp is not. */
export function isSameDay(ms, now) {
  if (!ms) return false;
  return dayKeyOf(ms) === dayKeyOf(now);
}
