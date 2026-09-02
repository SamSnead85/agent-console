import test from "node:test";
import assert from "node:assert/strict";

import { buildProjects, isInside, repoFor } from "../lib/projects.js";
import {
  addHistorySample,
  assembleHistory,
  createHistoryStore,
  mergeBucket,
  projectSplitOf,
  slugOfSessionKey,
  PERIODS,
} from "../lib/history.js";

const NOW = 1_788_000_000_000;
const HOUR = 3600_000;

test("containment is by path segment, never by string prefix", () => {
  assert.equal(isInside("/a/b", "/a"), true);
  assert.equal(isInside("/a", "/a"), true);
  assert.equal(
    isInside("/apple", "/a"),
    false,
    "/apple was read as living inside /a",
  );
  assert.equal(isInside(null, "/a"), false);
});

test("the most specific repository wins, so a nested repo is not stolen by its parent", () => {
  const repos = [
    { name: "outer", path: "/w" },
    { name: "inner", path: "/w/sub" },
  ];
  assert.equal(repoFor("/w/sub/app", repos).name, "inner");
  assert.equal(repoFor("/w/other", repos).name, "outer");
  assert.equal(repoFor("/elsewhere", repos), null);
});

/**
 * A project directory with no repository has NO code figures. Rendering zeroes
 * would read as "shipped nothing", which is a different and false claim.
 */
test("a project outside any repository reports no code figures rather than zeroes", () => {
  const built = buildProjects({
    projects: [
      {
        slug: "s1",
        label: "Notes",
        path: "/n",
        total: 100,
        attributed: 100,
        unattributed: 0,
      },
    ],
    code: { repos: [] },
    rows: [],
  });
  assert.equal(built.projects[0].repo, null);
  assert.equal(built.withRepo, 0);
});

/**
 * 617 merged PRs cannot be split between two directories inside one repository
 * by any ratio anybody could defend. The figures are named as the repository's
 * and the sharing is stated.
 */
test("a repository shared by two projects is named, not divided", () => {
  const built = buildProjects({
    projects: [
      {
        slug: "a",
        label: "App",
        path: "/w/app",
        total: 10,
        attributed: 10,
        unattributed: 0,
      },
      {
        slug: "b",
        label: "Docs",
        path: "/w/docs",
        total: 5,
        attributed: 5,
        unattributed: 0,
      },
    ],
    code: {
      repos: [
        {
          name: "w",
          path: "/w",
          commits: 100,
          prsMerged: 40,
          added: 900,
          removed: 100,
        },
      ],
    },
    rows: [],
  });
  for (const p of built.projects) {
    assert.equal(
      p.repo.prsMerged,
      40,
      "a repository figure was divided between projects",
    );
    assert.equal(p.repo.sharedWith, 1);
  }
});

test("live sessions and branches are attached to the project directory they run in", () => {
  const built = buildProjects({
    projects: [
      {
        slug: "a",
        label: "App",
        path: "/w/app",
        total: 10,
        attributed: 10,
        unattributed: 0,
      },
    ],
    code: { repos: [] },
    rows: [
      { path: "/w/app", state: "LIVE", branch: "main", vendor: "claude" },
      { path: "/w/app", state: "IDLE", branch: "feat/x", vendor: "codex" },
      { path: "/w/app", state: "COLD", branch: "old", vendor: "codex" },
    ],
    selected: "a",
  });
  const p = built.projects[0];
  assert.equal(p.sessions, 2, "a cold transcript was counted as a session");
  assert.equal(p.live, 1);
  assert.deepEqual(p.branches, ["feat/x", "main", "old"]);
  assert.deepEqual(p.vendors, ["claude", "codex"]);
  assert.equal(p.selected, true);
});

// ------------------------------------------------------- per-project totals

function store() {
  return createHistoryStore({});
}

test("a session key carries the project slug, which is what makes history retroactive", () => {
  assert.equal(slugOfSessionKey("-Users-me-App|uuid"), "-Users-me-App");
});

test("a bucket records its per-project class split at ingest", () => {
  const s = store();
  addHistorySample(s, NOW, "claude-opus-5", "projA|s1", {
    in: 10,
    out: 20,
    cr: 0,
    cw: 0,
    cw1h: 0,
    think: 0,
  });
  addHistorySample(s, NOW, "claude-opus-5", "projB|s2", {
    in: 5,
    out: 5,
    cr: 0,
    cw: 0,
    cw1h: 0,
    think: 0,
  });
  const bucket = Array.from(s.live.values())[0];
  const split = projectSplitOf(bucket);
  assert.equal(split.exact, true);
  assert.equal(split.source, "recorded");
  assert.equal(split.byProject.get("projA").total, 30);
  assert.equal(split.byProject.get("projB").total, 10);
  assert.ok(split.byProject.get("projA").models, "the class split was lost");
});

/**
 * The reason months of already-persisted history are usable. A bucket written
 * before per-project recording existed still names its sessions, and a bucket
 * whose sessions all belong to ONE project demonstrably belongs to that project
 * — no estimation involved.
 */
