import test from "node:test";
import assert from "node:assert/strict";

// The SAME file the page loads, not a copy of its logic: public/boardview.js
// contains no import/export and assigns one global, so it is a classic script
// in the browser and an importable module here. The rows the board draws are
// the rows these tests exercise.
await import("../public/boardview.js");
const { boardView } = globalThis.FleetBoard;

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const MINUTE = 60_000;

/** What lib/muster.js serves for a small live fleet. */
function served(overrides) {
  return {
    available: true,
    enabled: true,
    at: NOW,
    source: "muster status --json",
    sourceState: "remote-confirmed",
    sourceHeadSha: "8366ff291d35a1b2c3d4",
    remoteConfirmed: true,
    localOnly: false,
    protocolVersion: "1.1.0",
    sessions: [
      { name: "LAPTOP-ORCH", role: "orchestrator", machine: "laptop", stale: false, protocolMismatch: false, clockIssue: null },
      { name: "STUDIO-CODEX", role: "worker", machine: "studio", stale: true, protocolMismatch: true, clockIssue: null },
    ],
    machines: ["laptop", "studio"],
    packages: [
      {
        id: "docs-refresh",
        title: "Refresh the docs site",
        status: "open",
        owner: null,
        dispatchedTo: null,
        writes: ["docs/**"],
        blockedByIds: [],
        ready: true,
        leaseExpired: false,
        assignmentExpired: false,
        branch: null,
        headSha: null,
        at: NOW - 40 * MINUTE,
      },
      {
        id: "auth-hardening",
        title: "Harden the auth endpoints",
        status: "in-progress",
        owner: "STUDIO-CODEX",
        dispatchedTo: null,
        writes: ["src/auth/**", "src/lib/session/**", "src/lib/tokens/**"],
        blockedByIds: [],
        ready: true,
        leaseExpired: true,
        assignmentExpired: false,
        branch: "feat/auth-rate-limit",
        headSha: "ae881c99861ac7e1b0d1",
        at: NOW - 53 * MINUTE,
      },
      {
        id: "payments-retry",
        title: "Retry logic for payment webhooks",
        status: "in-progress",
        owner: "DESKTOP-OPENCODE",
        dispatchedTo: null,
        writes: ["src/payments/**"],
        blockedByIds: [],
        ready: true,
        leaseExpired: false,
        assignmentExpired: false,
        branch: null,
        headSha: null,
        at: NOW - 2 * MINUTE,
      },
      {
        id: "auth-contract",
        title: "Publish the auth contract",
        status: "open",
        owner: null,
        dispatchedTo: null,
        writes: ["src/lib/contracts/**"],
        blockedByIds: ["auth-hardening"],
        ready: false,
        leaseExpired: false,
        assignmentExpired: false,
        branch: null,
        headSha: null,
        at: NOW - 30 * MINUTE,
      },
      {
        id: "ci-matrix",
        title: "Windows lane",
        status: "assigned",
        owner: null,
        dispatchedTo: "CI-REVIEWER",
        writes: [".github/workflows/**"],
        blockedByIds: [],
        ready: true,
        leaseExpired: false,
        assignmentExpired: false,
        branch: null,
        headSha: null,
        at: NOW - 10 * MINUTE,
      },
      {
        id: "docs-proof",
        title: "Replace claims with evidence",
        status: "completed",
        owner: "STUDIO-DOCS",
        dispatchedTo: null,
        writes: ["README.md"],
        blockedByIds: [],
        ready: true,
        leaseExpired: false,
        assignmentExpired: false,
        branch: "docs/installation-proof",
        headSha: "c0ffee0021aa",
        at: NOW - 90 * MINUTE,
      },
    ],
    flagged: [
      {
        kind: "blocked",
        from: "DESKTOP-OPENCODE",
        to: "LAPTOP-ORCH",
        body: "BLOCKED: need the rotated webhook header from auth-hardening",
        at: NOW - 1 * MINUTE,
      },
    ],
    note: "declared by each session through the muster CLI",
    ...overrides,
  };
}

