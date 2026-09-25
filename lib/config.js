import os from "node:os";
import path from "node:path";
import net from "node:net";

import { productTitle } from "./brand.js";

/**
 * Two listeners, two ports.
 *
 * The console — every page, its data and every administrative action — is
 * served on 127.0.0.1 only, on its own port, and needs the sign-in cookie.
 * Reporting — the join page, the join exchange and token-checked ingestion —
 * has a second port, bound to `--listen` (this machine only by default). The
 * two never share a socket, so exposing reporting to a network cannot expose
 * the console.
 */
export const BIND_ADDRESS = "127.0.0.1";
export const DEFAULT_PORT = 6787;
export const DEFAULT_RETENTION_DAYS = 8;
export const MAX_INVITE_MINUTES = 60;

/** Switches that never take a value. */
const BOOLEAN_FLAGS = new Set(["demo", "no-local", "json", "open", "help", "h", "allow-public", "desktop-alerts"]);

/** False only on an explicit negation; a bare or oddly-spelled flag is true. */
function flagTruthy(flags, name) {
  if (!flags.has(name)) return false;
  const value = String(flags.get(name)).toLowerCase();
  return !(value === "false" || value === "0" || value === "no" || value === "off");
}

function envTruthy(value) {
  if (value === undefined || value === null) return false;
  const v = String(value).toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function portOf(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65_535 ? n : fallback;
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
    if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags.set(name, argv[++i]);
    else flags.set(name, "true");
  }

  const demo = flagTruthy(flags, "demo") || envTruthy(env.AGENT_CONSOLE_DEMO);
  // Demo mode reads nothing from this machine, so it has no home directory.
  const home = demo ? null : path.resolve(String(flags.get("home") || env.AGENT_CONSOLE_HOME || os.homedir()));

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
  const port = portOf(flags.get("port") ?? env.AGENT_CONSOLE_PORT, DEFAULT_PORT);
  const reportPortGiven = flags.has("report-port") || Boolean(env.AGENT_CONSOLE_REPORT_PORT);

  return {
    demo,
    // An explicit port is never moved to another one when it is busy.
    portExplicit: flags.has("port") || Boolean(env.AGENT_CONSOLE_PORT),
    port,
    reportPortExplicit: reportPortGiven,
    reportPort: portOf(flags.get("report-port") ?? env.AGENT_CONSOLE_REPORT_PORT, port === 0 ? 0 : port + 1),
    home,
    claudeRoot: demo ? null : path.resolve(String(flags.get("claude-root") || env.AGENT_CONSOLE_CLAUDE_ROOT || path.join(home, ".claude", "projects"))),
    codexRoot: demo ? null : path.resolve(String(flags.get("codex-root") || env.AGENT_CONSOLE_CODEX_ROOT || path.join(home, ".codex", "sessions"))),
    pollMs: Math.max(1000, Number(flags.get("poll-ms") || env.AGENT_CONSOLE_POLL_MS || 10_000) || 10_000),
    listen: listenRaw,
    listenErrors,
    allowPublic: flagTruthy(flags, "allow-public"),
    stateDir: demo
      ? null
      : path.resolve(String(flags.get("state-dir") || env.AGENT_CONSOLE_STATE_DIR || path.join(home, ".agent-console", "hub"))),
    retentionDays,
    local: !demo && !flagTruthy(flags, "no-local") && !envTruthy(env.AGENT_CONSOLE_NO_LOCAL),
    desktopAlerts: flagTruthy(flags, "desktop-alerts") || envTruthy(env.AGENT_CONSOLE_DESKTOP_ALERTS),
    alertRepeat: Math.max(2, Math.min(20, Math.round(Number(flags.get("alert-repeat") || env.AGENT_CONSOLE_ALERT_REPEAT) || 5))),
    alertSpikeFactor: Math.max(2, Math.min(10, Number(flags.get("alert-spike-factor") || env.AGENT_CONSOLE_ALERT_SPIKE_FACTOR) || 3)),
    alertStallMinutes: Math.max(1, Math.min(60, Number(flags.get("alert-stall-minutes") || env.AGENT_CONSOLE_ALERT_STALL_MINUTES) || 5)),
    machineName: flags.has("name") ? String(flags.get("name")) : env.AGENT_CONSOLE_NAME_MACHINE || null,
    person: flags.has("person") ? String(flags.get("person")) : null,
    inviteMinutes: Math.max(5, Math.min(MAX_INVITE_MINUTES, Number(flags.get("invite-minutes")) || 30)),
    open: flagTruthy(flags, "open"),
    json: flagTruthy(flags, "json"),
    help: flags.has("help") || flags.has("h"),
  };
}

/** Usage, written with the command that actually runs this copy. */
export function help(cmd = "agent-console") {
  return `
${productTitle()}
One view of the AI coding agents on this machine — and on any other machine
you connect to it: sessions, tokens, cache reads and writes, models, spend.

  ${cmd} [options]
      start the console (and read this machine)
  ${cmd} join '<join link>'
      report this machine to someone's console
  ${cmd} report
      keep reporting after a restart
  ${cmd} leave
      stop reporting and delete the enrolment

Console options
  --open                open the console in your browser, signed in
  --port <n>            the console's port, on 127.0.0.1 only (default ${DEFAULT_PORT})
  --report-port <n>     the port other machines join and report on (default: --port + 1)
  --listen <address>    where the reporting port listens, e.g. --listen 0.0.0.0.
                        Default ${BIND_ADDRESS}: this machine only. The console itself
                        is never on this port.
  --allow-public        accept reports from addresses outside private networks
  --demo                a synthetic team; reads nothing, accepts no machines
  --desktop-alerts      opt in to native desktop notifications for live alerts
  --alert-repeat <n>    repeated identical tool calls before alerting (default 5)
  --alert-spike-factor <n>  usage against session median (default 3)
  --alert-stall-minutes <n>  spending without tool success (default 5)
  --name <text>         what to call this machine on the console (default "This machine")
  --person <text>       whose machine it is (default "You")
  --no-local            do not read this machine's transcripts (a hub on a server)
  --state-dir <path>    where the hub keeps its data (default ~/.agent-console/hub)
  --retention-days <n>  how many days of usage to keep (default ${DEFAULT_RETENTION_DAYS})
  --invite-minutes <n>  how long a join link stays valid (default 30, at most ${MAX_INVITE_MINUTES})
  --claude-root <path>  Claude Code transcripts (default ~/.claude/projects)
  --codex-root <path>   Codex transcripts (default ~/.codex/sessions)
  --json                print launch details as JSON and keep running
  --help                this text
  --version             print the version and exit

Run the reporter's help with "join --help". Environment equivalents use the
AGENT_CONSOLE_ prefix.
`;
}
