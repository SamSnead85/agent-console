/**
 * Which transcripts a pass looks at.
 *
 * `scanRoots` walks every root and stats every file: what a reporter, the
 * standalone collector and a first read use.
 *
 * `createScanner` is for a reader that passes every two seconds over a
 * history that may hold tens of thousands of transcripts (the hub's own
 * machine). Walking and stat-ing all of them every pass kept a large share of
 * a core busy at idle. The scanner walks everything once a minute; between
 * those walks it looks only where something can be happening:
 *
 *   - files changed in the last quarter hour are stat-ed again (the sessions
 *     being written);
 *   - the roots, their direct children and every folder above a recently
 *     changed file are stat-ed, and a folder whose modification time moved is
 *     listed again (a new transcript, a new subagent folder, a new day);
 *   - everything else waits for the next whole walk, at most a minute away (a
 *     session resumed after a long pause, a new day folder under a quiet month).
 *
 * The file list, sizes and times are kept in memory only; nothing about a path
 * is written anywhere.
 */
import fsSync from 'node:fs';
import path from 'node:path';

export const WHOLE_EVERY_MS = 60_000;
export const HOT_MS = 15 * 60_000;

const statOf = (s) => ({ size: s.size, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs });

/**
 * One whole walk: `{ whole: true, roots: [{ tool, directory, optional, exists, files }], entries: [{ root, filename, stat }], unreadable }`.
 * `stat` is null for a file that could not be stat-ed; a root that cannot be listed makes `whole` false.
 */
export async function scanRoots(roots) {
  const out = { whole: true, roots: [], entries: [], unreadable: 0 };
  // Synchronous: a whole walk through promises costs several times the CPU (see createScanner).
  const walk = (directory, root, summary) => {
    let entries;
    try { entries = fsSync.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    entries.sort((a, b) => (a.isDirectory() - b.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full, root, summary);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        summary.files += 1;
        try { out.entries.push({ root, filename: full, stat: statOf(fsSync.statSync(full)) }); }
        catch { out.entries.push({ root, filename: full, stat: null }); out.unreadable += 1; }
      }
    }
  };
  for (const root of roots) {
    const summary = { tool: root.tool, directory: root.directory, optional: Boolean(root.optional), exists: false, files: 0 };
    out.roots.push(summary);
    try {
      if (!fsSync.statSync(root.directory).isDirectory()) continue;
      summary.exists = true;
      walk(root.directory, root, summary);
    } catch (error) {
      if (error?.code !== 'ENOENT') { out.whole = false; out.unreadable += 1; summary.readable = false; }
    }
  }
  return out;
}

/**
 * @param {object} [options]
 * @param {number} [options.wholeEveryMs]  how often a sweep of everything starts
 * @param {number} [options.hotMs]         how recently a file must have changed to be looked at on every pass
 * @param {number} [options.budgetMs]      the most a pass spends on the sweep, so the console keeps answering
 * @param {() => number} [options.now]
 */
