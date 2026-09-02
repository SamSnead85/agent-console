/**
 * Codex rollout scanner.
 *
 * Token counts here are EXACT — the rollout log records the thread's own
 * cumulative `total_token_usage`. They are also per-thread cumulative rather
 * than day-scoped, and no OpenAI price table is bundled, so no Codex quantity
 * is ever summed into a daily total or converted to dollars. Every Codex figure
 * is marked with a sigma to keep that distinction on screen rather than in a
 * footnote.
 *
 * The cumulative figure being exact is not the same as it being spent NOW. A
 * forked thread inherits its parent's history and rewrites it into the new
 * rollout under the fork's own clock, so the two questions this file answers —
 * "how much has this thread used in total" and "how much was burned in this
 * minute" — read the same records and must not read them the same way. See
 * isInheritedReplay.
 */

import fs from "node:fs";
import path from "node:path";
import { createReadState, readNewLines, parseLine } from "./jsonl.js";
import { createSeries, addSample } from "./series.js";
import { projectLabel } from "./paths.js";

const MARKERS = [
  "token_count",
  "session_meta",
  "turn_context",
  "sub_agent_activity",
  "patch_apply_end",
];

const FILE_RE = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-(.+)\.jsonl$/u;

/**
 * How long after a forked thread's own `session_meta` its INHERITED history is
 * still being written into the new file.
 *
 * In a 151-rollout validation sample, the longest opening replay burst spanned
 * 768 ms and the shortest gap from the end of a burst to the fork's first real
 * turn was 6,050 ms. The two populations are separated by roughly an order of
 * magnitude, placing 2 s conservatively between them.
 */
export const REPLAY_WINDOW_MS = 2000;

export function createCodexStore(config) {
  return {
    root: config.root,
    windowMs: config.windowMs,
    files: new Map(),
    // The SAME series the Claude scanner fills. The fleet burn test compares a
    // numerator summed over every row against a baseline built here, so a
    // vendor that contributes to the numerator and not to the baseline makes
    // the master say BURNING while the instrument under it reads zero.
    fleetSeries: config.fleetSeries || null,
  };
}

/**
 * Discover rollouts by modification time, not by directory date.
 *
 * Codex files a rollout under the day the THREAD STARTED. Reading only today's
 * and yesterday's date directories therefore misses long-running threads
 * entirely. The regression corpus includes a long-running thread stored under
 * an older start date to keep this discovery rule pinned.
 */
export function findRollouts(root, cutoffMs) {
  const out = [];
  const stack = [root];
  let guard = 0;
  while (stack.length && guard < 20_000) {
    guard += 1;
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const match = FILE_RE.exec(entry.name);
      if (!match) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoffMs) continue;
      out.push({ file: full, threadId: match[1], stat });
    }
  }
  return out;
}

function newState(found) {
  return createReadState(found.file, {
    threadId: found.threadId,
    mtime: found.stat.mtimeMs,
    id: found.threadId,
    metaId: null,
    agentPath: null,
    cwd: null,
    model: null,
    effort: null,
    originator: null,
    cliVersion: null,
    source: null,
    git: null,
    contextWindow: 0,
    total: null,
    rateLimits: null,
    ownMetaSeen: false,
    forkedFrom: null,
    openedAt: 0,
    replaying: false,
    inheritedTokens: 0,
    startedAt: 0,
    lastTs: 0,
    children: new Map(),
    events: [],
    series: createSeries(),
    patches: 0,
    patchFailures: 0,
    filesTouched: new Set(),
    calls: 0,
  });
}

