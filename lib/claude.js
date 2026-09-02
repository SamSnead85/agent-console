/**
 * Claude Code transcript scanner.
 *
 * Reads ~/.claude/projects/<project-slug>/**.jsonl. Everything here is measured
 * from files on disk; the only computed quantity is the dollar estimate, which
 * comes from lib/prices.js and is labelled as an estimate everywhere it appears.
 */

import fs from "node:fs";
import path from "node:path";
import { createReadState, readNewLines, parseLine } from "./jsonl.js";
import {
  addTokens,
  costOf,
  costSplit,
  sumTokens,
  zeroCost,
  zeroTokens,
  addCost,
} from "./prices.js";
import { createSeries, addSample } from "./series.js";
import { addHistorySample } from "./history.js";
import { resolveProjectSlug, projectLabel } from "./paths.js";
import { redactAndClip } from "./redact.js";

/** Lines worth the cost of JSON.parse. Everything else is skipped on a substring test. */
const MARKERS = [
  '"usage"',
  "quotaLimits",
  '"pr-link"',
  "compact_boundary",
  "api_error",
  "stop_hook_summary",
  '"agent-name"',
  '"custom-title"',
];

/**
 * How many leading lines are parsed unconditionally while the file's own cwd is
 * still unknown. The first line of a transcript carries `cwd` and `gitBranch`;
 * reading them only off usage-bearing lines (as the previous implementation did)
 * left every session with no priced response labelled by a lossy directory-name
 * guess instead of its real path.
 */
const HEAD_PARSE_LIMIT = 40;

/**
 * Distinct message ids retained per file before the oldest are evicted.
 *
 * The eviction has to survive interleaving. The regression corpus includes one
 * message id whose lines are 990 usage records apart with 464 other ids opened
 * between them. Eviction is by least-recently-touched, not insertion order, and
 * the widest observed span is reported so the margin stays falsifiable.
 */
const MSG_CAP = 40_000;

export function createClaudeStore(config) {
  return {
    root: config.root,
    sessionsDir: config.sessionsDir,
    windowMs: config.windowMs,
    files: new Map(),
    seriesBySession: new Map(),
    fleetSeries: config.fleetSeries || createSeries(),
    // Period-scoped token history (lib/history.js). Optional: tests that only
    // exercise the scanner run without one.
    history: config.history || null,
    metaCache: new Map(),
    dedupSpanMax: 0,
  };
}

/**
 * Enumerate the transcript tree.
 *
 * An unreadable ROOT is reported, never swallowed. Returning an empty list for
 * a directory that exists but cannot be read made a permissions problem
 * indistinguishable from a genuinely quiet fleet: the master read IDLE, the
 * instrument strip said "no scan error", and nothing on the screen suggested
 * the dashboard was blind. A missing root is a different thing and is reported
 * as unavailable rather than as an error.
 */
function walk(root) {
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return {
      files: out,
      error:
        error && error.code === "ENOENT"
          ? null
          : "transcript root unreadable: " +
            root +
            " (" +
            ((error && error.code) || "error") +
            ")",
      missing: !!(error && error.code === "ENOENT"),
    };
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    const stack = [projectDir];
    while (stack.length) {
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
          // `memory` holds notes, `tool-results` holds tool payloads; neither
          // carries usage and both are large.
          if (entry.name === "memory" || entry.name === "tool-results")
            continue;
          stack.push(full);
        } else if (entry.name.endsWith(".jsonl")) {
          out.push({ file: full, slug: project.name, projectDir });
        }
      }
    }
  }
  return { files: out, error: null, missing: false };
}

function ownerOf(file, projectDir) {
  const relative = path.relative(projectDir, file);
  const parts = relative.split(path.sep);
  if (parts.length === 1) {
    return {
      session: parts[0].replace(/\.jsonl$/u, ""),
      isSub: false,
      agentId: null,
    };
  }
  const leaf = parts[parts.length - 1].replace(/\.jsonl$/u, "");
  return {
    session: parts[0],
    isSub: true,
    agentId: leaf.replace(/^agent-/u, ""),
    lane: parts[1] || null,
  };
}

