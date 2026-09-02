/**
 * Live agent processes, and the guard that stands in front of terminating one.
 *
 * Matching is on argv[0] — the real executable path — never a name grep over
 * the whole command line. Helper processes, application plumbing, and commands
 * that merely mention an agent path must not be classified as agent processes.
 *
 * Everything in this file is a pure function of a `ps` snapshot so the guard can
 * be tested against captured output — including the cases that must be refused —
 * without signalling a real process.
 */

import { createHash } from "node:crypto";

import { redactAndClip } from "./redact.js";

/**
 * `ps -Ao pid=,ppid=,lstart=,etime=,pcpu=,rss=,command=`
 * lstart is five whitespace-separated tokens: "Fri Aug 28 20:12:54 2026".
 */
const PS_FORMAT = ["-Ao", "pid=,ppid=,lstart=,etime=,pcpu=,rss=,command="];
const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\S{3}\s+\S{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/u;

export const PS_ARGS = PS_FORMAT;

/**
 * Executable paths that identify a working coding agent.
 *
 * Each pattern is matched against argv[0] ONLY — see `matchesArgv0`. Matching
 * against the whole `ps` line creates false positives in both directions: an
 * argument may mention an agent executable, or a shell may merely launch one.
 */
const AGENT_BINARIES = [
  { re: /\/claude\.app\/Contents\/MacOS\/claude(?=\s|$)/u, vendor: "claude" },
  { re: /\/Contents\/Resources\/codex(?=\s|$)/u, vendor: "codex" },
  { re: /\/\.codex\/bin\/codex(?=\s|$)/u, vendor: "codex" },
  { re: /\/bin\/codex(?=\s|$)/u, vendor: "codex" },
];

/**
 * Flags that consume the next token as their value.
 *
 * Only used to find where the argument list stops being structure and starts
 * being free text — a prompt. It is deliberately over-inclusive: consuming one
 * token too many can only shorten the structural run, never lengthen it.
 */
const VALUE_FLAGS = new Set([
  "-c",
  "-C",
  "-m",
  "-p",
  "-a",
  "--config",
  "--print",
  "--prompt",
  "--model",
  "--cd",
  "--output-format",
  "--input-format",
  "--listen",
  "--sandbox",
  "--profile",
  "--permission-mode",
  "--append-system-prompt",
  "--system-prompt",
  "--mcp-config",
  "--settings",
  "--add-dir",
  "--session-id",
  "--resume",
  "--agents",
]);

/**
 * A codex subcommand that is vendor infrastructure, not a worker. Listed so the
 * operator can see it, and never terminable: killing the Codex app-server takes
 * the whole integration down instead of one session.
 */
const HOST_SUBCOMMANDS = new Set(["app-server"]);

/**
 * Not a process at all, for this purpose. The sandbox wrapper duplicates the
 * child it launches; the stdio shims are per-conversation helpers. Excluding
 * them here means they can never be offered for termination even by mistake.
 *
 * The old `--type=` exclusion is gone with the argv[0] anchoring that replaced
 * it: the Electron helpers it targeted live under `Claude Helper.app` and
 * `Codex Framework.framework`, whose argv[0] never matches an agent binary —
 * while a session whose PROMPT contained "--type=" was being dropped from the
 * roster entirely.
 */
const NEVER_SUBCOMMANDS = new Set(["sandbox"]);

/**
 * True when `re` matches inside argv[0] — the executable path — rather than
 * inside an argument.
 *
 * `ps` joins argv with single spaces and does not quote, and a real macOS
 * bundle path contains spaces ("…/Library/Application Support/Claude/…"), so
 * argv[0] cannot be recovered by splitting on whitespace. What CAN be decided
 * is whether the matched path still lies inside the first argument: everything
 * before it must be one unbroken path prefix. A flag token, a second absolute
 * path, or a whitespace boundary immediately before the match all mean the
 * match is in an argument, and the process is not identified.
 *
 * Returns the index just past the executable, or -1.
 */
export function matchesArgv0(cmd, re) {
  const m = re.exec(String(cmd));
  if (!m) return -1;
  const head = cmd.slice(0, m.index);
  if (head.length === 0) return m.index + m[0].length;
  if (/\s$/u.test(head)) return -1; // the match begins a new argument
  if (/\s-/u.test(head)) return -1; // a flag was already seen
  if (/\s\//u.test(head)) return -1; // another absolute path already began
  return m.index + m[0].length;
}

/**
 * Split what follows argv[0] into its structural run: the flags, and the first
 * two bare words (a subcommand, and whatever follows it).
 *
 * Scanning stops at the second bare word so that free text — a `-p` prompt,
 * which on this machine routinely contains the words "app-server" and
 * "--type=" — can never be read as a subcommand or a flag. That mistake made a
 * live session either invisible or permanently unkillable depending on which
 * word the operator happened to type.
 */
export function argvShape(cmd, from) {
  const rest = String(cmd).slice(from).trim().split(/\s+/u).filter(Boolean);
  const flags = [];
  const words = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith("-")) {
      flags.push(token);
      if (VALUE_FLAGS.has(token) && rest[i + 1] !== undefined) {
        i += 1;
        flags.push(rest[i]);
      }
      continue;
    }
    words.push(token);
    if (words.length >= 2) break;
  }
  return { flags, words };
}

export function parsePs(stdout) {
  const rows = [];
  for (const line of String(stdout).split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      lstart: m[3].replace(/\s+/gu, " ").trim(),
      etime: m[4],
      cpu: Number(m[5]),
      rssMb: Number(m[6]) / 1024,
      cmd: m[7],
    });
  }
  return rows;
}