export function scanCodex(store, now) {
  if (!fs.existsSync(store.root)) {
    return { available: false, reason: "no-directory" };
  }
  const cutoff = now - store.windowMs;
  const found = findRollouts(store.root, cutoff);
  const seen = new Set();

  for (const entry of found) {
    seen.add(entry.file);
    let state = store.files.get(entry.file);
    if (!state) {
      state = newState(entry);
      store.files.set(entry.file, state);
    }
    // See the matching guard in lib/claude.js: a pending un-terminated line is
    // flushed only once the file goes quiet, which is exactly when mtime and
    // size stop moving, so skipping on those two alone makes the flush
    // unreachable and the total depend on when the process started.
    if (
      entry.stat.mtimeMs === state.mtime &&
      entry.stat.size === state.offset &&
      state.offset > 0 &&
      !state.leftover
    ) {
      continue;
    }
    readNewLines(
      state,
      (line) => {
        let interesting = false;
        for (const marker of MARKERS) {
          if (line.indexOf(marker) !== -1) {
            interesting = true;
            break;
          }
        }
        if (!interesting) return;
        const d = parseLine(state, line);
        if (!d) return;
        ingest(state, d, store.fleetSeries);
      },
      now,
    );
    const hotFloor = now - 6 * 60_000;
    if (
      state.events.length > 4000 ||
      (state.events.length && state.events[0].t < hotFloor)
    ) {
      state.events = state.events.filter((e) => e.t >= hotFloor);
    }
  }
  for (const key of Array.from(store.files.keys())) {
    if (!seen.has(key)) store.files.delete(key);
  }
  return { available: true };
}

/**
 * Is this `token_count` part of the history the thread INHERITED at its fork,
 * rather than tokens it spent itself?
 *
 * Forking a Codex thread rewrites the parent's entire turn history into the new
 * rollout, stamped with the fork's own wall clock. Read at face value those
 * records land in the minute the fork happened: one fork of a day-old thread
 * inherited 533,976,873 tokens against a real lifetime burn of 1,544,220, and
 * three sibling forks opening together put 1,602,584,732 into the 19:08 bucket
 * — the "BURNING · 1.60B/5m" the banner was reporting. Replaying the same 72
 * hours of real rollouts through both readers, 48,357,223,126 of the
 * 53,715,634,013 tokens placed in minute buckets were inherited history the
 * parents' own rollouts had already counted: 90%.
 *
 * Three fixes were considered. Two are unavailable, and the log is what rules
 * them out rather than taste:
 *
 *  - De-duplicate by a per-entry identity. A `token_count` payload carries only
 *    `info` and `rate_limits`; there is no event id, no turn id, no sequence
 *    number. There is nothing stable to key on.
 *  - Re-stamp the entry with its ORIGINAL time. The replayed record carries no
 *    original timestamp — only the fork-time one. And even if it did, the
 *    parent's own rollout already contributed those samples to the same series,
 *    so re-stamping would move the double count rather than remove it.
 *
 * That leaves the third, which is also the true statement: the inherited turns
 * were spent by the PARENT and are already counted from the parent's file. The
 * fork's own burn is what it adds after the fork point, so the inherited prefix
 * contributes nothing to the series and only seeds the cumulative baseline.
 *
 * A tempting fourth — "several `token_count` records sharing one millisecond
 * must be a batch write" — is false on this disk: two of the nine non-forked
 * rollouts in the window also have same-millisecond pairs.
 *
 * The prefix is bounded by wall clock because Codex gives no in-band end
 * marker: the replay's closing records (`world_state`, `thread_settings_applied`,
 * `task_started`) all appear inside the replayed history too. See
 * REPLAY_WINDOW_MS for the measured margin. What keeps that honest is that the
 * gate is only opened for a thread that DECLARES it inherited a history, so a
 * plain thread with a fast first turn is never suppressed.
 *
 * A plain comparison is enough because `token_count` timestamps do not run
 * backwards: across the same 151 rollouts there is not one non-monotonic pair.
 * An "once live, always live" latch would therefore be unreachable code, and an
 * unreachable branch is a rule the suite cannot hold.
 */
