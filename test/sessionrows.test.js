import test from "node:test";
import assert from "node:assert/strict";

import { buildRoster } from "../lib/roster.js";

// The SAME file the page loads, not a copy of its logic: public/sessionrows.js
// contains no import/export and assigns one global, so it is a classic script
// in the browser and an importable module here.
await import("../public/sessionrows.js");
const { buildSessionRows, projectsSummary, reconciliation, rosterFootnote } =
  globalThis.FleetSessionRows;

const NOW = 1_788_000_000_000;
const HOST = "laptop.local";

function scanRow(over) {
  return {
    key: "slug|" + (over.id || "a"),
    id: over.id || "a",
    short: (over.id || "a").slice(0, 8),
    name: null,
    vendor: "claude",
    models: ["claude-opus-5"],
    project: "app",
    branch: "main",
    state: "LIVE",
    glyph: "●",
    hot: 5000,
    spark: [1, 2, 3],
    tok: { in: 1, out: 2, cw: 3, cr: 4 },
    agentLive: 0,
    agentCount: 0,
    total: 1000,
    cumulative: false,
    priced: true,
    cost: 1,
    lastTs: NOW - 30_000,
    pid: 100,
    pidAlive: true,
    ...over,
  };
}

function fixture(input) {
  const rows = (input && input.rows) || [];
  const roster = buildRoster({
    rows,
    registry: { sessions: (input && input.registrations) || [] },
    muster:
      input && input.ledger
        ? { available: true, sessions: input.ledger }
        : { available: false },
    host: HOST,
    now: NOW,
  });
  return { rows, roster };
}

function registration(over) {
  return {
    id: "kimi",
    sessionId: null,
    name: "Kimi",
    vendor: "kimi",
    machine: "studio.local",
    project: null,
    branch: "feat/x",
    state: null,
    stale: false,
    agents: { live: 0, total: 0 },
    total: null,
    at: NOW,
    author: null,
    note: null,
    ...over,
  };
}

/** Every declared or measured session belongs in the primary roster. */
test("every session is a row, including the ones this machine cannot scan", () => {
  const f = fixture({
    rows: [scanRow({ id: "aaa" })],
    registrations: [registration({})],
    ledger: [
      {
        name: "STUDIO-ORCH",
        role: "orchestrator",
        machine: "studio.local",
        vendor: "claude-code",
        model: null,
        status: "active",
        branch: "main",
        package: "W3",
        stale: false,
        at: NOW,
      },
    ],
  });
  const rows = buildSessionRows(f);
  assert.equal(rows.length, 3, "a session known to the roster is not a row");
  assert.equal(
    rows.filter((r) => r.declared).length,
    2,
    "the declared sessions did not become rows",
  );
  // Row shape: whatever the table asks a scanned row for, a declared row
  // answers too, so one renderer paints both.
  for (const key of [
    "key",
    "state",
    "glyph",
    "project",
    "branch",
    "vendor",
    "models",
    "hot",
    "total",
    "cost",
    "agentLive",
    "agentCount",
    "lastTs",
  ]) {
    for (const row of rows) {
      assert.ok(key in row, "row is missing " + key);
    }
  }
});

test("a declared row reports null, never zero, for what nobody measured", () => {
  const f = fixture({ registrations: [registration({ total: null })] });
  const row = buildSessionRows(f).find((r) => r.declared);
  assert.equal(row.hot, null, "0 tokens in 5m would be a measurement");
  assert.equal(row.tok, null);
  assert.equal(row.total, null);
  assert.equal(row.cost, null);
  assert.equal(row.priced, false);
  assert.equal(row.unpriced, false, "unpriced would blame the price table");
  assert.equal(row.spark, null);
  assert.equal(row.pid, null);
  assert.equal(row.killable, false);
});

test("a declared row is marked as declared, with its machine and its evidence", () => {
  const f = fixture({ registrations: [registration({})] });
  const row = buildSessionRows(f).find((r) => r.declared);
  assert.equal(row.measured, false);
  assert.equal(row.machine, "studio.local");
  assert.equal(row.remote, true);
  assert.deepEqual(row.evidence, ["registered"]);
  assert.ok(row.stateReason, "an UNKNOWN row with no reason is just a shrug");
  // The widest column carries the reason rather than a blank, so the row of em
  // dashes reads as "nothing was measured" rather than as a broken row.
  assert.equal(row.last, row.stateReason);
});

test("a declared row's own note outranks the state reason in the doing column", () => {
  const f = fixture({
    registrations: [registration({ note: "holding W3 for the studio" })],
  });
  const row = buildSessionRows(f).find((r) => r.declared);
  assert.equal(row.last, "holding W3 for the studio");
});

