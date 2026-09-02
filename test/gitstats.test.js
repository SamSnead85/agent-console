import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createGitStatsStore,
  gitStatsForPeriod,
  parseNumstat,
  prNumbersOf,
} from "../lib/gitstats.js";

const GIT = process.platform === "win32" ? "git" : "/usr/bin/git";
const REC = "\u001e";
const SEP = "\u001f";

function run(cwd, args, env) {
  execFileSync(GIT, args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      ...(env || {}),
    },
    stdio: "pipe",
  });
}

function commit(cwd, message, atMs) {
  const env = atMs
    ? {
        GIT_AUTHOR_DATE: new Date(atMs).toISOString(),
        GIT_COMMITTER_DATE: new Date(atMs).toISOString(),
      }
    : {};
  run(cwd, ["add", "-A"], env);
  run(cwd, ["commit", "-q", "-m", message], env);
}

test("prNumbersOf reads squash suffixes and classic merge subjects, nothing else", () => {
  assert.deepEqual(prNumbersOf("Merge pull request #12 from a/b"), [12]);
  assert.deepEqual(prNumbersOf("feat(core): the thing (#34)"), [34]);
  assert.deepEqual(prNumbersOf("feat: mentions (#34) mid-subject"), []);
  assert.deepEqual(prNumbersOf("chore: nothing"), []);
});

test("parseNumstat sums text changes and skips binary rows", () => {
  const at = Math.floor(Date.now() / 1000);
  const raw =
    REC +
    at +
    SEP +
    "feat: a (#7)\n\n3\t1\ta.txt\n-\t-\timg.png\n" +
    REC +
    at +
    SEP +
    "chore: b\n\n10\t2\tb.txt\n";
  const stats = parseNumstat(raw, null);
  assert.equal(stats.commits, 2);
  assert.equal(stats.added, 13);
  assert.equal(stats.removed, 3);
  assert.deepEqual(Array.from(stats.prs), [7]);
});

test("period stats from a real repository: merged PRs and lines are period-scoped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gitstats-"));
  run(root, ["init", "-q"]);
  const file = path.join(root, "a.txt");
  const now = Date.now();

  fs.writeFileSync(file, "one\ntwo\nthree\n");
  commit(root, "feat: base (#10)", now - 10 * 24 * 3600 * 1000);

  fs.writeFileSync(file, "one\nTWO\nthree\nfour\nfive\n");
  commit(root, "fix: tweak (#11)", now - 3600 * 1000);

  fs.writeFileSync(file, "one\nTWO\nthree\nfour\nfive\nsix\n");
  commit(root, "chore: no pr", now - 1800 * 1000);

  const store = createGitStatsStore();
  const day = await gitStatsForPeriod(store, [root], now - 24 * 3600 * 1000);
  assert.equal(day.errors.length, 0, day.errors.join(", "));
  assert.equal(
    day.totals.commits,
    2,
    "the 10-day-old commit is outside the period",
  );
  assert.equal(day.totals.prsMerged, 1, "only #11 landed inside the period");
  // fix: tweak rewrites one line (+2 net of a modification) and adds two more,
  // chore adds one: numstat says 3+1 added / 1 removed for those two commits.
  assert.equal(day.totals.added, 4);
  assert.equal(day.totals.removed, 1);

  const all = await gitStatsForPeriod(createGitStatsStore(), [root], null);
  assert.equal(all.totals.commits, 3);
  assert.equal(all.totals.prsMerged, 2);
  assert.equal(all.totals.added, 4 + 3);

  // A directory that is not a repository is reported absent, not fatal.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-norepo-"));
  const none = await gitStatsForPeriod(createGitStatsStore(), [empty], null);
  assert.equal(none.repos.length, 0);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});
