import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { parseEmbedOrigins } from "./embed.js";
import { PRODUCT_NAME, productTitle } from "./brand.js";

/**
 * The bind address is a constant, not an option.
 *
 * This process reads private session transcripts — prompts, file contents,
 * command lines. There is no configuration under which exposing that on a
 * routable interface is correct, so there is no flag for it.
 */
export const BIND_ADDRESS = "127.0.0.1";
export const DEFAULT_PORT = 6787;

/** Switches that never take a value. */
const BOOLEAN_FLAGS = new Set([
  "demo",
  "github",
  "no-github",
  "no-muster",
  "muster",
  "json",
  "open",
  "help",
  "h",
]);

/** False only on an explicit negation; a bare or oddly-spelled flag is true. */
function flagTruthy(flags, name) {
  if (!flags.has(name)) return false;
  const value = String(flags.get(name)).toLowerCase();
  return !(
    value === "false" ||
    value === "0" ||
    value === "no" ||
    value === "off"
  );
}

function envTruthy(value) {
  if (value === undefined || value === null) return false;
  const v = String(value).toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function readConfig(argv, env) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, "true");
      continue;
    }
    if (argv[i + 1] && !argv[i + 1].startsWith("--"))
      flags.set(name, argv[++i]);
    else flags.set(name, "true");
  }

  const demo =
    flagTruthy(flags, "demo") || envTruthy(env.AGENT_CONSOLE_DEMO || env.MUSTER_CONSOLE_DEMO);
  // Demo mode is deliberately severed from the operator's filesystem. Even
  // the derived roots use synthetic paths, so a later diagnostic cannot leak
  // a username or suggest that the fixture was read from a real home.
  const home = demo
    ? path.resolve(path.sep, "muster-demo")
    : flags.get("home") ||
      env.AGENT_CONSOLE_HOME ||
      env.MUSTER_CONSOLE_HOME ||
      env.FLEET_HOME ||
      os.homedir();
  // 72 rather than 36 so the "last 3 days" history period can be rebuilt from
  // SOURCE data (per-line timestamps), not only from persisted snapshots. The
  // scan still skips every file untouched inside the window, so the cost is
  // bounded by what was actually written in those three days.
  const windowHours = Number(
    flags.get("window-hours") ||
      env.AGENT_CONSOLE_WINDOW_HOURS ||
      env.MUSTER_CONSOLE_WINDOW_HOURS ||
      env.FLEET_WINDOW_HOURS ||
      72,
  );
  const legacyHistoryDir = path.join(home, ".sprintloop-fleet-dashboard");
  // existsSync is a read too. A privacy-safe demo must not probe the real (or
  // caller-supplied) history directory merely to choose a default it will
  // never use.
  const defaultHistoryDir = demo
    ? null
    : fs.existsSync(legacyHistoryDir)
      ? legacyHistoryDir
      : path.join(home, ".muster-console");

  const embedded = parseEmbedOrigins(
    flags.has("embed") ? flags.get("embed") : env.AGENT_CONSOLE_EMBED,
  );

  return {
    demo,
    port: Number(
      flags.get("port") ||
        env.AGENT_CONSOLE_PORT ||
        env.MUSTER_CONSOLE_PORT ||
        env.FLEET_PORT ||
        DEFAULT_PORT,
    ),
    repoRoot: demo
      ? path.join(home, "repository")
      : path.resolve(
          flags.get("repo") || env.AGENT_CONSOLE_REPO ||
            env.MUSTER_CONSOLE_REPO || process.cwd(),
        ),
    home,
    claudeRoot: demo ? path.join(home, ".claude", "projects") : path.resolve(flags.get("claude-root") || env.AGENT_CONSOLE_CLAUDE_ROOT || path.join(home, ".claude", "projects")),
    claudeSessions: path.join(home, ".claude", "sessions"),
    codexRoot: demo ? path.join(home, ".codex", "sessions") : path.resolve(flags.get("codex-root") || env.AGENT_CONSOLE_CODEX_ROOT || path.join(home, ".codex", "sessions")),
    windowMs: Math.max(1, windowHours) * 3600 * 1000,
    pollMs: Number(
      flags.get("poll-ms") ||
        env.AGENT_CONSOLE_POLL_MS ||
        env.MUSTER_CONSOLE_POLL_MS ||
        env.FLEET_POLL_MS ||
        10_000,
    ),
    // Retained in the snapshot schema for compatibility; there is no public
    // flag or route capable of changing it.
    killEnabled: false,
    // Optional hosted-forge checks use read-only gh calls. Disabling this panel
    // does not imply a no-network process: normal Muster ledger refresh may
    // still contact the repository's configured Git origin.
    /* Off by default, and that is a change from the version that shipped
       inside the Muster CLI. This panel infers "who is doing what" from the
       shape of GitHub issue comments — archaeology from before there was a
       ledger to read — and it does it by shelling out to `gh`. A console
       whose stated posture is "no outbound requests" should not make one on
       first launch to power a legacy panel most operators will never open.
       `--github` opts in; `--no-github` still parses so an existing command
       line does not become a usage error. */
    githubEnabled:
      !demo &&
      flagTruthy(flags, "github") &&
      !flagTruthy(flags, "no-github") &&
      !envTruthy(env.AGENT_CONSOLE_NO_GITHUB) &&
      !envTruthy(env.MUSTER_CONSOLE_NO_GITHUB) &&
      !envTruthy(env.FLEET_NO_GITHUB),
    fleetIssue: Number(
      flags.get("fleet-issue") ||
        env.MUSTER_CONSOLE_FLEET_ISSUE ||
        env.FLEET_ISSUE ||
        5,
    ),
    // The Muster ledger is read through the CLI or its Git branch. Refresh is
    // coordination-read-only but may contact the configured Git origin.
    // The launching CLI's own entry point, so the console reads the ledger
    // through the build that shipped it rather than whatever `muster` a PATH
    // lookup happens to find — or nothing at all.
    musterBin: demo ? null : flags.get("muster-bin") || env.MUSTER_CONSOLE_BIN || null,
    musterEnabled:
      !demo &&
      (flagTruthy(flags, "muster") || envTruthy(env.AGENT_CONSOLE_MUSTER) || flags.has("muster-bin")) &&
      !flagTruthy(flags, "no-muster") &&
      !envTruthy(env.MUSTER_CONSOLE_NO_MUSTER) &&
      !envTruthy(env.FLEET_NO_MUSTER),
    // Retained for compatibility with older snapshot consumers. HTTP session
    // ingest is not exposed by this build.
    ingestEnabled: false,
    // Snapshot history lives OUTSIDE any repository — a file inside one could
    // carry a credential out of a transcript and into the repo's secret gate.
    historyDir: demo
      ? null
      : flags.get("history-dir") ||
        env.AGENT_CONSOLE_HISTORY_DIR ||
        env.MUSTER_CONSOLE_HISTORY_DIR ||
        env.FLEET_HISTORY_DIR ||
        defaultHistoryDir,
    open: flagTruthy(flags, "open"),
    json: flagTruthy(flags, "json"),
    help: flags.has("help") || flags.has("h"),
    // Off unless an operator names an origin. See lib/embed.js for why there
    // is no wildcard and why the errors are carried rather than thrown: the
    // server reports them and exits, so a typo in an allowlist can never
    // degrade into "embedding is simply off" without saying so.
    embed: embedded.origins,
    embedErrors: embedded.errors,
  };
}