/**
 * Read an agent's .meta.json sidecar.
 *
 * A null is NOT cached: the sidecar is written moments after the transcript, so
 * caching the miss would leave that agent permanently unlabelled for the life of
 * the process.
 */
function readMeta(store, jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/u, ".meta.json");
  const cached = store.metaCache.get(metaPath);
  if (cached) return cached;
  let value = null;
  try {
    const d = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    value = {
      desc: d.description || null,
      agentType: d.agentType || null,
      depth: typeof d.spawnDepth === "number" ? d.spawnDepth : null,
      parentAgentId: d.parentAgentId
        ? String(d.parentAgentId).replace(/^agent-/u, "")
        : null,
      toolUseId: d.toolUseId || null,
    };
    store.metaCache.set(metaPath, value);
  } catch {
    value = null;
  }
  return value;
}

/** One-line description of what a message did, whitespace collapsed. */
export function describeMessage(message) {
  try {
    const content = message && message.content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const input = block.input || {};
      let text = block.name;
      if (input.command) text += ": " + String(input.command);
      else if (input.file_path)
        text += ": " + String(input.file_path).split("/").slice(-2).join("/");
      else if (input.pattern) text += ": " + String(input.pattern);
      else if (input.description) text += ": " + String(input.description);
      else if (input.prompt) text += ": " + String(input.prompt);
      // Masked FIRST, cut second. Cutting first removes the anchor a rule needs
      // — the "@host" of a connection string — and serves the whole password.
      return redactAndClip(text, 140);
    }
    for (const block of content) {
      if (block.type === "text" && block.text) {
        return redactAndClip(block.text, 140);
      }
    }
  } catch {
    /* a malformed message is not worth a crash */
  }
  return null;
}

function newFileState(store, found, stat) {
  const owner = ownerOf(found.file, found.projectDir);
  const sessionKey = found.slug + "|" + owner.session;
  let series = store.seriesBySession.get(sessionKey);
  if (!series) {
    series = createSeries();
    store.seriesBySession.set(sessionKey, series);
  }
  return createReadState(found.file, {
    slug: found.slug,
    sessionKey,
    session: owner.session,
    isSub: owner.isSub,
    agentId: owner.agentId,
    lane: owner.lane || null,
    meta: owner.isSub ? readMeta(store, found.file) : null,
    series,
    mtime: stat.mtimeMs,
    cwd: null,
    branch: null,
    version: null,
    entrypoint: null,
    agentName: null,
    customTitle: null,
    headParsed: 0,
    byDay: new Map(),
    msgs: new Map(),
    msgOrder: 0,
    responses: 0,
    usageLines: 0,
    models: new Set(),
    events: [],
    lastTs: 0,
    last: null,
    tools: new Map(),
    toolsSeen: new Set(),
    retries: 0,
    errorCodes: new Map(),
    hookErrors: 0,
    compactions: [],
    compactionSeen: new Set(),
    quota: null,
    prLinks: new Map(),
    cacheMiss: new Map(),
    serverTools: { search: 0, fetch: 0 },
    contextWindowPeak: 0,
  });
}

function bump(map, key, by) {
  map.set(key, (map.get(key) || 0) + (by === undefined ? 1 : by));
}

