/**
 * What actually shipped today — from local sources only.
 *
 * The previous implementation asked the GitHub API for the 30 most recent
 * merged PRs. That list is ordered by CREATION time, so a PR opened last week
 * and merged this morning falls outside it: measured here, it reported "30+
 * merged" on a day whose real figure was 64, missing 34. It was also the only
 * outbound network call in the program.
 *
 * Both problems have the same fix. Every repository the fleet is working in is
 * on this disk, and every PR a session opened is recorded in that session's own
 * transcript as a `pr-link` line. Reading those is exact, unbounded, and needs
 * no network in this subsystem. Other readers disclose their own transport
 * behavior in the snapshot metadata.
 */

import { execFile } from "node:child_process";
import process, { env } from "node:process";
import { isSameDay } from "./day.js";

const CACHE_MS = 60_000;
const SEP = "\u001f"; // ASCII unit separator: cannot occur in a commit subject
const MAX_REPOS = 8;

const gitEnv = { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

// Absolute on POSIX so PATH cannot decide what "git" means; Windows has no
// fixed location, so there it falls back to PATH resolution.
const GIT = process.platform === "win32" ? "git" : "/usr/bin/git";

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      GIT,
      args,
      { cwd, env: gitEnv, maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
      (error, stdout) => resolve({ error, stdout: stdout || "" }),
    );
  });
}

export function createShipStore() {
  return { at: 0, data: null, inFlight: null, toplevel: new Map() };
}

async function toplevelOf(store, dir) {
  if (store.toplevel.has(dir)) return store.toplevel.get(dir);
  const { error, stdout } = await git(dir, ["rev-parse", "--show-toplevel"]);
  const value = error ? null : stdout.trim() || null;
  store.toplevel.set(dir, value);
  return value;
}

/**
 * @param {string[]} cwds working directories observed in today's sessions
 * @param {Map<string, object>} prLinks PR records harvested from the transcripts
 * @param {number} now epoch milliseconds
 */
export async function refreshShipped(store, cwds, prLinks, now) {
  if (store.data && now - store.at < CACHE_MS) return store.data;
  if (store.inFlight) return store.inFlight;
  store.inFlight = collect(store, cwds, prLinks, now).then((data) => {
    store.at = now;
    store.data = data;
    store.inFlight = null;
    return data;
  });
  return store.inFlight;
}

async function collect(store, cwds, prLinks, now) {
  const roots = new Set();
  for (const cwd of cwds) {
    if (roots.size >= MAX_REPOS) break;
    const top = await toplevelOf(store, cwd);
    if (top) roots.add(top);
  }

  const repos = [];
  let commitCount = 0;
  let mergeCount = 0;
  const errors = [];

  for (const root of roots) {
    const [log, merges, branch] = await Promise.all([
      git(root, [
        "log",
        "--since=midnight",
        "--pretty=format:%h" + SEP + "%s" + SEP + "%ct",
      ]),
      git(root, ["log", "--since=midnight", "--merges", "--pretty=format:%h"]),
      git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
    if (log.error) {
      errors.push(root.split("/").pop() + ": git log unavailable");
      continue;
    }
    const commits = log.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(SEP);
        return {
          hash: parts[0],
          subject: (parts[1] || "").slice(0, 120),
          at: Number(parts[2] || 0) * 1000,
        };
      });
    const mergeList = merges.error
      ? []
      : merges.stdout.split("\n").filter(Boolean);
    commitCount += commits.length;
    mergeCount += mergeList.length;
    repos.push({
      name: root.split("/").pop(),
      path: root,
      branch: branch.error ? null : branch.stdout.trim(),
      commits: commits.length,
      merges: mergeList.length,
      recent: commits.slice(0, 6),
    });
  }

  // Scoped to the same local day the commit count is scoped to. `prLinks`
  // accumulates every PR record in the 36-hour file window for the life of the
  // process, so an unfiltered list mixes six-week-old PRs into a figure the UI
  // labels "today" and never stops growing. A record with no usable timestamp
  // is counted as older, never as today.
  const all = Array.from(prLinks.values()).sort((a, b) => b.ts - a.ts);
  const prs = all.filter((pr) => isSameDay(pr.ts, now));
  repos.sort((a, b) => b.commits - a.commits);

  return {
    at: now,
    source:
      "local git and this machine's transcripts — no network call is made",
    commitCount,
    mergeCount,
    repos,
    prs: prs.slice(0, 12),
    prCount: prs.length,
    // Everything the transcripts still hold, so the drawer can say what it is
    // leaving out rather than quietly dropping it.
    prCountWindow: all.length,
    errors,
  };
}
