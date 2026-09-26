/**
 * The reporter: the small program a teammate runs so their machine shows up
 * on somebody's Agent Console.
 *
 *   join '<link>'     enrol this machine with a join link, then report
 *   report            keep reporting (after a restart)
 *   stop              stop a reporter running in the background, and keep the enrolment
 *   leave             stop, tell the console, and delete everything the enrolment left here
 *
 * One reporter runs per state directory, for its whole life: a lock file
 * with its process id, taken before it joins or reports and removed when it
 * exits. `stop` and `leave` find a running reporter through it.
 *
 * What it sends is decided in lib/collector/collector.js, not here: every
 * record passes the collector's allowlist, so only token counts, a model id, a
 * minute and hashes of the session and project leave this machine.
 *
 * The connection. A join link names the hub and carries the SHA-256
 * fingerprint of the hub's own TLS certificate. The reporter talks to the hub
 * over TLS and accepts that certificate only (lib/collector/pinned.js), so the
 * join code, the device token and every report are private on the way even on
 * a shared network, and a machine pretending to be the hub gets nothing.
 *
 * The credential. A join link carries a single-use code that expires within
 * the hour, never a long-lived secret. The reporter spends it once, and the hub
 * answers with a device token that goes straight into a private file here
 * (mode 600): never printed, never in a URL, never on a screen. Whoever runs
 * the console can revoke it at any time.
 *
 * Everything the hub sends back is checked before it is used or printed:
 * identifiers must have their exact shape (so none can steer a file path) and
 * text has control characters removed (so none can drive the terminal).
 */

import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSea } from "node:sea";
import { transcriptRoots, runOnce } from "./collector/collector.js";
import { createScanner } from "./collector/scanner.js";
import { firstDay } from "./hub/store.js";
import { endpoint } from "./collector/transport.js";
import { pinnedFetch, probeCertificate } from "./collector/pinned.js";
import { normalizeCode, labelProblem, TOKEN_PATTERN, DEVICE_ID_PATTERN, ORG_ID_PATTERN, LINK_CODE_PATTERN } from "./hub/registry.js";
import { FINGERPRINT_PATTERN } from "./hub/tls.js";
import { clearDeadLock } from "./hub/local.js";
import { createAlerts } from "./hub/alerts.js";
import { createActivityBook } from "./collector/activity.js";
import { createExtrasOutbox } from "./reporter-outbox.js";
import { productTitle } from "./brand.js";
import { invocation, shellArgument, REPOSITORY } from "./invocation.js";
import { REPORTER_SEARCH } from "./reporter-search.js";
import { closest } from "./config.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const DEFAULT_INTERVAL_S = 10;
/* Up to a minute between reports is "live" on the console; longer is
   "periodic", which the console allows two hours before calling it silent. */
const LIVE_INTERVAL_S = 60;
const PRIVACY = "Only token counts, model names, times and hashes leave this machine — never a prompt, a reply, a file path or file contents.";

export function help(cmd = invocation(VERSION)) {
  return `
${productTitle("reporter")}

  ${cmd} join '<join link>'
      enrol this machine, then keep reporting
  ${cmd} join <hub address> <code> --fingerprint <fingerprint>
      the same, typed by hand from what the console shows
  ${cmd} report
      keep reporting (uses the saved enrolment)
  ${cmd} stop
      stop a reporter running in the background; the enrolment stays
  ${cmd} leave
      stop reporting, take this machine off the console, and delete the
      enrolment from this machine

Options
  --name <text>          what to call this machine on the console (join only)
  --interval <seconds>   how often to report, 2 to 3600 (default ${DEFAULT_INTERVAL_S}). Over
                         ${LIVE_INTERVAL_S} the console shows the machine as reporting periodically.
  --background           keep reporting after this window closes; output goes to
                         reporter.log in the state directory (join and report)
  --once                 report once and exit
  --state-dir <path>     where the enrolment is kept (default ~/.agent-console/reporter)
  --home <path>          read this home directory's transcripts instead of your own
  --claude-root <path>   Claude Code transcripts (default <home>/.claude/projects)
  --codex-root <path>    Codex transcripts (default <home>/.codex/sessions)
  --share-project-names  off unless given, each time. Also send each project folder's
                         NAME (never its path) so the console can show "atlas-api"
                         instead of a hash. Run without it and names stop at once.
  --share-alerts         off unless given, each time. Also send the alerts this machine
                         raises (repeated tool call, burn spike, spending without a
                         tool success): the kind, the minute, a salted session hash and
                         one count. Without it the console says this machine is not watched.
  --share-tool-activity  off unless given, each time. Also send how many tool calls each
                         session made per minute, by kind (read, edit, shell, search,
                         web, agent, mcp, other), and how many results were errors.
                         Never a tool's name, arguments, output, a path or a server name.
  --json                 print one JSON line per event instead of sentences

${PRIVACY}
`;
}

/** Text from the hub, safe to print: no control characters, no terminal escapes, bounded. */
export function printable(value, max = 200) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

const BOOLEANS = new Set(["once", "json", "help", "h", "share-project-names", "share-alerts", "share-tool-activity", "background"]);
/** The options each command takes. Anything else is refused, never ignored. */
const OPTIONS = {
  join: ["name", "fingerprint", "interval", "once", "background", "state-dir", "home", "claude-root", "codex-root", "share-project-names", "share-alerts", "share-tool-activity", "json", "help", "h"],
  report: ["interval", "once", "background", "state-dir", "home", "claude-root", "codex-root", "share-project-names", "share-alerts", "share-tool-activity", "json", "help", "h"],
  stop: ["state-dir", "json", "help", "h"],
  leave: ["state-dir", "json", "help", "h"],
};
/** How many words each command takes before its options. */
const POSITIONAL = { join: [1, 2], report: [0, 0], stop: [0, 0], leave: [0, 0] };