function ingestUsageLine(store, state, d, day) {
  const message = d.message;
  const usage = message.usage;
  const model = message.model || "unknown";
  if (model === "<synthetic>") return;
  const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
  if (!Number.isFinite(ts)) return;

  state.usageLines += 1;
  const creation = usage.cache_creation || {};
  const details = usage.output_tokens_details || {};
  let tokens = {
    in: usage.input_tokens || 0,
    out: usage.output_tokens || 0,
    cr: usage.cache_read_input_tokens || 0,
    cw: usage.cache_creation_input_tokens || 0,
    cw1h: creation.ephemeral_1h_input_tokens || 0,
    think: details.thinking_tokens || 0,
  };

  // ---- De-duplicate by message.id --------------------------------------
  // Claude Code writes one API response as SEVERAL assistant lines — one per
  // content block, plus streaming snapshots — each carrying that response's
  // usage. Measured over today's 333 in-window files: 19,337 usage lines carry
  // 9,679 distinct ids, and summing every line inflates the total 1.84x.
  // Count each id once, keep the element-wise high-water mark, add the delta.
  // Server-tool counts are per-response and are repeated on every line of that
  // response exactly as the token counts are, so they go through the same
  // high-water de-duplication. Summing them per physical line multiplied them
  // by the duplication factor: on three days of transcripts here, 7,867 of
  // 28,857 distinct ids repeat this block on more than one line.
  const serverUse = usage.server_tool_use || {};
  let serverDelta = {
    ss: serverUse.web_search_requests || 0,
    sf: serverUse.web_fetch_requests || 0,
  };

  const id = message.id;
  if (id) {
    const prev = state.msgs.get(id);
    state.msgOrder += 1;
    if (prev) {
      const span = state.msgOrder - prev.order;
      if (span > store.dedupSpanMax) store.dedupSpanMax = span;
      const high = {
        in: Math.max(prev.in, tokens.in),
        out: Math.max(prev.out, tokens.out),
        cr: Math.max(prev.cr, tokens.cr),
        cw: Math.max(prev.cw, tokens.cw),
        cw1h: Math.max(prev.cw1h, tokens.cw1h),
        think: Math.max(prev.think, tokens.think),
        ss: Math.max(prev.ss || 0, serverDelta.ss),
        sf: Math.max(prev.sf || 0, serverDelta.sf),
        order: state.msgOrder,
      };
      tokens = {
        in: high.in - prev.in,
        out: high.out - prev.out,
        cr: high.cr - prev.cr,
        cw: high.cw - prev.cw,
        cw1h: high.cw1h - prev.cw1h,
        think: high.think - prev.think,
      };
      serverDelta = {
        ss: high.ss - (prev.ss || 0),
        sf: high.sf - (prev.sf || 0),
      };
      state.msgs.delete(id);
      state.msgs.set(id, high);
    } else {
      state.responses += 1;
      state.msgs.set(id, { ...tokens, ...serverDelta, order: state.msgOrder });
    }
    if (state.msgs.size > MSG_CAP) {
      // Least-recently-touched first: re-setting an id above moves it to the
      // end of the Map's insertion order, so this evicts by last sighting.
      const iterator = state.msgs.keys();
      for (let i = 0; i < MSG_CAP / 4; i += 1)
        state.msgs.delete(iterator.next().value);
    }
  } else {
    state.responses += 1;
  }

  const dayOfLine = day(ts);
  let perDay = state.byDay.get(dayOfLine);
  if (!perDay) {
    perDay = new Map();
    state.byDay.set(dayOfLine, perDay);
  }
  let perModel = perDay.get(model);
  if (!perModel) {
    perModel = zeroTokens();
    perDay.set(model, perModel);
  }
  addTokens(perModel, tokens);
  state.models.add(model);

  const delta = sumTokens(tokens);
  if (delta > 0) {
    // `null` is evidence: this model has no verified rate. Preserve it through
    // the minute series so the UI cannot show a reassuring $0 for unknown cost.
    const cost = costOf(model, tokens, dayOfLine);
    addSample(state.series, ts, delta, cost);
    addSample(store.fleetSeries, ts, delta, cost);
    state.events.push({ t: ts, n: delta });
    // History records the same de-duplicated delta at the timestamp parsed off
    // the line, so a restart recovers yesterday from the source data itself.
    if (store.history) {
      addHistorySample(store.history, ts, model, state.sessionKey, tokens);
    }
  }

  if (ts > state.lastTs) {
    state.lastTs = ts;
    const described = describeMessage(message);
    if (described) state.last = described;
  }

  // Tool calls, counted once per response id.
  if (Array.isArray(message.content) && (!id || !state.toolsSeen.has(id))) {
    if (id) state.toolsSeen.add(id);
    for (const block of message.content) {
      if (block && block.type === "tool_use" && block.name)
        bump(state.tools, block.name);
    }
  }

  state.serverTools.search += serverDelta.ss;
  state.serverTools.fetch += serverDelta.sf;

  // Anthropic naming why a prefix cache did not hit, and what it cost.
  const diagnostics = message.diagnostics;
  if (diagnostics && diagnostics.cache_miss_reason) {
    bump(state.cacheMiss, String(diagnostics.cache_miss_reason), tokens.in);
  }
}

