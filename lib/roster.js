/**
 * The roster — how many sessions there actually are, and where.
 *
 * The owner runs four sessions across two machines and this console showed
 * three rows. Neither figure was wrong and both were useless: the table listed
 * every locally visible TRANSCRIPT, folded the cold ones, and silently omitted
 * everything on the other machine, because a program can only scan the disk it
 * is running on. Omission is what made the count untrustworthy.
 *
 * So this module builds one list from three kinds of evidence and never hides
 * which kind a row came from:
 *
 *   observed   — scanned off this disk. Measured.
 *   registered — a session declared itself through the ingest endpoint or a
 *                drop file (lib/ingest.js). Declared.
 *   declared   — the muster ledger's roster (lib/muster.js). Declared.
 *
 * Joining is explicit and its BASIS is published. A registration that supplies
 * a session id is joined to the scanned row with that id — exactly, no
 * guessing. A ledger entry on THIS machine is joined to a scanned row when its
 * branch matches one and only one row, and the row says "joined by branch" so
 * the reader can disbelieve it. Everything else stands alone. Two rows that
 * might be the same session are never silently collapsed, and never silently
 * doubled: the count line shows the arithmetic.
 */

import { deadheadOf } from "./stall.js";
import { MEASURED_LIVE, classifyDeclared } from "./liveness.js";
import { REGISTRY_STALE_MS } from "./ingest.js";

/**
 * Fold a session name and a ledger identity onto the same key.
 *
 * "MAC-STUDIO-CLAUDE" in the muster roster and "MAC STUDIO CLAUDE" in a GitHub
 * ledger header are the same session written two ways, and nothing else on this
 * screen could tell. Case and separators are the only difference the join
 * ignores; it will not stem, abbreviate or guess.
 */
function identityKey(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, " ")
    .trim();
}

/**
 * States that mean "somebody is running this right now".
 *
 * Deliberately the MEASURED set from lib/liveness.js and nothing else. It used
 * to be a local copy, and a declared session rendered WARM slipped into it — so
 * a line reading "2 live" could be one measured session and one assertion.
 */
const RUNNING = MEASURED_LIVE;
/** States that are a session, even if quiet. COLD is not. */
const A_SESSION = new Set(["LIVE", "WARM", "RUN", "STALL", "IDLE", "DEAD"]);

/** Ledger statuses that describe a session somebody is still running. */
const LEDGER_ACTIVE = new Set(["active", "in-progress", "working"]);

function liveness(entry) {
  if (RUNNING.has(entry.state)) return "live";
  if (entry.state === "IDLE") return "idle";
  if (entry.state === "UNKNOWN") return "unknown";
  return "stale";
}

function machineKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.local$/u, "");
}

/**
 * @param {object} input
 * @param {Array}  input.rows scanned roster rows
 * @param {object} input.registry lib/ingest.js readRegistry() result
 * @param {object} input.muster lib/muster.js panel
 * @param {string} input.host this machine's hostname
 * @param {number} input.now
 */
