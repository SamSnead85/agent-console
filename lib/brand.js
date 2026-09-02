/*
 * The product's name, in one place.
 *
 * This console began life inside the Muster CLI, where it was "Muster
 * Console". It is a standalone product now — it reads the AI coding sessions
 * on this machine and needs no fleet, no ledger, and no Git repository — so
 * carrying the old name would assert a dependency that no longer exists.
 *
 * The name is a decision the owner has not made yet, so it lives here as one
 * constant rather than being spelled twenty times across a page title, a
 * banner, a manifest, and a help text. Changing it is one edit, and the tests
 * read it from here rather than from a literal, so nothing drifts.
 *
 * `AGENT_CONSOLE_NAME` overrides it at runtime for anyone embedding this in a
 * product of their own.
 */

export const PRODUCT_NAME = process.env.AGENT_CONSOLE_NAME || "Agent Console";
export const PRODUCT_VENDOR = process.env.AGENT_CONSOLE_VENDOR || "LockedIn Labs";

/** "Agent Console · by LockedIn Labs" — the banner and the document title. */
export function productTitle() {
  return PRODUCT_VENDOR
    ? `${PRODUCT_NAME} · by ${PRODUCT_VENDOR}`
    : PRODUCT_NAME;
}
