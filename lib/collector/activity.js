/**
 * Tool activity as counts: what kind of tool each session called, how many
 * times a minute, and how many results came back as errors.
 *
 * COUNTS AND ENUMS ONLY. A tool's name is mapped here, on the machine that
 * read it, to one of eight kinds (ACTIVITY_KINDS). The name itself, its
 * arguments, its output, a path, a command and an MCP server's name never
 * leave this module: an MCP tool is `mcp`, a tool this list does not know is
 * `other`. A result is `ok` or `error` and nothing more.
 *
 * One book per machine. The hub keeps one for its own machine (fed by the
 * collector's line hook, with the line's own time) and one for every joined
 * machine that chose `--share-tool-activity` (fed by `merge()` from its
 * envelopes, to the minute): two machines never share a book, so the same
 * session hash on two machines is two readings, never one sum.
 *
 * READ ONCE. A line read from a transcript is staged, and counts only once
 * the collector has written the cursor that says it was read: a transcript
 * that failed half-way, or a pass that failed before its cursor was written,
 * is read again from where it was, so its staged lines are dropped rather
 * than counted twice (`journal`, lib/collector/collector.js).
 *
 * ONE CLOCK RULE. A minute or a last tool later than this machine's clock
 * plus CLOCK_SKEW_MS is refused, wherever it comes from; a window has two
 * edges and a minute after the current one is not in it. A refused entry is
 * never stored, so it cannot become "now" later.
 *
 * A session's minutes are kept for a quarter of an hour; its last tool is
 * kept as long as the session is.
 */

const MINUTE = 60_000;
export const ACTIVITY_KINDS = Object.freeze(["read", "edit", "shell", "search", "web", "agent", "mcp", "other"]);
/* The window the console shows ("calls in the last five minutes"). */
export const ACTIVITY_WINDOW_MINUTES = 5;
/* How far ahead of this clock another machine's minute may be: its clock may run a little fast. */
export const CLOCK_SKEW_MS = 2 * MINUTE;
/* How long a machine's minutes are kept for the console. */
export const KEEP_MINUTES = 15;
/* How far back a transcript line is counted at all: a reporter's pending contributions reach no further. */
export const STAGE_MINUTES = 60;
const MAX_SESSIONS = 5_000;
const MAX_COUNT = 1_000_000;
/* Contribution ids remembered per machine, while their minute is kept (lib/hub/fleet.js). */
const MAX_CONTRIBUTIONS = 100_000;
const HASH = /^[a-f0-9]{64}$/u;

const CLAUDE_KIND = new Map(Object.entries({
  Read: "read", NotebookRead: "read",
  Write: "edit", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Bash: "shell", BashOutput: "shell", KillShell: "shell", KillBash: "shell",
  Grep: "search", Glob: "search", LS: "search", ToolSearch: "search",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent",
}));
const CODEX_KIND = new Map(Object.entries({
  shell: "shell", exec_command: "shell", write_stdin: "shell", local_shell: "shell", "container.exec": "shell",
  apply_patch: "edit",
  read_file: "read", view_image: "read",
  grep_files: "search", list_dir: "search",
  web_search: "web",
}));

/** The kind of a tool call, from its name alone. Never returns the name. */
export function toolKind(tool, name) {
  if (typeof name !== "string" || !name) return "other";
  if (/^mcp(__|[.:])/iu.test(name)) return "mcp";
  const map = tool === "codex" ? CODEX_KIND : CLAUDE_KIND;
  return map.get(name) ?? "other";
}

const emptyCalls = () => Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, 0]));
const clamp = (n) => (Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_COUNT) : 0);
const floorMinute = (ms) => Math.floor(ms / MINUTE) * MINUTE;
/** The first minute a book still keeps at time `t`. */
export const keepEdge = (t) => floorMinute(t) - KEEP_MINUTES * MINUTE;
/** The one timestamp rule: true when `at` is not a time at all, or later than `t` plus the skew allowance. */
export const tooFarAhead = (at, t) => !(Number.isFinite(at) && at <= t + CLOCK_SKEW_MS);

/** Codex writes a failed command's exit status into its output text; only the verdict is kept. */
function codexFailed(payload) {
  if (payload?.is_error === true) return true;
  const out = payload?.output;
  const text = typeof out === "string" ? out.slice(0, 4096) : "";
  const m = /"exit_code"\s*:\s*(-?\d+)/u.exec(text) || /^Exit code:\s*(-?\d+)/mu.exec(text);
  return Boolean(m && Number(m[1]) !== 0);
}