export function parse(argv, command = "join") {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h") { flags.set("help", true); continue; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const allowed = OPTIONS[command] || OPTIONS.join;
    if (!allowed.includes(name)) {
      const elsewhere = Object.entries(OPTIONS).filter(([, list]) => list.includes(name)).map(([c]) => c);
      const near = elsewhere.length ? null : closest(name, allowed.filter((o) => o.length > 1));
      throw usage(elsewhere.length ? `--${name} applies to ${elsewhere.join(" and ")}, not ${command}.`
        : `--${name} is not an option of ${command}.${near ? ` Did you mean --${near}?` : " Run it with --help for the list."}`);
    }
    if (eq !== -1) { flags.set(name, BOOLEANS.has(name) ? !/^(false|0|no|off)$/iu.test(arg.slice(eq + 1)) : arg.slice(eq + 1)); continue; }
    if (BOOLEANS.has(name)) { flags.set(name, true); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw usage(`--${name} needs a value.`);
    flags.set(name, next);
    i += 1;
  }
  if (flags.get("help")) return { positional, flags };
  const [least, most] = POSITIONAL[command] || [0, 0];
  if (positional.length > most) {
    throw usage(command === "join" ? `join takes the link (or an address and a code), then options; "${positional[most]}" is extra. Put the link in single quotes.`
      : `${command} takes no link or address; "${positional[0]}" is extra.`);
  }
  if (positional.length < least && command !== "join") throw usage(`${command} needs more.`);
  if (flags.has("interval")) {
    const raw = String(flags.get("interval"));
    const value = Number(raw);
    if (!/^\d+$/u.test(raw) || value < 2 || value > 3600) throw usage(`--interval needs a whole number of seconds from 2 to 3600; got "${raw}".`);
  }
  if (flags.has("name")) {
    const problem = labelProblem(String(flags.get("name")));
    if (problem) throw usage(`--name cannot be used: ${problem}. A machine's name is 1 to 40 characters, without < > or control characters.`);
  }
  if (flags.get("background") && flags.get("once")) throw usage("--background and --once do not go together: --once reports once and exits.");
  return { positional, flags };
}

function usage(message) {
  return Object.assign(new Error(message), { usage: true });
}

/**
 * Reads a join link — http://<hub>:<port>/join#<code>.<fingerprint> — or a hub
 * address typed with its code and --fingerprint. Returns the hub's HTTPS
 * address, the code, and the certificate fingerprint to pin.
 */