export function classify(row) {
  const cmd = String(row.cmd || "");
  let vendor = null;
  let after = -1;
  for (const binary of AGENT_BINARIES) {
    const end = matchesArgv0(cmd, binary.re);
    if (end !== -1) {
      vendor = binary.vendor;
      after = end;
      break;
    }
  }
  if (!vendor) return null;
  const { flags, words } = argvShape(cmd, after);
  const subcommand = words[0] || null;
  if (subcommand && NEVER_SUBCOMMANDS.has(subcommand)) return null;
  // `codex app-server --listen stdio://` is a per-conversation shim, not the
  // desktop app-server, and there are several of them per Codex window.
  if (flags.includes("--listen") && flags.some((f) => f.startsWith("stdio://")))
    return null;
  if (vendor === "codex" && subcommand && HOST_SUBCOMMANDS.has(subcommand))
    return { vendor, role: "host" };
  return { vendor, role: "agent" };
}

/**
 * A process identity that survives a poll but not a PID reuse.
 * Hashed, so the argv (which routinely carries secrets) never leaves the process
 * in a form anyone can read.
 */
export function fingerprint(row) {
  return createHash("sha256")
    .update(String(row.pid) + "\u0000" + row.lstart + "\u0000" + row.cmd)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Shorten the argv wall to the flags that identify the process.
 *
 * Redaction runs on the FULL argv and the cut is applied to the masked result.
 * Cutting first defeats every rule anchored to the right of a secret — a
 * `postgresql://user:pass@host` in an argument had its "@host" removed by the
 * 160-character cut, and the whole password was then served in the clear.
 */
function gistOf(cmd) {
  const index = cmd.search(/\s(--|-c\s|sandbox|app-server|exec|resume)/u);
  const gist =
    index > 0
      ? cmd.slice(0, index) +
        " " +
        cmd.slice(index).trim().split(/\s+/u).slice(0, 8).join(" ")
      : cmd;
  return redactAndClip(gist, 160, "\u2026");
}

/** Every pid between `pid` and the root of the process tree. */
export function ancestorsOf(rows, pid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const out = new Set();
  let current = byPid.get(pid);
  let guard = 0;
  while (current && guard < 64) {
    guard += 1;
    out.add(current.pid);
    if (!current.ppid || current.ppid === current.pid) break;
    current = byPid.get(current.ppid);
    if (current) out.add(current.pid);
  }
  out.add(1);
  return out;
}

export function listAgents(stdout, selfPid) {
  const rows = parsePs(stdout);
  const protectedPids = ancestorsOf(rows, selfPid);
  const out = [];
  for (const row of rows) {
    const kind = classify(row);
    if (!kind) continue;
    out.push({
      pid: row.pid,
      ppid: row.ppid,
      lstart: row.lstart,
      etime: row.etime,
      cpu: row.cpu,
      rssMb: row.rssMb,
      vendor: kind.vendor,
      role: kind.role,
      cmd: gistOf(row.cmd),
      fingerprint: fingerprint(row),
      // A host process is agent infrastructure (the Codex desktop app-server,
      // the code-mode host). Killing one takes the whole vendor integration
      // down rather than one runaway session, so it is never offered.
      killable: kind.role === "agent" && !protectedPids.has(row.pid),
      protectedReason: protectedPids.has(row.pid)
        ? "this dashboard or one of its ancestors"
        : kind.role !== "agent"
          ? "vendor host process, not a working agent"
          : null,
    });
  }
  out.sort((a, b) => b.cpu - a.cpu || b.rssMb - a.rssMb);
  return out;
}

export const REFUSALS = {
  NOT_FOUND: "no process with that pid is running now",
  NOT_AN_AGENT: "that pid is not a recognised coding-agent process",
  HOST: "that pid is vendor host infrastructure, not a working agent",
  SELF: "that pid is this dashboard or one of its ancestors",
  CHANGED: "that pid no longer matches what was shown; it may have been reused",
  NO_TICKET: "no confirmation ticket was presented",
  BAD_TICKET: "the confirmation ticket is unknown, already used, or expired",
  MISMATCH: "the confirmation ticket does not describe that process",
};

/**
 * Decide whether `pid` may be signalled, from a `ps` snapshot taken NOW.
 *
 * Fails closed: every path that cannot positively re-identify the process as a
 * live, killable coding agent returns a refusal with a reason. `expected` is the
 * fingerprint the operator was looking at when they asked; a mismatch means the
 * pid was recycled or the process re-execed, and is refused rather than guessed.
 */
export function authorizeKill(stdout, pid, expected, selfPid) {
  const rows = parsePs(stdout);
  const row = rows.find((r) => r.pid === pid);
  if (!row) return { ok: false, code: "NOT_FOUND", reason: REFUSALS.NOT_FOUND };
  const kind = classify(row);
  if (!kind)
    return { ok: false, code: "NOT_AN_AGENT", reason: REFUSALS.NOT_AN_AGENT };
  if (kind.role !== "agent")
    return { ok: false, code: "HOST", reason: REFUSALS.HOST };
  if (ancestorsOf(rows, selfPid).has(pid)) {
    return { ok: false, code: "SELF", reason: REFUSALS.SELF };
  }
  const actual = fingerprint(row);
  if (!expected || expected !== actual) {
    return { ok: false, code: "CHANGED", reason: REFUSALS.CHANGED };
  }
  return {
    ok: true,
    target: {
      pid,
      vendor: kind.vendor,
      lstart: row.lstart,
      etime: row.etime,
      cmd: gistOf(row.cmd),
      fingerprint: actual,
    },
  };
}
