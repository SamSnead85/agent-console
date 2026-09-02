/*
 * The per-session row model — one row per session, wherever it runs.
 *
 * This module builds one authoritative list: every session the roster knows
 * about, measured or declared, in a common row shape. A declared session fills
 * only the fields its evidence supports and renders unavailable measurements
 * as "—" or "not reported". It never inherits measured liveness or token data
 * from another row (see lib/liveness.js).
 *
 * Dual-environment on purpose, exactly like units.js: no import/export, one
 * global. The browser loads it as a plain script before app.js and the node
 * suite imports the very same file, so the row model the page paints is the row
 * model the tests exercise.
 */

"use strict";

(function () {
  /** States a declaration can produce. Nothing here was measured. */
  const DECLARED_STATES = new Set(["UNKNOWN", "STALE", "COLD"]);

  /**
   * Ledger placeholders that mean "not stated".
   *
   * A muster entry may carry the literal string "unknown" in its model field.
   * Printed straight into the MODEL column it reads as a model named unknown,
   * one column away from a STATE column where UNKNOWN is a defined word with a
   * different meaning. "The ledger said unknown" and "the ledger said nothing"
   * are the same fact, so both render as the em dash every unreported field
   * uses.
   */
  const NOT_STATED = new Set(["", "-", "?", "n/a", "na", "none", "unknown"]);

  function statedModels(models) {
    return (models || []).filter(
      (m) => m && !NOT_STATED.has(String(m).trim().toLowerCase()),
    );
  }

  /** The only states that mean "this machine measured work happening". */
  const MEASURED_LIVE = new Set(["LIVE", "WARM", "RUN", "STALL"]);

  /**
   * Sort weight for the merged list.
   *
   * Trouble first, then measured activity, then the sessions whose liveness
   * this machine cannot determine, then everything quiet. A declared row can
   * never outrank a measured one: the reader's eye should land on the sessions
   * this console can actually vouch for.
   */
  const ORDER = {
    RUN: 0,
    STALL: 1,
    DEAD: 2,
    LIVE: 3,
    WARM: 4,
    IDLE: 5,
    UNKNOWN: 6,
    STALE: 7,
    COLD: 8,
  };

  /**
   * State alone — no "declared" tie-break.
   *
   * Stable sorting preserves measured rows ahead of declarations at equal
   * weight, so an additional fractional tie-break would be redundant.
   */
  function weight(row) {
    const base = ORDER[row.state];
    return base === undefined ? 9 : base;
  }

  /**
   * A roster entry that is not on this disk, shaped as a roster row.
   *
   * Every measured field is null rather than zero. A declared session that
   * reported no tokens has not reported zero tokens, and a row that prints 0
   * where it means "not reported" is the same class of lie as one that prints
   * LIVE where it means "we cannot tell".
   */
  function declaredRow(entry, host) {
    return {
      key: entry.key,
      id: entry.fullId,
      short: entry.id,
      name: entry.name,
      project: entry.project,
      branch: entry.branch,
      vendor: entry.vendor || "other",
      models: statedModels(entry.models),
      state: entry.state,
      glyph: entry.glyph,
      // Measured columns. Null is "not reported", and renders as such.
      hot: null,
      spark: null,
      tok: null,
      total: entry.tokens,
      cumulative: !!entry.cumulative,
      priced: false,
      unpriced: false,
      cost: null,
      agentLive: entry.agentsLive || 0,
      agentCount: entry.agentsTotal || 0,
      lastTs: entry.lastSeen || null,
      // The DOING column is the widest on the row and a declared session has
      // nothing to put in it, so it carries the one sentence worth reading:
      // why this row has no numbers. Eight em dashes and a blank is a row that
      // looks broken; eight em dashes and a reason is a row that is honest.
      last: entry.lastMentionedDoing || entry.note || entry.stateReason || null,
      agents: [],
      pid: null,
      killable: false,
      // Provenance, carried on the row so the table can mark it without a
      // second panel to cross-reference.
      declared: true,
      measured: false,
      machine: entry.machine || null,
      remote: (entry.machine || null) !== host,
      evidence: entry.sources || [],
      joinedBy: entry.joinedBy || null,
      liveness: entry.liveness || "unknown",
      stateReason: entry.stateReason || null,
      declaredState: entry.declaredState || null,
      declaredStale: !!entry.declaredStale,
      author: entry.author || null,
      note: entry.note || null,
      ledgerStatus: entry.ledgerStatus || null,
      ledgerPackage: entry.ledgerPackage || null,
      unmatchedLocal: !!entry.unmatchedLocal,
      // Shared-ledger activity is evidence of a mention, not direct liveness.
      // Keep that distinction explicit in both naming and rendering.
      lastMentionedAt: entry.lastMentionedAt || null,
      lastMentionedDoing: entry.lastMentionedDoing || null,
      lastMentionedBasis: entry.lastMentionedBasis || null,
      deadhead: false,
      deadheadReason: null,
    };
  }

  /** Every roster entry, flattened out of its per-machine grouping. */
  function rosterEntries(roster) {
    const machines = (roster && roster.machines) || [];
    const out = [];
    for (const machine of machines) {
      for (const entry of machine.sessions || []) out.push(entry);
    }
    return out;
  }

  /**
   * The unified list: measured rows first, then the sessions only a
   * declaration knows about.
   *
   * @param {object} input
   * @param {Array}  input.rows the scanned roster rows (measured)
   * @param {object} input.roster lib/roster.js buildRoster() result
   * @param {string} input.host this machine's name
   */
  function buildSessionRows(input) {
    const scanned = (input && input.rows) || [];
    const roster = (input && input.roster) || null;
    const host = (roster && roster.localHost) || (input && input.host) || null;
    const entries = rosterEntries(roster);

    // The observed entries are keyed by the scanned row's own key, so the
    // provenance a scanned row gained by being joined to a declaration (an
    // author, a ledger package, a machine name) rides back onto it here rather
    // than living in a separate panel.
    const byKey = new Map();
    for (const entry of entries) {
      if (entry.scannable) byKey.set(entry.key, entry);
    }

    const rows = scanned.map((row) => {
      const entry = byKey.get(row.key) || null;
      return {
        ...row,
        declared: false,
        measured: true,
        machine: (entry && entry.machine) || host,
        remote: false,
        evidence: (entry && entry.sources) || ["observed"],
        joinedBy: (entry && entry.joinedBy) || null,
        liveness: (entry && entry.liveness) || null,
        stateReason: null,
        declaredState: (entry && entry.declaredState) || null,
        declaredStale: !!(entry && entry.declaredStale),
        author: (entry && entry.author) || null,
        note: (entry && entry.note) || null,
        ledgerStatus: (entry && entry.ledgerStatus) || null,
        ledgerPackage: (entry && entry.ledgerPackage) || null,
        lastMentionedAt: (entry && entry.lastMentionedAt) || null,
        lastMentionedDoing: (entry && entry.lastMentionedDoing) || null,
        lastMentionedBasis: (entry && entry.lastMentionedBasis) || null,
        unmatchedLocal: false,
      };
    });

    for (const entry of entries) {
      if (entry.scannable) continue;
      rows.push(declaredRow(entry, host));
    }

    // A stable sort by weight only: within a weight the server's own order
    // (trouble, then five-minute burn) survives, and so does the roster's
    // last-seen order for the declared tail.
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => weight(a.row) - weight(b.row) || a.index - b.index)
      .map((x) => x.row);
  }

  /**
   * Reconcile the headline count against the rows actually on screen.
   *
   * The header says "3 sessions" and five rows are visible, and both are right:
   * two of those rows are declarations about THIS machine that its own disk
   * does not confirm, which are listed and deliberately left out of the count.
   * A reader who adds up the rows and gets a different number from the heading
   * above them has been given two facts and no way to reconcile them, so the
   * arithmetic is printed rather than left as an exercise.
   *
   * Returns null when the two agree, because a sentence explaining that 3 is 3
   * is exactly the noise this change exists to remove.
   */
  function reconciliation(roster, shownCount) {
    if (!roster || !roster.counts) return null;
    const counted = roster.counts.sessions || 0;
    const rows = Number(shownCount) || 0;
    if (rows === counted) return null;
    const bits = [];
    if (roster.counts.unmatchedLocal)
      bits.push(
        roster.counts.unmatchedLocal +
          " declared for this machine but not on its disk (†)",
      );
    if (roster.counts.cold && rows > counted)
      bits.push("cold transcripts are not sessions");
    return (
      rows +
      " row" +
      (rows === 1 ? "" : "s") +
      " · " +
      counted +
      " counted as session" +
      (counted === 1 ? "" : "s") +
      (bits.length ? " · the difference is " + bits.join(" and ") : "")
    );
  }

  /**
   * The one line worth keeping from the sessions drawer.
   *
   * A drawer summary would duplicate the visible roster. The derivation is
   * retained because it explains count differences that cannot be inferred
   * from individual rows. It appears only when declarations, registrations,
   * joins, or unmatched local entries make that arithmetic material.
   */
  function rosterFootnote(roster) {
    if (!roster || !roster.counts) return null;
    const c = roster.counts;
    const needed =
      (c.declared || 0) > 0 ||
      (c.registered || 0) > 0 ||
      (c.joined || 0) > 0 ||
      (c.unmatchedLocal || 0) > 0;
    if (!needed) return null;
    return roster.derivation || null;
  }

  /**
   * Summarize project and repository coverage without repeating the roster's
   * session count. Repository coverage determines whether code metrics exist.
   */
  function projectsSummary(projects, periodLabel) {
    if (!projects || !projects.available) return null;
    const list = projects.projects || [];
    const withRepo = list.filter((p) => p.repo).length;
    const count = projects.count === undefined ? list.length : projects.count;
    return (
      count +
      " project" +
      (count === 1 ? "" : "s") +
      " · " +
      withRepo +
      " in a repository" +
      (periodLabel ? " · " + periodLabel : "")
    );
  }

  globalThis.FleetSessionRows = {
    DECLARED_STATES,
    MEASURED_LIVE,
    ORDER,
    buildSessionRows,
    declaredRow,
    projectsSummary,
    reconciliation,
    rosterFootnote,
  };
})();
