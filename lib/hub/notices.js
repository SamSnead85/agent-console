/**
 * What the console says when starting goes wrong, or finds nothing: one plain
 * sentence and the one thing to do about it, never a stack trace.
 */

const TOOL_NAMES = { "claude-code": "Claude Code", codex: "Codex" };

/** Where the first read looked, when it found nothing, and how to point it elsewhere. */
export function emptyReadNotice(roots = [], command = "agent-console") {
  const shown = roots.filter((r) => r.exists || !r.optional);
  const width = Math.max(...shown.map((r) => (TOOL_NAMES[r.tool] || r.tool).length), 6);
  const lines = ["  No Claude Code or Codex transcripts were found on this machine. Looked in:"];
  for (const r of shown) {
    const what = !r.exists ? "not there" : r.files === 1 ? "1 file" : `${r.files ?? 0} files`;
    lines.push(`    ${(TOOL_NAMES[r.tool] || r.tool).padEnd(width)}  ${r.directory}  (${what})`);
  }
  lines.push(`  If they are elsewhere, start with --claude-root <folder> or --codex-root <folder>, e.g. ${command} --claude-root ~/work/.claude/projects`);
  return lines.join("\n");
}

/** -1, 0 or 1: dotted numeric versions, a pre-release before its release. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = null] = String(v || "").replace(/^v/u, "").split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i += 1) {
    const d = (x.parts[i] || 0) - (y.parts[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The exact command that stops a console: by its process id when known, otherwise by its port. */
export function stopCommand({ pid = null, port = null, platform = process.platform } = {}) {
  if (platform === "win32") {
    return pid ? `taskkill /PID ${pid} /F` : `Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess`;
  }
  return pid ? `kill ${pid}` : `kill $(lsof -ti tcp:${port} -sTCP:LISTEN)`;
}

/**
 * A console of another version already answers on the port. An older one is
 * never opened as if it were this one: it is named, with the command that
 * stops it. Returns null when the running console is this version or newer.
 */
export function olderConsoleNotice({ running = null, version, url, pid = null, port = null, platform = process.platform, command = "agent-console" }) {
  if (!running || typeof running.version !== "string" || compareVersions(running.version, version) >= 0) return null;
  return [
    "",
    `  An older Agent Console (${running.version}) is still running at ${url}; this is ${version}.`,
    "  It was not opened. Stop it, then start this one again:",
    `    ${stopCommand({ pid, port, platform })}`,
    `    ${command}`,
    "  (Or press Ctrl+C in the window where it runs.)",
    "",
  ].join("\n");
}

/** The state directory is held by another console: name it and how to stop it. */
export function lockedStateNotice({ dir, owner = null, platform = process.platform }) {
  const who = owner?.pid ? `process ${owner.pid}${owner.host ? " on " + owner.host : ""}` : "another process";
  return [
    "",
    `  Another Agent Console (${who}) is using ${dir}.`,
    owner?.pid ? `  If it is an older version still running, stop it first:  ${stopCommand({ pid: owner.pid, platform })}` : "  Stop that console first,",
    "  or start this one with a different --state-dir.",
    "",
  ].join("\n");
}

/**
 * One line of remedy for a failure while starting or reading: by the error's
 * code, with the path or port it names. `what` says what was being done.
 */
export function remedy(error, { what = "starting", path: where = null, port = null, command = "agent-console" } = {}) {
  const code = error && typeof error === "object" ? error.code : null;
  const target = where || error?.path || null;
  switch (code) {
    case "EACCES":
    case "EPERM":
      if (port !== null && error?.syscall === "listen") {
        return `Port ${port} needs administrator rights here. Use a port above 1024:  ${command} --port 6787`;
      }
      return `Permission denied ${what}${target ? " (" + target + ")" : ""}. Give your user read and write access to it, or start with --state-dir <a folder you own>.`;
    case "ENOSPC": return `The disk is full ${what}${target ? " (" + target + ")" : ""}. Free some space, or start with --state-dir <a folder on another disk>.`;
    case "EROFS": return `${target || "That folder"} is on a read-only disk. Start with --state-dir <a folder you can write to>.`;
    case "ENOTDIR":
    case "EEXIST": return `${target || "A path"} is a file where a folder is expected. Move it aside, or start with --state-dir <another folder>.`;
    case "EMFILE":
    case "ENFILE": return "Too many files are open. Close other programs, or raise the limit (ulimit -n 4096), and start again.";
    case "EADDRINUSE": return `${port ? `Port ${port}` : "The port"} is already in use. Start on another:  ${command} --port ${(Number(port) || 6787) + 2}`;
    case "EADDRNOTAVAIL": return "This machine has no such network address. Use --listen 0.0.0.0, or one of this machine's own addresses.";
    default: return `Something went wrong ${what}: ${String(error?.message || error).split("\n")[0]}`;
  }
}