test("an absent, disabled, or loading ledger produces a reason and no rows — never an empty board", () => {
  // `disabled` is a field, not something the page reads out of the sentence:
  // a renderer matching on message text is a proxy for a state the payload
  // can carry, and it breaks silently when the wording changes.
  assert.deepEqual(boardView(null, { now: NOW }), {
    visible: false,
    disabled: true,
    reason: "ledger reads are disabled (--no-muster)",
  });
  assert.deepEqual(boardView({ enabled: false }, { now: NOW }), {
    visible: false,
    disabled: true,
    reason: "ledger reads are disabled (--no-muster)",
  });
  assert.equal(
    boardView({ enabled: true, available: false }, { now: NOW }).disabled,
    false,
    "an unreadable ledger is not a disabled one — the band must stay and say why",
  );
  assert.equal(
    boardView({ enabled: true, available: false, loading: true }, { now: NOW }).reason,
    "first ledger read in progress…",
  );
  assert.equal(
    boardView(
      { enabled: true, available: false, reason: "no muster ledger here — run `muster init`" },
      { now: NOW },
    ).reason,
    "no muster ledger here — run `muster init`",
  );
  assert.equal(
    boardView({ enabled: true, available: false }, { now: NOW }).reason,
    "no muster ledger here",
  );
});

test("packages are ordered work-in-motion first, then reserved, free, finished — most recent first within a state", () => {
  const v = boardView(served(), { now: NOW });
  assert.equal(v.visible, true);
  assert.deepEqual(
    v.rows.map((r) => r.id),
    ["payments-retry", "auth-hardening", "ci-matrix", "auth-contract", "docs-refresh", "docs-proof"],
  );
  assert.equal(v.headline, "2 in progress · 1 assigned · 2 open · 1 completed");
  assert.equal(v.counts.inProgress, 2);
  assert.equal(v.counts.open, 2);
  assert.equal(v.counts.completed, 1);
});

test("every label comes from a ledger field: holder, fence, evidence, gate, age", () => {
  const rows = new Map(boardView(served(), { now: NOW }).rows.map((r) => [r.id, r]));

  const payments = rows.get("payments-retry");
  assert.equal(payments.statusLabel, "in progress");
  assert.equal(payments.tone, "live");
  assert.equal(payments.holderLabel, "DESKTOP-OPENCODE");
  assert.equal(payments.fenceLabel, "src/payments/**");
  // No branch was ever checkpointed: say so, never dress it as progress.
  assert.equal(payments.evidence, "no checkpoint yet");
  assert.equal(payments.gate, "");
  assert.equal(payments.ageText, "2m");

  const auth = rows.get("auth-hardening");
  // An expired lease overrides the state's own hue and names the remedy.
  assert.equal(auth.tone, "reclaim");
  assert.equal(auth.reclaimable, true);
  assert.equal(auth.gate, "lease expired · salvageable");
  assert.equal(auth.evidence, "feat/auth-rate-limit @ ae881c9986");
  // Three fences: the first is shown, the rest are counted and carried in
  // full on the hover so nothing declared is lost.
  assert.equal(auth.fenceLabel, "src/auth/**  +2");
  assert.equal(auth.fenceTitle, "src/auth/**\nsrc/lib/session/**\nsrc/lib/tokens/**");

  const contract = rows.get("auth-contract");
  assert.equal(contract.tone, "open");
  assert.equal(contract.gate, "blocked by auth-hardening");
  assert.equal(contract.holderLabel, "unclaimed");
  assert.equal(contract.evidence, "");

  const ci = rows.get("ci-matrix");
  assert.equal(ci.tone, "reserved");
  assert.equal(ci.holderLabel, "CI-REVIEWER · not yet claimed");
  assert.equal(ci.gate, "reserved, not yet claimed");

  const docs = rows.get("docs-refresh");
  assert.equal(docs.gate, "ready");

  const proof = rows.get("docs-proof");
  assert.equal(proof.tone, "done");
  assert.equal(proof.terminal, true);
  assert.equal(proof.evidence, "docs/installation-proof @ c0ffee0021");
  assert.equal(proof.ageText, "1h30m");
});

