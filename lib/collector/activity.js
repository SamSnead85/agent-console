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
 * The same book serves the hub's own machine (fed by the collector's line
 * hook, with the line's own time) and every joined machine that chose
 * `--share-tool-activity` (fed by `merge()` from its envelope, to the
 * minute). A session's minutes are kept for a quarter of an hour; its last
 * tool is kept as long as the session is.
 */

const MINUTE = 60_000;
export const ACTIVITY_KINDS = Object.freeze(["read", "edit", "shell", "search", "web", "agent", "mcp", "other"]);
/* The window the console shows ("calls in the last five minutes"). */
export const ACTIVITY_WINDOW_MINUTES = 5;
const KEEP_MINUTES = 15;
const MAX_SESSIONS = 5_000;
const MAX_COUNT = 1_000_000;

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

/** Codex writes a failed command's exit status into its output text; only the verdict is kept. */
function codexFailed(payload) {
  if (payload?.is_error === true) return true;
  const out = payload?.output;
  const text = typeof out === "string" ? out.slice(0, 4096) : "";
  const m = /"exit_code"\s*:\s*(-?\d+)/u.exec(text) || /^Exit code:\s*(-?\d+)/mu.exec(text);
  return Boolean(m && Number(m[1]) !== 0);
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 */
export function createActivityBook({ now = () => Date.now() } = {}) {
  // sessionHash -> { minutes: Map(minuteMs -> {calls, ok, error}), lastTool: {kind, at}|null, fresh: Map(minuteMs -> same) }
  const sessions = new Map();
  const sessionFor = (hash) => {
    let s = sessions.get(hash);
    if (!s) {
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      s = { minutes: new Map(), fresh: new Map(), lastTool: null };
      sessions.set(hash, s);
    }
    return s;
  };
  const cell = (map, minute) => {
    let c = map.get(minute);
    if (!c) { c = { calls: emptyCalls(), ok: 0, error: 0 }; map.set(minute, c); }
    return c;
  };
  const prune = (s, t) => {
    const edge = Math.floor(t / MINUTE) * MINUTE - KEEP_MINUTES * MINUTE;
    for (const m of s.minutes.keys()) if (m < edge) s.minutes.delete(m);
    for (const m of s.fresh.keys()) if (m < edge - 60 * MINUTE) s.fresh.delete(m);
  };

  function add(hash, at, { kind = null, ok = 0, error = 0, calls = null } = {}, { local = false } = {}) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash) || !Number.isFinite(at)) return;
    const s = sessionFor(hash);
    const minute = Math.floor(at / MINUTE) * MINUTE;
    for (const map of local ? [s.minutes, s.fresh] : [s.minutes]) {
      const c = cell(map, minute);
      if (kind) c.calls[kind] = Math.min(MAX_COUNT, c.calls[kind] + 1);
      if (calls) for (const k of ACTIVITY_KINDS) c.calls[k] = Math.min(MAX_COUNT, c.calls[k] + clamp(calls[k]));
      c.ok = Math.min(MAX_COUNT, c.ok + clamp(ok));
      c.error = Math.min(MAX_COUNT, c.error + clamp(error));
    }
    prune(s, now());
  }
  const setLast = (hash, kind, at) => {
    const s = sessionFor(hash);
    if (!s.lastTool || at >= s.lastTool.at) s.lastTool = { kind, at };
  };

  return {
    /** The collector's line hook (lib/collector/collector.js onTranscriptLine). */
    observeLine({ tool, line, sessionHash, historyStartOrdinal }) {
      if (!sessionHash || !line || typeof line !== "object") return;
      const at = Date.parse(line.timestamp);
      if (!Number.isFinite(at)) return;
      if (tool === "claude-code") {
        const content = Array.isArray(line.message?.content) ? line.message.content : [];
        for (const block of content) {
          if (line.type === "assistant" && block?.type === "tool_use") {
            const kind = toolKind(tool, block.name);
            add(sessionHash, at, { kind }, { local: true });
            setLast(sessionHash, kind, at);
          } else if (line.type === "user" && block?.type === "tool_result") {
            add(sessionHash, at, block.is_error === true ? { error: 1 } : { ok: 1 }, { local: true });
          }
        }
      } else if (tool === "codex") {
        const p = line.payload;
        const ordinal = Number.isSafeInteger(line.ordinal) ? line.ordinal : null;
        if (Number.isSafeInteger(historyStartOrdinal) && ordinal !== null && ordinal < historyStartOrdinal) return;
        if (line.type !== "response_item" || !p || typeof p !== "object") return;
        let kind = null;
        if (p.type === "function_call" || p.type === "custom_tool_call") kind = toolKind(tool, p.name);
        else if (p.type === "local_shell_call") kind = "shell";
        else if (p.type === "web_search_call") kind = "web";
        if (kind) { add(sessionHash, at, { kind }, { local: true }); setLast(sessionHash, kind, at); }
        else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
          add(sessionHash, at, codexFailed(p) ? { error: 1 } : { ok: 1 }, { local: true });
        }
      }
    },

    /** One call (`kind`) or one result (`ok`/`error`), already reduced to counts; the demo's source. */
    note(sessionHash, at, { kind = null, ok = 0, error = 0 } = {}) {
      if (kind !== null && !ACTIVITY_KINDS.includes(kind)) return;
      add(sessionHash, at, { kind, ok, error });
      if (kind) setLast(sessionHash, kind, at);
    },

    /** Entries from a machine's envelope (already checked by activityFor). */
    merge(entries) {
      for (const e of entries || []) {
        const at = Date.parse(e.at);
        add(e.sessionHash, at, { calls: e.calls, ok: e.results.ok, error: e.results.error });
        if (e.lastTool) setLast(e.sessionHash, e.lastTool.kind, Date.parse(e.lastTool.at));
      }
    },

    /**
     * What a reporter sends next: the minutes counted since the last send,
     * per session, to the minute. `take()` then `ack()` once the console has
     * the envelope; an unacknowledged send is offered again.
     */
    outbox() {
      let taken = [];
      return {
        take() {
          taken = [];
          const out = [];
          for (const [sessionHash, s] of sessions) {
            for (const [minute, c] of s.fresh) {
              taken.push([s, minute]);
              out.push({ sessionHash, at: new Date(minute).toISOString(), calls: { ...c.calls }, results: { ok: c.ok, error: c.error },
                lastTool: s.lastTool ? { kind: s.lastTool.kind, at: new Date(Math.floor(s.lastTool.at / MINUTE) * MINUTE).toISOString() } : null });
              if (out.length >= 500) return out;
            }
          }
          return out;
        },
        ack() { for (const [s, minute] of taken) s.fresh.delete(minute); taken = []; },
      };
    },

    /**
     * One session's (or several sessions') activity in the five whole minutes
     * ending with the current one, and the latest tool among them.
     */
    snapshot(hashes, t = now()) {
      const from = Math.floor(t / MINUTE) * MINUTE - (ACTIVITY_WINDOW_MINUTES - 1) * MINUTE;
      const calls = emptyCalls();
      let ok = 0, error = 0, lastTool = null, seen = false;
      for (const hash of hashes) {
        const s = sessions.get(hash);
        if (!s) continue;
        seen = true;
        for (const [minute, c] of s.minutes) {
          if (minute < from) continue;
          for (const k of ACTIVITY_KINDS) calls[k] += c.calls[k];
          ok += c.ok; error += c.error;
        }
        if (s.lastTool && (!lastTool || s.lastTool.at > lastTool.at)) lastTool = { ...s.lastTool };
      }
      if (!seen) return null;
      return { window: `${ACTIVITY_WINDOW_MINUTES}m`, calls, results: { ok, error }, lastTool };
    },

    /** Results only, ok and error, over everything kept for a session. */
    results(hash) {
      const s = sessions.get(hash);
      if (!s) return null;
      let ok = 0, error = 0;
      for (const c of s.minutes.values()) { ok += c.ok; error += c.error; }
      return { ok, error };
    },

    get size() { return sessions.size; },
  };
}
