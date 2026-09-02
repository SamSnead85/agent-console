import test from "node:test";
import assert from "node:assert/strict";

import {
  assembleFromLedger,
  assembleMuster,
  createMusterStore,
  normalizePackage,
  normalizeSession,
  refreshMuster,
} from "../lib/muster.js";
import { SECRETS } from "./helpers.js";

const NOW = 1_788_000_000_000;

const STATUS = {
  ok: true,
  status: {
    generatedAt: "2026-08-31T18:56:00.000Z",
    protocolVersion: "1.0.0",
    roster: [
      {
        name: "MAC-STUDIO-CLAUDE",
        role: "worker",
        machine: "studio.local",
        vendor: "claude-code",
        status: "active",
        currentBranch: "feat/data",
        currentPackage: "data-module",
        lastEventAt: "2026-08-31T18:33:14.594Z",
        stale: false,
        holding: ["data-module"],
      },
      {
        name: "smoke-test-worker",
        role: "worker",
        machine: "laptop.local",
        vendor: "claude-code",
        status: "stood-down",
        lastEventAt: "2026-08-30T14:07:22.479Z",
        stale: true,
      },
    ],
    packages: {
      all: [
        {
          id: "data-module",
          title: "Data module: estate intake",
          status: "assigned",
          owner: "MAC-STUDIO-CLAUDE",
          writes: ["apps/web/src/**", "packages/fde-modernization/**"],
          dependsOn: [],
          updatedAt: "2026-08-31T18:31:04.695Z",
        },
        {
          id: "unclaimed-thing",
          title: "Nobody has this",
          status: "open",
          owner: null,
          dispatchedTo: null,
          writes: [],
          updatedAt: "2026-08-31T18:30:00.000Z",
        },
      ],
    },
  },
};

test("the CLI's status becomes a roster, a package board and a claim list", () => {
  const m = assembleMuster(STATUS, NOW);
  assert.equal(m.available, true);
  assert.equal(m.sessionCount, 2);
  assert.equal(m.activeCount, 1);
  assert.deepEqual(m.machines, ["laptop.local", "studio.local"]);
  assert.equal(m.counts.assigned, 1);
  assert.equal(m.counts.open, 1);
  assert.equal(m.protocolVersion, "1.0.0");

  // A claim is a package with an owner — the authoritative "who owns what",
  // with no dependence on anybody remembering to write a comment.
  assert.equal(m.claims.length, 1);
  assert.equal(m.claims[0].id, "data-module");
  assert.equal(m.claims[0].owner, "MAC-STUDIO-CLAUDE");
});

/**
 * The write fence is the reason two sessions do not land on the same file, so
 * it is carried through rather than summarized away.
 */
test("a package keeps its write fence", () => {
  const m = assembleMuster(STATUS, NOW);
  const pkg = m.packages.find((p) => p.id === "data-module");
  assert.deepEqual(pkg.writes, [
    "apps/web/src/**",
    "packages/fde-modernization/**",
  ]);
});

test("ledger text is masked before it is stored, like every other foreign string", () => {
  const session = normalizeSession({
    name: "worker",
    note: "resuming with ANTHROPIC_API_KEY=" + SECRETS.anthropic,
  });
  assert.ok(
    !session.note.includes(SECRETS.anthropic),
    "a key survived into the panel",
  );
  assert.match(session.note, /redacted/u);

  const pkg = normalizePackage({
    id: "p",
    title: "deploy with " + SECRETS.stripe,
  });
  assert.ok(!pkg.title.includes(SECRETS.stripe));
});

test("a nameless roster row and an idless package are dropped, not rendered blank", () => {
  assert.equal(normalizeSession({ role: "worker" }), null);
  assert.equal(normalizeSession(null), null);
  assert.equal(normalizePackage({ title: "x" }), null);
});

test("a missing status shape yields an empty panel, never a crash", () => {
  const m = assembleMuster({}, NOW);
  assert.equal(m.available, true);
  assert.deepEqual(m.sessions, []);
  assert.deepEqual(m.packages, []);
  assert.equal(m.sessionCount, 0);
});

/**
 * The fallback path: the ledger is on the branch even where the CLI is not on
 * PATH. Every muster command appends a line, so folding newest-wins per
 * identity reproduces the roster.
 */
test("the ledger branch reproduces the roster without the CLI", () => {
  const sessions = [
    JSON.stringify({
      type: "join",
      name: "W1",
      machine: "studio.local",
      vendor: "codex",
      at: "2026-08-31T10:00:00.000Z",
    }),
    JSON.stringify({
      type: "checkpoint",
      name: "W1",
      currentBranch: "feat/x",
      at: "2026-08-31T11:00:00.000Z",
    }),
    "not json",
    JSON.stringify({
      type: "stand-down",
      name: "W2",
      machine: "laptop.local",
      at: "2026-08-31T09:00:00.000Z",
    }),
  ].join("\n");
  const packages = JSON.stringify({
    type: "created",
    id: "pkg-1",
    title: "A package",
    status: "open",
    updatedAt: "2026-08-31T10:00:00.000Z",
  });

  const m = assembleFromLedger(sessions, packages, NOW);
  assert.equal(m.available, true);
  assert.match(m.source, /ledger branch/u);
  assert.equal(m.sessionCount, 2, "a torn line broke the fold");
  const w1 = m.sessions.find((s) => s.name === "W1");
  assert.equal(w1.branch, "feat/x", "the newest line did not win");
  assert.equal(w1.status, "active");
  const w2 = m.sessions.find((s) => s.name === "W2");
  assert.equal(w2.status, "stood-down");
  assert.equal(m.packages.length, 1);
});

