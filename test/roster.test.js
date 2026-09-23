import test from "node:test";
import assert from "node:assert/strict";

import { buildRoster } from "../lib/roster.js";

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

function roster(input) {
  return buildRoster({
    rows: [],
    registry: { sessions: [] },
    muster: { available: false },
    host: HOST,
    now: NOW,
    ...input,
  });
}

test("the headline states sessions, machines and vendors, and the derivation adds up", () => {
  const r = roster({
    rows: [scanRow({ id: "aaa" }), scanRow({ id: "bbb", vendor: "codex" })],
    registry: {
      sessions: [
        {
          id: "kimi",
          sessionId: null,
          name: "Kimi",
          vendor: "kimi",
          machine: "studio.local",
          project: "checkout",
          branch: "feat/x",
          state: "LIVE",
          stale: false,
          tokens: { in: 1, out: 1, cr: 0, cw: 0 },
          agents: { live: 0, total: 0 },
          total: 2,
          at: NOW,
          author: "Sam",
        },
      ],
    },
  });
  assert.equal(r.headline, "3 sessions · 2 machines · 3 vendors");
  assert.equal(r.counts.sessions, 3);
  assert.equal(r.counts.machines, 2);
  assert.equal(r.counts.observed, 2);
  assert.equal(r.counts.registered, 1);
  assert.match(r.derivation, /2 observed on laptop\.local/u);
  // The local machine sorts first; a reader looks there before anywhere else.
  assert.equal(r.machines[0].name, HOST);
  assert.equal(r.machines[0].isLocal, true);
  assert.equal(r.machines[1].scannable, false);
});

/**
 * The whole reason the count was untrustworthy: a machine this program cannot
 * scan was simply absent. Its sessions must appear, and must be marked as not
 * locally scannable rather than dressed up as observations.
 */
test("a session on another machine appears, marked not scannable", () => {
  const r = roster({
    muster: {
      available: true,
      sessions: [
        {
          name: "STUDIO-CLAUDE",
          role: "worker",
          machine: "studio.local",
          vendor: "claude-code",
          model: null,
          status: "active",
          branch: null,
          package: "data-module",
          stale: false,
          at: NOW,
        },
      ],
    },
  });
  assert.equal(r.counts.sessions, 1);
  const remote = r.machines.find((m) => m.name === "studio.local");
  assert.equal(remote.sessions[0].scannable, false);
  assert.deepEqual(remote.sessions[0].sources, ["declared"]);
  assert.equal(remote.sessions[0].ledgerPackage, "data-module");
});

test("a registration carrying a session id is joined, never counted twice", () => {
  const r = roster({
    rows: [scanRow({ id: "aaa" })],
    registry: {
      sessions: [
        {
          id: "reg-aaa",
          sessionId: "aaa",
          name: "declared name",
          vendor: "claude",
          machine: HOST,
          project: null,
          branch: null,
          state: "LIVE",
          stale: false,
          tokens: { in: 0, out: 0, cr: 0, cw: 0 },
          agents: { live: 0, total: 0 },
          total: 0,
          at: NOW,
          author: "Dana Example",
        },
      ],
    },
  });
  assert.equal(r.counts.sessions, 1, "one session was counted twice");
  assert.equal(r.counts.joined, 1);
  const entry = r.machines[0].sessions[0];
  assert.deepEqual(entry.sources, ["observed", "registered"]);
  assert.equal(entry.joinedBy, "session id");
  // A declaration adds what the scan cannot know and overwrites nothing measured.
  assert.equal(entry.author, "Dana Example");
  assert.equal(entry.tokens, 1000, "a declaration overwrote a measured figure");
});

/**
 * The disk is the authority for its own machine. A ledger entry naming this
 * machine that matches nothing observed is either stale or a duplicate of a row
 * already on screen; counting it inflates the very figure this panel exists to
 * make trustworthy.
 */
test("an unmatched declaration about THIS machine is listed and not counted", () => {
  const r = roster({
    rows: [scanRow({ id: "aaa" })],
    muster: {
      available: true,
      sessions: [
        {
          name: "LAPTOP-ORCH",
          role: "orchestrator",
          machine: HOST,
          vendor: "claude-code",
          model: null,
          status: "active",
          branch: null,
          package: null,
          stale: false,
          at: NOW,
        },
      ],
    },
  });
  assert.equal(r.counts.sessions, 1);
  assert.equal(r.counts.unmatchedLocal, 1);
  assert.match(r.derivation, /1 declared for laptop\.local but not observed/u);
  const listed = r.machines[0].sessions.find((s) => s.unmatchedLocal);
  assert.ok(listed, "the unmatched declaration was dropped instead of shown");
  // The subtotal on a machine must agree with the headline's rule.
  assert.equal(r.machines[0].counts.sessions, 1);
  assert.equal(r.machines[0].counts.listedNotCounted, 1);
});

/**
 * A stood-down session is not running anything. Joining one to a live row on a
 * matching branch relabelled a working session with a retired session's name
 * and handed it that row's cumulative token figure.
 */