export const HELP = `
${productTitle()}
Local, read-only visibility into the AI coding sessions on this machine and the
sessions elsewhere that declare themselves to it.

  agent-console [options]

  --port <n>            listen port (default ${DEFAULT_PORT}; always bound to ${BIND_ADDRESS})
  --demo                use deterministic synthetic data; performs no local scans
                        and makes no outbound network requests
  --repo <path>         repository whose Muster ledger and Git history are read
  --home <path>         home directory to scan (default: your own)
  --window-hours <n>    how far back a transcript may have been touched (default 72)
  --poll-ms <n>         browser refresh interval in milliseconds (default 10000)
  --github              enable the legacy hosted-forge panel, which shells out
                        to the gh CLI. Off by default: it makes outbound
                        requests and predates the coordination ledger
  --fleet-issue <n>     the coordination-ledger issue number (default 5)
  --muster              opt in to the optional Muster coordination ledger
  --no-muster           disable ledger reading, even if enabled elsewhere
  --claude-root <path>  override the Claude transcript directory
  --codex-root <path>   override the Codex rollout directory
  --muster-bin <path>   the muster CLI entry point to read the ledger through
                        (set automatically by \`muster dashboard\`)
  --history-dir <path>  where token-history snapshots are appended
                        (default ~/.muster-console; legacy history is reused)
  --embed <origins>     comma-separated origins allowed to fetch and frame this
                        console, e.g. --embed http://localhost:3000. Off by
                        default; "*" and "null" are refused
  --open                open the page in your default browser once it is listening
  --help                this text

Environment equivalents use the AGENT_CONSOLE_ prefix (MUSTER_CONSOLE_ is still read). Legacy FLEET_ names
for read-only scan, refresh, and history settings remain accepted so an
existing LockedIn Labs console keeps its state during migration.
`;