export function createScanner({ wholeEveryMs = WHOLE_EVERY_MS, hotMs = HOT_MS, budgetMs = 15, now = () => Date.now() } = {}) {
  let state = null;   // { sig, roots, dirs: Map(dir -> mtimeMs), files: Map(filename -> { root, stat }) }
  let sweep = null;   // { startedAt, pending: [{ dir, root }], dirs, files, unreadable, rootsSeen: Set }
  let lastSweep = 0;
  const keys = new Map();   // filename -> { birthtimeMs, key }

  const signature = (roots) => roots.map((r) => `${r.tool}\0${r.directory}`).join('\n');
  // Synchronous calls: tens of thousands of stat calls through promises cost
  // several times the CPU of the calls themselves. The sweep is cut into
  // slices of `budgetMs`, so no pass holds the process for long.
  const statSync = (file) => { try { return statOf(fsSync.statSync(file)); } catch { return null; } };

  function startSweep(roots) {
    sweep = { startedAt: now(), pending: [], dirs: new Map(), files: new Map(), unreadable: 0, rootsSeen: new Set(), rootUnreadable: false };
    for (const root of [...roots].reverse()) sweep.pending.push({ dir: root.directory, root });
    lastSweep = sweep.startedAt;
  }
  /** Sweeps for at most `budget` ms (all of it when budget is Infinity); true when the sweep is done. */
  function advance(budget) {
    const t0 = performance.now();
    // At least one folder a pass, however small the budget.
    for (let first = true; sweep.pending.length && (first || performance.now() - t0 < budget); first = false) {
      const { dir, root } = sweep.pending.pop();
      let entries, mtimeMs;
      try { mtimeMs = fsSync.statSync(dir).mtimeMs; entries = fsSync.readdirSync(dir, { withFileTypes: true }); }
      catch (error) {
        // A root that cannot be listed (not merely absent) makes the sweep partial: nothing may be let go.
        if (dir === root.directory && error?.code !== 'ENOENT') { sweep.unreadable += 1; sweep.rootUnreadable = true; }
        continue;
      }
      if (dir === root.directory) sweep.rootsSeen.add(root);
      sweep.dirs.set(dir, mtimeMs);
      const subdirs = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) subdirs.push({ dir: full, root });
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const stat = statSync(full);
          if (stat) sweep.files.set(full, { root, stat }); else sweep.unreadable += 1;
        }
      }
      for (const sub of subdirs.reverse()) sweep.pending.push(sub);
    }
    return sweep.pending.length === 0;
  }

  function summaries() {
    const counts = new Map();
    for (const { root } of state.files.values()) counts.set(root, (counts.get(root) || 0) + 1);
    return state.roots.map((root) => ({ tool: root.tool, directory: root.directory, optional: Boolean(root.optional),
      exists: state.dirs.has(root.directory), files: counts.get(root) || 0 }));
  }

  /* Deepest last, so a session's own transcript is read before its subagents' (collector.js walk). */
  const ordered = (list) => list.sort((a, b) => a.filename.split(path.sep).length - b.filename.split(path.sep).length || (a.filename < b.filename ? -1 : 1));

  /* A sweep is complete: it replaces the file list; what changed since the list it replaces is looked at. */
  function finishSweep() {
    const changed = [];
    for (const [filename, entry] of sweep.files) {
      const held = state?.files.get(filename);
      // A file looked at since the sweep passed it is newer than the sweep's reading: that one stands.
      if (held && held.stat.birthtimeMs === entry.stat.birthtimeMs && held.stat.mtimeMs > entry.stat.mtimeMs) { sweep.files.set(filename, held); continue; }
      if (!held || held.stat.size !== entry.stat.size || held.stat.mtimeMs !== entry.stat.mtimeMs || held.stat.birthtimeMs !== entry.stat.birthtimeMs) {
        changed.push({ root: entry.root, filename, stat: entry.stat });
      }
    }
    state = { sig: state?.sig, roots: state?.roots, dirs: sweep.dirs, files: sweep.files };
    for (const filename of keys.keys()) if (!state.files.has(filename)) keys.delete(filename);
    const unreadable = sweep.unreadable, whole = !sweep.rootUnreadable;
    sweep = null;
    return { changed, unreadable, whole };
  }

  /* Between sweeps: files changed lately, and folders where a new transcript can appear. */
  function quick() {
    const t = now();
    const changed = new Map();
    const rootOfDir = (dir) => state.roots.find((r) => dir === r.directory || dir.startsWith(r.directory + path.sep));
    const addFile = (filename, root) => {
      const stat = statSync(filename);
      if (!stat) { state.files.delete(filename); return; }
      const held = state.files.get(filename);
      state.files.set(filename, { root, stat });
      if (!held || held.stat.size !== stat.size || held.stat.mtimeMs !== stat.mtimeMs || held.stat.birthtimeMs !== stat.birthtimeMs) changed.set(filename, { root, filename, stat });
    };
    const addTree = (dir, root) => {
      let entries;
      try { state.dirs.set(dir, fsSync.statSync(dir).mtimeMs); entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) addTree(full, root);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) addFile(full, root);
      }
    };
    // The folders worth a look: the roots, their children, and every folder above a file changed lately.
    const hotDirs = new Set();
    const rootDirs = new Set(state.roots.map((r) => r.directory).filter((d) => state.dirs.has(d)));
    for (const dir of rootDirs) hotDirs.add(dir);
    for (const dir of state.dirs.keys()) if (rootDirs.has(path.dirname(dir))) hotDirs.add(dir);
    for (const [filename, { stat }] of state.files) {
      if (t - stat.mtimeMs >= hotMs) continue;
      for (let dir = path.dirname(filename); state.dirs.has(dir) && !hotDirs.has(dir); dir = path.dirname(dir)) hotDirs.add(dir);
    }
    for (const dir of hotDirs) {
      let mtimeMs;
      try { mtimeMs = fsSync.statSync(dir).mtimeMs; } catch { continue; }   // gone: the next sweep sees it
      if (mtimeMs === state.dirs.get(dir)) continue;
      state.dirs.set(dir, mtimeMs);
      let entries;
      try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      const root = rootOfDir(dir);
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !state.dirs.has(full)) addTree(full, root);
        else if (entry.isFile() && entry.name.endsWith('.jsonl') && !state.files.has(full)) addFile(full, root);
      }
    }
    for (const [filename, { root, stat }] of state.files) {
      if (changed.has(filename) || t - stat.mtimeMs >= hotMs) continue;
      addFile(filename, root);
    }
    return changed;
  }

  return {
    /** The collector's cursor as this process last wrote or read it (lib/collector/collector.js), or null. */
    cursor: null,
    /**
     * The files to look at on this pass: `entries` changed (or, on the first
     * pass, all), and `all`, every file known, when a sweep completed on this
     * pass (`whole` true): only then may a file missing from it be let go.
     */
    async scan(roots) {
      const sig = signature(roots);
      if (!state || state.sig !== sig) {
        // The first pass (or new roots): everything, at once.
        startSweep(roots);
        advance(Infinity);
        const seen = sweep.rootsSeen;
        state = null;
        const { changed, unreadable, whole } = finishSweep();
        state.sig = sig; state.roots = roots;
        return { whole, roots: summaries().map((r, i) => ({ ...r, exists: seen.has(roots[i]) })), entries: ordered(changed), all: [...state.files].map(([filename, e]) => ({ root: e.root, filename, stat: e.stat })), unreadable };
      }
      const changed = quick();
      if (!sweep && now() - lastSweep >= wholeEveryMs) startSweep(roots);
      if (sweep && advance(budgetMs)) {
        const done = finishSweep();
        for (const entry of done.changed) changed.set(entry.filename, entry);
        return { whole: done.whole, roots: summaries(), entries: ordered([...changed.values()]), all: [...state.files].map(([filename, e]) => ({ root: e.root, filename, stat: e.stat })), unreadable: done.unreadable };
      }
      return { whole: false, roots: summaries(), entries: ordered([...changed.values()]), unreadable: 0 };
    },
    /** A file's source key, computed once per file and creation time. */
    key(filename, birthtimeMs, compute) {
      const held = keys.get(filename);
      if (held && held.birthtimeMs === birthtimeMs) return held.key;
      const key = compute();
      keys.set(filename, { birthtimeMs, key });
      return key;
    },
    /** Start a sweep of everything on the next pass. */
    invalidate() { lastSweep = 0; },
    /** A file the reader could not take this pass (unreadable, or waiting for a whole listing): offered again by the next sweep. */
    forget(filename) { state?.files.delete(filename); },
  };
}