function isInheritedReplay(state, ts) {
  if (!state.replaying) return false;
  if (!Number.isFinite(ts)) return false;
  // A fork whose own session_meta had no usable timestamp still anchors here,
  // on its first token_count, rather than silently reverting to the old
  // face-value reading.
  if (!state.openedAt) state.openedAt = ts;
  return ts - state.openedAt <= REPLAY_WINDOW_MS;
}

function ingest(state, d, fleetSeries) {
  const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
  if (Number.isFinite(ts)) {
    if (!state.startedAt) state.startedAt = ts;
    if (ts > state.lastTs) state.lastTs = ts;
  }
  const payload = d.payload;
  if (!payload) return;

  if (d.type === "session_meta") {
    // ONLY the first session_meta belongs to this thread. A forked rollout
    // replays its ancestors' session_meta records verbatim further down the
    // file — the fork examined below carries six, one its own and five its
    // parent's — and those replayed copies carry no fork markers. Reading the
    // markers from the last one seen would therefore erase the fork.
    if (!state.ownMetaSeen) {
      state.ownMetaSeen = true;
      if (Number.isFinite(ts)) state.openedAt = ts;
      // `forked_from_id` and not `parent_thread_id`, and the difference is the
      // whole point: a sub-agent SPAWNED fresh has a parent but starts its
      // counter at zero, while a thread FORKED from another inherits that
      // thread's history. Over the 151 rollouts in the window the two agree
      // exactly with what the file contains — all 106 with `forked_from_id`
      // open with a replayed history, and none of the other 45 do, including
      // the 35 that are sub-agents with a `parent_thread_id`. Keying on the
      // parent link instead would arm the suppression on 35 threads that have
      // nothing to suppress.
      state.forkedFrom = payload.forked_from_id || null;
      state.replaying = !!state.forkedFrom;
    }
    // NOT the thread identity. Every sub-agent rollout on this disk repeats its
    // PARENT's id in session_meta, so trusting it collapsed a four-thread
    // fan-out into one row and lost the tree. The filename carries the thread's
    // own id, and it is the id the parent's sub_agent_activity events point at.
    state.metaId = payload.id || payload.session_id || state.metaId;
    state.cwd = payload.cwd || state.cwd;
    state.originator = payload.originator || state.originator;
    state.cliVersion = payload.cli_version || state.cliVersion;
    state.source = payload.source || state.source;
    if (payload.git) {
      state.git = {
        branch: payload.git.branch || null,
        commit: payload.git.commit_hash
          ? String(payload.git.commit_hash).slice(0, 8)
          : null,
        repo: payload.git.repository_url || null,
      };
    }
    return;
  }
  if (d.type === "turn_context") {
    if (payload.model) state.model = payload.model;
    if (payload.effort) state.effort = payload.effort;
    if (payload.cwd && !state.cwd) state.cwd = payload.cwd;
    return;
  }
  if (d.type !== "event_msg") return;

  if (payload.type === "token_count" && payload.info) {
    const info = payload.info;
    if (info.model_context_window)
      state.contextWindow = info.model_context_window;
    if (payload.rate_limits) state.rateLimits = payload.rate_limits;
    const total = info.total_token_usage;
    if (!total) return;
    const inherited = isInheritedReplay(state, ts);
    const previous = state.total ? state.total.total_tokens || 0 : null;
    // On a cold read the previous cumulative total is unknown. Diffing against
    // zero would report the thread's whole lifetime as one turn's burn, which on
    // a 1.5-billion-token thread would render as a fictional runaway. The log
    // carries the exact per-turn figure; use it.
    const delta =
      previous === null
        ? (info.last_token_usage && info.last_token_usage.total_tokens) || 0
        : Math.max(0, (total.total_tokens || 0) - previous);
    // Advance the cumulative counter even while replaying. That is what makes
    // the boundary below cheap to get wrong: the first LIVE turn diffs against
    // the last replayed total, so misplacing the boundary by one record moves
    // one turn (tens of thousands of tokens), never the inherited history
    // (hundreds of millions). It is also what keeps the sigma column exact —
    // `total` is the thread's own cumulative figure, unchanged by this fix.
    state.total = total;
    if (inherited) {
      state.inheritedTokens = total.total_tokens || 0;
      return;
    }
    if (Number.isFinite(ts) && delta > 0) {
      state.events.push({ t: ts, n: delta });
      addSample(state.series, ts, delta, null);
      // Tokens are exact. Actual Codex dollar spend is not: subscriptions and
      // Codex credits do not map honestly to the public API rate card. Carry an
      // unknown cost through the burn series instead of understating it as $0.
      if (fleetSeries) addSample(fleetSeries, ts, delta, null);
    }
    return;
  }

  if (payload.type === "sub_agent_activity" && payload.agent_thread_id) {
    // The parent/child edge the TREE is built from. `parent_thread_id` and
    // `thread_source` are no longer absent — the note that said so predates the
    // rollouts now on disk, where every sub-agent carries both — but they name
    // the spawner, not the shape of the fan-out, and the graph these events
    // describe is still the one the roster draws.
    const child = state.children.get(payload.agent_thread_id) || {
      id: payload.agent_thread_id,
      agentPath: null,
      kind: null,
      at: 0,
    };
    if (payload.agent_path) child.agentPath = payload.agent_path;
    if (payload.kind) child.kind = payload.kind;
    if (payload.occurred_at_ms)
      child.at = Math.max(child.at, payload.occurred_at_ms);
    state.children.set(payload.agent_thread_id, child);
    return;
  }

  if (payload.type === "patch_apply_end") {
    state.patches += 1;
    if (payload.success === false) state.patchFailures += 1;
    // Only the keys — the payload also embeds full file contents, which are
    // never read into this process.
    const changes = payload.changes;
    if (
      changes &&
      typeof changes === "object" &&
      state.filesTouched.size < 400
    ) {
      for (const file of Object.keys(changes)) state.filesTouched.add(file);
    }
    return;
  }
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    state.calls += 1;
  }
}

