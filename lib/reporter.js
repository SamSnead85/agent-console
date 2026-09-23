/**
 * The reporter: the small program a teammate runs so their machine shows up
 * on somebody's Agent Console.
 *
 *   join "<link>"     enrol this machine with a join link, then report
 *   report            keep reporting (after a restart)
 *   leave             stop, and delete everything the enrolment left here
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRoots, runOnce } from "./collector/collector.js";
import { endpoint } from "./collector/transport.js";
import { pinnedFetch, probeCertificate } from "./collector/pinned.js";
import { normalizeCode, TOKEN_PATTERN, DEVICE_ID_PATTERN, ORG_ID_PATTERN, LINK_CODE_PATTERN } from "./hub/registry.js";
import { FINGERPRINT_PATTERN } from "./hub/tls.js";
import { clearDeadLock } from "./hub/local.js";
import { productTitle } from "./brand.js";
import { invocation } from "./invocation.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const DEFAULT_INTERVAL_S = 10;
const PRIVACY = "Only token counts, model names, times and hashes leave this machine — never a prompt, a reply, a file path or file contents.";

export function help(cmd = invocation(VERSION)) {
  return `
${productTitle("reporter")}

  ${cmd} join "<join link>"
      enrol this machine, then keep reporting
  ${cmd} join <hub address> <code> --fingerprint <fingerprint>
      the same, typed by hand from what the console shows
  ${cmd} report
      keep reporting (uses the saved enrolment)
  ${cmd} leave
      stop reporting and delete the enrolment from this machine

Options
  --name <text>          what to call this machine on the console (join only)
  --interval <seconds>   how often to report (default ${DEFAULT_INTERVAL_S})
  --once                 report once and exit
  --state-dir <path>     where the enrolment is kept (default ~/.agent-console/reporter)
  --home <path>          read this home directory's transcripts instead of your own
  --claude-root <path>   Claude Code transcripts (default <home>/.claude/projects)
  --codex-root <path>    Codex transcripts (default <home>/.codex/sessions)
  --share-project-names  off unless given, each time. Also send each project folder's
                         NAME (never its path) so the console can show "atlas-api"
                         instead of a hash. Run without it and names stop at once.
  --json                 print one JSON line per event instead of sentences

${PRIVACY}
`;
}

/** Text from the hub, safe to print: no control characters, no terminal escapes, bounded. */
export function printable(value, max = 200) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

