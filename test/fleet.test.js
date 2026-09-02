import test from "node:test";
import assert from "node:assert/strict";

import {
  assembleFleet,
  createFleetStore,
  firstLineOf,
  identityOf,
  refreshFleet,
  slugOfRemote,
  summarizeChecks,
} from "../lib/fleet.js";
import { SECRETS } from "./helpers.js";

test("slugOfRemote reads https and ssh remotes", () => {
  assert.equal(
    slugOfRemote("https://github.com/example-org/example-repo.git"),
    "example-org/example-repo",
  );
  assert.equal(slugOfRemote("git@github.com:owner/repo.git\n"), "owner/repo");
  assert.equal(slugOfRemote("https://gitlab.example/o/r.git"), null);
});

test("firstLineOf strips markdown dressing and masks before it clips", () => {
  assert.equal(
    firstLineOf("**MAC STUDIO CLAUDE — #116 merged.**\nrest of body"),
    "MAC STUDIO CLAUDE — #116 merged.",
  );
  assert.equal(
    firstLineOf("## CLAIM / RUNWAY — #140 FM-WP-6\nbody"),
    "CLAIM / RUNWAY — #140 FM-WP-6",
  );
  assert.equal(firstLineOf("\n\n  plain line\n"), "plain line");
  assert.equal(firstLineOf(""), null);
  // A ledger comment quoting a connection string must never reach the panel
  // in the clear — masked FIRST, clipped second, like every other string here.
  const leaked = firstLineOf(
    "gate output: psql postgresql://ops:" +
      SECRETS.password +
      "@db.internal:5432/app " +
      "x".repeat(300),
  );
  assert.ok(!leaked.includes(SECRETS.password), leaked);
  assert.match(leaked, /‹redacted \d+›/u);
});

test("identityOf recognises the ledger's self-declared headers", () => {
  assert.deepEqual(
    identityOf(
      "MAC LAPTOP CODEX — capability-coverage fix-forward rebased after #192.",
    ),
    {
      identity: "MAC LAPTOP CODEX",
      doing: "capability-coverage fix-forward rebased after #192.",
    },
  );
  assert.equal(
    identityOf("MAC STUDIO CODEX CLAIM — #110 / P2B-WP-3.").identity,
    "MAC STUDIO CODEX",
  );
  assert.equal(
    identityOf("LAPTOP DB + WEB-BUILD WINDOWS ACQUIRED — fix-forward.")
      .identity,
    "LAPTOP",
  );
  assert.equal(
    identityOf("MAC STUDIO CLAUDE — #116 / PR #152 merged.").identity,
    "MAC STUDIO CLAUDE",
  );
  assert.equal(identityOf("#131 HANDOFF — READY PR #155"), null);
  assert.equal(
    identityOf("DB WINDOW · #119 entering after #131 cleanup"),
    null,
  );
  assert.equal(identityOf(null), null);
});

test("summarizeChecks maps CheckRun and StatusContext states to pass/fail/pending", () => {
  const rollup = [
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
    { __typename: "StatusContext", state: "SUCCESS" },
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "TIMED_OUT" },
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
  ];
  assert.deepEqual(summarizeChecks(rollup), { pass: 3, fail: 2, pending: 1 });
  assert.deepEqual(summarizeChecks(null), { pass: 0, fail: 0, pending: 0 });
});

const COMMENTS = [
  {
    created_at: "2026-08-31T10:00:00Z",
    body: "MAC LAPTOP CODEX — #140 SOURCE-ONLY REPAIR CHECKPOINT\ndetail",
  },
  {
    created_at: "2026-08-31T11:00:00Z",
    body: "**RULING — the shared export barrel. Here is how it stops being one.**\nbody",
  },
  {
    created_at: "2026-08-31T12:00:00Z",
    body: "#131 HANDOFF — READY PR #155\nbody",
  },
  {
    created_at: "2026-08-31T13:00:00Z",
    body: "MAC LAPTOP CODEX — capability-coverage fix-forward 2 CLAIMED after review.\nbody",
  },
  {
    created_at: "2026-08-31T13:30:00Z",
    body: "MAC STUDIO CLAUDE — #117 dispatched. Full brief there.\nbody",
  },
];

