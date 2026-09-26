/**
 * The Projects view: this machine's usage per project, beside what Git
 * recorded in the same period.
 *
 * Tokens, cost and sessions come from the hub's own store (this machine's
 * records only); project names, branches and folders come from the private
 * local names the hub keeps for its own machine. Git figures come from a
 * local `git log` in each project's repository — no network call — for the
 * busiest projects only, so a machine with hundreds of folders does not run
 * hundreds of git processes, and once per repository, however many project
 * folders sit inside it. Nothing here is sent anywhere.
 *
 * A project is its salted folder hash, never its name: two folders called
 * `app` under different parents are two rows, each with its parent folder's
 * name beside it. Every figure on the payload is computed at one `now`
 * (`computedAt`), including the whole team's totals the Effort line sets this
 * machine's share against.
 */

import crypto from "node:crypto";
import path from "node:path";
import { gitStatsForPeriod, repoToplevel } from "../gitstats.js";
import { costPerOutcome } from "../analysis/index.js";
import { MINUTE, sessionKey } from "./store.js";
import { PERIODS as CONSOLE_PERIODS, periodRange, priceStatus, STACK_STEPS, stackOf, laneRootResolver } from "./aggregate.js";

/*
 * The same periods as the Console and Team views, with the same edges
 * (aggregate.js, periodRange). "3d" is kept for a 0.2 link and is three days of
 * whole minutes ending with the current one.
 */
export const PERIODS = {
  ...Object.fromEntries(Object.entries(CONSOLE_PERIODS).map(([id, p]) => [id, { id, label: p.label }])),
  "3d": { id: "3d", label: "last 3 days", ms: 3 * 24 * 3600_000 },
};
const MAX_GIT_PROJECTS = 12;
const MAX_NAMED_MODELS = 20;

/* The demo's own machine: Git figures as synthetic as everything else in demo mode. */
const DEMO_GIT = {
  "atlas-api": { commits: 14, added: 2480, removed: 612, prsMerged: 3, defaultMerges: 2 },
  "atlas-web": { commits: 9, added: 1310, removed: 402, prsMerged: 2, defaultMerges: 1 },
  "docs-site": { commits: 4, added: 540, removed: 96, prsMerged: 1, defaultMerges: 0 },
};

const tokensOf = (b) => b.fresh + b.output + b.cacheWrite + b.cacheRead;
/* A repository's identity on this payload: a hash of its folder, which stays on this machine. */
const repoHashOf = (top) => crypto.createHash("sha256").update("agent-console-repo|" + top).digest("hex").slice(0, 16);

function emptyCost() {
  return { usd: 0, priced: 0, unpriced: 0, pricedMessages: 0, unpricedMessages: 0, unpricedTokens: 0, unpricedModels: new Set() };
}
function addCost(c, b) {
  c.usd += b.usd; c.priced += b.pricedN; c.unpriced += b.unpricedN;
  c.pricedMessages += b.pricedMessages ?? 0; c.unpricedMessages += b.unpricedMessages ?? 0; c.unpricedTokens += b.unpricedTokens ?? 0;
  if (b.unpricedN && c.unpricedModels.size < MAX_NAMED_MODELS) c.unpricedModels.add(b.model);
}
/** A money figure and its standing: "partial" dollars are a floor, "unpriced" has none. */
function costOut(c) {
  const status = priceStatus(c.priced, c.unpriced);
  return { usd: c.priced ? c.usd : null, status, pricedMessages: c.pricedMessages, unpricedMessages: c.unpricedMessages,
    unpricedTokens: c.unpricedTokens, unpricedModels: [...c.unpricedModels].sort() };
}

/**
 * @param {object} input
 * @param {object} input.store, input.registry, input.names
 * @param {string} input.period     one of PERIODS
 * @param {boolean} input.demo
 * @param {object} [input.git]      a createGitStatsStore(); absent in demo
 */