test("a stood-down ledger entry is never joined to a live row", () => {
  const r = roster({
    rows: [scanRow({ id: "aaa", branch: "feat/x", name: null })],
    muster: {
      available: true,
      sessions: [
        {
          name: "smoke-test-worker",
          role: "worker",
          machine: HOST,
          vendor: "claude-code",
          model: null,
          status: "stood-down",
          branch: "feat/x",
          package: null,
          stale: true,
          at: NOW - 3600_000,
        },
      ],
    },
  });
  const live = r.machines[0].sessions.find((s) =>
    s.sources.includes("observed"),
  );
  assert.deepEqual(
    live.sources,
    ["observed"],
    "a retired session was joined to a live row",
  );
  assert.equal(live.name, null, "a live row took a stood-down session's name");
  assert.equal(r.counts.sessions, 1);
});

test("an active ledger entry joins by a unique branch, and says so", () => {
  const r = roster({
    rows: [scanRow({ id: "aaa", branch: "feat/x" })],
    muster: {
      available: true,
      sessions: [
        {
          name: "LAPTOP-WORKER",
          role: "worker",
          machine: HOST,
          vendor: "claude-code",
          model: null,
          status: "active",
          branch: "feat/x",
          package: "pkg-1",
          stale: false,
          at: NOW,
        },
      ],
    },
  });
  assert.equal(r.counts.sessions, 1);
  const entry = r.machines[0].sessions[0];
  assert.equal(entry.joinedBy, "branch");
  assert.equal(entry.ledgerPackage, "pkg-1");
});

test("an ambiguous branch is never joined — two candidates means no evidence", () => {
  const r = roster({
    rows: [
      scanRow({ id: "aaa", branch: "feat/x" }),
      scanRow({ id: "bbb", branch: "feat/x" }),
    ],
    muster: {
      available: true,
      sessions: [
        {
          name: "LAPTOP-WORKER",
          role: "worker",
          machine: HOST,
          vendor: "claude-code",
          model: null,
          status: "active",
          branch: "feat/x",
          package: null,
          stale: false,
          at: NOW,
        },
      ],
    },
  });
  assert.equal(r.counts.joined, 0, "an ambiguous branch was joined anyway");
  assert.equal(r.counts.sessions, 2);
});

test("cold transcripts are counted separately and never as sessions", () => {
  const r = roster({
    rows: [
      scanRow({ id: "aaa" }),
      scanRow({ id: "ccc", state: "COLD", total: 500 }),
      scanRow({ id: "ddd", state: "COLD", cumulative: true, total: 9e9 }),
    ],
  });
  assert.equal(r.counts.sessions, 1);
  assert.equal(r.counts.cold, 2);
  // Σ figures are never folded into a day-scoped number, here as anywhere else.
  assert.equal(r.counts.coldTokens, 500);
});

test("a stale registration decays to STALE rather than continuing to claim it is live", () => {
  const r = roster({
    registry: {
      sessions: [
        {
          id: "kimi",
          sessionId: null,
          name: "Kimi",
          vendor: "kimi",
          machine: "studio.local",
          project: null,
          branch: null,
          state: "LIVE",
          stale: true,
          tokens: { in: 0, out: 0, cr: 0, cw: 0 },
          agents: { live: 0, total: 0 },
          total: 0,
          at: NOW - 3600_000,
          author: null,
        },
      ],
    },
  });
  const entry = r.machines.find((m) => m.name === "studio.local").sessions[0];
  assert.equal(
    entry.state,
    "STALE",
    "an unrefreshed declaration still claimed LIVE",
  );
  assert.equal(entry.declaredStale, true);
  // The claim is kept as a claim — it is what the session said about itself —
  // but it is never the word in the state column.
  assert.equal(entry.declaredState, "LIVE");
  assert.equal(entry.measured, false);
  assert.match(entry.stateReason, /not refreshed/);
  assert.equal(r.counts.live, 0, "a declaration was counted as a live session");
});

/**
 * The heading is a fact worth stating; the COUNT is about the fleet. Counting a
 * machine that is running nothing produced "1 session · 2 machines", which
 * invites the reader to hunt for a session that does not exist.
 */
test("the local machine is always a heading, but an empty one is never counted", () => {
  const empty = roster({});
  assert.equal(empty.machines.length, 1);
  assert.equal(empty.machines[0].name, HOST);
  assert.equal(empty.counts.sessions, 0);
  assert.equal(empty.headline, "0 sessions · 0 machines · 0 vendors");

  const remoteOnly = roster({
    registry: {
      sessions: [
        {
          id: "kimi",
          sessionId: null,
          name: "Kimi",
          vendor: "kimi",
          machine: "studio.local",
          project: null,
          branch: null,
          state: "LIVE",
          stale: false,
          tokens: { in: 1, out: 0, cr: 0, cw: 0 },
          agents: { live: 0, total: 0 },
          total: 1,
          at: NOW,
          author: null,
        },
      ],
    },
  });
  assert.equal(
    remoteOnly.headline,
    "1 session · 1 machine · 1 vendor",
    "an idle local machine was counted into the fleet's size",
  );
  assert.equal(remoteOnly.counts.machines, 1);
  assert.equal(remoteOnly.counts.machinesListed, 2);
  assert.equal(remoteOnly.machines[0].name, HOST, "the local heading vanished");
  assert.equal(remoteOnly.machines[0].counts.sessions, 0);
});