/**
 * A muster entry can carry the literal string "unknown" as its model. Printed
 * straight through it reads as a model called unknown, one column away from a
 * STATE column where UNKNOWN is a defined word meaning something else.
 */
test("a placeholder model is not stated, and renders as unreported", () => {
  for (const value of ["unknown", "UNKNOWN", "n/a", "-", "?", "", "  none "]) {
    const f = fixture({ registrations: [registration({ model: value })] });
    const row = buildSessionRows(f).find((r) => r.declared);
    assert.deepEqual(row.models, [], "kept the placeholder " + value);
  }
  const real = fixture({ registrations: [registration({ model: "kimi-k2" })] });
  assert.deepEqual(buildSessionRows(real).find((r) => r.declared).models, [
    "kimi-k2",
  ]);
});

/**
 * A declaration naming THIS machine that matches nothing on this machine's
 * disk is listed and left out of the count. The row has to carry that, or the
 * reader adds it up by hand and gets a different number from the headline.
 */
test("a declaration about this machine that matched nothing is flagged on its row", () => {
  const f = fixture({
    rows: [scanRow({ id: "aaa" })],
    ledger: [
      {
        name: "GHOST",
        role: "worker",
        machine: HOST,
        vendor: "claude-code",
        model: "unknown",
        status: "active",
        branch: "some/other/branch",
        package: null,
        stale: false,
        at: NOW,
      },
    ],
  });
  const row = buildSessionRows(f).find((r) => r.declared);
  assert.equal(row.unmatchedLocal, true);
  assert.equal(row.remote, false, "it claims to be on this very machine");
  assert.equal(f.roster.counts.sessions, 1, "the ghost was counted");
  assert.equal(f.roster.counts.unmatchedLocal, 1);
});

test("a declared row can never be LIVE, and never outranks a measured one", () => {
  const f = fixture({
    rows: [scanRow({ id: "aaa", state: "IDLE", glyph: "○", hot: 0 })],
    registrations: [registration({ state: "LIVE" })],
  });
  const rows = buildSessionRows(f);
  const declared = rows.find((r) => r.declared);
  assert.notEqual(declared.state, "LIVE");
  assert.equal(declared.state, "UNKNOWN");
  assert.equal(
    declared.declaredState,
    "LIVE",
    "the claim was thrown away rather than kept as a claim",
  );
  // Measured IDLE still sorts above declared UNKNOWN: the eye should land on
  // the rows this console can vouch for.
  assert.equal(rows[0].measured, true);
  assert.equal(rows[1].declared, true);
});

test("trouble still sorts first, whatever else is on the roster", () => {
  const f = fixture({
    rows: [
      scanRow({ id: "aaa", state: "LIVE" }),
      scanRow({ id: "bbb", state: "RUN", glyph: "▲" }),
      scanRow({ id: "ccc", state: "COLD", glyph: "·", hot: 0 }),
    ],
    registrations: [registration({})],
  });
  const rows = buildSessionRows(f);
  assert.deepEqual(
    rows.map((r) => r.state),
    ["RUN", "LIVE", "UNKNOWN", "COLD"],
  );
});

/**
 * COLD is the one word both vocabularies can produce, so it is the one place a
 * declared row and a measured row can collide on rank. The measured one wins.
 */
test("in the one state both vocabularies share, the measured row comes first", () => {
  const f = fixture({
    rows: [scanRow({ id: "aaa", state: "COLD", glyph: "·", hot: 0 })],
    ledger: [
      {
        name: "OLD-WORKER",
        role: "worker",
        machine: "studio.local",
        vendor: "claude-code",
        model: null,
        status: "stood-down",
        branch: null,
        package: null,
        stale: false,
        at: NOW - 3600_000,
      },
    ],
  });
  const rows = buildSessionRows(f);
  assert.deepEqual(
    rows.map((r) => r.declared),
    [false, true],
    "a declaration sorted ahead of a measurement in the same state",
  );
});

test("the server's own order survives inside a state band", () => {
  const f = fixture({
    rows: [
      scanRow({ id: "aaa", hot: 10 }),
      scanRow({ id: "bbb", hot: 900 }),
      scanRow({ id: "ccc", hot: 400 }),
    ],
  });
  // buildSessionRows must not re-sort by burn: the server already ordered these
  // by trouble then five-minute burn, and a second opinion here would fight it.
  assert.deepEqual(
    buildSessionRows(f).map((r) => r.short),
    ["aaa", "bbb", "ccc"],
  );
});