// ------------------------------------------------------- refresh behaviour

function runnerFor(script) {
  const calls = [];
  return {
    calls,
    run: (cmd, args) => {
      calls.push(cmd + " " + args.join(" "));
      return Promise.resolve(script(cmd, args));
    },
  };
}

test("a snapshot never waits: the first call is absent, the next carries the data", async () => {
  const runner = runnerFor(() => ({
    ok: true,
    stdout: JSON.stringify(STATUS),
    stderr: "",
  }));
  const store = createMusterStore({ runner: runner.run });
  const first = refreshMuster(store, {
    enabled: true,
    repoDir: "/repo",
    now: NOW,
  });
  assert.equal(first.available, false);
  assert.equal(first.loading, true);

  await store.inFlight;
  const second = refreshMuster(store, {
    enabled: true,
    repoDir: "/repo",
    now: Date.now(),
  });
  assert.equal(second.available, true);
  assert.equal(second.sessionCount, 2);
});

test("with no CLI it falls back to git, and with neither it is absent with a reason", async () => {
  const gitOnly = runnerFor((cmd, args) => {
    if (cmd === "muster")
      return { ok: false, stdout: "", stderr: "command not found" };
    if (args.includes("muster:sessions.jsonl")) {
      return {
        ok: true,
        stdout: JSON.stringify({
          type: "join",
          name: "W1",
          machine: "m",
          at: "2026-08-31T10:00:00.000Z",
        }),
        stderr: "",
      };
    }
    return { ok: true, stdout: "", stderr: "" };
  });
  const store = createMusterStore({ runner: gitOnly.run });
  refreshMuster(store, { enabled: true, repoDir: "/repo", now: NOW });
  const data = await store.inFlight;
  assert.equal(data.available, true);
  assert.equal(data.sessionCount, 1);
  assert.ok(
    gitOnly.calls.some((c) => c.startsWith("git ")),
    "git was never tried",
  );

  const nothing = createMusterStore({
    runner: () =>
      Promise.resolve({ ok: false, stdout: "", stderr: "no such ref" }),
  });
  refreshMuster(nothing, { enabled: true, repoDir: "/repo", now: NOW });
  const absent = await nothing.inFlight;
  assert.equal(absent.available, false);
  assert.match(absent.reason, /muster init/u);
});

test("disabled is disabled, and no subprocess is run", () => {
  const runner = runnerFor(() => ({ ok: true, stdout: "{}", stderr: "" }));
  const store = createMusterStore({ runner: runner.run });
  const m = refreshMuster(store, {
    enabled: false,
    repoDir: "/repo",
    now: NOW,
  });
  assert.equal(m.enabled, false);
  assert.equal(m.available, false);
  assert.equal(runner.calls.length, 0, "a disabled panel still shelled out");
});

test("a CLI that reports failure is not read as an empty fleet", async () => {
  const store = createMusterStore({
    runner: (cmd) =>
      Promise.resolve(
        cmd === "muster"
          ? {
              ok: true,
              stdout: JSON.stringify({ ok: false, error: "no ledger" }),
              stderr: "",
            }
          : { ok: false, stdout: "", stderr: "no such ref" },
      ),
  });
  refreshMuster(store, { enabled: true, repoDir: "/repo", now: NOW });
  const data = await store.inFlight;
  assert.equal(
    data.available,
    false,
    "an explicit CLI failure was rendered as a fleet with no sessions",
  );
});

// The console is launched BY the CLI, so the entry point it should read the
// ledger through is known rather than looked up. Resolving `muster` on PATH
// meant every machine without a global install silently fell through to the
// JSONL fallback, which cannot apply the CLI's readiness, staleness or lease
// rules — and said nothing about having done so.
test("the launching CLI's own entry point is used instead of a PATH lookup", async () => {
  const runner = runnerFor((cmd, args) => {
    if (args.includes("status") && args.includes("--json")) {
      return { ok: true, stdout: JSON.stringify(STATUS), stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "not attempted" };
  });
  const store = createMusterStore({ runner: runner.run });
  refreshMuster(store, {
    enabled: true,
    repoDir: "/repo",
    binPath: "/opt/muster/bin/muster.mjs",
    node: "/usr/bin/node",
    now: NOW,
  });
  const data = await store.inFlight;
  assert.equal(data.available, true);
  assert.equal(data.sessionCount, 2);
  assert.deepEqual(runner.calls, [
    "/usr/bin/node /opt/muster/bin/muster.mjs status --json",
  ]);
  assert.equal(
    runner.calls.some((c) => c.startsWith("muster ")),
    false,
    "a PATH lookup was attempted anyway",
  );
});

// Readiness is the CLI's verdict. The fallback has no dependency graph and no
// roster clock, so it must leave the field unknown rather than answer `false`
// — a package that is ready reading "not ready" is a proxy's silence reported
// as a finding. Caught against a real three-package fleet.
test("readiness the fallback cannot compute stays unknown, never false", () => {
  const fromCli = normalizePackage({ id: "a", status: "open", ready: true });
  assert.equal(fromCli.ready, true);
  const refused = normalizePackage({ id: "b", status: "open", ready: false });
  assert.equal(refused.ready, false);
  const unknown = normalizePackage({ id: "c", status: "open" });
  assert.equal(unknown.ready, null);

  const m = assembleFromLedger(
    JSON.stringify({ type: "join", name: "W", at: "2026-08-31T10:00:00.000Z" }),
    JSON.stringify({
      type: "created",
      id: "pkg-1",
      status: "open",
      at: "2026-08-31T10:00:00.000Z",
    }),
    NOW,
  );
  assert.equal(m.packages[0].ready, null);
});