/** Fold rollout files into threads, nesting sub-agent threads under their parent. */
export function buildThreads(store, now) {
  // Codex writes sub-agent edges as `sub_agent_activity` events, and a
  // sub-agent's own log reports activity for its parent and siblings too — so
  // the edge set is undirected and contains cycles. Union the connected threads,
  // then take the root from `agent_path`: the thread whose path is "/root" is
  // the parent, and path depth is the tree depth.
  const parent = new Map();
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root)
      root = parent.get(root);
    let cursor = x;
    while (parent.get(cursor) !== undefined && parent.get(cursor) !== cursor) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a, b) => {
    if (parent.get(a) === undefined) parent.set(a, a);
    if (parent.get(b) === undefined) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const pathOf = new Map();
  for (const state of store.files.values()) {
    const id = state.id;
    if (parent.get(id) === undefined) parent.set(id, id);
    for (const child of state.children.values()) {
      union(id, child.id);
      if (child.agentPath) pathOf.set(child.id, child.agentPath);
    }
  }

  const depthOf = (id) => {
    const agentPath = pathOf.get(id);
    if (!agentPath) return null;
    return Math.max(0, agentPath.split("/").filter(Boolean).length - 1);
  };

  // Elect one root per connected component: shallowest agent_path wins, and an
  // earlier thread start breaks a tie.
  const rootOf = new Map();
  const candidates = new Map();
  for (const state of store.files.values()) {
    const component = find(state.id);
    const depth = depthOf(state.id);
    const score = depth === null ? 0 : depth;
    const current = candidates.get(component);
    if (
      !current ||
      score < current.score ||
      (score === current.score &&
        (state.startedAt || Infinity) < current.startedAt)
    ) {
      candidates.set(component, {
        id: state.id,
        score,
        startedAt: state.startedAt || Infinity,
      });
    }
  }
  for (const [component, best] of candidates) rootOf.set(component, best.id);

  const groups = new Map();
  for (const state of store.files.values()) {
    if (!state.total) continue;
    const id = state.id;
    const root = rootOf.get(find(id)) || id;
    let group = groups.get(root);
    if (!group) {
      group = {
        vendor: "codex",
        id: root,
        cwd: null,
        model: null,
        effort: null,
        originator: null,
        cliVersion: null,
        git: null,
        contextWindow: 0,
        rateLimits: null,
        tokens: { in: 0, cachedIn: 0, cw: 0, out: 0, reasoning: 0, total: 0 },
        hot: 0,
        agents: [],
        agentLive: 0,
        lastTs: 0,
        mtime: 0,
        bad: 0,
        startedAt: 0,
        patches: 0,
        patchFailures: 0,
        files: new Set(),
        calls: 0,
        series: null,
      };
      groups.set(root, group);
    }
    const isRoot = id === root;
    const total = state.total;
    group.tokens.in += total.input_tokens || 0;
    group.tokens.cachedIn += total.cached_input_tokens || 0;
    group.tokens.cw += total.cache_write_input_tokens || 0;
    group.tokens.out += total.output_tokens || 0;
    group.tokens.reasoning += total.reasoning_output_tokens || 0;
    group.tokens.total += total.total_tokens || 0;
    group.patches += state.patches;
    group.patchFailures += state.patchFailures;
    group.calls += state.calls;
    for (const file of state.filesTouched) group.files.add(file);
    if (state.contextWindow > group.contextWindow)
      group.contextWindow = state.contextWindow;
    if (state.rateLimits) group.rateLimits = state.rateLimits;
    if (isRoot || !group.cwd) {
      group.cwd = state.cwd || group.cwd;
      group.model = state.model || group.model;
      group.effort = state.effort || group.effort;
      group.originator = state.originator || group.originator;
      group.cliVersion = state.cliVersion || group.cliVersion;
      group.git = state.git || group.git;
    }
    if (isRoot) group.series = state.series;
    group.lastTs = Math.max(group.lastTs, state.lastTs);
    group.mtime = Math.max(group.mtime, state.mtime);
    group.startedAt = group.startedAt
      ? Math.min(group.startedAt, state.startedAt || group.startedAt)
      : state.startedAt;
    group.bad += state.bad;

    let hot = 0;
    for (const e of state.events) if (now - e.t <= 5 * 60_000) hot += e.n;
    group.hot += hot;

    if (!isRoot) {
      const live = now - state.mtime <= 2 * 60_000;
      if (live) group.agentLive += 1;
      const agentPath = pathOf.get(id) || null;
      group.agents.push({
        id,
        parent: root,
        depth: depthOf(id),
        type: "codex-subagent",
        desc: agentPath
          ? agentPath.replace(/^\/root\/?/u, "") || "root"
          : "sub-agent",
        described: !!agentPath,
        tokens: total.total_tokens || 0,
        cost: null,
        hot,
        live,
        lastTs: state.lastTs,
        mtime: state.mtime,
      });
    }
  }

  const list = [];
  for (const group of groups.values()) {
    group.project = group.cwd ? projectLabel(group.cwd) : "unknown";
    group.path = group.cwd || "";
    group.live = now - group.mtime <= 2 * 60_000;
    group.agents.sort((a, b) => b.tokens - a.tokens);
    group.agentCount = group.agents.length;
    group.fileCount = group.files.size;
    group.filesTouched = Array.from(group.files).slice(0, 40);
    delete group.files;
    if (!group.series) {
      // The elected root has no rollout on disk in this window; fall back so
      // the sparkline still has the component's own history.
      group.series = createSeries();
    }
    list.push(group);
  }
  list.sort((a, b) => b.hot - a.hot || b.tokens.total - a.tokens.total);
  return list;
}