test("a scanned row joined to a declaration keeps the measurement and gains the provenance", () => {
  const f = fixture({
    rows: [scanRow({ id: "aaa" })],
    registrations: [
      registration({
        id: "reg-a",
        sessionId: "aaa",
        author: "sam",
        state: "LIVE",
      }),
    ],
  });
  const rows = buildSessionRows(f);
  assert.equal(rows.length, 1, "one session became two rows");
  const row = rows[0];
  assert.equal(row.measured, true);
  assert.equal(row.declared, false);
  assert.equal(row.state, "LIVE", "the measurement was overwritten");
  assert.equal(row.total, 1000);
  assert.equal(row.author, "sam");
  assert.equal(row.joinedBy, "session id");
  assert.deepEqual(row.evidence, ["observed", "registered"]);
});

// ------------------------------------------------------- redundancy collapse

/**
 * "Remove the rest of those lines that are overlapping. It seems like a lot of
 * information that's not needed."
 */
test("the footnote appears only when there is arithmetic the rows cannot show", () => {
  // Nothing but observed rows: the count is the row count, and a sentence
  // explaining a sum of one is the noise that was asked to be removed.
  const plain = fixture({ rows: [scanRow({ id: "aaa" })] });
  assert.equal(rosterFootnote(plain.roster), null);

  // A declared session, a join, or an uncounted local declaration all make the
  // count differ from what the rows alone would suggest — so it is explained.
  const mixed = fixture({
    rows: [scanRow({ id: "aaa" })],
    registrations: [registration({})],
  });
  const note = rosterFootnote(mixed.roster);
  assert.ok(note, "the count changed and nothing explained it");
  assert.match(note, /observed/);
  assert.match(note, /declared/);

  assert.equal(rosterFootnote(null), null);
  assert.equal(rosterFootnote({}), null);
});

test("the projects summary drops what the roster already says", () => {
  const projects = {
    available: true,
    count: 2,
    liveCount: 3,
    projects: [{ repo: { name: "a" } }, { repo: null }],
  };
  const line = projectsSummary(projects, "last 24 hours");
  assert.equal(line, "2 projects · 1 in a repository · last 24 hours");
  assert.doesNotMatch(
    line,
    /live/,
    "the live-session count is the roster's headline said twice",
  );
  assert.equal(projectsSummary({ available: false }), null);
  assert.equal(projectsSummary(null), null);
});

test("a lone project is singular, and a period label is optional", () => {
  assert.equal(
    projectsSummary(
      { available: true, count: 1, projects: [{ repo: { name: "a" } }] },
      "",
    ),
    "1 project · 1 in a repository",
  );
});

test("no roster at all still yields the scanned rows", () => {
  const rows = buildSessionRows({
    rows: [scanRow({ id: "aaa" })],
    roster: null,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].measured, true);
  assert.deepEqual(rows[0].evidence, ["observed"]);
  assert.deepEqual(buildSessionRows({}), []);
});

// ----------------------------------------------------- count vs rows on screen

/**
 * "If the header says three sessions, three rows appear, and if those numbers
 * can ever disagree the header explains why rather than leaving him to notice."
 *
 * They can disagree, legitimately: a declaration naming THIS machine that the
 * disk does not confirm is listed and not counted. So the arithmetic is
 * printed — but only when it is needed.
 */
test("when the rows and the count agree, nothing explains the agreement", () => {
  const f = fixture({ rows: [scanRow({ id: "aaa" }), scanRow({ id: "bbb" })] });
  assert.equal(f.roster.counts.sessions, 2);
  assert.equal(reconciliation(f.roster, 2), null);
  assert.equal(reconciliation(null, 2), null);
});

test("when they disagree, the difference is named", () => {
  const f = fixture({
    rows: [scanRow({ id: "aaa" })],
    ledger: [
      {
        name: "GHOST",
        role: "worker",
        machine: HOST,
        vendor: "claude-code",
        model: null,
        status: "active",
        branch: "some/other/branch",
        package: null,
        stale: false,
        at: NOW,
      },
    ],
  });
  // One measured row plus one listed-not-counted declaration: two rows, one
  // counted session.
  const rows = buildSessionRows(f);
  assert.equal(rows.length, 2);
  assert.equal(f.roster.counts.sessions, 1);
  const line = reconciliation(f.roster, rows.length);
  assert.match(line, /^2 rows · 1 counted as session/);
  assert.match(line, /declared for this machine but not on its disk/);
  assert.match(
    line,
    /†/,
    "the marker in the line is not the marker on the row",
  );
});

test("a lone row and a lone session are stated in the singular", () => {
  const f = fixture({
    rows: [],
    ledger: [
      {
        name: "GHOST",
        role: "worker",
        machine: HOST,
        vendor: "claude-code",
        model: null,
        status: "active",
        branch: "x",
        package: null,
        stale: false,
        at: NOW,
      },
    ],
  });
  assert.match(reconciliation(f.roster, 1), /^1 row · 0 counted as sessions/);
});