const PRS = [
  {
    number: 209,
    title: "feat(opportunity): the Opportunity lane engine",
    isDraft: false,
    headRefName: "macstudio/opportunity",
    updatedAt: "2026-08-31T15:49:00Z",
    statusCheckRollup: [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
  },
  {
    number: 220,
    title: "feat(fleet-dashboard): history",
    isDraft: true,
    headRefName: "laptop/fleet-dashboard-history",
    updatedAt: "2026-08-31T16:00:00Z",
    statusCheckRollup: [],
  },
];

test("assembleFleet: newest self-declared header per session, rulings and claims, PR checks", () => {
  const now = Date.parse("2026-08-31T16:30:00Z");
  const data = assembleFleet({
    now,
    slug: "o/r",
    issue: 5,
    comments: COMMENTS,
    prs: PRS,
  });

  assert.equal(data.available, true);
  const laptop = data.assignments.find(
    (a) => a.identity === "MAC LAPTOP CODEX",
  );
  assert.ok(laptop, "the laptop session must be listed once");
  assert.match(
    laptop.doing,
    /fix-forward 2 CLAIMED/u,
    "the NEWEST declaration wins, not the first: " + laptop.doing,
  );
  assert.equal(
    data.assignments.filter((a) => a.identity === "MAC LAPTOP CODEX").length,
    1,
    "superseded declarations are not listed",
  );
  assert.ok(data.assignments.find((a) => a.identity === "MAC STUDIO CLAUDE"));

  assert.equal(data.rulings.length, 2, "RULING and HANDOFF lines are surfaced");
  assert.match(data.rulings[0].text, /HANDOFF/u, "newest first");
  assert.match(data.rulings[1].text, /RULING/u);

  assert.equal(data.inFlight.length, 1);
  assert.match(data.inFlight[0].text, /CLAIMED/u);

  assert.equal(data.prs[0].number, 220, "PRs sort by most recently updated");
  assert.equal(data.prs[0].draft, true);
  assert.deepEqual(data.prs[1].checks, { pass: 1, fail: 1, pending: 0 });
});

function fakeRunner(script) {
  const calls = [];
  return {
    calls,
    run(cmd, args) {
      calls.push({ cmd, args });
      return Promise.resolve(script(cmd, args));
    },
  };
}

test("refreshFleet: disabled never touches the runner; the TTL holds; failures degrade to absent", async () => {
  const ok = fakeRunner((cmd) => {
    if (cmd === "git")
      return { ok: true, stdout: "https://github.com/o/r.git\n", stderr: "" };
    return { ok: true, stdout: "[]", stderr: "" };
  });
  const store = createFleetStore({ runner: ok.run });

  const off = refreshFleet(store, {
    enabled: false,
    repoDir: "/x",
    issue: 5,
    now: Date.now(),
  });
  assert.equal(off.enabled, false);
  assert.equal(ok.calls.length, 0, "disabled must make no call at all");

  // First enabled call kicks a background refresh and reports loading.
  const first = refreshFleet(store, {
    enabled: true,
    repoDir: "/x",
    issue: 5,
    now: Date.now(),
  });
  assert.equal(first.available, false);
  assert.equal(first.loading, true);
  await store.inFlight;
  const second = refreshFleet(store, {
    enabled: true,
    repoDir: "/x",
    issue: 5,
    now: Date.now(),
  });
  assert.equal(second.available, true);
  assert.equal(second.repo, "o/r");
  const callsAfter = ok.calls.length;
  refreshFleet(store, {
    enabled: true,
    repoDir: "/x",
    issue: 5,
    now: Date.now(),
  });
  assert.equal(ok.calls.length, callsAfter, "inside the TTL nothing re-runs");

  // gh missing or offline: gracefully absent with a reason, never a throw.
  const down = fakeRunner((cmd) =>
    cmd === "git"
      ? { ok: true, stdout: "git@github.com:o/r.git", stderr: "" }
      : { ok: false, stdout: "", stderr: "gh: command not found" },
  );
  const downStore = createFleetStore({ runner: down.run });
  refreshFleet(downStore, {
    enabled: true,
    repoDir: "/x",
    issue: 5,
    now: Date.now(),
  });
  const failed = await downStore.inFlight;
  assert.equal(failed.available, false);
  assert.match(failed.reason, /gh unavailable or offline/u);

  // No GitHub remote at all: absent with the other reason.
  const norepo = fakeRunner(() => ({ ok: false, stdout: "", stderr: "fatal" }));
  const norepoStore = createFleetStore({ runner: norepo.run });
  refreshFleet(norepoStore, {
    enabled: true,
    repoDir: "/x",
    issue: 5,
    now: Date.now(),
  });
  const absent = await norepoStore.inFlight;
  assert.equal(absent.available, false);
  assert.match(absent.reason, /no GitHub remote/u);
});

/**
 * The ledger froze a full day behind and nothing on screen said so.
 *
 * GitHub returns issue comments OLDEST FIRST. One un-paginated page of 100 is
 * therefore the oldest 100 comments in the window, and on this repository the
 * 48-hour window held exactly 100 — so the panel showed the state of the fleet
 * as it had been a day earlier and looked entirely healthy doing it.
 *
 * The tell that ruled out the header parser: `recent` was frozen at the same
 * moment as `assignments`, and `recent` parses no identity at all. A regex
 * cannot freeze a list that never calls it. The bug was the read.
 */
test("the ledger read is paginated — one page is the OLDEST page", async () => {
  const ok = fakeRunner((cmd) => {
    if (cmd === "git")
      return { ok: true, stdout: "https://github.com/o/r.git\n", stderr: "" };
    return { ok: true, stdout: "[]", stderr: "" };
  });
  const store = createFleetStore({ runner: ok.run });
  refreshFleet(store, {
    enabled: true,
    repoDir: "/x",
    issue: 5,
    now: Date.now(),
  });
  await store.inFlight;
  const api = ok.calls.find(
    (c) =>
      c.cmd === "gh" &&
      c.args[0] === "api" &&
      c.args.join(" ").includes("/comments"),
  );
  assert.ok(api, "no ledger comment read was issued");
  assert.ok(
    api.args.includes("--paginate"),
    "the ledger read takes page one only, which is the oldest page",
  );
});

test("a window larger than the cap keeps the NEWEST comments and admits the cut", () => {
  const base = Date.parse("2026-08-30T00:00:00Z");
  const comments = [];
  for (let i = 0; i < 450; i += 1) {
    comments.push({
      created_at: new Date(base + i * 60_000).toISOString(),
      body: "comment number " + i,
    });
  }
  const f = assembleFleet({
    now: base,
    slug: "o/r",
    issue: 5,
    comments,
    prs: [],
  });
  assert.equal(f.commentCount, 400);
  assert.equal(f.commentsDropped, 50);
  // Newest kept, oldest dropped — the opposite end from the one a single
  // un-paginated page returned.
  assert.equal(f.recent[0].text, "comment number 449");
  assert.equal(f.latestCommentAt, base + 449 * 60_000);
});

test("the newest comment the read saw is published, so a frozen ledger cannot hide", () => {
  const at = Date.parse("2026-08-31T23:00:00Z");
  const f = assembleFleet({
    now: at,
    slug: "o/r",
    issue: 5,
    comments: [
      { created_at: new Date(at).toISOString(), body: "LAPTOP — working" },
    ],
    prs: [],
  });
  assert.equal(f.latestCommentAt, at);
  assert.equal(f.commentsDropped, 0);
  const empty = assembleFleet({
    now: at,
    slug: "o/r",
    issue: 5,
    comments: [],
    prs: [],
  });
  assert.equal(
    empty.latestCommentAt,
    null,
    "no comments is null, never a fake timestamp",
  );
});

/**
 * The parser was accused of the freeze. It is innocent, and this pins that so
 * nobody "fixes" it by loosening the anchor — which would start attributing an
 * orchestrator's dispatches TO the sessions they were addressed to.
 */
test("a markdown-dressed header still declares its identity through the real path", () => {
  for (const [body, expected] of [
    ["MAC STUDIO CODEX CLAIM — #110", "MAC STUDIO CODEX"],
    ["## MAC STUDIO CLAUDE — #256 something", "MAC STUDIO CLAUDE"],
    ["# MAC STUDIO CLAUDE — HOLD ON that", "MAC STUDIO CLAUDE"],
    ["**MAC STUDIO CODEX** — status", "MAC STUDIO CODEX"],
  ]) {
    const id = identityOf(firstLineOf(body));
    assert.ok(id, "identity was lost for: " + body);
    assert.equal(id.identity, expected);
  }
  // The anchor still does its job: an identity buried mid-sentence is somebody
  // TALKING ABOUT that session, not that session declaring itself.
  assert.equal(identityOf(firstLineOf("> quoted MAC STUDIO CLAUDE — x")), null);
  assert.equal(
    identityOf(firstLineOf("handing this to MAC STUDIO CLAUDE now")),
    null,
    "a mention was read as a self-declaration, putting words in another session's mouth",
  );
});
