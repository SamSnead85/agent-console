/**
 * Project-directory name recovery.
 *
 * Claude Code names a project directory after its cwd with every non-alphanumeric
 * character replaced by "-". Replacing every dash with a slash cannot invert
 * that lossy mapping and can produce confidently incorrect project labels.
 *
 * The mapping is not invertible in the abstract, but it IS resolvable against
 * the filesystem the slug came from: walk down from the root and, at each level,
 * pick the longest real directory entry whose own slug is a prefix of what is
 * left. Results are cached; a slug that does not resolve falls back to a clearly
 * approximate rendering rather than a confident wrong one.
 */

import fs from "node:fs";
import path from "node:path";

export function slugifySegment(name) {
  return name.replace(/[^A-Za-z0-9]/gu, "-");
}

const resolveCache = new Map();
const dirCache = new Map();

function entriesOf(dir) {
  const cached = dirCache.get(dir);
  if (cached) return cached;
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    names = [];
  }
  const table = names
    .map((name) => ({ name, slug: slugifySegment(name) }))
    .sort((a, b) => b.slug.length - a.slug.length);
  dirCache.set(dir, table);
  return table;
}

/** Drop the memoised directory listings (used by tests and on rescan of a new root). */
export function clearPathCaches() {
  resolveCache.clear();
  dirCache.clear();
}

/**
 * Best-effort absolute path for a project slug.
 * Returns { path, exact } — `exact` false means the filesystem could not confirm
 * it and the value is a readable guess, which callers must label as such.
 */
export function resolveProjectSlug(slug) {
  if (resolveCache.has(slug)) return resolveCache.get(slug);
  const result = resolveUncached(slug);
  resolveCache.set(slug, result);
  return result;
}

function resolveUncached(slug) {
  if (typeof slug !== "string" || slug.length === 0) {
    return { path: "", exact: false };
  }
  let rest = slug.startsWith("-") ? slug.slice(1) : slug;
  let dir = slug.startsWith("-") ? "/" : "";
  if (!dir) return { path: rest.replace(/-/gu, "/"), exact: false };

  let guard = 0;
  while (rest.length > 0 && guard < 64) {
    guard += 1;
    let matched = null;
    for (const entry of entriesOf(dir)) {
      if (entry.slug.length === 0) continue;
      if (rest === entry.slug) {
        matched = { name: entry.name, consumed: entry.slug.length };
        break;
      }
      if (rest.startsWith(entry.slug + "-")) {
        matched = { name: entry.name, consumed: entry.slug.length + 1 };
        break;
      }
    }
    if (!matched) {
      // Unresolvable tail (the directory has since been deleted or renamed).
      const tail = rest.replace(/-/gu, "/");
      return { path: path.join(dir, tail), exact: false };
    }
    dir = path.join(dir, matched.name);
    rest = rest.slice(matched.consumed);
  }
  return { path: dir, exact: true };
}

/** The label shown in the roster: the last real path segment. */
export function projectLabel(absolutePath) {
  if (!absolutePath) return "unknown";
  const parts = String(absolutePath).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}