function ingestOther(state, d) {
  const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
  if (d.type === "pr-link" && d.prNumber !== undefined) {
    state.prLinks.set(String(d.prNumber), {
      number: d.prNumber,
      url: d.prUrl || null,
      repo: d.prRepository || null,
      ts: Number.isFinite(ts) ? ts : 0,
    });
    return;
  }
  if (d.quotaLimits) {
    const q = d.quotaLimits;
    const at = Number.isFinite(ts) ? ts : 0;
    if (!state.quota || at >= state.quota.at) {
      state.quota = {
        at,
        status: q.status || null,
        resetsAt: typeof q.resetsAt === "number" ? q.resetsAt * 1000 : null,
        limitType: q.rateLimitType || q.unifiedRateLimitFallbackType || null,
        overageStatus: q.overageStatus || null,
      };
    }
    return;
  }
  if (d.type !== "system") return;
  if (d.subtype === "api_error") {
    if (d.source === "request_retry") state.retries += 1;
    const code =
      (d.error && d.error.connection && d.error.connection.code) ||
      (d.error && d.error.message) ||
      "error";
    bump(state.errorCodes, String(code).slice(0, 40));
    return;
  }
  if (d.subtype === "compact_boundary" && d.compactMetadata) {
    if (d.uuid && state.compactionSeen.has(d.uuid)) return;
    if (d.uuid) state.compactionSeen.add(d.uuid);
    state.compactions.push({
      at: Number.isFinite(ts) ? ts : 0,
      trigger: d.compactMetadata.trigger || null,
      preTokens: d.compactMetadata.preTokens || 0,
      durationMs: d.compactMetadata.durationMs || 0,
    });
    if (d.compactMetadata.preTokens > state.contextWindowPeak) {
      state.contextWindowPeak = d.compactMetadata.preTokens;
    }
    return;
  }
  if (d.subtype === "stop_hook_summary") {
    state.hookErrors += d.hookErrors || 0;
  }
}

function captureContext(state, d) {
  if (!state.cwd && d.cwd) state.cwd = d.cwd;
  if (d.gitBranch) state.branch = d.gitBranch;
  if (!state.version && d.version) state.version = d.version;
  if (!state.entrypoint && d.entrypoint) state.entrypoint = d.entrypoint;
  if (d.type === "agent-name" && d.name) state.agentName = String(d.name);
  if (d.type === "custom-title" && d.title) state.customTitle = String(d.title);
}

export function scanClaude(store, now, dayKey) {
  const walked = walk(store.root);
  const found = walked.files;
  const seen = new Set();
  const cutoff = now - store.windowMs;
  let bytes = 0;

  for (const entry of found) {
    seen.add(entry.file);
    let stat;
    try {
      stat = fs.statSync(entry.file);
    } catch {
      continue;
    }
    let state = store.files.get(entry.file);
    if (!state) {
      // A file untouched for longer than the window cannot hold today's
      // activity. Skipping it keeps the first scan bounded against a >2 GB tree.
      if (stat.mtimeMs < cutoff) continue;
      state = newFileState(store, entry, stat);
      store.files.set(entry.file, state);
    }
    if (state.isSub && !state.meta) state.meta = readMeta(store, entry.file);
    // `state.leftover` is checked because a file whose last line has no
    // terminating newline is only flushed once it has gone quiet — and quiet is
    // exactly when mtime and size stop changing. Skipping on those two alone
    // made the flush unreachable in production, so the same bytes produced two
    // different day totals depending on whether the file was already idle when
    // the process started.
    if (
      stat.mtimeMs === state.mtime &&
      stat.size === state.offset &&
      state.offset > 0 &&
      !state.leftover
    ) {
      continue;
    }

    const before = state.offset;
    readNewLines(
      state,
      (line) => {
        const wantsHead = state.headParsed < HEAD_PARSE_LIMIT && !state.cwd;
        let interesting = wantsHead;
        if (!interesting) {
          for (const marker of MARKERS) {
            if (line.indexOf(marker) !== -1) {
              interesting = true;
              break;
            }
          }
        }
        if (!interesting) return;
        if (wantsHead) state.headParsed += 1;
        const d = parseLine(state, line);
        if (!d) return;
        captureContext(state, d);
        if (d.type === "assistant" && d.message && d.message.usage) {
          ingestUsageLine(store, state, d, dayKey);
        } else {
          ingestOther(state, d);
        }
      },
      now,
    );
    bytes += state.offset - before;

    const hotFloor = now - 6 * 60_000;
    if (
      state.events.length > 4000 ||
      (state.events.length && state.events[0].t < hotFloor)
    ) {
      state.events = state.events.filter((e) => e.t >= hotFloor);
    }
    if (state.byDay.size > 3) {
      const keys = Array.from(state.byDay.keys()).sort();
      while (keys.length > 3) state.byDay.delete(keys.shift());
    }
  }

  for (const key of Array.from(store.files.keys())) {
    if (!seen.has(key)) store.files.delete(key);
  }
  return {
    bytes,
    fileCount: store.files.size,
    error: walked.error,
    missing: walked.missing,
  };
}