export function parseJoinTarget(first, second, fingerprintFlag) {
  if (!first) throw usage(`Paste the join link you were sent, in single quotes, for example:\n  ${invocation(VERSION)} join 'http://192.168.1.20:6788/join#…'`);
  let raw = String(first).trim();
  // cmd.exe passes single quotes through as part of the argument.
  const quoted = /^'([^']*)'$|^"([^"]*)"$/u.exec(raw);
  if (quoted) raw = (quoted[1] ?? quoted[2]).trim();
  if (!/^https?:\/\//iu.test(raw)) raw = "http://" + raw;
  let url;
  try { url = new URL(raw); } catch { throw usage("That does not look like a join link or a hub address."); }
  const fragment = decodeURIComponent(url.hash.replace(/^#/u, ""));
  const [fromLink, fromLinkPrint] = fragment.split(".");
  let code = null;
  if (second) code = normalizeCode(second) || (LINK_CODE_PATTERN.test(second) ? second : null);
  else if (fromLink) code = LINK_CODE_PATTERN.test(fromLink) ? fromLink : normalizeCode(fromLink);
  if (!code) throw usage("The join code is missing or mistyped. Copy the whole link again, or the eight-character code the console shows (it looks like K7Q2-9XMA).");
  const fingerprint = String(fingerprintFlag || fromLinkPrint || "").replace(/[\s:]/gu, "");
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw usage("This link has no certificate fingerprint, so the console cannot be checked. Copy the whole link again from the console (it is long), or add --fingerprint with the value the console shows.");
  }
  if (!url.port) throw usage("The link has no port. Copy the whole link again from the console.");
  // url.hostname keeps the brackets of an IPv6 address.
  return { hub: `https://${url.hostname}:${url.port}`, code, fingerprint };
}

function stateDirOf(flags) {
  return path.resolve(String(flags.get("state-dir") || process.env.AGENT_CONSOLE_REPORTER_DIR || path.join(os.homedir(), ".agent-console", "reporter")));
}

function rootsOf(flags) {
  const given = flags.get("home") ? path.resolve(String(flags.get("home"))) : null;
  // CLAUDE_CONFIG_DIR and CODEX_HOME are this user's; a --home stands for another layout.
  return transcriptRoots({ home: given ?? os.homedir(), env: given ? {} : process.env,
    claudeRoot: flags.get("claude-root") ? path.resolve(String(flags.get("claude-root"))) : null,
    codexRoot: flags.get("codex-root") ? path.resolve(String(flags.get("codex-root"))) : null });
}

function credentialsFile(stateDir) {
  return path.join(stateDir, "credentials.json");
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

const SALT = (value) => typeof value === "string" && Buffer.from(value, "base64url").length === 32 && Buffer.from(value, "base64url").toString("base64url") === value;

/** A credentials object whose every identifier has its exact shape, or null. */
export function validCredentials(value) {
  return Boolean(value) && value.v === 2 && TOKEN_PATTERN.test(value.token)
    && typeof value.hub === "string" && /^https:\/\/[^/?#]+$/u.test(value.hub)
    && DEVICE_ID_PATTERN.test(value.deviceId) && ORG_ID_PATTERN.test(value.organizationId) && SALT(value.orgSalt)
    && FINGERPRINT_PATTERN.test(value.fingerprint) && typeof value.certificate === "string" && value.certificate.startsWith("-----BEGIN CERTIFICATE-----")
    && typeof value.label === "string" && value.label.length <= 80;
}

export function readCredentials(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(credentialsFile(stateDir), "utf8"));
    if (validCredentials(value)) return value;
  } catch { /* none yet */ }
  return null;
}

function createOutput(json) {
  const out = (line) => process.stdout.write(line + "\n");
  return {
    event(kind, fields, sentence) {
      if (json) out(JSON.stringify({ event: kind, at: new Date().toISOString(), ...fields }));
      else if (sentence) out(sentence);
    },
  };
}

const clock = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const n = (value) => Number(value || 0).toLocaleString("en-US");

/**
 * Why a report did not go through, in words a person can act on. The
 * transport keeps the last HTTP status on its error (null when nothing
 * answered), so "cannot reach the hub" is said only when that is what happened.
 */
export function failureReason(error, hub, { once = false } = {}) {
  const code = error && error.code ? String(error.code) : null;
  const status = error && Number.isInteger(error.status) ? error.status : null;
  const progress = error && error.progress && error.progress.total > error.progress.delivered
    ? ` — ${n(error.progress.delivered)} of ${n(error.progress.total)} records sent so far, and those are kept`
    : "";
  // With --once nothing is retried, so nothing says it will be.
  const again = once ? "; not retrying (--once)" : "; will keep trying";
  if (code === "certificate_mismatch" || /certificate/iu.test(String(error && error.message))) {
    return { kind: "certificate", text: `the machine at ${hub} answers with a different certificate, so it is not the console this one joined; nothing was sent${again}.\n           If that console was set up again from scratch, it has a new certificate: ask for a new join link.` };
  }
  if (code === "ingestion_unavailable" && status === 429) return { kind: "paced", text: `the hub is pacing uploads${progress}${once ? again : "; continuing shortly"}` };
  if (code === "ingestion_unavailable" && status !== null && status >= 500) return { kind: "hub-error", text: `the hub answered with an error (HTTP ${status})${progress}${again}` };
  if (code === "ingestion_unavailable" && status !== null) return { kind: "hub-busy", text: `the hub did not accept the upload yet (HTTP ${status})${progress}${again}` };
  if (!code || code === "ingestion_unavailable" || code === "retry_interrupted") return { kind: "unreachable", text: `cannot reach the hub at ${hub}${progress}${again}` };
  return { kind: "refused", text: `the hub did not accept this report (${printable(code, 40)}${status ? " " + status : ""})${again}.\n           If this persists, check that this machine and the hub run the same Agent Console version.` };
}

/** Prints a first scan or a catch-up as it goes, at most every few seconds. */
function progressPrinter(output, everyMs = 3000) {
  let lastAt = 0, lastKey = "";
  return (p) => {
    const now = Date.now();
    const done = p.phase === "deliver" ? p.delivered >= p.total : p.files >= p.filesTotal;
    const key = JSON.stringify(p);
    if (key === lastKey || (!done && now - lastAt < everyMs)) return;
    // Small, quick runs say nothing: only a scan or upload worth waiting for is narrated.
    if (p.phase === "scan" && p.filesTotal < 50) return;
    if (p.phase === "deliver" && p.total <= 500) return;
    lastAt = now; lastKey = key;
    if (p.phase === "scan") {
      output.event("progress", { phase: "scan", files: p.files, filesTotal: p.filesTotal, records: p.records },
        `  ${clock()}  reading this machine's transcripts · ${n(p.files)} of ${n(p.filesTotal)} files · ${n(p.records)} records`);
    } else {
      output.event("progress", { phase: "deliver", delivered: p.delivered, total: p.total },
        `  ${clock()}  ${done ? "caught up" : "catching up"} · sent ${n(p.delivered)} of ${n(p.total)} records`);
    }
  };
}

/** True when an Agent Console's own (sign-in) port answers at this address: not where machines join. */
async function isConsolePort(hub) {
  try {
    const url = new URL(hub);
    const r = await fetch(`http://${url.host}/api/hello`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    const body = r.ok ? await r.json() : null;
    return Boolean(body && body.product === "Agent Console");
  } catch { return false; }
}

/** Spends the join code over the pinned connection, and checks the answer's every field. */
async function exchange(target, name, previous = null) {
  let certificate;
  try {
    certificate = await probeCertificate(target.hub, target.fingerprint);
  } catch (error) {
    if (error.code === "certificate_mismatch") {
      throw new Error(`The machine at ${target.hub} is not the console that made this link: its certificate does not match.\n  Nothing was sent. Ask for a new link, and check the address in it.`);
    }
    if (await isConsolePort(target.hub)) {
      throw Object.assign(new Error(`${target.hub} is the console's own port, which only its own computer uses.\n  Machines join on its reporting port: the one in the join link. Copy the whole link again.`), { usage: true });
    }
    throw new Error(`Could not reach the console at ${target.hub}.\n  Check that the console is still running, that it was started with --listen 0.0.0.0,\n  that this machine is on the same network, and that the address and port are the ones in the link.`);
  }
  const fetchPinned = pinnedFetch({ certificate, fingerprint: target.fingerprint });
  let response;
  try {
    response = await fetchPinned(endpoint(target.hub + "/api/join"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `previous` is this machine's current token for the same console (same
      // pinned certificate): the proof that lets it keep its entry and history.
      body: JSON.stringify({ code: target.code, ...(name ? { name } : {}), ...(previous ? { previous } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Could not reach the console at ${target.hub}.`);
  }
  let body = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new Error(printable(body && body.reason) || `The console refused the join (${response.status}).`);
  const device = body && body.device;
  if (!body || !TOKEN_PATTERN.test(body.token) || !device || !DEVICE_ID_PATTERN.test(device.id)
    || !ORG_ID_PATTERN.test(body.organizationId) || !SALT(body.orgSalt)
    || !(Number.isInteger(body.retentionDays) && body.retentionDays >= 1 && body.retentionDays <= 90)) {
    throw new Error("The answer was not a valid join. Is that address really an Agent Console of the same version?");
  }
  return { body, certificate };
}

function enrolmentDir(stateDir, deviceId) {
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("The saved enrolment is not valid. Join again with a new link.");
  return path.join(stateDir, "devices", deviceId);
}

function writeEnrolment(stateDir, credentials) {
  const directory = enrolmentDir(stateDir, credentials.deviceId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writePrivate(path.join(directory, "enrollment.json"), {
    v: 1,
    organizationId: credentials.organizationId,
    device: { id: credentials.deviceId, label: credentials.label },
    orgSalt: credentials.orgSalt,
  });
  // This machine's own key for project hashes: the hub never has it.
  const keyFile = path.join(directory, "project.key");
  let projectKey;
  try { projectKey = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64url"); } catch { /* first run */ }
  if (!projectKey || projectKey.length !== 32) {
    projectKey = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, projectKey.toString("base64url") + "\n", { mode: 0o600 });
  }
  return { directory, projectKey };
}

/**
 * The one opt-in: a project folder's last name, reduced to [a-z0-9-], written
 * into the collector's own labels.json so it travels as the record's
 * `engagement` label. Off unless --share-project-names is passed on this run;
 * the path, the branch and everything else stay on this machine either way.
 */
export function projectLabel(cwd) {
  const base = String(cwd || "").replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || "";
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48).replace(/-+$/u, "");
  const label = /^[a-z]/u.test(slug) ? slug : slug ? "p-" + slug.slice(0, 46) : "";
  return /^[a-z][a-z0-9-]{1,47}$/u.test(label) ? label : null;
}

function labelWriter(directory) {
  const file = path.join(directory, "labels.json");
  let labels = {};
  try { labels = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { /* created by the collector */ }
  let dirty = false;
  return {
    hook: ({ projectHash, cwd }) => {
      if (!projectHash || labels[projectHash]) return;
      const label = projectLabel(cwd);
      if (label) { labels[projectHash] = label; dirty = true; }
    },
    save: () => { if (dirty) { writePrivate(file, labels); dirty = false; } },
  };
}

// ---------------------------------------------------------------------------
// One reporter per state directory, for its whole life
// ---------------------------------------------------------------------------

const lockFile = (stateDir) => path.join(stateDir, "reporter.lock");

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/* A reporter touches its lock this often, so a lock nobody touches is stale. */
const LOCK_BEAT_MS = 10_000;
const LOCK_FRESH_MS = 60_000;

/**
 * True only when the process named in a lock is really an Agent Console
 * reporter. A reporter that died without its exit handler (killed, a power
 * cut, Windows) leaves its process id behind, and the system can give that id
 * to anything. Where `ps` exists the process's command must be Agent
 * Console's; elsewhere the lock must have been touched in the last minute.
 */
function confirmedReporter(pid, file, { ps = spawnSync } = {}) {
  if (!alive(pid)) return false;
  const answer = ps("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (!answer.error && answer.status === 0 && typeof answer.stdout === "string" && answer.stdout.trim()) {
    return /agent-console/iu.test(answer.stdout);
  }
  // No usable `ps` here (Windows, a minimal system): the lock's heartbeat decides.
  try { return Date.now() - fs.statSync(file).mtimeMs < LOCK_FRESH_MS; } catch { return false; }
}

/** The process id of the reporter holding this state directory, or null. */
export function runningReporter(stateDir) {
  let pid;
  const file = lockFile(stateDir);
  try { pid = JSON.parse(fs.readFileSync(file, "utf8")).pid; } catch { return null; }
  if (pid === process.pid) return null;
  return confirmedReporter(pid, file) ? pid : null;
}

/**
 * Takes the reporter lock for this process's lifetime, or throws `locked`
 * with the holder's process id. A lock left by a reporter that crashed is
 * cleared. Released when the process exits, however it exits.
 */
export function takeReporterLock(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = lockFile(stateDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
      const beat = setInterval(() => {
        try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* released */ }
      }, LOCK_BEAT_MS);
      beat.unref();
      const release = () => {
        clearInterval(beat);
        try { if (JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid) fs.unlinkSync(file); } catch { /* gone already */ }
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = runningReporter(stateDir);
      if (holder) throw Object.assign(new Error("locked"), { code: "locked", pid: holder });
      try { fs.unlinkSync(file); } catch { /* raced another start */ }
    }
  }
  throw Object.assign(new Error("locked"), { code: "locked", pid: null });
}

/** Asks a running reporter to stop, and waits up to a few seconds for it to go. */
async function stopReporter(pid, waitMs = 6000) {
  try { process.kill(pid, "SIGTERM"); } catch { return !alive(pid); }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

// ---------------------------------------------------------------------------
// Finding the console again after its reporting port moved
// ---------------------------------------------------------------------------

/**
 * The console's reporting port moved (it restarted with another
 * --report-port, or its usual port was busy): look for the same pinned
 * certificate on the ports either side. Only a TLS handshake is made; a port
 * that answers with any other certificate is passed over and is sent nothing.
 * Returns the new https://host:port, or null.
 */
export async function findMovedHub(hub, fingerprint, { span = REPORTER_SEARCH, probe = probeCertificate } = {}) {
  const url = new URL(hub);
  const port = Number(url.port);
  const candidates = [];
  for (let d = 1; d <= span; d += 1) for (const p of [port - d, port + d]) if (p > 0 && p <= 65_535) candidates.push(p);
  const found = await Promise.all(candidates.map(async (p) => {
    const next = `https://${url.hostname}:${p}`;
    try { await probe(next, fingerprint, { timeoutMs: 2000 }); return next; } catch { return null; }
  }));
  return found.find(Boolean) || null;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const FIND_EVERY_MS = 5 * 60_000;

/**
 * The opt-in extras a reporter sends beside its records: its alerts
 * (--share-alerts) and its tool activity (--share-tool-activity), each counts,
 * enums, minutes and salted hashes only (lib/collector/transport.js). Alerts
 * raised while the first pass reads the backlog are marked historical.
 * `share` is said on every envelope, so the console knows what this run
 * covers; `journal` keeps what is pending in the collector's cursor file
 * until the console acknowledges it (lib/reporter-outbox.js).
 */
export function reporterExtras({ shareAlerts = false, shareToolActivity = false, now = () => Date.now() } = {}) {
  let caughtUp = false;
  const share = { alerts: shareAlerts ? "on" : "off", activity: shareToolActivity ? "on" : "off" };
  const alerts = shareAlerts ? createAlerts({ now, live: () => caughtUp }) : null;
  const activity = shareToolActivity ? createActivityBook({ now }) : null;
  if (!alerts && !activity) return { share, onTranscriptLine: null, journal: null, outbox: null, caughtUp() {} };
  const box = createExtrasOutbox({ alerts, activity, now });
  return {
    share,
    onTranscriptLine(args) { alerts?.observeLine(args); activity?.observeLine(args); },
    journal: box.journal,
    outbox: {
      // Taken once a pass has read every transcript: from here on, what is read is new.
      take: () => {
        const out = box.take();
        caughtUp = true;
        return out;
      },
      ack: () => box.ack(),
      saved: () => box.saved(),
    },
    caughtUp() { caughtUp = true; },
  };
}

async function reportLoop({ credentials, stateDir, roots, intervalS, once, output, shareProjectNames = false, shareAlerts = false, shareToolActivity = false }) {
  const { directory, projectKey } = writeEnrolment(stateDir, credentials);
  clearDeadLock(directory);
  const labels = shareProjectNames ? labelWriter(directory) : null;
  const extras = reporterExtras({ shareAlerts, shareToolActivity });
  const scanner = createScanner();
  let backfillSettled = false;
  const token = process.env.AGENT_CONSOLE_TOKEN || credentials.token;
  const retentionMs = Math.max(1, Number(credentials.retentionDays) || 8) * 86_400_000;
  const fetchPinned = pinnedFetch({ certificate: credentials.certificate, fingerprint: credentials.fingerprint });
  const cmd = invocation(VERSION);
  let stopping = false;
  let reachable = null;
  let lastReason = null;
  let lastSearch = 0;
  let waitMs = intervalS * 1000;
  const onProgress = progressPrinter(output);
  let stoppedBy = null;
  const stop = (signal) => { stopping = true; stoppedBy ??= signal; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const stopped = () => {
    // `stop` in another window sends SIGTERM: say so here, where the output was.
    if (stoppedBy === "SIGTERM") output.event("stopped", { by: "signal" }, `  ${clock()}  stopped from another window (\`stop\` or \`leave\`).`);
  };

  for (;;) {
    // `leave` in another window deletes the enrolment: this reporter stops
    // instead of retrying with a credential that no longer exists.
    if (!fs.existsSync(credentialsFile(stateDir))) {
      output.event("left", {}, `\n  This machine left the console (the enrolment was deleted), so this reporter stops.\n`);
      return;
    }
    try {
      const result = await runOnce({
        directory, roots, token,
        post: credentials.hub + "/api/ingest",
        // Reports a minute apart or closer are "live" on the console; slower
        // ones are "periodic", so a machine reporting every ten minutes is
        // not called silent between its reports.
        watch: intervalS <= LIVE_INTERVAL_S,
        compact: true,
        sinceMs: Date.now() - retentionMs,
        // The first delivery goes back the console's 30 days, and says so (lib/hub/store.js);
        // asked until a run completes.
        ...(backfillSettled ? {} : { backfillFromMs: Date.parse(firstDay(Date.now()) + "T00:00:00Z") }),
        // Walks every transcript once a minute, and between walks only what can be changing.
        scanner,
        onProgress,
        shareLabels: shareProjectNames,
        projectKey,
        transport: { fetch: fetchPinned },
        ...(labels ? { onLocalLabel: labels.hook } : {}),
        share: extras.share,
        ...(extras.onTranscriptLine ? { onTranscriptLine: extras.onTranscriptLine, journal: extras.journal, outbox: extras.outbox } : {}),
      });
      extras.caughtUp();
      backfillSettled = true;
      if (labels) labels.save();
      if (reachable === false) output.event("reconnected", {}, `  ${clock()}  the hub is taking reports again`);
      reachable = true;
      lastReason = null;
      waitMs = intervalS * 1000;
      const r = result.receipt || { accepted: 0, duplicate: 0, expired: 0 };
      if (result.emitted > 0) {
        output.event("sync", { sent: result.emitted, accepted: r.accepted, duplicate: r.duplicate, expired: r.expired ?? 0 },
          `  ${clock()}  sent ${n(result.emitted)} record${result.emitted === 1 ? "" : "s"}` +
          (r.duplicate ? ` (${n(r.duplicate)} already on the hub)` : ""));
      } else {
        output.event("heartbeat", {}, null);
      }
      if (result.coverage && result.coverage.sourcesAvailable === 0) {
        output.event("no-sources", {}, reachable === true && !reportLoop.warned
          ? "  No Claude Code or Codex transcripts were found on this machine yet. The console will show it as reporting, with no usage."
          : null);
        reportLoop.warned = true;
      }
    } catch (error) {
      if (error && error.code === "ingestion_refused" && (error.status === 401 || error.status === 403)) {
        output.event("revoked", { status: error.status },
          `\n  The hub no longer accepts this machine — it was removed from the console.\n  Ask for a new join link, then run: ${cmd} join '<link>'\n`);
        process.exitCode = 3;
        return;
      }
      if (/locked/iu.test(String(error && error.message))) {
        output.event("locked", {}, "\n  Another reporter is already running for this machine. Leave that one running, or stop it first.\n");
        process.exitCode = 4;
        return;
      }
      const code = error && error.code ? String(error.code) : null;
      const reason = failureReason(error, credentials.hub, { once });
      reachable = false;
      // Nothing answers where it joined, or something else does: the console
      // may have moved its reporting port. Look nearby, now and then (and
      // once, for --once), before saying anything.
      if ((reason.kind === "unreachable" || reason.kind === "certificate") && lastSearch >= 0 && Date.now() - lastSearch >= FIND_EVERY_MS) {
        lastSearch = once ? -1 : Date.now();
        const moved = await findMovedHub(credentials.hub, credentials.fingerprint);
        if (moved && moved !== credentials.hub) {
          output.event("moved", { from: credentials.hub, to: moved }, `  ${clock()}  the console now takes reports at ${moved}; reporting there`);
          credentials.hub = moved;
          writePrivate(credentialsFile(stateDir), credentials);
          lastReason = null;
          waitMs = 1000;
          continue;
        }
      }
      // Said once per distinct reason, not every retry.
      if (reason.text !== lastReason) {
        output.event(reason.kind, { code, status: error && Number.isInteger(error.status) ? error.status : null,
          ...(error && error.progress ? { delivered: error.progress.delivered, total: error.progress.total } : {}) },
          `  ${clock()}  ${reason.text}`);
        lastReason = reason.text;
      }
      if (once) { process.exitCode = 5; return; }
      // Paced by the hub: come straight back (the hub named its wait and it has
      // passed). Anything else backs off, up to a minute.
      waitMs = reason.kind === "paced" ? 1000 : Math.min(60_000, waitMs * 2);
    }
    if (once) return;
    if (stopping) { stopped(); return; }
    // Jittered, so a room full of machines started together does not report in step.
    const pause = waitMs * (0.8 + Math.random() * 0.4);
    const until = Date.now() + pause;
    while (!stopping && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(500, until - Date.now())));
    if (stopping) { stopped(); return; }
  }
}

/** The options a later `report` needs to read and keep the same things this run does. */
const SHARE_FLAGS = ["share-project-names", "share-alerts", "share-tool-activity"];
function carriedArgs(flags, names = ["state-dir", "home", "claude-root", "codex-root", "interval", ...SHARE_FLAGS]) {
  const out = [];
  for (const name of names) {
    if (!flags.has(name) || flags.get(name) === false) continue;
    if (SHARE_FLAGS.includes(name)) out.push("--" + name);
    else out.push("--" + name, name === "interval" ? String(flags.get(name)) : path.resolve(String(flags.get(name))));
  }
  return out;
}
/** The same, quoted for a shell. */
export function carriedOptions(flags, names, platform = process.platform) {
  return carriedArgs(flags, names).map((value) => /^[A-Za-z0-9_./:=@%+-]+$/u.test(value) ? value : shellArgument(value, platform));
}

function announce(output, credentials, intervalS, joined, flags, background = false) {
  const again = [invocation(VERSION), "report", ...carriedOptions(flags)].join(" ");
  const shareProjectNames = Boolean(flags.get("share-project-names"));
  const once = Boolean(flags.get("once"));
  const every = once ? "once, then this command exits"
    : intervalS <= LIVE_INTERVAL_S ? `every ${intervalS} seconds` : `every ${Math.round(intervalS / 60 * 10) / 10} minutes (the console shows it as reporting periodically)`;
  output.event(joined ? "joined" : "resumed", {
    hub: credentials.hub, device: { id: credentials.deviceId, label: credentials.label, person: credentials.person || null },
    intervalSeconds: intervalS, mode: intervalS <= LIVE_INTERVAL_S ? "live" : "periodic", command: again,
  }, [
    "",
    `  ${productTitle("reporter")}`,
    `  ${joined ? "Joined" : "Reporting to"} ${credentials.hub} as “${printable(credentials.label, 80)}”${credentials.person ? ` for ${printable(credentials.person, 80)}` : ""}.`,
    `  Reporting this machine's Claude Code and Codex usage ${every}, over TLS to that console only.`,
    `  ${PRIVACY}`,
    shareProjectNames ? "  You chose --share-project-names: each project folder's name (not its path) is sent as its label." : null,
    flags.get("share-alerts") ? "  You chose --share-alerts: the alerts this machine raises are sent as a kind, a minute, a salted hash and a count." : null,
    flags.get("share-tool-activity") ? "  You chose --share-tool-activity: tool calls are sent as counts per minute by kind; never a tool's name, arguments or output." : null,
    background || once ? null : `  Leave this window open. Ctrl+C stops; to start again later:`,
    once ? `  To keep reporting, run it without --once:` : null,
    background ? null : `    ${again}`,
    background || once ? null : `  To keep reporting without a window open, add --background; to start at login, see ${REPOSITORY}/blob/main/docs/BACKGROUND.md`,
    "",
  ].filter((line) => line !== null).join("\n"));
}

/** Deletes what an enrolment left on this machine: credentials, key, salt, labels, spool and cursor. */
function forget(stateDir) {
  fs.rmSync(credentialsFile(stateDir), { force: true });
  fs.rmSync(path.join(stateDir, "devices"), { recursive: true, force: true });
  fs.rmSync(path.join(stateDir, "reporter.log"), { force: true });
  // A lock whose reporter is gone (Windows ends a process without its exit handlers).
  let holder = null;
  try { holder = JSON.parse(fs.readFileSync(lockFile(stateDir), "utf8")).pid; } catch { /* no lock */ }
  if (holder !== null && holder !== process.pid && !confirmedReporter(holder, lockFile(stateDir))) fs.rmSync(lockFile(stateDir), { force: true });
}

/**
 * The arguments that start `report` again in a new process of this runtime.
 * Under node that is the script, then the command. A standalone executable
 * already carries its entry (packaging/sea/main.cjs), so it is given the
 * command first: an entry path there would stand where the command goes.
 */
export function backgroundArgs(carried, { sea = isSea(), entry = process.argv[1] } = {}) {
  return sea ? ["report", ...carried] : [entry, "report", ...carried];
}

/**
 * Starts `report` as a detached process that outlives this window, with the
 * same options, writing to reporter.log in the state directory. Returns its
 * process id once it holds the reporter lock, or throws with the log's end.
 */
async function startInBackground(stateDir, flags) {
  const log = path.join(stateDir, "reporter.log");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(log, "a", 0o600);
  const child = spawn(process.execPath, backgroundArgs(carriedArgs(flags)), {
    detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env: process.env,
  });
  child.unref();
  fs.closeSync(fd);
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    if (runningReporter(stateDir) === child.pid) return child.pid;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let tail = "";
  try { tail = fs.readFileSync(log, "utf8").split("\n").slice(-6).join("\n"); } catch { /* none */ }
  throw new Error("The background reporter did not start." + (tail.trim() ? "\n" + tail.trim() : ""));
}

/** Tells the console this machine is leaving, over the pinned connection. Best effort. */
async function tellConsole(credentials) {
  try {
    const fetchPinned = pinnedFetch({ certificate: credentials.certificate, fingerprint: credentials.fingerprint });
    const response = await fetchPinned(endpoint(credentials.hub + "/api/leave"), {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.AGENT_CONSOLE_TOKEN || credentials.token}` },
      signal: AbortSignal.timeout(5000),
    });
    return response.status === 200 ? "told" : response.status === 401 ? "already-removed" : "not-told";
  } catch {
    return "not-told";
  }
}

export async function main(command, argv) {
  const json = argv.includes("--json");
  const output = createOutput(json);
  const fail = (error, exitCode) => {
    // Under --json, a failure is a JSON line too, so a program can read it.
    const message = String(error && error.message).split("\n").map((line) => printable(line, 300)).join("\n  ");
    if (json) process.stdout.write(JSON.stringify({ event: "error", at: new Date().toISOString(), kind: exitCode === 2 ? "usage" : error && error.code === "locked" ? "locked" : "failed", message: message.replace(/\n  /gu, " ") }) + "\n");
    else process.stderr.write("\n  " + message + "\n\n");
    process.exitCode = exitCode;
  };
  let parsed;
  try { parsed = parse(argv, command); } catch (error) { fail(error, 2); return; }
  const { positional, flags } = parsed;
  if (flags.get("help") || flags.get("h")) { process.stdout.write(help()); return; }
  const stateDir = stateDirOf(flags);
  const intervalS = flags.has("interval") ? Number(flags.get("interval")) : DEFAULT_INTERVAL_S;
  const once = Boolean(flags.get("once"));
  const cmd = invocation(VERSION);

  try {
    if (command === "stop") {
      const pid = runningReporter(stateDir);
      const stopped = pid ? await stopReporter(pid) : false;
      output.event("stopped", { pid: pid || null, stopped }, pid
        ? stopped ? `\n  Stopped the reporter (process ${pid}). This machine stays enrolled; \`report\` starts it again.\n`
          : `\n  Asked the reporter (process ${pid}) to stop, but it is still running.\n`
        : "\n  No reporter is running for this state directory.\n");
      if (pid && !stopped) process.exitCode = 1;
      return;
    }

    if (command === "leave") {
      const existing = readCredentials(stateDir);
      // Stop a reporter running in another window or in the background first,
      // so it does not write into what is about to be deleted.
      const pid = runningReporter(stateDir);
      if (pid) await stopReporter(pid);
      const told = existing ? await tellConsole(existing) : null;
      forget(stateDir);
      const lines = existing ? [
        "",
        `  Deleted this machine's enrolment with ${existing.hub}. Nothing more will be sent.`,
        pid ? `  Stopped the reporter that was running (process ${pid}).` : null,
        told === "told" ? "  The console was told, and shows this machine as having left; what it already received stays there."
          : told === "already-removed" ? "  The console had already removed this machine."
          : "  The console could not be reached to be told, so it will show this machine as silent until it is removed there.",
        "",
      ] : ["", "  This machine is not enrolled with any console. Nothing was left to delete.", ""];
      output.event("left", { hub: existing ? existing.hub : null, told, stoppedReporter: pid || null }, lines.filter((l) => l !== null).join("\n"));
      return;
    }

    // One reporter per state directory, from before the join to exit.
    let release;
    try { release = takeReporterLock(stateDir); } catch (error) {
      if (error.code !== "locked") throw error;
      output.event("locked", { pid: error.pid }, `\n  Another reporter is already running for this machine${error.pid ? ` (process ${error.pid})` : ""}.\n  Leave that one running, or stop it first: ${[cmd, "stop", ...carriedOptions(flags, ["state-dir"])].join(" ")}\n`);
      process.exitCode = 4;
      return;
    }

    let credentials;
    if (command === "join") {
      const target = parseJoinTarget(positional[0], positional[1], flags.get("fingerprint"));
      // Joining the same console again (same pinned certificate) proves this
      // machine's current token, so the console keeps its entry and history.
      const existing = readCredentials(stateDir);
      const same = existing && existing.fingerprint === target.fingerprint ? existing : null;
      const { body, certificate } = await exchange(target, flags.get("name") ? String(flags.get("name")) : null, same ? same.token : null);
      const kept = Boolean(same && body.reattached === true && body.device.id === same.deviceId);
      // A new enrolment replaces the old one entirely; the same one keeps its key and cursor.
      if (kept) fs.rmSync(credentialsFile(stateDir), { force: true });
      else forget(stateDir);
      credentials = {
        v: 2,
        hub: target.hub,
        fingerprint: target.fingerprint,
        certificate,
        token: body.token,
        deviceId: body.device.id,
        label: printable(body.device.label, 80) || "This machine",
        person: body.device.person ? printable(body.device.person, 80) : null,
        organizationId: body.organizationId,
        orgSalt: body.orgSalt,
        retentionDays: body.retentionDays,
        joinedAt: new Date().toISOString(),
      };
      writePrivate(credentialsFile(stateDir), credentials);
      if (kept) output.event("rejoined", { deviceId: credentials.deviceId }, `\n  This machine was already on that console: it keeps its entry and history as “${printable(credentials.label, 80)}”.`);
      else if (body.reattached === true) output.event("rejoined", { deviceId: credentials.deviceId }, `\n  The console brought back the entry “${printable(credentials.label, 80)}” that left earlier, with its history.`);
      const renamed = body.renamed && typeof body.renamed === "object" ? body.renamed : null;
      if (renamed) {
        output.event("renamed", { asked: printable(renamed.asked, 80), used: credentials.label, reason: printable(renamed.reason, 120) },
          `\n  The console could not use the name “${printable(renamed.asked, 80)}” (${printable(renamed.reason, 120)}); it calls this machine “${credentials.label}”.`);
      }
      announce(output, credentials, intervalS, true, flags, Boolean(flags.get("background")));
    } else {
      credentials = readCredentials(stateDir);
      if (!credentials) throw usage(`This machine has not joined a console yet (or joined one older than this version). Open the join link you were sent, or run:\n  ${cmd} join '<join link>'`);
      announce(output, credentials, intervalS, false, flags, Boolean(flags.get("background")));
    }
    if (flags.get("background")) {
      release();
      const pid = await startInBackground(stateDir, flags);
      output.event("background", { pid, log: path.join(stateDir, "reporter.log") }, [
        `  Reporting in the background (process ${pid}); this window can close.`,
        `  Its output goes to ${path.join(stateDir, "reporter.log")}.`,
        `  Stop it with: ${[cmd, "stop", ...carriedOptions(flags, ["state-dir"])].join(" ")}`,
        `  It does not start again after a restart of this computer; to start it at login (launchd, systemd, Task Scheduler), see`,
        `  ${REPOSITORY}/blob/main/docs/BACKGROUND.md`,
        "",
      ].join("\n"));
      return;
    }
    await reportLoop({ credentials, stateDir, roots: rootsOf(flags), intervalS, once, output,
      shareProjectNames: Boolean(flags.get("share-project-names")),
      shareAlerts: Boolean(flags.get("share-alerts")), shareToolActivity: Boolean(flags.get("share-tool-activity")) });
  } catch (error) {
    fail(error, error && error.usage ? 2 : 1);
  }
}
