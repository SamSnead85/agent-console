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
const BOOLEAN_FLAGS = new Set(["demo", "no-local", "json", "open", "help", "h", "allow-public", "allow-cgnat", "desktop-alerts", "interop"]);
/** Options that take a value. Anything else is a mistake, and is said to be one. */
const VALUE_FLAGS = new Set(["port", "report-port", "listen", "home", "claude-root", "codex-root", "poll-ms", "state-dir",
  "retention-days", "alert-repeat", "alert-spike-factor", "alert-stall-minutes", "name", "person", "invite-minutes"]);
/** Options whose value is a whole number, and the range it must fall in. */
const NUMBER_FLAGS = { "port": [0, 65_535], "report-port": [0, 65_535], "retention-days": [1, 90], "invite-minutes": [5, MAX_INVITE_MINUTES],
  "poll-ms": [1000, 3_600_000], "alert-repeat": [2, 20], "alert-spike-factor": [2, 10, true], "alert-stall-minutes": [1, 60] };

/** The closest known option to a mistyped one, when there is a close one. */
export function closest(word, known) {
  let best = null, score = Infinity;
  for (const candidate of known) {
    const d = distance(word, candidate);
    if (d < score) { best = candidate; score = d; }
  }
  return score <= (word.length >= 4 ? 2 : 1) ? best : null;
}
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

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
  // Mistakes are collected and refused at start, never ignored: a mistyped
  // option would otherwise start a console that does something else.
  const errors = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h") { flags.set("help", "true"); continue; }
    if (!arg.startsWith("--")) {
      errors.push(`"${arg}" is not an option of the console. Options start with --; run --help for the list.`);
      continue;
    }
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
  for (const [name, value] of flags) {
    if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
      const near = closest(name, [...BOOLEAN_FLAGS, ...VALUE_FLAGS].filter((f) => f.length > 1));
      errors.push(`--${name} is not an option of the console.${near ? ` Did you mean --${near}?` : " Run --help for the list."}`);
    } else if (VALUE_FLAGS.has(name) && value === "true" && !["name", "person"].includes(name)) {
      errors.push(`--${name} needs a value.`);
    } else if (NUMBER_FLAGS[name]) {
      const [low, high, decimal] = NUMBER_FLAGS[name];
      const n = Number(value);
      if (!(decimal ? /^\s*\d+(\.\d+)?\s*$/u : /^\s*\d+\s*$/u).test(String(value)) || n < low || n > high) {
        errors.push(`--${name} needs ${decimal ? "a number" : "a whole number"} from ${low} to ${high}; got "${value}".`);
      }
    }
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
    errors: [...errors, ...listenErrors],
    allowPublic: flagTruthy(flags, "allow-public"),
    // 100.64.0.0/10 is Tailscale's range, and also carrier-grade NAT shared with strangers: opt in.
    allowCgnat: flagTruthy(flags, "allow-cgnat") || envTruthy(env.AGENT_CONSOLE_ALLOW_CGNAT),
    interop: flagTruthy(flags, "interop") || envTruthy(env.AGENT_CONSOLE_INTEROP),
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
  ${cmd} stop
      stop a reporter running in the background; keep the enrolment
  ${cmd} leave
      stop reporting, leave the console, and delete the enrolment
  ${cmd} metrics-token [--state-dir <path>]
      print the scrape token for /metrics and telemetry ingest (--interop)

Console options
  --open                open the console in your browser, signed in
  --port <n>            the console's port, on 127.0.0.1 only (default ${DEFAULT_PORT})
  --report-port <n>     the port other machines join and report on (default: --port + 1)
  --listen <address>    where the reporting port listens, e.g. --listen 0.0.0.0.
                        Default ${BIND_ADDRESS}: this machine only. The console itself
                        is never on this port.
  --allow-public        accept reports from addresses outside private networks
  --allow-cgnat         also treat 100.64.0.0/10 as private (Tailscale, carrier-grade NAT)
  --demo                a synthetic team; reads nothing, accepts no machines
  --desktop-alerts      opt in to native desktop notifications for live alerts
  --alert-repeat <n>    repeated identical tool calls before alerting (default 5)
  --alert-spike-factor <n>  usage against session median (default 3)
  --alert-stall-minutes <n>  spending without tool success (default 5)
  --interop             local-only /metrics and telemetry ingest (off by default);
                        they take the token that metrics-token prints
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
