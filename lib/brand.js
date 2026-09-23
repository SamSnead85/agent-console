/*
 * The product's name, in one place.
 *
 * Agent Console, by LockedIn Labs. The terminal banners and help text read
 * the name from here, and the tests read it from here rather than from a
 * literal, so nothing drifts.
 *
 * `AGENT_CONSOLE_NAME` and `AGENT_CONSOLE_VENDOR` override it at runtime for
 * anyone embedding this in a product of their own.
 */

export const PRODUCT_NAME = process.env.AGENT_CONSOLE_NAME || "Agent Console";
export const PRODUCT_VENDOR = process.env.AGENT_CONSOLE_VENDOR || "LockedIn Labs";

/**
 * "Agent Console · by LockedIn Labs" — the console's banner and help text.
 * With a part: "Agent Console reporter · by LockedIn Labs".
 */
export function productTitle(part = "") {
  const name = part ? `${PRODUCT_NAME} ${part}` : PRODUCT_NAME;
  return PRODUCT_VENDOR ? `${name} · by ${PRODUCT_VENDOR}` : name;
}
