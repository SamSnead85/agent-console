/**
 * The Projects view: this machine's usage per project, beside what Git
 * recorded in the same period.
 *
 * Tokens, cost and sessions come from the hub's own store (this machine's
 * records only); project names, branches and folders come from the private
 * local names the hub keeps for its own machine. Git figures come from a
 * local `git log` in each project's repository — no network call — for the
 * busiest projects only, so a machine with hundreds of folders does not run
 * hundreds of git processes. Nothing here is sent anywhere.
 */

import { gitStatsForPeriod } from "../gitstats.js";
import { costPerOutcome } from "../analysis/index.js";
import { MINUTE } from "./store.js";

export const PERIODS = {
  "24h": { id: "24h", label: "last 24 hours", ms: 24 * 3600_000 },
  "3d": { id: "3d", label: "last 3 days", ms: 3 * 24 * 3600_000 },
};
const MAX_GIT_PROJECTS = 12;

/* The demo's own machine: Git figures as synthetic as everything else in demo mode. */
const DEMO_GIT = {
  "atlas-api": { commits: 14, added: 2480, removed: 612, prsMerged: 3, defaultMerges: 2 },
  "atlas-web": { commits: 9, added: 1310, removed: 402, prsMerged: 2, defaultMerges: 1 },
  "docs-site": { commits: 4, added: 540, removed: 96, prsMerged: 1, defaultMerges: 0 },
};

/**
 * @param {object} input
 * @param {object} input.store, input.registry, input.names
 * @param {string} input.period     "24h" or "3d"
 * @param {boolean} input.demo
 * @param {object} [input.git]      a createGitStatsStore(); absent in demo
 */
export async function projectsPayload({ store, registry, names, period, demo, git = null, now = Date.now() }) {
  const span = PERIODS[period].ms;
  const minuteNow = Math.floor(now / MINUTE) * MINUTE;
  const from = minuteNow - span + MINUTE;
  const local = registry.list().find((d) => d.local);
  const byProject = new Map();
  store.eachBucket(from, minuteNow + MINUTE, (_minute, bucket) => {
    if (!local || bucket.deviceId !== local.id || !names) return;
    const session = store.sessions.get(bucket.sessionHash);
    const top = (session && session.isSubagent && store.sessions.get(session.parentSessionHash)) || session;
    if (!top) return;
    const name = names.project(top.projectHash) || "project " + top.projectHash.slice(0, 6);
    let p = byProject.get(name);
    if (!p) { p = { name, projectHash: top.projectHash, tokens: 0, usd: 0, priced: 0, unpriced: 0, sessions: new Set(), branches: new Set() }; byProject.set(name, p); }
    p.tokens += bucket.fresh + bucket.output + bucket.cacheWrite + bucket.cacheRead;
    p.usd += bucket.usd;
    p.priced += bucket.pricedN;
    p.unpriced += bucket.unpricedN;
    p.sessions.add(top.sessionHash);
    const branch = names.branch(top.sessionHash);
    if (branch) p.branches.add(branch);
  });
  const ranked = [...byProject.values()].sort((a, b) => b.tokens - a.tokens);

  const scale = period === "3d" ? 2.6 : 1;
  const repoOf = new Map();
  if (demo) {
    for (const p of ranked) {
      const g = DEMO_GIT[p.name];
      if (g) repoOf.set(p.name, { name: p.name, commits: Math.round(g.commits * scale), added: Math.round(g.added * scale), removed: Math.round(g.removed * scale), prsMerged: Math.round(g.prsMerged * scale), defaultMerges: Math.round(g.defaultMerges * scale) });
    }
  } else if (git && names && names.path) {
    for (const p of ranked.slice(0, MAX_GIT_PROJECTS)) {
      const dir = names.path(p.projectHash);
      if (!dir) continue;
      try {
        const stats = await gitStatsForPeriod(git, [dir], from, { periodKey: period });
        const repo = stats.repos[0];
        if (repo) repoOf.set(p.name, { name: repo.name, commits: repo.commits, added: repo.added, removed: repo.removed, prsMerged: repo.prsMerged, defaultMerges: repo.defaultMerges });
      } catch { /* a repository git cannot read shows no evidence, not an error */ }
    }
  }

  const projects = ranked.map((p) => ({
    name: p.name,
    tokens: p.tokens,
    usd: p.priced ? p.usd : null,
    sessions: p.sessions.size,
    branches: [...p.branches],
    repo: repoOf.get(p.name) || null,
    costPerOutcome: costPerOutcome({ usd: p.usd, pricedMessages: p.priced, unpricedMessages: p.unpriced,
      commits: repoOf.get(p.name)?.commits ?? null,
      defaultMerges: repoOf.get(p.name)?.defaultMerges ?? null }),
  }));
  // One repository can hold several projects; count each repository once.
  const seen = new Map();
  for (const p of projects) if (p.repo) seen.set(p.repo.name, p.repo);
  const sum = (key) => [...seen.values()].reduce((a, r) => a + (r[key] || 0), 0);
  return {
    demo: Boolean(demo),
    period: { id: period, label: PERIODS[period].label },
    tokens: projects.reduce((a, p) => a + p.tokens, 0),
    sessions: projects.reduce((a, p) => a + p.sessions, 0),
    withRepo: projects.filter((p) => p.repo).length,
    totals: { commits: sum("commits"), added: sum("added"), removed: sum("removed"), prsMerged: sum("prsMerged") },
    projects,
  };
}