test("a deadheading row is surfaced on its machine's counts", () => {
  const r = roster({
    rows: [scanRow({ id: "aaa", lastTs: NOW - 40 * 60_000 })],
  });
  assert.equal(r.counts.deadhead, 1);
  assert.equal(r.machines[0].counts.deadhead, 1);
  assert.equal(r.machines[0].sessions[0].deadhead, true);
});

/**
 * "They're still connected, and we're still working with them. They're just
 * dormant for a while now. They should still be listed."
 *
 * Three sessions had gone STALE on the registration clock while their operators
 * were plainly still working — the evidence was on the shared GitHub ledger,
 * which this console read and never connected to the roster.
 */
test("a session that posted to the shared ledger is refreshed, not expired", () => {
  const r = roster({
    registry: {
      sessions: [
        {
          id: "MAC-STUDIO-CLAUDE",
          sessionId: null,
          name: "MAC-STUDIO-CLAUDE",
          vendor: "claude-code",
          machine: "studio.local",
          project: null,
          branch: "main",
          state: null,
          stale: true,
          agents: { live: 0, total: 0 },
          total: null,
          at: NOW - 4 * 3600_000,
          author: null,
        },
      ],
    },
    // Written "MAC STUDIO CLAUDE" on the ledger, "MAC-STUDIO-CLAUDE" in the
    // registration. Case and separators are the only difference the join
    // ignores.
    ledgerIdentities: [
      {
        identity: "MAC STUDIO CLAUDE",
        doing: "holding the data module",
        at: NOW - 60_000,
      },
    ],
  });
  const entry = r.machines.find((m) => m.name === "studio.local").sessions[0];
  assert.equal(
    entry.state,
    "UNKNOWN",
    "a refreshed claim was still called STALE",
  );
  assert.equal(entry.lastMentionedAt, NOW - 60_000);
  assert.equal(entry.lastMentionedDoing, "holding the data module");
  assert.match(entry.stateReason, /shared ledger/);
  // Refreshed is not measured. It must never become live.
  assert.equal(
    r.counts.live,
    0,
    "a ledger comment was counted as a live session",
  );
  assert.notEqual(entry.state, "LIVE");
  assert.notEqual(entry.state, "WARM");
});

test("an ambiguous ledger identity is attached to nothing", () => {
  const twin = (id) => ({
    id,
    sessionId: null,
    name: "WORKER",
    vendor: "claude-code",
    machine: "studio.local",
    project: null,
    branch: null,
    state: null,
    stale: true,
    agents: { live: 0, total: 0 },
    total: null,
    at: NOW - 4 * 3600_000,
    author: null,
  });
  const r = roster({
    registry: { sessions: [twin("w1"), twin("w2")] },
    ledgerIdentities: [{ identity: "worker", doing: "x", at: NOW - 60_000 }],
  });
  for (const entry of r.machines.find((m) => m.name === "studio.local")
    .sessions) {
    assert.equal(
      entry.lastMentionedAt,
      null,
      "an ambiguous identity was attached",
    );
    assert.equal(entry.state, "STALE");
  }
});

test("a mention older than the staleness window does not refresh anything", () => {
  const r = roster({
    registry: {
      sessions: [
        {
          id: "MAC-STUDIO-CLAUDE",
          sessionId: null,
          name: "MAC-STUDIO-CLAUDE",
          vendor: "claude-code",
          machine: "studio.local",
          project: null,
          branch: null,
          state: null,
          stale: true,
          agents: { live: 0, total: 0 },
          total: null,
          at: NOW - 4 * 3600_000,
          author: null,
        },
      ],
    },
    ledgerIdentities: [
      { identity: "MAC STUDIO CLAUDE", doing: "x", at: NOW - 3 * 3600_000 },
    ],
  });
  const entry = r.machines.find((m) => m.name === "studio.local").sessions[0];
  assert.equal(entry.state, "STALE");
  // It is still recorded — an old mention is information, it is just not a
  // refresh — so the row can show when the session was last heard from.
  assert.equal(entry.lastMentionedAt, NOW - 3 * 3600_000);
});

test("a ledger identity never touches a measured row", () => {
  const r = roster({
    rows: [scanRow({ id: "aaa", name: "MAC STUDIO CLAUDE" })],
    ledgerIdentities: [{ identity: "MAC STUDIO CLAUDE", doing: "x", at: NOW }],
  });
  const entry = r.machines[0].sessions[0];
  assert.equal(entry.measured, true);
  assert.equal(entry.state, "LIVE");
  assert.equal(
    entry.lastMentionedAt,
    null,
    "a declaration was allowed to overwrite something measured",
  );
});