/** PID -> live session record, the only reliable process/session join that exists. */
export function readPidSessions(sessionsDir) {
  const map = new Map();
  let names;
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return map;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const d = JSON.parse(
        fs.readFileSync(path.join(sessionsDir, name), "utf8"),
      );
      if (!d || !d.pid) continue;
      map.set(Number(d.pid), {
        pid: Number(d.pid),
        sessionId: d.sessionId || null,
        cwd: d.cwd || null,
        name: d.name || null,
        entrypoint: d.entrypoint || null,
        version: d.version || null,
        kind: d.kind || null,
        startedAt: d.startedAt ? Number(d.startedAt) : null,
      });
    } catch {
      /* a half-written record is skipped, never fatal */
    }
  }
  return map;
}

/**
 * Fold the per-file states into one row per session for `day`.
 * Sub-agent files roll into their parent session and also become tree nodes.
 */
export function buildSessions(store, now, day, pidSessions) {
  const byCwd = new Map();
  const sessionHasProcess = new Set();
  for (const record of pidSessions.values()) {
    if (record.sessionId) {
      byCwd.set(record.sessionId, record);
      sessionHasProcess.add(record.sessionId);
    }
  }
  const sessions = new Map();

  for (const state of store.files.values()) {
    const today = state.byDay.get(day);
    const hasToday = today && today.size > 0;
    // A session with a process record is kept even with no tokens today: a live
    // process whose transcript has gone silent is exactly the STALL case, and
    // dropping it would hide the most actionable row on the screen.
    if (
      !hasToday &&
      now - state.mtime > 30 * 60_000 &&
      !sessionHasProcess.has(state.session)
    ) {
      continue;
    }

    let s = sessions.get(state.sessionKey);
    if (!s) {
      s = {
        vendor: "claude",
        key: state.sessionKey,
        id: state.session,
        slug: state.slug,
        cwd: null,
        branch: null,
        version: null,
        name: null,
        models: new Map(),
        tokens: zeroTokens(),
        cost: zeroCost(),
        unpriced: false,
        lastTs: 0,
        mtime: 0,
        last: null,
        bad: 0,
        responses: 0,
        usageLines: 0,
        agents: [],
        agentLive: 0,
        hot: 0,
        files: 0,
        tools: new Map(),
        retries: 0,
        errorCodes: new Map(),
        hookErrors: 0,
        compactions: [],
        quota: null,
        prLinks: new Map(),
        cacheMiss: new Map(),
        serverTools: { search: 0, fetch: 0 },
        contextPeak: 0,
        series: state.series,
      };
      sessions.set(state.sessionKey, s);
    }
    s.files += 1;
    if (!s.cwd && state.cwd) s.cwd = state.cwd;
    if (!state.isSub && state.branch) s.branch = state.branch;
    if (!s.branch && state.branch) s.branch = state.branch;
    if (!s.version && state.version) s.version = state.version;
    if (!s.name && (state.customTitle || state.agentName)) {
      s.name = state.customTitle || state.agentName;
    }

    let ownTokens = zeroTokens();
    let ownCost = 0;
    if (today) {
      for (const [model, tokens] of today) {
        let bucket = s.models.get(model);
        if (!bucket) {
          bucket = zeroTokens();
          s.models.set(model, bucket);
        }
        addTokens(bucket, tokens);
        addTokens(s.tokens, tokens);
        addTokens(ownTokens, tokens);
        const split = costSplit(model, tokens, day);
        if (!split) s.unpriced = true;
        else {
          addCost(s.cost, split);
          ownCost += split.in + split.out + split.cw + split.cr;
        }
      }
    }

    let hot = 0;
    for (const e of state.events) if (now - e.t <= 5 * 60_000) hot += e.n;
    s.hot += hot;

    for (const [name, count] of state.tools) bump(s.tools, name, count);
    for (const [code, count] of state.errorCodes)
      bump(s.errorCodes, code, count);
    for (const [reason, count] of state.cacheMiss)
      bump(s.cacheMiss, reason, count);
    for (const [number, pr] of state.prLinks) s.prLinks.set(number, pr);
    s.retries += state.retries;
    s.hookErrors += state.hookErrors;
    s.serverTools.search += state.serverTools.search;
    s.serverTools.fetch += state.serverTools.fetch;
    s.responses += state.responses;
    s.usageLines += state.usageLines;
    s.bad += state.bad;
    if (state.compactions.length) s.compactions.push(...state.compactions);
    if (state.contextWindowPeak > s.contextPeak)
      s.contextPeak = state.contextWindowPeak;
    if (state.quota && (!s.quota || state.quota.at > s.quota.at))
      s.quota = state.quota;

    if (state.isSub) {
      const live = now - state.mtime <= 2 * 60_000;
      if (live) s.agentLive += 1;
      const described = !!(state.meta && state.meta.desc);
      s.agents.push({
        id: state.agentId,
        parent: (state.meta && state.meta.parentAgentId) || null,
        toolUseId: (state.meta && state.meta.toolUseId) || null,
        depth:
          state.meta && state.meta.depth !== null ? state.meta.depth : null,
        type: (state.meta && state.meta.agentType) || state.lane || null,
        // Where the sidecar is missing the task is inferred from what the agent
        // last did. The UI marks that case; it is not the task it was given.
        desc: described
          ? state.meta.desc
          : String(state.last || "subagent").replace(/^[#*\s]+/u, ""),
        described,
        tokens: sumTokens(ownTokens),
        cost: ownCost,
        hot,
        live,
        lastTs: state.lastTs,
        mtime: state.mtime,
      });
    } else if (state.last) {
      s.last = state.last;
    }
    if (!s.last && state.last) s.last = state.last;
    if (state.lastTs > s.lastTs) s.lastTs = state.lastTs;
    if (state.mtime > s.mtime) s.mtime = state.mtime;
  }

  const out = [];
  for (const s of sessions.values()) {
    const joined = byCwd.get(s.id);
    if (joined) {
      if (joined.cwd) s.cwd = joined.cwd;
      if (!s.name && joined.name) s.name = joined.name;
      s.pid = joined.pid;
      s.startedAt = joined.startedAt || null;
    }
    const resolved = s.cwd
      ? { path: s.cwd, exact: true }
      : resolveProjectSlug(s.slug);
    s.path = resolved.path;
    s.pathExact = resolved.exact;
    s.project = projectLabel(resolved.path);
    s.total = sumTokens(s.tokens);
    s.costTotal = s.cost.in + s.cost.out + s.cost.cw + s.cost.cr;
    s.modelList = Array.from(s.models.keys()).sort();
    s.agents.sort((a, b) => b.tokens - a.tokens);
    s.agentCount = s.agents.length;
    if (s.total > 0 || now - s.mtime <= 2 * 60_000 || s.pid !== undefined)
      out.push(s);
  }
  return out;
}