function parse(argv) {
  const positional = [];
  const flags = new Map();
  const booleans = new Set(["once", "json", "help", "h", "share-project-names"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const eq = arg.indexOf("=");
    if (eq !== -1) { flags.set(arg.slice(2, eq), arg.slice(eq + 1)); continue; }
    const name = arg.slice(2);
    if (booleans.has(name)) { flags.set(name, true); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw usage(`--${name} needs a value.`);
    flags.set(name, next);
    i += 1;
  }
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
  if (!first) throw usage(`Paste the join link you were sent, in quotes, for example:\n  ${invocation(VERSION)} join "http://192.168.1.20:6788/join#…"`);
  let raw = String(first).trim();
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
  const home = flags.get("home") ? path.resolve(String(flags.get("home"))) : os.homedir();
  const roots = defaultRoots(home);
  if (flags.get("claude-root")) roots[0].directory = path.resolve(String(flags.get("claude-root")));
  if (flags.get("codex-root")) roots[1].directory = path.resolve(String(flags.get("codex-root")));
  return roots;
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
export function failureReason(error, hub) {
  const code = error && error.code ? String(error.code) : null;
  const status = error && Number.isInteger(error.status) ? error.status : null;
  const progress = error && error.progress && error.progress.total > error.progress.delivered
    ? ` — ${n(error.progress.delivered)} of ${n(error.progress.total)} records sent so far, and those are kept`
    : "";
  if (/certificate/iu.test(String(error && error.message))) return { kind: "certificate", text: `the machine at ${hub} is not the console this one joined (its certificate changed); nothing was sent` };
  if (code === "ingestion_unavailable" && status === 429) return { kind: "paced", text: `the hub is pacing uploads${progress}; continuing shortly` };
  if (code === "ingestion_unavailable" && status !== null && status >= 500) return { kind: "hub-error", text: `the hub answered with an error (HTTP ${status})${progress}; will keep trying` };
  if (code === "ingestion_unavailable" && status !== null) return { kind: "hub-busy", text: `the hub did not accept the upload yet (HTTP ${status})${progress}; will keep trying` };
  if (!code || code === "ingestion_unavailable" || code === "retry_interrupted") return { kind: "unreachable", text: `cannot reach the hub at ${hub}${progress}; will keep trying` };
  return { kind: "refused", text: `the hub did not accept this report (${printable(code, 40)}${status ? " " + status : ""}) — will keep trying.\n           If this persists, check that this machine and the hub run the same Agent Console version.` };
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

/** Spends the join code over the pinned connection, and checks the answer's every field. */
async function exchange(target, name) {
  let certificate;
  try {
    certificate = await probeCertificate(target.hub, target.fingerprint);
  } catch (error) {
    if (error.code === "certificate_mismatch") {
      throw new Error(`The machine at ${target.hub} is not the console that made this link: its certificate does not match.\n  Nothing was sent. Ask for a new link, and check the address in it.`);
    }
    throw new Error(`Could not reach the console at ${target.hub}.\n  Check that this machine is on the same network, and that the console was started with --listen.`);
  }
  const fetchPinned = pinnedFetch({ certificate, fingerprint: target.fingerprint });
  let response;
  try {
    response = await fetchPinned(endpoint(target.hub + "/api/join"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: target.code, ...(name ? { name } : {}) }),
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

async function reportLoop({ credentials, stateDir, roots, intervalS, once, output, shareProjectNames = false }) {
  const { directory, projectKey } = writeEnrolment(stateDir, credentials);
  clearDeadLock(directory);
  const labels = shareProjectNames ? labelWriter(directory) : null;
  const token = process.env.AGENT_CONSOLE_TOKEN || credentials.token;
  const retentionMs = Math.max(1, Number(credentials.retentionDays) || 8) * 86_400_000;
  const fetchPinned = pinnedFetch({ certificate: credentials.certificate, fingerprint: credentials.fingerprint });
  const cmd = invocation(VERSION);
  let stopping = false;
  let reachable = null;
  let lastReason = null;
  let waitMs = intervalS * 1000;
  const onProgress = progressPrinter(output);
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  for (;;) {
    try {
      const result = await runOnce({
        directory, roots, token,
        post: credentials.hub + "/api/ingest",
        watch: true,
        compact: true,
        sinceMs: Date.now() - retentionMs,
        onProgress,
        shareLabels: shareProjectNames,
        projectKey,
        transport: { fetch: fetchPinned },
        ...(labels ? { onLocalLabel: labels.hook } : {}),
      });
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
          `\n  The hub no longer accepts this machine — it was removed from the console.\n  Ask for a new join link, then run: ${cmd} join "<link>"\n`);
        process.exitCode = 3;
        return;
      }
      if (/locked/iu.test(String(error && error.message))) {
        output.event("locked", {}, "\n  Another reporter is already running for this machine. Leave that one running, or stop it first.\n");
        process.exitCode = 4;
        return;
      }
      const code = error && error.code ? String(error.code) : null;
      const reason = failureReason(error, credentials.hub);
      // Said once per distinct reason, not every retry.
      if (reason.text !== lastReason) {
        output.event(reason.kind, { code, status: error && Number.isInteger(error.status) ? error.status : null,
          ...(error && error.progress ? { delivered: error.progress.delivered, total: error.progress.total } : {}) },
          `  ${clock()}  ${reason.text}`);
        lastReason = reason.text;
      }
      reachable = false;
      // Paced by the hub: come straight back (the hub named its wait and it has
      // passed). Anything else backs off, up to a minute.
      waitMs = reason.kind === "paced" ? 1000 : Math.min(60_000, waitMs * 2);
      if (once) { process.exitCode = 5; return; }
    }
    if (once || stopping) return;
    // Jittered, so a room full of machines started together does not report in step.
    const pause = waitMs * (0.8 + Math.random() * 0.4);
    const until = Date.now() + pause;
    while (!stopping && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(500, until - Date.now())));
    if (stopping) return;
  }
}

function announce(output, credentials, intervalS, joined, shareProjectNames = false) {
  const cmd = invocation(VERSION);
  output.event(joined ? "joined" : "resumed", {
    hub: credentials.hub, device: { id: credentials.deviceId, label: credentials.label, person: credentials.person || null },
  }, [
    "",
    `  ${productTitle("reporter")}`,
    `  ${joined ? "Joined" : "Reporting to"} ${credentials.hub} as “${printable(credentials.label, 80)}”${credentials.person ? ` for ${printable(credentials.person, 80)}` : ""}.`,
    `  Reporting this machine's Claude Code and Codex usage every ${intervalS} seconds, over TLS to that console only.`,
    `  ${PRIVACY}`,
    shareProjectNames ? "  You chose --share-project-names: each project folder's name (not its path) is sent as its label." : null,
    `  Leave this window open. Ctrl+C stops; to start again later:`,
    `    ${cmd} report`,
    "",
  ].filter((line) => line !== null).join("\n"));
}

/** Deletes what an enrolment left on this machine: credentials, key, salt, labels, spool and cursor. */
function forget(stateDir) {
  fs.rmSync(credentialsFile(stateDir), { force: true });
  fs.rmSync(path.join(stateDir, "devices"), { recursive: true, force: true });
}

export async function main(command, argv) {
  let parsed;
  try { parsed = parse(argv); } catch (error) { process.stderr.write("\n  " + error.message + "\n\n"); process.exitCode = 2; return; }
  const { positional, flags } = parsed;
  if (flags.get("help") || flags.get("h")) { process.stdout.write(help()); return; }
  const stateDir = stateDirOf(flags);
  const output = createOutput(Boolean(flags.get("json")));
  const intervalS = Math.max(2, Math.min(3600, Number(flags.get("interval")) || DEFAULT_INTERVAL_S));
  const once = Boolean(flags.get("once"));
  const cmd = invocation(VERSION);

  try {
    if (command === "leave") {
      const existing = readCredentials(stateDir);
      forget(stateDir);
      output.event("left", { hub: existing ? existing.hub : null }, existing
        ? `\n  Deleted this machine's enrolment with ${existing.hub}. Nothing more will be sent.\n  (The console keeps what it already received; this machine can be removed there.)\n`
        : "\n  This machine is not enrolled with any console. Nothing was left to delete.\n");
      return;
    }

    let credentials;
    if (command === "join") {
      const target = parseJoinTarget(positional[0], positional[1], flags.get("fingerprint"));
      const { body, certificate } = await exchange(target, flags.get("name") ? String(flags.get("name")) : null);
      forget(stateDir);   // a new enrolment replaces the old one entirely
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
      announce(output, credentials, intervalS, true, Boolean(flags.get("share-project-names")));
    } else {
      credentials = readCredentials(stateDir);
      if (!credentials) throw usage(`This machine has not joined a console yet (or joined one older than this version). Open the join link you were sent, or run:\n  ${cmd} join "<join link>"`);
      announce(output, credentials, intervalS, false, Boolean(flags.get("share-project-names")));
    }
    await reportLoop({ credentials, stateDir, roots: rootsOf(flags), intervalS, once, output,
      shareProjectNames: Boolean(flags.get("share-project-names")) });
  } catch (error) {
    process.stderr.write("\n  " + String(error && error.message).split("\n").map((line) => printable(line, 300)).join("\n  ") + "\n\n");
    process.exitCode = error && error.usage ? 2 : 1;
  }
}
