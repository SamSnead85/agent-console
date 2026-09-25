/**
 * Period-scoped code statistics — merged PRs and lines added/removed — from
 * local `git log --numstat` only. No network call is made; every repository
 * the agents work in is on this disk.
 *
 * "Merged PRs" here means: distinct PR numbers named by commits that LANDED in
 * the current branch's history inside the period — GitHub's squash merges end
 * the subject with "(#N)" and classic merges start it with "Merge pull request
 * #N". Counting merge commits alone misses every squash merge, which is most
 * of them on this repository. The page calls them "commits referencing #N":
 * a subject can name an issue, not a pull request.
 *
 * WHOSE COMMITS. Figures shown beside this machine's tokens count only
 * commits authored with this repository's configured Git email
 * (`git config user.email`), so a clone does not credit other people's work
 * to this machine. With no email configured, every author is counted and the
 * payload says so (`author: null`).
 */

import { execFile } from "node:child_process";
import process, { env } from "node:process";

const CACHE_MS = 60_000;
const MAX_REPOS = 8;
const REC = "\u001e"; // record separator between commits
const SEP = "\u001f"; // unit separator inside a commit header

const gitEnv = { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
const GIT = process.platform === "win32" ? "git" : "/usr/bin/git";

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      GIT,
      args,
      { cwd, env: gitEnv, maxBuffer: 64 * 1024 * 1024, timeout: 20_000 },
      (error, stdout) => resolve({ error, stdout: stdout || "" }),
    );
  });
}

export function createGitStatsStore() {
  return { cache: new Map(), toplevel: new Map(), defaultMerges: new Map(), emails: new Map() };
}

/** This repository's configured author email, or null. Cached for a minute. */
async function authorEmailOf(store, root) {
  if (!store.emails) store.emails = new Map();
  const cached = store.emails.get(root);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const { error, stdout } = await git(root, ["config", "--get", "user.email"]);
  const value = error ? null : stdout.trim() || null;
  store.emails.set(root, { at: Date.now(), value });
  return value;
}

/** git log arguments that keep only this author's commits: an exact, fixed-string match on the email. */
export function authorArgs(email) {
  return email ? ["--fixed-strings", "--author=<" + email + ">"] : [];
}

/** Count integration commits on a locally known default branch; never fetch. */
async function defaultMergesForPeriod(store, root, fromMs, periodKey, email = null) {
  const now = Date.now();
  for (const [oldKey, entry] of store.defaultMerges) {
    if (now - entry.at >= CACHE_MS) store.defaultMerges.delete(oldKey);
  }
  const key = root + '|' + (email || '*') + '|' + (periodKey || Math.round((now - fromMs) / 3_600_000) + 'h');
  const cached = store.defaultMerges.get(key);
  if (cached) return cached.value;
  const remoteHead = await git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  let ref = remoteHead.error ? null : remoteHead.stdout.trim();
  if (!ref) {
    for (const name of ['main', 'master']) {
      const found = await git(root, ['show-ref', '--verify', '--quiet', 'refs/heads/' + name]);
      if (!found.error) { ref = 'refs/heads/' + name; break; }
    }
  }
  if (!ref) return null;
  const result = await git(root, ['log', ref, '--first-parent', ...authorArgs(email), '--since=' + new Date(fromMs).toISOString(),
    '--pretty=format:%ct' + SEP + '%P' + SEP + '%s']);
  if (result.error) return null;
  let value = 0;
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const [seconds, parents, subject] = line.split(SEP);
    if (Number(seconds) * 1000 < fromMs) continue;
    if ((parents || '').trim().split(/\s+/u).length > 1 || prNumbersOf(subject || '').length) value += 1;
  }
  store.defaultMerges.set(key, { at: now, value });
  return value;
}

/** The repository a folder belongs to (its `git rev-parse --show-toplevel`), or null; asked once per folder. */
export async function repoToplevel(store, dir) { return toplevelOf(store, dir); }

async function toplevelOf(store, dir) {
  if (store.toplevel.has(dir)) return store.toplevel.get(dir);
  const { error, stdout } = await git(dir, ["rev-parse", "--show-toplevel"]);
  const value = error ? null : stdout.trim() || null;
  store.toplevel.set(dir, value);
  return value;
}