test("a terminal package is never reclaimable, and a package with no fence says so", () => {
  const v = boardView(
    served({
      sessions: [],
      flagged: [],
      packages: [
        {
          id: "old",
          title: "Old",
          status: "released",
          owner: "GONE",
          writes: [],
          blockedByIds: [],
          leaseExpired: true,
          assignmentExpired: false,
          branch: null,
          headSha: null,
          at: NOW - 5 * MINUTE,
        },
      ],
    }),
    { now: NOW },
  );
  const [row] = v.rows;
  assert.equal(row.reclaimable, false);
  assert.equal(row.tone, "quiet");
  assert.equal(row.fenceLabel, "no fence declared");
  assert.equal(row.evidence, "no branch recorded");
  assert.equal(v.headline, "1 released");
  assert.deepEqual(v.attention, []);
});

test("the attention line counts only conditions the ledger states", () => {
  const v = boardView(served(), { now: NOW });
  assert.deepEqual(v.attention, [
    "1 reclaimable package",
    "1 blocked package",
    "1 protocol mismatch",
    "1 flagged message",
  ]);
  assert.equal(v.flagged.length, 1);
  assert.equal(v.flagged[0].kind, "BLOCKED");
  assert.equal(v.flagged[0].from, "DESKTOP-OPENCODE");
  assert.equal(v.flagged[0].ageText, "1m");
  assert.equal(v.sessionCount, 2);
  assert.equal(v.machineCount, 2);
  assert.equal(v.staleSessions, 1);
});

test("the source line says how the ledger was read, with the ledger HEAD", () => {
  assert.equal(boardView(served(), { now: NOW }).source, "remote-confirmed · 8366ff291d");
  assert.equal(
    boardView(served({ remoteConfirmed: false, localOnly: true }), { now: NOW }).source,
    "local-only · 8366ff291d",
  );
  assert.equal(
    boardView(
      served({ remoteConfirmed: false, localOnly: false, sourceState: "remote-unavailable", sourceHeadSha: null }),
      { now: NOW },
    ).source,
    "remote-unavailable",
  );
  assert.equal(boardView(served(), { now: NOW }).protocolVersion, "1.1.0");
});

test("an empty package list is drawn as an empty board with its own headline, not hidden", () => {
  const v = boardView(served({ packages: [], flagged: [], sessions: [] }), { now: NOW });
  assert.equal(v.visible, true);
  assert.equal(v.rows.length, 0);
  assert.equal(v.headline, "no packages on the ledger");
  assert.deepEqual(v.attention, []);
});

// The raw-ledger fallback in lib/muster.js cannot compute readiness — it has
// no dependency graph and no roster clock. Found live against a real fleet:
// three ready packages were labelled "not ready" because an absent field had
// been coerced to false, which is a proxy's silence reported as a finding.
test("unknown readiness prints neither verdict", () => {
  const unknown = boardView(
    served({
      sessions: [],
      flagged: [],
      packages: [
        { id: "a", title: "A", status: "open", writes: ["src/a/**"], at: NOW - MINUTE },
        { id: "b", title: "B", status: "open", ready: false, writes: ["src/b/**"], at: NOW - MINUTE },
        { id: "c", title: "C", status: "open", ready: true, writes: ["src/c/**"], at: NOW - MINUTE },
      ],
    }),
    { now: NOW },
  );
  const rows = new Map(unknown.rows.map((r) => [r.id, r]));
  assert.equal(rows.get("a").gate, "");
  assert.equal(rows.get("a").ready, null);
  assert.equal(rows.get("b").gate, "not ready");
  assert.equal(rows.get("c").gate, "ready");
});

// An unconfirmed source falls back to the panel's own account of how it read,
// so "muster ledger branch (CLI not on PATH)" reaches the screen instead of a
// generic shrug that hides which path produced these rows.
test("an unconfirmed source names the read path the panel used", () => {
  const v = boardView(
    served({
      remoteConfirmed: false,
      localOnly: false,
      sourceState: null,
      sourceHeadSha: null,
      source: "muster ledger branch (CLI not on PATH)",
    }),
    { now: NOW },
  );
  assert.equal(v.source, "muster ledger branch (CLI not on PATH)");
});