test("a legacy single-project bucket is attributed exactly, with its classes", () => {
  const map = new Map();
  mergeBucket(map, NOW, {
    models: {
      "claude-opus-5": { in: 10, out: 20, cr: 5, cw: 5, cw1h: 0, think: 0 },
    },
    sessions: { "projA|s1": 40 },
  });
  const split = projectSplitOf(map.get(NOW));
  assert.equal(split.exact, true);
  assert.equal(split.source, "single-project bucket");
  const share = split.byProject.get("projA");
  assert.equal(share.total, 40);
  assert.ok(share.models, "a single-project bucket lost its class split");
});

test("a legacy multi-project bucket yields totals only, and says so", () => {
  const map = new Map();
  mergeBucket(map, NOW, {
    models: {
      "claude-opus-5": { in: 10, out: 20, cr: 5, cw: 5, cw1h: 0, think: 0 },
    },
    sessions: { "projA|s1": 30, "projB|s2": 10 },
  });
  const split = projectSplitOf(map.get(NOW));
  assert.equal(split.exact, false);
  assert.equal(split.byProject.get("projA").total, 30);
  assert.equal(
    split.byProject.get("projA").models,
    null,
    "a class split was invented for a bucket that never recorded one",
  );
});

test("a history file written before the projects field merges unchanged", () => {
  const map = new Map();
  mergeBucket(map, NOW, {
    models: { m: { in: 1, out: 1, cr: 0, cw: 0, cw1h: 0, think: 0 } },
    sessions: { "a|s": 2 },
  });
  assert.equal(map.get(NOW).projects.size, 0);
  // And a newer line merges its projects in on top, high-water like everything.
  mergeBucket(map, NOW, {
    projects: { a: { m: { in: 3, out: 1, cr: 0, cw: 0, cw1h: 0, think: 0 } } },
  });
  assert.equal(map.get(NOW).projects.get("a").get("m").in, 3);
  mergeBucket(map, NOW, {
    projects: { a: { m: { in: 2, out: 1, cr: 0, cw: 0, cw1h: 0, think: 0 } } },
  });
  assert.equal(
    map.get(NOW).projects.get("a").get("m").in,
    3,
    "re-reading the same bucket summed instead of taking the high-water mark",
  );
});

// ------------------------------------------------------------ period scoping

function seeded() {
  const s = store();
  const tokens = (n) => ({ in: n, out: n, cr: 0, cw: 0, cw1h: 0, think: 0 });
  addHistorySample(s, NOW - HOUR, "claude-opus-5", "projA|s1", tokens(100));
  addHistorySample(s, NOW - HOUR, "claude-opus-5", "projB|s2", tokens(50));
  addHistorySample(s, NOW - 2 * HOUR, "claude-opus-5", "projA|s1", tokens(10));
  return s;
}

test("with no project selected every project is counted, and all are listed", () => {
  const h = assembleHistory(seeded(), { now: NOW, period: "24h" });
  assert.equal(h.scope, null);
  assert.equal(h.totals.total, 320);
  assert.equal(h.projectCount, 2);
  assert.equal(h.projects[0].total, 220);
});

test("selecting a project scopes the totals, the models and the sessions together", () => {
  const h = assembleHistory(seeded(), {
    now: NOW,
    period: "24h",
    project: "projA",
  });
  assert.equal(h.scope.slug, "projA");
  assert.equal(
    h.totals.total,
    220,
    "the scoped total included another project",
  );
  assert.ok(h.totals.costTotal > 0, "a scoped period lost its cost");
  assert.equal(h.bySession.length, 1);
  assert.equal(h.bySession[0].key, "projA|s1");
  // The selector must still list everything, or the scope cannot be changed.
  assert.equal(h.projectCount, 2);
  assert.equal(h.scope.unattributed, 0);
});

/**
 * Tokens that are known to belong to a project but whose class split was never
 * recorded are counted and reported, never folded into a cost that would then
 * silently understate the project.
 */
test("a scoped period reports the tokens it could not price rather than hiding them", () => {
  const s = store();
  mergeBucket(s.persisted, NOW - HOUR, {
    models: {
      "claude-opus-5": { in: 100, out: 100, cr: 0, cw: 0, cw1h: 0, think: 0 },
    },
    sessions: { "projA|s1": 150, "projB|s2": 50 },
  });
  const h = assembleHistory(s, { now: NOW, period: "24h", project: "projA" });
  assert.equal(
    h.totals.total,
    0,
    "an unpriceable share was counted as if it were split",
  );
  assert.equal(h.scope.unattributed, 150);
  assert.match(h.scope.note, /predate per-project class recording/u);
  // The project ledger still knows the true token figure.
  assert.equal(h.projects.find((p) => p.slug === "projA").total, 150);
});

test("a slug with nothing in the period reads zero rather than erroring", () => {
  const h = assembleHistory(seeded(), {
    now: NOW,
    period: "24h",
    project: "no-such-project",
  });
  assert.equal(h.totals.total, 0);
  assert.equal(h.scope.slug, "no-such-project");
  assert.equal(h.bySession.length, 0);
});

/**
 * "project lifecycle" made two false claims in two words: it was never one
 * project, and never that project's lifetime.
 */
test("the all-history period says what it actually covers", () => {
  assert.equal(PERIODS.all.label, "everything recorded");
  const h = assembleHistory(seeded(), { now: NOW, period: "all" });
  assert.equal(h.period.label, "everything recorded");
  assert.match(
    h.coverage.scopeNote,
    /every project on this machine, from \d{4}-\d{2}-\d{2}/u,
  );
});