/* A session in one of the book's maps; the oldest session goes when a map is full. */
function sessionIn(map, hash) {
  let s = map.get(hash);
  if (!s) {
    if (map.size >= MAX_SESSIONS) map.delete(map.keys().next().value);
    s = { minutes: new Map(), lastTool: null };
    map.set(hash, s);
  }
  return s;
}
function cellIn(map, minute) {
  let c = map.get(minute);
  if (!c) { c = { calls: emptyCalls(), ok: 0, error: 0 }; map.set(minute, c); }
  return c;
}
function bump(c, { kind = null, calls = null, ok = 0, error = 0 }) {
  if (kind) c.calls[kind] = Math.min(MAX_COUNT, c.calls[kind] + 1);
  if (calls) for (const k of ACTIVITY_KINDS) c.calls[k] = Math.min(MAX_COUNT, c.calls[k] + clamp(calls[k]));
  c.ok = Math.min(MAX_COUNT, c.ok + clamp(ok));
  c.error = Math.min(MAX_COUNT, c.error + clamp(error));
}
const later = (a, b) => (!a || (b && b.at > a.at) ? b : a);

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 */
export function createActivityBook({ now = () => Date.now() } = {}) {
  // sessionHash -> { minutes: Map(minuteMs -> {calls, ok, error}), lastTool: {kind, at}|null }
  const sessions = new Map();
  // Contribution id -> its minute: a machine's resent contribution is counted once (merge).
  const contributions = new Map();
  // Lines of the transcript being read, then of every transcript read whole in
  // this pass: counted once the cursor that says they were read is written.
  let staged = new Map();
  let pass = new Map();

  const prune = (s, t) => {
    const edge = keepEdge(t);
    for (const m of s.minutes.keys()) if (m < edge) s.minutes.delete(m);
  };
  /* Counts into the kept minutes, under the clock rule and the keep window. */
  function add(hash, at, fields) {
    const t = now();
    if (typeof hash !== "string" || !HASH.test(hash) || tooFarAhead(at, t)) return false;
    const minute = floorMinute(at);
    if (minute < keepEdge(t)) return false;
    const s = sessionIn(sessions, hash);
    bump(cellIn(s.minutes, minute), fields);
    prune(s, t);
    return true;
  }
  function setLast(map, hash, kind, at) {
    if (typeof hash !== "string" || !HASH.test(hash) || !ACTIVITY_KINDS.includes(kind) || tooFarAhead(at, now())) return;
    const s = sessionIn(map, hash);
    s.lastTool = later(s.lastTool, { kind, at });
  }
  /* A transcript line's call or result, staged until its cursor is written. */
  function stage(hash, at, fields) {
    const t = now();
    if (typeof hash !== "string" || !HASH.test(hash) || tooFarAhead(at, t)) return;
    if (fields.kind) setLast(staged, hash, fields.kind, at);
    const minute = floorMinute(at);
    if (minute < floorMinute(t) - STAGE_MINUTES * MINUTE) return;
    bump(cellIn(sessionIn(staged, hash).minutes, minute), fields);
  }

  /** Every staged transcript is read whole: its lines join the pass. `ok` false drops them (it is read again). */
  function fileRead(ok) {
    if (ok) {
      for (const [hash, st] of staged) {
        const p = sessionIn(pass, hash);
        for (const [minute, c] of st.minutes) bump(cellIn(p.minutes, minute), { calls: c.calls, ok: c.ok, error: c.error });
        p.lastTool = later(p.lastTool, st.lastTool);
      }
    }
    staged = new Map();
  }
  /** The pass's counts, per session and minute, with the session's last tool: what a reporter seals. */
  function passCells() {
    const out = [];
    for (const [sessionHash, p] of pass) {
      const lastTool = later(sessions.get(sessionHash)?.lastTool ?? null, p.lastTool);
      for (const [minute, c] of [...p.minutes].sort((a, b) => a[0] - b[0])) {
        out.push({ sessionHash, minute, calls: { ...c.calls }, ok: c.ok, error: c.error, lastTool: lastTool ? { ...lastTool } : null });
      }
    }
    return out;
  }
  /** The cursor that says these lines were read is written: they count. */
  function commitPass() {
    for (const [hash, p] of pass) {
      for (const [minute, c] of p.minutes) add(hash, minute, { calls: c.calls, ok: c.ok, error: c.error });
      if (p.lastTool) setLast(sessions, hash, p.lastTool.kind, p.lastTool.at);
    }
    pass = new Map();
    staged = new Map();
  }
  /** The pass failed before its cursor was written: its lines will be read again. */
  function abortPass() { staged = new Map(); pass = new Map(); }

  return {
    /** The collector's line hook (lib/collector/collector.js onTranscriptLine). Staged until committed. */
    observeLine({ tool, line, sessionHash, historyStartOrdinal }) {
      if (!sessionHash || !line || typeof line !== "object") return;
      const at = Date.parse(line.timestamp);
      if (!Number.isFinite(at)) return;
      if (tool === "claude-code") {
        const content = Array.isArray(line.message?.content) ? line.message.content : [];
        for (const block of content) {
          if (line.type === "assistant" && block?.type === "tool_use") stage(sessionHash, at, { kind: toolKind(tool, block.name) });
          else if (line.type === "user" && block?.type === "tool_result") stage(sessionHash, at, block.is_error === true ? { error: 1 } : { ok: 1 });
        }
      } else if (tool === "codex") {
        const p = line.payload;
        // A forked session's replayed history, before its own first line, is its parent's activity.
        const ordinal = Number.isSafeInteger(line.ordinal) ? line.ordinal : null;
        if (Number.isSafeInteger(historyStartOrdinal) && ordinal !== null && ordinal < historyStartOrdinal) return;
        if (line.type !== "response_item" || !p || typeof p !== "object") return;
        let kind = null;
        if (p.type === "function_call" || p.type === "custom_tool_call") kind = toolKind(tool, p.name);
        else if (p.type === "local_shell_call") kind = "shell";
        else if (p.type === "web_search_call") kind = "web";
        if (kind) stage(sessionHash, at, { kind });
        else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
          stage(sessionHash, at, codexFailed(p) ? { error: 1 } : { ok: 1 });
        }
      }
    },

    /**
     * The collector's side of the cursor transaction for a machine that only
     * shows its activity (the hub's own): nothing to persist; lines count
     * once their cursor is written. A reporter wraps the same steps with its
     * durable outbox (lib/reporter-outbox.js).
     */
    journal: { file: fileRead, prepare: () => null, get changed() { return false; }, commit: commitPass, abort: abortPass },
    fileRead, passCells, commitPass, abortPass,

    /** One call (`kind`) or one result (`ok`/`error`), already reduced to counts; the demo's source. */
    note(sessionHash, at, { kind = null, ok = 0, error = 0 } = {}) {
      if (kind !== null && !ACTIVITY_KINDS.includes(kind)) return;
      if (add(sessionHash, at, { kind, ok, error }) && kind) setLast(sessions, sessionHash, kind, at);
    },

    /**
     * One machine's contributions from its envelope (already checked by
     * activityFor). A contribution id already counted is a resend and adds
     * nothing; distinct contributions to one minute add up. A minute or a
     * last tool past the clock rule is refused whole; one older than the
     * kept quarter hour is expired. Returns the counts of each.
     */
    merge(entries, t = now()) {
      const edge = keepEdge(t);
      const out = { accepted: 0, duplicate: 0, future: 0, expired: 0 };
      for (const e of entries || []) {
        const at = Date.parse(e.at);
        const lastAt = e.lastTool ? Date.parse(e.lastTool.at) : null;
        if (tooFarAhead(at, t) || (lastAt !== null && tooFarAhead(lastAt, t))) { out.future += 1; continue; }
        if (contributions.has(e.id)) { out.duplicate += 1; continue; }
        if (floorMinute(at) < edge) { out.expired += 1; continue; }
        contributions.set(e.id, floorMinute(at));
        if (contributions.size > MAX_CONTRIBUTIONS) contributions.delete(contributions.keys().next().value);
        add(e.sessionHash, at, { calls: e.calls, ok: e.results.ok, error: e.results.error });
        if (e.lastTool) setLast(sessions, e.sessionHash, e.lastTool.kind, lastAt);
        out.accepted += 1;
      }
      for (const [id, minute] of contributions) if (minute < edge) contributions.delete(id);
      return out;
    },

    /**
     * One session's (or several sessions') activity in the five whole minutes
     * ending with the current one, and the latest tool among them. Both edges
     * hold: a minute after the current one is not in the window, and a last
     * tool later than now is not the last tool yet.
     */
    snapshot(hashes, t = now()) {
      const to = floorMinute(t);
      const from = to - (ACTIVITY_WINDOW_MINUTES - 1) * MINUTE;
      const calls = emptyCalls();
      let ok = 0, error = 0, lastTool = null, seen = false;
      for (const hash of hashes) {
        const s = sessions.get(hash);
        if (!s) continue;
        seen = true;
        for (const [minute, c] of s.minutes) {
          if (minute < from || minute > to) continue;
          for (const k of ACTIVITY_KINDS) calls[k] += c.calls[k];
          ok += c.ok; error += c.error;
        }
        if (s.lastTool && s.lastTool.at <= t) lastTool = later(lastTool, { ...s.lastTool });
      }
      if (!seen) return null;
      return { window: `${ACTIVITY_WINDOW_MINUTES}m`, calls, results: { ok, error }, lastTool };
    },

    /** Results only, ok and error, over every kept minute of a session up to now. */
    results(hash, t = now()) {
      const s = sessions.get(hash);
      if (!s) return null;
      const to = floorMinute(t);
      let ok = 0, error = 0;
      for (const [minute, c] of s.minutes) if (minute <= to) { ok += c.ok; error += c.error; }
      return { ok, error };
    },

    get size() { return sessions.size; },
  };
}
