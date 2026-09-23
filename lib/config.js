import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";

import { parseEmbedOrigins } from "./embed.js";
import { PRODUCT_NAME, productTitle } from "./brand.js";

/**
 * The default bind address, and why there is now a flag to change it.
 *
 * This process reads private session transcripts, and the console built from
 * them answers only on this machine — that has not changed, whatever the bind
 * address. What v0.2 adds is a hub: other machines report to it. For them to
 * reach it, the process has to listen on the network, so `--listen` exists.
 * It is explicit, it prints a warning, and it opens only the join exchange and
 * token-authenticated ingestion to other machines (see lib/hub/routes.js).
 */
export const BIND_ADDRESS = "127.0.0.1";
export const DEFAULT_PORT = 6787;
export const DEFAULT_RETENTION_DAYS = 8;

/** Switches that never take a value. */
const BOOLEAN_FLAGS = new Set([
  "demo",
  "no-local",
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

  const listenRaw = String(flags.get("listen") || env.AGENT_CONSOLE_LISTEN || BIND_ADDRESS).trim();
  const listenErrors = [];
  if (listenRaw !== "localhost" && !net.isIP(listenRaw)) {
    listenErrors.push(
      `--listen needs an IP address, for example --listen 0.0.0.0 (every network interface) or --listen 192.168.1.20; got "${listenRaw}"`,
    );
  }
  const retentionDays = Math.max(1, Math.min(90, Math.round(Number(
    flags.get("retention-days") || env.AGENT_CONSOLE_RETENTION_DAYS || DEFAULT_RETENTION_DAYS,
  )) || DEFAULT_RETENTION_DAYS));

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
    // ---- the hub (v0.2) ----
    listen: listenRaw,
    listenErrors,
    stateDir: demo
      ? null
      : path.resolve(String(flags.get("state-dir") || env.AGENT_CONSOLE_STATE_DIR || path.join(home, ".agent-console", "hub"))),
    retentionDays,
    local: !demo && !flagTruthy(flags, "no-local") && !envTruthy(env.AGENT_CONSOLE_NO_LOCAL),
    machineName: flags.has("name") ? String(flags.get("name")) : env.AGENT_CONSOLE_NAME_MACHINE || null,
    person: flags.has("person") ? String(flags.get("person")) : null,
    inviteMinutes: Math.max(5, Math.min(24 * 60, Number(flags.get("invite-minutes")) || 30)),
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
One view of the AI coding agents on this machine — and on any other machine
you connect to it: sessions, tokens, cache reads and writes, models, spend.

  agent-console [options]                 start the console (and read this machine)
  agent-console join <join link>          report this machine to someone's console
  agent-console report                    keep reporting after a restart
  agent-console leave                     stop reporting and forget the enrolment

Console options
  --open                open the console in your browser once it is listening
  --port <n>            port (default ${DEFAULT_PORT})
  --listen <address>    accept other machines on this network, e.g. --listen 0.0.0.0.
                        Default ${BIND_ADDRESS}: this machine only. Other machines can
                        reach ONLY the join exchange and token-checked reporting; the
                        console itself still answers only here.
  --demo                a synthetic fleet; reads nothing, accepts no machines
  --name <text>         what to call this machine on the console (default "This machine")
  --person <text>       whose machine it is (default "You")
  --no-local            do not read this machine's transcripts (a hub on a server)
  --state-dir <path>    where the hub keeps its data (default ~/.agent-console/hub)
  --retention-days <n>  how many days of usage to keep (default ${DEFAULT_RETENTION_DAYS})
  --invite-minutes <n>  how long a join link stays valid (default 30)
  --claude-root <path>  Claude Code transcripts (default ~/.claude/projects)
  --codex-root <path>   Codex transcripts (default ~/.codex/sessions)
  --json                print launch details as JSON and keep running
  --help                this text
  --version             print the version and exit

This-machine detail (the Projects view)
  --repo <path>         repository whose Git history is read for delivery evidence
  --home <path>         home directory to scan (default: your own)
  --window-hours <n>    how far back a transcript may have been touched (default 72)
  --history-dir <path>  where the Projects view keeps token history
  --embed <origins>     origins allowed to embed the <agent-console-panel>
  --github, --muster    legacy opt-in panels that may contact a remote

Run \`agent-console join --help\` for the reporter's options. Environment
equivalents use the AGENT_CONSOLE_ prefix.
`;