export async function projectsPayload({ store, registry, names, period, demo, git = null, now = Date.now() }) {
  const minuteNow = Math.floor(now / MINUTE) * MINUTE;
  const range = period === "3d" ? { basis: "minutes", from: minuteNow + MINUTE - PERIODS["3d"].ms, to: minuteNow + MINUTE } : periodRange(period, now);
  const from = range.from;
  const local = registry.list().find((d) => d.local);
  const byProject = new Map();
  const nameOf = (projectHash) => (names && names.project(projectHash)) || "project " + projectHash.slice(0, 6);
  // Sessions are lanes, as on the Console: a top-level session with its
  // subagents folded in. A subagent thread is counted apart, as a subagent.
  const add = (projectHash, bucket, sessionHash, threadHash = sessionHash) => {
    let p = byProject.get(projectHash);
    if (!p) { p = { name: nameOf(projectHash), projectHash, tokens: 0, cost: emptyCost(), sessions: new Set(), subagents: new Set(), sessionsKnown: true, branches: new Set() }; byProject.set(projectHash, p); }
    p.tokens += tokensOf(bucket);
    addCost(p.cost, bucket);
    if (!sessionHash) { p.sessionsKnown = false; return; }
    p.sessions.add(sessionHash);
    if (threadHash && threadHash !== sessionHash) p.subagents.add(threadHash);
    // A session key is machine|hash; the branch is named by the hash (this machine's own names).
    const branch = names.branch(sessionHash.slice(sessionHash.indexOf("|") + 1));
    if (branch) p.branches.add(branch);
  };
  const rootOf = laneRootResolver(store);
  // One machine's session tree, as the Console's lanes (a hash two machines share is two sessions).
  const topOf = (deviceId, sessionHash) => (sessionHash
    ? store.sessions.get(sessionKey(deviceId, rootOf(deviceId, sessionHash))) || store.sessions.get(sessionKey(deviceId, sessionHash)) : null);

  // Every period's stacked series by project (this machine only) and the
  // whole team's totals, from one pass over the minutes and one over the days.
  const ranges = Object.fromEntries(Object.keys(CONSOLE_PERIODS).map((key) => [key, periodRange(key, now)]));
  const frames = Object.fromEntries(Object.keys(CONSOLE_PERIODS).map((key) => [key,
    { start: ranges[key].from, step: STACK_STEPS[key], steps: Math.round((ranges[key].to - ranges[key].from) / STACK_STEPS[key]) }]));
  const steps = Object.fromEntries(Object.keys(CONSOLE_PERIODS).map((key) => [key, new Map()]));
  const fleet = Object.fromEntries(Object.keys(CONSOLE_PERIODS).map((key) => [key, { tokens: 0, cost: emptyCost() }]));
  const stack = (key, projectHash, i, tokens) => {
    let a = steps[key].get(projectHash);
    if (!a) { a = new Array(frames[key].steps).fill(0); steps[key].set(projectHash, a); }
    if (i >= 0 && i < a.length) a[i] += tokens;
  };
  const minuteKeys = ["1h", "24h", "7d"];
  const scanFrom = Math.min(ranges["7d"].from, range.basis === "minutes" ? from : Infinity);
  store.eachBucket(scanFrom, minuteNow + MINUTE, (minute, bucket) => {
    const tokens = tokensOf(bucket);
    const mine = local && bucket.deviceId === local.id && names;
    const top = mine ? topOf(bucket.deviceId, bucket.sessionHash) : null;
    for (const key of minuteKeys) {
      if (minute < ranges[key].from || minute >= ranges[key].to) continue;
      fleet[key].tokens += tokens;
      addCost(fleet[key].cost, bucket);
      if (top) stack(key, top.projectHash, Math.floor((minute - frames[key].start) / frames[key].step), tokens);
    }
    if (range.basis === "minutes" && top && minute >= from && minute < range.to) add(top.projectHash, bucket, sessionKey(top.deviceId, top.sessionHash), sessionKey(bucket.deviceId, bucket.sessionHash));
  });
  // 30 days come from the daily rollup, which keeps projects but not sessions.
  const month = ranges["30d"];
  store.eachDay?.(month.fromDay, month.toDay, (day, bucket) => {
    const tokens = tokensOf(bucket);
    fleet["30d"].tokens += tokens;
    addCost(fleet["30d"].cost, bucket);
    const mine = local && bucket.deviceId === local.id && names && bucket.projectHash;
    if (!mine) return;
    stack("30d", bucket.projectHash, Math.round((Date.parse(day + "T00:00:00Z") - month.from) / 86_400_000), tokens);
    if (range.basis === "utc-days") add(bucket.projectHash, bucket, null);
  });
  const ranked = [...byProject.values()].sort((a, b) => b.tokens - a.tokens);

  // Git, once per repository: projects are grouped by the folder Git calls the
  // top of their repository, and each repository's log is read one time.
  const scale = { "1h": 0.05, "24h": 1, "3d": 2.6, "7d": 5.8, "30d": 21 }[period] ?? 1;
  const repoOf = new Map();   // projectHash -> repo figures
  if (demo) {
    for (const p of ranked) {
      const g = DEMO_GIT[p.name];
      if (!g) continue;
      // Lines come with commits: a period too short for one commit shows no lines either.
      const commits = Math.round(g.commits * scale);
      const per = commits / g.commits;
      repoOf.set(p.projectHash, { name: p.name, repoHash: repoHashOf("demo|" + p.name), commits, added: Math.round(g.added * per), removed: Math.round(g.removed * per),
        prsMerged: Math.min(commits, Math.round(g.prsMerged * per)), defaultMerges: Math.min(commits, Math.round(g.defaultMerges * per)) });
    }
  } else if (git && names && names.path) {
    const byTop = new Map();
    for (const p of ranked.slice(0, MAX_GIT_PROJECTS)) {
      const dir = names.path(p.projectHash);
      if (!dir) continue;
      let top = null;
      try { top = await repoToplevel(git, dir); } catch { top = null; }
      if (!top) continue;
      if (!byTop.has(top)) byTop.set(top, []);
      byTop.get(top).push(p.projectHash);
    }
    for (const [top, hashes] of byTop) {
      try {
        // Only this machine's author's commits sit beside this machine's tokens.
        const stats = await gitStatsForPeriod(git, [top], from, { periodKey: period, mineOnly: true });
        const repo = stats.repos[0];
        if (!repo) continue;
        const figures = { name: repo.name, repoHash: repoHashOf(top), commits: repo.commits, added: repo.added, removed: repo.removed,
          prsMerged: repo.prsMerged, defaultMerges: repo.defaultMerges, mine: Boolean(repo.author) };
        for (const h of hashes) repoOf.set(h, figures);
      } catch { /* a repository git cannot read shows no evidence, not an error */ }
    }
  }

  const parentOf = (projectHash) => {
    const dir = names && names.path ? names.path(projectHash) : null;
    if (!dir) return null;
    const parent = path.basename(path.dirname(String(dir).replace(/[\\/]+$/u, "")));
    return parent && parent !== "." && parent !== path.sep ? parent : null;
  };
  // Each row's activity over the requested period, at that period's stacked
  // resolution, so the table's sparklines follow the period control. The
  // legacy "3d" period has no stacked frame and no sparkline.
  const rowFrame = frames[period] || null;
  const sparkOf = (projectHash) => rowFrame
    ? { start: rowFrame.start, step: rowFrame.step, tokens: steps[period].get(projectHash)?.slice() ?? new Array(rowFrame.steps).fill(0) }
    : null;
  const projects = ranked.map((p) => {
    const repo = repoOf.get(p.projectHash) || null;
    const cost = costOut(p.cost);
    return {
      name: p.name,
      projectHash: p.projectHash,
      // The folder the project sits in (one name, never a path): tells two `app`s apart.
      parent: parentOf(p.projectHash),
      repoHash: repo ? repo.repoHash : null,
      tokens: p.tokens,
      usd: cost.usd,
      cost,
      sessions: p.sessionsKnown ? p.sessions.size : null,
      // Subagent threads folded into those sessions; null where sessions are not kept.
      subagents: p.sessionsKnown ? p.subagents.size : null,
      branches: [...p.branches],
      spark: sparkOf(p.projectHash),
      repo,
      costPerOutcome: costPerOutcome({ usd: p.cost.usd, pricedMessages: p.cost.priced, unpricedMessages: p.cost.unpriced,
        commits: repo?.commits ?? null, defaultMerges: repo?.defaultMerges ?? null }),
    };
  });
  // One repository can hold several projects; count each repository once.
  const seen = new Map();
  for (const p of projects) if (p.repo) seen.set(p.repo.repoHash, p.repo);
  const repos = [...seen.values()];
  // Git figures nobody could read are unknown, never a measured zero: null
  // when no project is in a repository Git could read, and per field when no
  // repository reported that figure.
  const sum = (key) => {
    const known = repos.filter((r) => Number.isFinite(r[key]));
    return known.length ? known.reduce((a, r) => a + r[key], 0) : null;
  };
  const whole = emptyCost();
  for (const p of byProject.values()) {
    whole.usd += p.cost.usd; whole.priced += p.cost.priced; whole.unpriced += p.cost.unpriced;
    whole.pricedMessages += p.cost.pricedMessages; whole.unpricedMessages += p.cost.unpricedMessages; whole.unpricedTokens += p.cost.unpricedTokens;
    for (const m of p.cost.unpricedModels) if (whole.unpricedModels.size < MAX_NAMED_MODELS) whole.unpricedModels.add(m);
  }
  const series = Object.fromEntries(Object.keys(CONSOLE_PERIODS).map((key) => [key, { byProject: stackOf(frames[key], steps[key], "projectHash") }]));
  const minuteBasis = range.basis === "minutes";
  return {
    demo: Boolean(demo),
    computedAt: now,
    asOf: now,
    // True when every repository's figures are this machine's author's own;
    // false when one has no Git email set and counts every author; null when
    // there are no Git figures (or they are the demo's).
    author: demo || repos.length === 0 ? null : repos.every((r) => r.mine),
    // What the period keeps: minute detail has sessions and branches; the
    // daily rollup behind 30 days keeps neither.
    period: { id: period, label: PERIODS[period].label, basis: range.basis, from: range.from, to: range.to,
      branchesKept: minuteBasis, sessionsKept: minuteBasis },
    tokens: projects.reduce((a, p) => a + p.tokens, 0),
    // "partial": some project's usage had no verified price, so the dollars are a floor.
    cost: costOut(whole),
    // Lanes on this machine with usage in the period: the Console's count of the same sessions.
    sessions: projects.every((p) => p.sessions !== null) ? projects.reduce((a, p) => a + p.sessions, 0) : null,
    subagents: projects.every((p) => p.subagents !== null) ? projects.reduce((a, p) => a + p.subagents, 0) : null,
    withRepo: projects.filter((p) => p.repo).length,
    totals: repos.length
      ? { commits: sum("commits"), added: sum("added"), removed: sum("removed"), prsMerged: sum("prsMerged"), reason: null }
      : { commits: null, added: null, removed: null, prsMerged: null,
        reason: projects.length ? "no project here is in a Git repository this console could read" : "no project has usage in this period" },
    projects,
    // Every period, stacked by project: this machine's top four projects and the rest.
    series,
    // The whole team at the same `now`, every period: what this machine's
    // share is of. Git is read on this machine only, so the team's commits are unknown.
    fleet: Object.fromEntries(Object.entries(fleet).map(([key, f]) => {
      const c = costOut(f.cost);
      return [key, { tokens: f.tokens, cost: { usd: c.usd, status: c.status }, commits: null }];
    })),
  };
}
