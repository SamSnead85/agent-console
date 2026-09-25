#!/usr/bin/env node
/** Authorize a tagged source using its own main-push CI, never a PR merge's CI. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_WORKFLOWS = {
  ".github/workflows/ci.yml": ["ubuntu-latest", "macos-latest", "windows-latest"]
    .flatMap((os) => [22, 24].map((node) => `Test (${os}, Node ${node})`)),
  ".github/workflows/public-safety.yml": ["Secrets (gitleaks)", "Public-facing content only"],
  ".github/workflows/perf.yml": ["Performance budget"],
};
const SHA = /^[0-9a-f]{40}$/u;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;

export function releaseSource({ tag, cwd = process.cwd() }) {
  if (typeof tag !== "string" || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(tag)) {
    throw new Error("Release tag must be a version tag.");
  }
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const sha = git("rev-parse", "--verify", "HEAD^{commit}");
    const tagged = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
    const main = git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
    if (!SHA.test(sha) || tagged !== sha || !SHA.test(main)) throw new Error();
    git("merge-base", "--is-ancestor", sha, main);
    return sha;
  } catch {
    throw new Error("Release checkout must equal its tag and belong to fetched origin/main; use a full-history checkout.");
  }
}

export async function authorizeChecks({ repository, sha, token, fetchImpl = globalThis.fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository || "") || !SHA.test(sha || "") || !token) {
    throw new Error("Release authorization requires a repository, exact commit and read-only GitHub API access.");
  }
  const base = `https://api.github.com/repos/${repository}`;
  async function pages(endpoint, key) {
    const items = [];
    for (let page = 1; page <= 10; page += 1) {
      let response;
      try {
        response = await fetchImpl(`${base}${endpoint}&per_page=100&page=${page}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          signal: AbortSignal.timeout(15_000), redirect: "error",
        });
      } catch { throw new Error("GitHub release authorization request failed."); }
      if (!response.ok) throw new Error(`GitHub release authorization request failed (HTTP ${response.status}).`);
      let body;
      try { body = await response.json(); } catch { throw new Error("GitHub returned invalid release authorization data."); }
      if (!Array.isArray(body[key]) || !Number.isSafeInteger(body.total_count) || body.total_count < 0) {
        throw new Error("GitHub returned incomplete release authorization data.");
      }
      items.push(...body[key]);
      if (items.length >= body.total_count) return items;
      if (!body[key].length) break;
    }
    throw new Error("Release authorization results could not be read completely.");
  }

  const runs = await pages(`/actions/runs?head_sha=${sha}&event=push&branch=main`, "workflow_runs");
  for (const [workflow, names] of Object.entries(REQUIRED_WORKFLOWS)) {
    const matching = runs.filter((run) => run.path === workflow && run.head_sha === sha
      && run.head_branch === "main" && run.event === "push");
    if (!matching.length || matching.some((run) => !positiveId(run.id)
      || ![run.created_at, run.updated_at, run.run_started_at].every((value) => Number.isFinite(Date.parse(value))))) {
      throw new Error(`Release source is missing main-push evidence for ${workflow}.`);
    }
    // A rerun keeps its old id/creation date but updates its attempt/activity.
    // Also refuse any active run or unsuccessful result since the selected
    // success began: a slow old success cannot mask a more recent failure.
    matching.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id);
    const run = matching[0];
    if (run.status !== "completed" || run.conclusion !== "success" || !positiveId(run.check_suite_id)
      || matching.some((other) => other.status !== "completed"
        || (other.conclusion !== "success" && Date.parse(other.updated_at) >= Date.parse(run.run_started_at)))) {
      throw new Error(`Latest main-push run for ${workflow} has not completed successfully.`);
    }
    // GitHub's latest filter handles retried jobs within this exact run's suite.
    const checks = await pages(`/check-suites/${run.check_suite_id}/check-runs?filter=latest`, "check_runs");
    for (const name of names) {
      const found = checks.filter((check) => check.name === name);
      if (found.length !== 1 || found[0].head_sha !== sha || found[0].app?.id !== 15368
        || found[0].app?.slug !== "github-actions" || found[0].check_suite?.id !== run.check_suite_id
        || found[0].status !== "completed" || found[0].conclusion !== "success") {
        throw new Error(`Release source has no current successful GitHub Actions check: ${name}.`);
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const sha = releaseSource({ tag: process.env.TAG });
    await authorizeChecks({ repository: process.env.GITHUB_REPOSITORY, sha, token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN });
    process.stdout.write(`Release source ${sha} belongs to main and passed all nine required main-push checks.\n`);
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
