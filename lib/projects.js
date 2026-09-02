/**
 * The project ledger — this machine has more than one.
 *
 * The scan has always covered every project on the disk; nothing on screen said
 * so. The headline read "project lifecycle" over a figure that was in fact
 * fourteen projects added together, which is a number nobody asked for
 * presented as a number somebody did.
 *
 * This module joins the three things already measured about a project and
 * refuses to invent a fourth:
 *
 *   tokens   — from the period's history buckets, keyed by transcript slug.
 *   code     — from local `git log --numstat` for the repository that project
 *              sits in, over the SAME period. Matched by filesystem path, and
 *              left null when no repository contains it, because a project with
 *              no repository is a real thing (notes, scratch work) and a zero
 *              would read as "shipped nothing" rather than "not a repo".
 *   sessions — live rows currently scanned in that directory, with branches.
 *
 * A repository can hold several transcript projects (a worktree, a subdirectory
 * opened separately), so the repository figures are marked as belonging to the
 * REPOSITORY, not divided between the projects that share it. Splitting 617
 * merged PRs across two directories by some ratio would be arithmetic with no
 * evidence under it.
 */

/** True when `child` is `parent` or sits underneath it. */
export function isInside(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

/** The most specific repository containing this path, or null. */
export function repoFor(projectPath, repos) {
  let best = null;
  for (const repo of repos || []) {
    if (!isInside(projectPath, repo.path)) continue;
    if (!best || repo.path.length > best.path.length) best = repo;
  }
  return best;
}

/**
 * @param {object} input
 * @param {Array}  input.projects history's per-project totals
 * @param {object} input.code gitStatsForPeriod() result
 * @param {Array}  input.rows live roster rows
 * @param {object} input.period the period these figures cover
 * @param {string|null} input.selected the currently scoped project slug
 */
export function buildProjects(input) {
  const projects = input.projects || [];
  const repos = (input.code && input.code.repos) || [];
  const rows = input.rows || [];
  const selected = input.selected || null;

  // Live sessions and branches, grouped by the directory they are running in.
  const liveByPath = new Map();
  for (const row of rows) {
    if (!row.path) continue;
    let entry = liveByPath.get(row.path);
    if (!entry) {
      entry = { sessions: 0, live: 0, branches: new Set(), vendors: new Set() };
      liveByPath.set(row.path, entry);
    }
    if (row.state !== "COLD") entry.sessions += 1;
    if (row.state === "LIVE" || row.state === "WARM") entry.live += 1;
    if (row.branch) entry.branches.add(row.branch);
    entry.vendors.add(row.vendor);
  }

  const out = projects.map((p) => {
    const repo = repoFor(p.path, repos);
    const live = liveByPath.get(p.path) || null;
    const shared = repo
      ? projects.filter((other) => isInside(other.path, repo.path)).length
      : 0;
    return {
      slug: p.slug,
      label: p.label,
      path: p.path,
      tokens: p.total,
      // Tokens whose class split (and therefore cost) is recoverable.
      attributed: p.attributed,
      unattributed: p.unattributed,
      repo: repo
        ? {
            name: repo.name,
            path: repo.path,
            commits: repo.commits,
            prsMerged: repo.prsMerged,
            added: repo.added,
            removed: repo.removed,
            // Named rather than divided. Two transcript projects inside one
            // repository share these figures; they are not each project's own.
            sharedWith: Math.max(0, shared - 1),
          }
        : null,
      sessions: live ? live.sessions : 0,
      live: live ? live.live : 0,
      branches: live ? Array.from(live.branches).sort() : [],
      vendors: live ? Array.from(live.vendors).sort() : [],
      selected: p.slug === selected,
    };
  });

  const withRepo = out.filter((p) => p.repo).length;
  return {
    available: true,
    period: input.period || null,
    selected,
    projects: out,
    count: out.length,
    withRepo,
    liveCount: out.reduce((n, p) => n + p.live, 0),
    note:
      out.length +
      (out.length === 1 ? " project has" : " projects have") +
      " transcripts in this period; " +
      withRepo +
      (withRepo === 1 ? " sits" : " sit") +
      " inside a git repository. Repository figures belong to the repository and are not divided between projects that share it.",
  };
}
