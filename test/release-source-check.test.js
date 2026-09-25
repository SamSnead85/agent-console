import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorizeChecks, releaseSource, REQUIRED_WORKFLOWS } from "../scripts/release-source-check.mjs";

const SHA = "a".repeat(40);
const REPO = "example/console";

function evidence() {
  const suites = new Map();
  const runs = Object.entries(REQUIRED_WORKFLOWS).map(([workflow, names], index) => {
    const id = index + 1;
    suites.set(id, names.map((name) => ({
      name, head_sha: SHA, status: "completed", conclusion: "success",
      check_suite: { id }, app: { id: 15368, slug: "github-actions" },
    })));
    return { id, path: workflow, head_sha: SHA, head_branch: "main", event: "push",
      status: "completed", conclusion: "success", check_suite_id: id, created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:01:00Z", run_started_at: "2026-01-01T00:00:00Z" };
  });
  const requested = [];
  async function fetchImpl(input) {
    const url = new URL(input);
    requested.push(url);
    if (url.pathname.endsWith("/actions/runs")) {
      assert.equal(url.searchParams.get("head_sha"), SHA);
      assert.equal(url.searchParams.get("branch"), "main");
      assert.equal(url.searchParams.get("event"), "push");
      const start = (Number(url.searchParams.get("page")) - 1) * 100;
      return { ok: true, json: async () => ({ total_count: runs.length, workflow_runs: runs.slice(start, start + 100) }) };
    }
    assert.equal(url.searchParams.get("filter"), "latest");
    const id = Number(url.pathname.match(/check-suites\/(\d+)\//u)?.[1]);
    const checks = suites.get(id) || [];
    return { ok: true, json: async () => ({ total_count: checks.length, check_runs: checks }) };
  }
  return { runs, suites, requested, check: () => authorizeChecks({ repository: REPO, sha: SHA, token: "synthetic", fetchImpl }) };
}

test("release tag must match HEAD and be an ancestor of fetched main", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-release-source-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test",
    GIT_AUTHOR_EMAIL: "1+test@users.noreply.github.com", GIT_COMMITTER_EMAIL: "1+test@users.noreply.github.com" };
  const git = (args, input = "") => execFileSync("git", args, { cwd, env, input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  git(["init", "-q"]);
  const tree = git(["mktree"]);
  const first = git(["commit-tree", tree, "-m", "first"]);
  const main = git(["commit-tree", tree, "-p", first, "-m", "main"]);
  const side = git(["commit-tree", tree, "-p", first, "-m", "unmerged"]);
  git(["update-ref", "HEAD", first]);
  git(["update-ref", "refs/remotes/origin/main", main]);
  git(["update-ref", "refs/tags/v0.2.2", first]);
  assert.equal(releaseSource({ cwd, tag: "v0.2.2" }), first);
  assert.throws(() => releaseSource({ cwd, tag: "--help" }), /version tag/u);
  git(["update-ref", "HEAD", side]);
  assert.throws(() => releaseSource({ cwd, tag: "v0.2.2" }), /must equal its tag/u);
  git(["update-ref", "refs/tags/v0.2.2", side]);
  assert.throws(() => releaseSource({ cwd, tag: "v0.2.2" }), /belong to fetched origin\/main/u);
});

test("all nine exact-source main-push checks authorize a release without a PR-only job", async () => {
  const fixture = evidence();
  await fixture.check();
  assert.equal(fixture.requested.length, 4);
});

test("a successful older workflow cannot hide a newer failure or pending attempt", async () => {
  for (const [status, conclusion] of [["completed", "failure"], ["completed", "cancelled"], ["in_progress", null], ["queued", null]]) {
    const fixture = evidence();
    fixture.runs.push({ ...fixture.runs[0], id: 100, created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:01:00Z", run_started_at: "2026-01-02T00:00:00Z", status, conclusion });
    await assert.rejects(fixture.check(), /Latest main-push run/u);
  }
});

test("new successful workflow supersedes an old failure", async () => {
  const fixture = evidence();
  fixture.runs.push({ ...fixture.runs[0], id: 100, created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:01:00Z", run_started_at: "2026-01-02T00:00:00Z" });
  fixture.runs[0].conclusion = "failure";
  await fixture.check();
});

test("rerunning an older workflow after a green run cannot hide the new failure", async () => {
  const fixture = evidence();
  fixture.runs.push({ ...fixture.runs[0], id: 100, created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:01:00Z", run_started_at: "2026-01-02T00:00:00Z" });
  Object.assign(fixture.runs[0], { run_attempt: 2, conclusion: "failure", updated_at: "2026-01-03T00:00:00Z" });
  await assert.rejects(fixture.check(), /Latest main-push run/u);
});

test("a slow older green run finishing after a newer failure still fails closed", async () => {
  const fixture = evidence();
  fixture.runs[0].updated_at = "2026-01-03T00:00:00Z";
  fixture.runs.push({ ...fixture.runs[0], id: 100, created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:01:00Z", run_started_at: "2026-01-02T00:00:00Z", conclusion: "failure" });
  await assert.rejects(fixture.check(), /Latest main-push run/u);
});

test("PR, other-branch and different-commit runs cannot supply release evidence", async () => {
  for (const change of [{ event: "pull_request" }, { head_branch: "feature" }, { head_sha: "b".repeat(40) }]) {
    const fixture = evidence();
    Object.assign(fixture.runs[0], change);
    await assert.rejects(fixture.check(), /missing main-push evidence/u);
  }
});

test("missing, skipped, failing, pending, foreign-app and wrong-source checks fail closed", async () => {
  for (const change of [null, { conclusion: "skipped" }, { conclusion: "failure" }, { status: "queued", conclusion: null },
    { head_sha: "b".repeat(40) }, { app: { id: 7, slug: "other" } }, { check_suite: { id: 99 } }]) {
    const fixture = evidence();
    const checks = fixture.suites.get(1);
    if (change) Object.assign(checks[0], change); else checks.shift();
    await assert.rejects(fixture.check(), /no current successful GitHub Actions check/u);
  }
});

test("pagination cannot hide a newer failed workflow behind the first hundred results", async () => {
  const fixture = evidence();
  while (fixture.runs.length < 100) fixture.runs.push({ ...fixture.runs[0], path: "unrelated", id: fixture.runs.length + 10 });
  fixture.runs.push({ ...fixture.runs[0], id: 500, created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:01:00Z", run_started_at: "2026-01-02T00:00:00Z", conclusion: "failure" });
  await assert.rejects(fixture.check(), /Latest main-push run/u);
  assert.equal(fixture.requested.length, 2);
});

test("API denial and incomplete results fail closed without printing API bodies", async () => {
  const options = { repository: REPO, sha: SHA, token: "synthetic" };
  await assert.rejects(authorizeChecks({ ...options, fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/u);
  await assert.rejects(authorizeChecks({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) }) }), /incomplete/u);
  await assert.rejects(authorizeChecks({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ total_count: 1, workflow_runs: [] }) }) }), /completely/u);
});