export function buildRoster(input) {
  const now = input.now;
  const host = input.host || "this machine";
  const rows = input.rows || [];
  const registrations = (input.registry && input.registry.sessions) || [];
  const ledger =
    input.muster && input.muster.available ? input.muster.sessions || [] : [];

  const entries = [];
  const byScanId = new Map();

  // ---- observed ----------------------------------------------------------
  let coldCount = 0;
  let coldTokens = 0;
  for (const row of rows) {
    if (!A_SESSION.has(row.state)) {
      coldCount += 1;
      // Day-scoped and thread-cumulative figures are not addable, so only the
      // day-scoped ones are folded into a number under a day-scoped heading.
      if (!row.cumulative) coldTokens += row.total || 0;
      continue;
    }
    const dead = deadheadOf(row, now);
    const entry = {
      key: row.key,
      id: row.short,
      fullId: row.id,
      name: row.name || null,
      vendor: row.vendor,
      model: (row.models || [])[0] || null,
      models: row.models || [],
      machine: host,
      project: row.project,
      branch: row.branch,
      state: row.state,
      glyph: row.glyph,
      agentsLive: row.agentLive || 0,
      agentsTotal: row.agentCount || 0,
      tokens: row.total || 0,
      cumulative: !!row.cumulative,
      cost: row.priced ? row.cost : null,
      lastSeen: row.lastTs || null,
      pid: row.pid || null,
      sources: ["observed"],
      scannable: true,
      joinedBy: null,
      deadhead: dead.deadhead,
      deadheadReason: dead.reason,
      author: null,
      note: null,
      ledgerStatus: null,
      ledgerPackage: null,
      declaredStale: false,
      // Measured: the state came from reading this file. Nothing to explain.
      measured: true,
      stateReason: null,
      declaredState: null,
      lastMentionedAt: null,
      lastMentionedDoing: null,
      lastMentionedBasis: null,
    };
    entries.push(entry);
    byScanId.set(String(row.id), entry);
    byScanId.set(String(row.short), entry);
  }

  // ---- registered --------------------------------------------------------
  // A registration with a session id is an EXACT join. Everything the
  // registration declares that the scan cannot know — an author, a machine
  // other than this one, a vendor this program does not read — is overlaid;
  // nothing measured is overwritten by a declaration.
  for (const reg of registrations) {
    const joined = reg.sessionId ? byScanId.get(String(reg.sessionId)) : null;
    if (joined) {
      joined.sources.push("registered");
      joined.joinedBy = "session id";
      if (reg.author) joined.author = reg.author;
      if (reg.note) joined.note = reg.note;
      if (reg.name && !joined.name) joined.name = reg.name;
      if (reg.machine) joined.machine = reg.machine;
      joined.declaredStale = !!reg.stale;
      // What the session says about itself is kept as a CLAIM beside the
      // measurement, never in place of it.
      if (reg.state) joined.declaredState = reg.state;
      continue;
    }
    // Nothing here was measured, so the liveness rule decides the word — and
    // the rule cannot return LIVE. `reg.state` is what the session ASSERTS; it
    // is carried as a claim and never promoted to the row's state.
    const life = classifyDeclared({
      standDown: false,
      stale: !!reg.stale,
      machine: reg.machine,
      lastSeen: reg.at,
      now,
    });
    entries.push({
      key: "reg|" + reg.id,
      id: reg.id,
      fullId: reg.sessionId || reg.id,
      name: reg.name || reg.id,
      vendor: reg.vendor || "other",
      model: reg.model,
      models: reg.model ? [reg.model] : [],
      machine: reg.machine || "unstated machine",
      project: reg.project,
      branch: reg.branch,
      state: life.state,
      glyph: life.glyph,
      agentsLive: reg.agents.live,
      agentsTotal: reg.agents.total,
      tokens: reg.total,
      cumulative: false,
      cost: null,
      lastSeen: reg.at,
      pid: null,
      sources: ["registered"],
      scannable: false,
      joinedBy: null,
      deadhead: false,
      deadheadReason: null,
      author: reg.author,
      note: reg.note,
      ledgerStatus: null,
      ledgerPackage: null,
      declaredStale: !!reg.stale,
      measured: false,
      stateReason: life.reason,
      declaredState: reg.state || null,
      lastMentionedAt: null,
      lastMentionedDoing: null,
      lastMentionedBasis: null,
    });
  }

  // ---- declared (muster ledger) -----------------------------------------
  // Only a UNIQUE branch match on this machine is accepted as a join, and the
  // basis is recorded so the reader can reject it. Anything ambiguous stands
  // alone rather than being attached to a plausible row.
  for (const session of ledger) {
    const sameMachine = machineKey(session.machine) === machineKey(host);
    const active = LEDGER_ACTIVE.has(session.status);
    let joined = null;
    // A session that has stood down is not running anything, so it is never
    // attached to a row that is. Joining one to a live transcript on the same
    // branch relabelled a working session with a retired session's name and
    // handed it that row's 26 billion cumulative tokens.
    if (active && sameMachine && session.branch) {
      const candidates = entries.filter(
        (e) => e.scannable && e.branch === session.branch,
      );
      if (candidates.length === 1) joined = candidates[0];
    }
    if (!joined && active) {
      const byName = entries.filter(
        (e) => e.name && session.name && e.name === session.name,
      );
      if (byName.length === 1) {
        joined = byName[0];
        joined.joinedBy = "declared name";
      }
    } else if (joined) {
      joined.joinedBy = joined.joinedBy || "branch";
    }
    if (joined) {
      if (!joined.sources.includes("declared")) joined.sources.push("declared");
      joined.ledgerStatus = session.status;
      joined.ledgerPackage = session.package;
      if (!joined.name) joined.name = session.name;
      continue;
    }
    // Same rule as a registration: a ledger row is a declaration. "active" in
    // the ledger used to render WARM, and WARM was counted as live — so the
    // headline could report a live session that nothing had measured.
    const life = classifyDeclared({
      standDown: !active,
      stale: !!session.stale,
      machine: session.machine,
      lastSeen: session.at,
      now,
    });
    entries.push({
      key: "muster|" + session.name,
      id: session.name,
      fullId: session.name,
      name: session.name,
      vendor: session.vendor,
      model: session.model,
      models: session.model ? [session.model] : [],
      machine: session.machine,
      project: null,
      branch: session.branch,
      state: life.state,
      glyph: life.glyph,
      agentsLive: 0,
      agentsTotal: 0,
      tokens: null,
      cumulative: false,
      cost: null,
      lastSeen: session.at,
      pid: null,
      sources: ["declared"],
      scannable: false,
      joinedBy: null,
      deadhead: false,
      deadheadReason: null,
      author: null,
      note:
        session.note || (session.package ? "holding " + session.package : null),
      ledgerStatus: session.status,
      ledgerPackage: session.package,
      declaredStale: !!session.stale,
      measured: false,
      stateReason: life.reason,
      declaredState: session.status || null,
      lastMentionedAt: null,
      lastMentionedDoing: null,
      lastMentionedBasis: null,
      role: session.role,
      // A declaration about THIS machine that matched nothing on this machine's
      // disk. Listed, explained, and deliberately not counted — see below.
      unmatchedLocal: sameMachine,
    });
  }

  // ---- last mentioned on the shared ledger -------------------------------
  //
  // "They're still connected, and we're still working with them. They're just
  // dormant for a while now."
  //
  // A registration goes stale on its own clock, and three sessions had gone
  // stale by it while their operators were plainly still working — because the
  // evidence that they were working was on the GitHub ledger, which this panel
  // read but never connected to the roster.
  //
  // Two rules keep the join honest. The word is LAST MENTIONED, not "last
  // declared": lib/fleet.js anchors its identity match at the start of the
  // line, so a header IS conventionally a self-declaration, but the convention
  // is a convention and this console cannot see intent. And an ambiguous
  // identity is never attached — one candidate or nothing, the same rule the
  // branch join uses. A refresh on the shared ledger does lift a claim out of
  // STALE, because refreshing is exactly what STALE says stopped happening; it
  // never makes a row LIVE, because none of this was measured.
  const mentions = new Map();
  for (const m of input.ledgerIdentities || []) {
    const key = identityKey(m.identity);
    if (!key) continue;
    const prev = mentions.get(key);
    if (!prev || (m.at || 0) > (prev.at || 0)) mentions.set(key, m);
  }
  if (mentions.size) {
    for (const [key, mention] of mentions) {
      const candidates = entries.filter(
        (e) =>
          !e.measured &&
          (identityKey(e.name) === key || identityKey(e.id) === key),
      );
      if (candidates.length !== 1) continue;
      const entry = candidates[0];
      entry.lastMentionedAt = mention.at || null;
      entry.lastMentionedDoing = mention.doing || null;
      entry.lastMentionedBasis = "ledger identity, matched on name";
      if (
        entry.state === "STALE" &&
        mention.at &&
        now - mention.at <= REGISTRY_STALE_MS
      ) {
        const life = classifyDeclared({
          standDown: false,
          stale: false,
          machine: entry.machine,
          lastSeen: mention.at,
          now,
        });
        entry.state = life.state;
        entry.glyph = life.glyph;
        entry.declaredStale = false;
        entry.stateReason =
          life.reason +
          " Its registration had gone stale, but it posted to the shared ledger " +
          Math.max(1, Math.round((now - mention.at) / 60_000)) +
          "m ago, so the claim is refreshed rather than expired.";
      }
    }
  }

  // ---- counting ----------------------------------------------------------
  //
  // Two rules, from one principle: whichever source can actually see a machine
  // is authoritative for it.
  //
  //  - On a machine this console CAN scan, the disk is the authority. A ledger
  //    entry naming this machine that matched no observed session is either
  //    stale or describes a session that has written no transcript, and adding
  //    it would inflate the count with a duplicate of a row already on screen.
  //    It is listed, marked, and left out of the total.
  //  - On a machine it CANNOT scan, a declaration is the only evidence there
  //    is, so it counts. This is the whole reason the remote sessions stopped
  //    being invisible.
  //
  // A row that is not a session anybody is running (COLD, stood down) is listed
  // but never counted either.
  const counted = entries.filter(
    (e) => e.state !== "COLD" && !e.unmatchedLocal,
  );
  const unmatchedLocal = entries.filter((e) => e.unmatchedLocal).length;
  // The local machine is always a ROW, even with nothing running on it: "this
  // machine has no session" is a fact worth stating, and a vanished heading
  // reads as a broken panel. It is not always COUNTED, though — the headline
  // describes the fleet, and a machine running nothing is not part of it.
  // Counting it read "1 session · 2 machines", which invites the reader to look
  // for a session that does not exist.
  const activeMachines = Array.from(new Set(counted.map((e) => e.machine)));
  // Listed is not the same as counted. A machine whose only entry has stood
  // down was dropped from the list entirely, so the entry it held never reached
  // the screen at all — silent omission, which is the exact failure this module
  // exists to prevent. Every machine any entry names is listed; the COUNT still
  // comes from `counted` alone, so no total moves.
  const machineNames = Array.from(
    new Set([host, ...activeMachines, ...entries.map((e) => e.machine)]),
  );
  machineNames.sort((a, b) =>
    a === host ? -1 : b === host ? 1 : a < b ? -1 : 1,
  );
  const vendors = Array.from(new Set(counted.map((e) => e.vendor))).sort();

  const machines = machineNames.map((name) => {
    const list = entries
      .filter((e) => e.machine === name)
      .sort(
        (a, b) =>
          (b.state === "COLD" ? -1 : 1) - (a.state === "COLD" ? -1 : 1) ||
          (b.lastSeen || 0) - (a.lastSeen || 0),
      );
    return {
      name,
      isLocal: name === host,
      scannable: list.some((e) => e.scannable),
      sessions: list.map((e) => ({ ...e, liveness: liveness(e) })),
      counts: {
        // The same rule as the headline, or a machine's own subtotal would not
        // add up to the total printed above it.
        sessions: list.filter((e) => e.state !== "COLD" && !e.unmatchedLocal)
          .length,
        live: list.filter((e) => RUNNING.has(e.state) && !e.unmatchedLocal)
          .length,
        deadhead: list.filter((e) => e.deadhead).length,
        listedNotCounted: list.filter(
          (e) => e.state === "COLD" || e.unmatchedLocal,
        ).length,
      },
    };
  });

  const observed = counted.filter((e) => e.sources.includes("observed")).length;
  const registered = counted.filter((e) =>
    e.sources.includes("registered"),
  ).length;
  const declared = counted.filter((e) => e.sources.includes("declared")).length;
  const joined = counted.filter((e) => e.sources.length > 1).length;

  return {
    headline:
      counted.length +
      " session" +
      (counted.length === 1 ? "" : "s") +
      " · " +
      activeMachines.length +
      " machine" +
      (activeMachines.length === 1 ? "" : "s") +
      " · " +
      vendors.length +
      " vendor" +
      (vendors.length === 1 ? "" : "s"),
    counts: {
      sessions: counted.length,
      machines: activeMachines.length,
      machinesListed: machineNames.length,
      vendors: vendors.length,
      // Measured-live only. See lib/liveness.js: a declaration can never
      // enter this figure, whatever state it claims for itself.
      live: counted.filter((e) => RUNNING.has(e.state)).length,
      // Sessions that exist and whose liveness this machine cannot determine.
      // Reported separately rather than folded into `live` or left out.
      unknown: counted.filter((e) => e.state === "UNKNOWN").length,
      stale: counted.filter((e) => e.state === "STALE").length,
      deadhead: counted.filter((e) => e.deadhead).length,
      observed,
      registered,
      declared,
      joined,
      unmatchedLocal,
      cold: coldCount,
      coldTokens,
    },
    vendors,
    machines,
    localHost: host,
    // The arithmetic, in words, so the headline count is checkable rather than
    // asserted. This is the line the owner reads when the count surprises them.
    derivation:
      observed +
      " observed on " +
      host +
      " · " +
      registered +
      " registered · " +
      declared +
      " declared in the muster ledger · " +
      joined +
      " of those are the same session seen twice and are counted once · " +
      unmatchedLocal +
      " declared for " +
      host +
      " but not observed on its disk, so not counted · " +
      coldCount +
      " cold transcript" +
      (coldCount === 1 ? "" : "s") +
      " not counted as sessions",
    note: "Only this machine's disk can be scanned. A session elsewhere appears here because it declared itself, and is marked as not locally scannable rather than being left out. A declared session is never rendered LIVE and is never counted as live: its liveness is unknown from here, and unknown is what the row says.",
  };
}
