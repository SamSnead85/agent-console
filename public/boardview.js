/*
 * The coordination board's reading, decided in one place.
 *
 * This is the muster ledger as the sessions declared it — packages, holders,
 * write fences, recorded branch and HEAD, dependency gates, lease state — and
 * nothing on it is inferred from a transcript, a process table, or the shape
 * of a comment. That is the whole distinction the board exists to draw: the
 * roster above it MEASURES sessions on this disk; the board carries what the
 * fleet DECLARED through the CLI, wherever those sessions actually run.
 *
 * Two rules this file holds:
 *
 *  1. An absent ledger produces no rows and a reason, never a fabricated empty
 *     board. "No packages" and "could not read the ledger" are different
 *     facts, and the second must not be drawn as the first.
 *  2. Every label is derived from a field the ledger actually carries. A
 *     package with no recorded branch says "no checkpoint yet"; it is never
 *     dressed as done, and never hidden because it is embarrassing.
 *
 * Dual-environment, exactly like progressview.js: no import/export and one
 * global, so the browser loads it as a plain script and the node suite imports
 * this very file. The reading the page draws is the reading the tests exercise.
 */

"use strict";

(function () {
  /** Display order: work in motion first, reserved, then free, then finished. */
  const ORDER = {
    "in-progress": 0,
    assigned: 1,
    open: 2,
    completed: 3,
    released: 4,
  };

  /** The hue each state carries. Reclaimable overrides all of them. */
  const TONES = {
    "in-progress": "live",
    assigned: "reserved",
    open: "open",
    completed: "done",
    released: "quiet",
  };

  const TERMINAL = new Set(["completed", "released"]);

  function text(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  function list(value) {
    return Array.isArray(value)
      ? value.filter((item) => typeof item === "string" && item.trim())
      : [];
  }

  function shortSha(sha) {
    return typeof sha === "string" && sha.trim() ? sha.trim().slice(0, 10) : null;
  }

  /** The same short form the roster's LAST column uses. */
  function ageText(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400)
      return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
    return Math.floor(s / 86400) + "d";
  }

  function plural(n, singular, pluralForm) {
    return n + " " + (n === 1 ? singular : pluralForm || singular + "s");
  }

  function packageRow(p, now) {
    const status = text(p.status, "unknown");
    const terminal = TERMINAL.has(status);
    const reclaimable = !terminal && !!(p.leaseExpired || p.assignmentExpired);
    const blockedBy = list(p.blockedByIds);
    const writes = list(p.writes);
    const owner = text(p.owner, null);
    const dispatchedTo = text(p.dispatchedTo, null);
    const holder = owner || dispatchedTo;
    const branch = text(p.branch, null);
    const head = shortSha(p.headSha);
    const at = Number(p.at);
    const ageMs = Number.isFinite(at) && at > 0 ? Math.max(0, now - at) : null;

    let gate;
    if (blockedBy.length) gate = "blocked by " + blockedBy.join(", ");
    else if (reclaimable)
      gate = p.leaseExpired
        ? "lease expired · salvageable"
        : "assignment expired · reclaimable";
    // `ready` is tri-state: the raw-ledger fallback cannot compute it, and an
    // unknown must not be printed as either verdict.
    else if (status === "open")
      gate = p.ready === false ? "not ready" : p.ready === true ? "ready" : "";
    else if (status === "assigned") gate = "reserved, not yet claimed";
    else gate = "";

    let evidence;
    if (branch) evidence = head ? branch + " @ " + head : branch + " · no checkpoint yet";
    else if (terminal) evidence = "no branch recorded";
    else if (status === "in-progress") evidence = "no checkpoint yet";
    else evidence = "";

    return {
      id: text(p.id, "?"),
      title: text(p.title, text(p.id, "")),
      status,
      statusLabel: status === "in-progress" ? "in progress" : status,
      tone: reclaimable ? "reclaim" : TONES[status] || "unknown",
      terminal,
      holder,
      holderLabel: holder
        ? holder + (owner ? "" : " · not yet claimed")
        : "unclaimed",
      writes,
      fenceLabel: writes.length
        ? writes[0] + (writes.length > 1 ? "  +" + (writes.length - 1) : "")
        : "no fence declared",
      fenceTitle: writes.join("\n"),
      branch,
      head,
      evidence,
      blockedBy,
      gate,
      reclaimable,
      ready: typeof p.ready === "boolean" ? p.ready : null,
      ageMs,
      ageText: ageMs === null ? "—" : ageText(ageMs),
    };
  }

  function sourceLabel(m) {
    const sha = shortSha(m.sourceHeadSha);
    if (m.remoteConfirmed) return "remote-confirmed" + (sha ? " · " + sha : "");
    if (m.localOnly) return "local-only" + (sha ? " · " + sha : "");
    const state = text(m.sourceState, text(m.source, "source unconfirmed"));
    return state + (sha ? " · " + sha : "");
  }

  function headline(counts) {
    const parts = [];
    if (counts.inProgress) parts.push(counts.inProgress + " in progress");
    if (counts.assigned) parts.push(counts.assigned + " assigned");
    if (counts.open) parts.push(counts.open + " open");
    if (counts.completed) parts.push(counts.completed + " completed");
    if (counts.released) parts.push(counts.released + " released");
    return parts.length ? parts.join(" · ") : "no packages on the ledger";
  }

  /**
   * The whole board's reading from one served `muster` panel.
   *
   * @param {object|null} m the server's `muster` payload (lib/muster.js)
   * @param {{now?: number}} [options]
   * @returns {object} `{visible: false, reason}` or the full reading
   */
  function boardView(m, options) {
    const now = Number((options || {}).now) || Date.now();
    // `disabled` is a field rather than something the page infers from the
    // wording of `reason`. A renderer matching on message text is a proxy for
    // a state the payload can simply carry, and it breaks silently the day
    // the sentence is reworded.
    if (!m || m.enabled === false) {
      return {
        visible: false,
        disabled: true,
        reason: "ledger reads are disabled (--no-muster)",
      };
    }
    if (m.available !== true) {
      return {
        visible: false,
        disabled: false,
        reason: m.loading
          ? "first ledger read in progress…"
          : text(m.reason, "no muster ledger here"),
      };
    }

    const rows = (Array.isArray(m.packages) ? m.packages : [])
      .filter((p) => p && typeof p === "object")
      .map((p) => packageRow(p, now))
      .sort((a, b) => {
        const order = (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9);
        if (order !== 0) return order;
        // Within a state, the most recently touched first; unknown ages last.
        const ageA = a.ageMs === null ? Infinity : a.ageMs;
        const ageB = b.ageMs === null ? Infinity : b.ageMs;
        return ageA - ageB;
      });

    const counts = {
      inProgress: 0,
      assigned: 0,
      open: 0,
      completed: 0,
      released: 0,
      other: 0,
    };
    for (const row of rows) {
      if (row.status === "in-progress") counts.inProgress += 1;
      else if (row.status === "assigned") counts.assigned += 1;
      else if (row.status === "open") counts.open += 1;
      else if (row.status === "completed") counts.completed += 1;
      else if (row.status === "released") counts.released += 1;
      else counts.other += 1;
    }

    const sessions = Array.isArray(m.sessions) ? m.sessions : [];
    const machines = Array.isArray(m.machines) ? m.machines : [];
    const flagged = (Array.isArray(m.flagged) ? m.flagged : [])
      .filter((f) => f && typeof f === "object")
      .map((f) => {
        const at = Number(f.at);
        const ms = Number.isFinite(at) && at > 0 ? Math.max(0, now - at) : null;
        return {
          kind: text(f.kind, "flagged").toUpperCase(),
          from: text(f.from, "unknown"),
          to: text(f.to, "all"),
          body: text(f.body, ""),
          ageText: ms === null ? "—" : ageText(ms),
        };
      });

    // The attention line names only what is true right now. Every entry is a
    // count of a condition the ledger states, never a judgement about it.
    const attention = [];
    const reclaimable = rows.filter((r) => r.reclaimable).length;
    if (reclaimable) attention.push(plural(reclaimable, "reclaimable package"));
    const blocked = rows.filter((r) => !r.terminal && r.blockedBy.length).length;
    if (blocked) attention.push(plural(blocked, "blocked package"));
    const mismatches = sessions.filter((s) => s && s.protocolMismatch).length;
    if (mismatches)
      attention.push(plural(mismatches, "protocol mismatch", "protocol mismatches"));
    const clocks = sessions.filter((s) => s && s.clockIssue).length;
    if (clocks) attention.push(plural(clocks, "clock issue"));
    if (flagged.length) attention.push(plural(flagged.length, "flagged message"));

    return {
      visible: true,
      source: sourceLabel(m),
      protocolVersion: text(m.protocolVersion, null),
      stale: m.stale === true,
      counts,
      headline: headline(counts),
      rows,
      flagged,
      attention,
      sessionCount: sessions.length,
      machineCount: machines.length,
      staleSessions: sessions.filter((s) => s && s.stale).length,
      note: text(m.note, ""),
    };
  }

  globalThis.FleetBoard = {
    boardView,
    ORDER,
    TONES,
  };
})();