/** Distinct PR numbers a commit subject names, or an empty list. */
export function prNumbersOf(subject) {
  const out = [];
  const merge = /^Merge pull request #(\d+)/u.exec(subject);
  if (merge) out.push(Number(merge[1]));
  const squash = /\(#(\d+)\)\s*$/u.exec(subject);
  if (squash) out.push(Number(squash[1]));
  return out;
}

/**
 * Parse `git log --numstat` output framed with REC/SEP separators.
 * Binary files report "-" in numstat and are skipped, never counted as zero
 * lines of a text change.
 */
export function parseNumstat(stdout, fromMs) {
  let commits = 0;
  let added = 0;
  let removed = 0;
  const prs = new Set();
  /** author name -> that author's share of the same four figures. */
  const authors = new Map();
  for (const block of stdout.split(REC)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const header = lines[0].split(SEP);
    const at = Number(header[0] || 0) * 1000;
    // --since already filters, but the guard keeps the arithmetic right if a
    // caller framed the log differently.
    if (fromMs !== null && Number.isFinite(fromMs) && at < fromMs) continue;
    const subject = header[1] || "";
    // The author is the LAST field, not the second: a subject containing the
    // unit separator would otherwise shift every field after it, and the
    // pre-existing two-field framing (no author at all) must keep parsing.
    const author = (header[2] || "").trim() || "unknown";
    commits += 1;
    let mine = authors.get(author);
    if (!mine) {
      mine = { commits: 0, added: 0, removed: 0, prs: new Set() };
      authors.set(author, mine);
    }
    mine.commits += 1;
    for (const n of prNumbersOf(subject)) {
      prs.add(n);
      mine.prs.add(n);
    }
    for (const line of lines.slice(1)) {
      const m = /^(\d+|-)\t(\d+|-)\t/u.exec(line);
      if (!m) continue;
      if (m[1] !== "-") {
        added += Number(m[1]);
        mine.added += Number(m[1]);
      }
      if (m[2] !== "-") {
        removed += Number(m[2]);
        mine.removed += Number(m[2]);
      }
    }
  }
  return { commits, added, removed, prs, authors };
}

/**
 * Stats for one repository over the period. Cached per (root, period minute)
 * so the poll loop never runs more than one log per repo per minute.
 */
async function statsForRoot(store, root, fromMs, email = null) {
  const cacheKey =
    root + "|" + (email || "*") + "|" + (fromMs === null ? "all" : Math.floor(fromMs / 60_000));
  const cached = store.cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const args = [
    "log",
    "--numstat",
    "--no-renames",
    "--pretty=format:" + REC + "%ct" + SEP + "%s" + SEP + "%aN",
    ...authorArgs(email),
  ];
  if (fromMs !== null)
    args.splice(1, 0, "--since=" + new Date(fromMs).toISOString());
  const { error, stdout } = await git(root, args);
  const value = error
    ? { error: "git log unavailable" }
    : parseNumstat(stdout, fromMs);
  store.cache.set(cacheKey, { at: Date.now(), value });
  if (store.cache.size > 64) {
    for (const key of store.cache.keys()) {
      if (store.cache.size <= 64) break;
      store.cache.delete(key);
    }
  }
  return value;
}

/**
 * @param {string[]} dirs candidate working directories (session cwds plus the
 *   dashboard's own repository)
 * @param {number|null} fromMs period start, or null for all history
 */
export async function gitStatsForPeriod(store, dirs, fromMs, { periodKey = null, mineOnly = false } = {}) {
  const roots = new Set();
  for (const dir of dirs) {
    if (roots.size >= MAX_REPOS) break;
    if (!dir) continue;
    const top = await toplevelOf(store, dir);
    if (top) roots.add(top);
  }

  const repos = [];
  const totals = { commits: 0, prsMerged: 0, added: 0, removed: 0 };
  const errors = [];
  const allPrs = new Set();
  // A PR number is only unique within its repository, so authorship is keyed
  // "<root>#<n>" here exactly as the combined total is. Counting bare numbers
  // would let #12 in two repositories collapse into one merged PR.
  const byAuthor = new Map();
  let author = null;
  for (const root of roots) {
    const email = mineOnly ? await authorEmailOf(store, root) : null;
    if (email) author = email;
    const stats = await statsForRoot(store, root, fromMs, email);
    if (stats.error) {
      errors.push(root.split("/").pop() + ": " + stats.error);
      continue;
    }
    repos.push({
      name: root.split("/").pop(),
      path: root,
      commits: stats.commits,
      prsMerged: stats.prs.size,
      added: stats.added,
      removed: stats.removed,
      author: email,
      defaultMerges: fromMs === null ? null : await defaultMergesForPeriod(store, root, fromMs, periodKey, email),
    });
    totals.commits += stats.commits;
    totals.added += stats.added;
    totals.removed += stats.removed;
    for (const n of stats.prs) allPrs.add(root + "#" + n);
    for (const [name, mine] of stats.authors || []) {
      let entry = byAuthor.get(name);
      if (!entry) {
        entry = {
          name,
          commits: 0,
          added: 0,
          removed: 0,
          prs: new Set(),
          repos: new Set(),
        };
        byAuthor.set(name, entry);
      }
      entry.commits += mine.commits;
      entry.added += mine.added;
      entry.removed += mine.removed;
      entry.repos.add(root.split("/").pop());
      for (const n of mine.prs) entry.prs.add(root + "#" + n);
    }
  }
  totals.prsMerged = allPrs.size;
  repos.sort((a, b) => b.commits - a.commits);
  const authors = Array.from(byAuthor.values())
    .map((a) => ({
      name: a.name,
      commits: a.commits,
      added: a.added,
      removed: a.removed,
      prsMerged: a.prs.size,
      repos: Array.from(a.repos).sort(),
    }))
    .sort((a, b) => b.commits - a.commits);
  return {
    source: "local git log --numstat — no network call is made",
    author,
    repos,
    authors,
    totals,
    errors,
  };
}
