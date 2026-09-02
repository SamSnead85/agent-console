/**
 * The liveness rule — one definition of LIVE, and an honest word when the
 * question cannot be answered.
 *
 * Two prior classification paths could label a row LIVE without current
 * measured activity:
 *
 *   1. A registration that supplied no state at all defaulted to LIVE
 *      (`reg.state || "LIVE"`). A session that never claimed to be running was
 *      printed as running, in the same green as a row measured off this disk.
 *   2. A muster-ledger entry whose status was "active" was rendered WARM, and
 *      WARM was inside the set that the roster counted as live. "The ledger says
 *      somebody meant to run this" is not "somebody is running this".
 *
 * Both are the same mistake: treating a DECLARATION as a MEASUREMENT. This
 * module states the rule once and makes the dishonest answer unreachable.
 *
 * MEASURED — the transcript is on this disk and was read this scan.
 *
 *   LIVE  the transcript was written to within LIVE_MS *and* the session
 *         produced tokens inside the burn window. Both halves are required:
 *         a file touch alone is motion, not work.
 *   WARM  written to within LIVE_MS, no tokens in the window.
 *   IDLE / COLD / STALL / RUN / DEAD — see lib/state.js.
 *
 * DECLARED — a session that declared itself (lib/ingest.js) or appears in the
 * muster ledger (lib/muster.js). Nothing about it can be measured from here,
 * so it can never be LIVE or WARM:
 *
 *   UNKNOWN  a fresh declaration. This console cannot scan that machine, so its
 *            liveness is unknown — and unknown is printed, not guessed.
 *   STALE    the declaration stopped being refreshed. A session that crashed
 *            cannot retract its own claim to be running, so an unrefreshed
 *            claim decays instead of standing.
 *   COLD     the ledger says the session stood down.
 *
 * DEADHEAD stays what it was: an overlay on a MEASURED row (see lib/stall.js).
 * It is a statement about a process this machine can see, so a declared row can
 * never carry it.
 */

import { LIVE_MS, STATES } from "./state.js";
import { REGISTRY_STALE_MS } from "./ingest.js";

/** States that can only come from reading this machine's disk. */
export const MEASURED_STATES = new Set([
  "LIVE",
  "WARM",
  "IDLE",
  "COLD",
  "STALL",
  "RUN",
  "DEAD",
]);

/** States that can only come from a declaration. */
export const DECLARED_STATES = new Set(["UNKNOWN", "STALE", "COLD"]);

/**
 * The states that mean "this machine measured work happening right now".
 *
 * Nothing outside this set may be counted as live, anywhere. It is deliberately
 * a subset of MEASURED_STATES: no declared state can enter it.
 */
export const MEASURED_LIVE = new Set(["LIVE", "WARM", "RUN", "STALL"]);

/** True only for a state a measurement produced and that means "running". */
export function isMeasuredLive(state) {
  return MEASURED_LIVE.has(state);
}

/**
 * The state of a session nobody here can measure.
 *
 * @param {object} input
 * @param {boolean} [input.standDown] the ledger says this session finished
 * @param {boolean} [input.stale] the declaration was not refreshed in time
 * @param {string}  [input.machine] where the declaration says it runs
 * @param {number}  [input.lastSeen] when it last refreshed, epoch ms
 * @param {number}  [input.now]
 * @returns {{state: string, glyph: string, liveness: string, reason: string}}
 */
export function classifyDeclared(input) {
  const it = input || {};
  const where = it.machine ? String(it.machine) : "another machine";
  if (it.standDown) {
    return {
      state: "COLD",
      glyph: STATES.COLD.glyph,
      liveness: "stood-down",
      reason: "the muster ledger says this session stood down.",
    };
  }
  if (it.stale) {
    return {
      state: "STALE",
      glyph: STATES.STALE.glyph,
      liveness: "stale",
      reason:
        "declared, then not refreshed for over " +
        Math.round(REGISTRY_STALE_MS / 60_000) +
        " minutes. A session that crashed cannot retract its own claim to be running, so the claim decays instead of standing.",
    };
  }
  return {
    state: "UNKNOWN",
    glyph: STATES.UNKNOWN.glyph,
    liveness: "unknown",
    reason:
      "declared from " +
      where +
      ", which this console cannot scan. Its liveness is unknown rather than live — nothing here measured it.",
  };
}

/**
 * The rule, in the words the glossary prints.
 *
 * Interpolated from the constants that enforce it, so tuning LIVE_MS or
 * REGISTRY_STALE_MS cannot leave the explanation behind.
 */
export function livenessRule() {
  const live = Math.round(LIVE_MS / 60_000);
  const stale = Math.round(REGISTRY_STALE_MS / 60_000);
  return {
    short:
      "A row reads LIVE only when this machine measured it: the transcript was written to within " +
      live +
      " minutes AND the session produced tokens in the burn window. Nothing declared can be LIVE.",
    body: [
      "LIVE — measured. The transcript file on this disk was written to within " +
        live +
        " minutes and the session produced tokens in the five-minute burn window. Both halves are required: a file touch on its own is motion, not work, and it is rendered WARM.",
      "WARM — measured. Written to within " +
        live +
        " minutes, but no tokens in the window.",
      "UNKNOWN — declared. The session registered itself or appears in the muster ledger, and it runs on a machine this console cannot scan. Nothing about it was measured, so its liveness is unknown and says so. A declaration that names a state of its own is recorded as a claim in the row facts and is never promoted to the row's state.",
      "STALE — declared, then not refreshed for over " +
        stale +
        " minutes. The claim decays rather than standing, because a session that crashed cannot retract it.",
      "COLD — either a transcript nobody has touched for a long time, or a ledger entry that stood down.",
      "Only the measured states LIVE, WARM, RUN and STALL are ever counted as live, anywhere on this screen.",
    ].join("\n"),
  };
}
