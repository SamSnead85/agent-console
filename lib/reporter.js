/**
 * The reporter: the small program a teammate runs so their machine shows up
 * on somebody's Agent Console.
 *
 *   agent-console join <link>        enrol this machine with a join link, then report
 *   agent-console report             keep reporting (after a restart)
 *   agent-console leave              forget this machine's credential
 *
 * What it sends is decided in lib/collector/collector.js, not here: every
 * record passes the collector's allowlist, so only token counts, a model id, a
 * minute and salted hashes of the session and project leave this machine.
 *
 * The credential. A join link carries a single-use, thirty-minute code, never
 * a long-lived secret. The reporter spends that code once, and the hub answers
 * with a device token that goes straight into a private file here (mode 600)
 * — it is never printed, never put in a URL and never shown on any screen. The
 * owner can revoke it from the console at any time.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRoots, runOnce } from "./collector/collector.js";
import { endpoint, isPrivateHost } from "./collector/transport.js";
import { normalizeCode, TOKEN_PATTERN } from "./hub/registry.js";
import { clearDeadLock } from "./hub/local.js";
import { productTitle } from "./brand.js";

const DEFAULT_INTERVAL_S = 10;
const PRIVACY = "Only token counts, model names, times and salted hashes leave this machine — never a prompt, a reply, a file path or file contents.";

export const HELP = `
${productTitle("reporter")}

  agent-console join <join link>          enrol this machine, then keep reporting
  agent-console join <hub address> <code> the same, with the code typed separately
  agent-console report                    keep reporting (uses the saved enrolment)
  agent-console leave                     forget this machine's enrolment

Options
  --name <text>          what to call this machine on the console (join only)
  --interval <seconds>   how often to report (default ${DEFAULT_INTERVAL_S})
  --once                 report once and exit
  --state-dir <path>     where the enrolment is kept (default ~/.agent-console/reporter)
  --home <path>          read this home directory's transcripts instead of your own
  --claude-root <path>   Claude Code transcripts (default <home>/.claude/projects)
  --codex-root <path>    Codex transcripts (default <home>/.codex/sessions)
  --share-project-names  OFF by default. Also send each project folder's NAME (never
                         its path) so the console can show "atlas-api" instead of a
                         hash. Nothing else changes.
  --allow-http           permit plain HTTP to a hub that is not on a private network
  --json                 print one JSON line per event instead of sentences

${PRIVACY}
`;

function parse(argv) {
  const positional = [];
  const flags = new Map();
  const booleans = new Set(["once", "allow-http", "json", "help", "h", "share-project-names"]);
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

/** Splits a join link into the hub's base address and the code. */
export function parseJoinTarget(first, second) {
  if (!first) throw usage("Paste the join link you were sent, for example:\n  agent-console join http://192.168.1.20:6787/join#K7Q2-9XMA");
  let raw = first.trim();
  if (!/^https?:\/\//iu.test(raw)) raw = "http://" + raw;
  let url;
  try { url = new URL(raw); } catch { throw usage("That does not look like a join link or a hub address."); }
  const code = normalizeCode(second || url.hash.replace(/^#/u, "") || url.searchParams.get("code") || "");
  if (!code) throw usage("The join code is missing or mistyped. It looks like K7Q2-9XMA and comes at the end of the link.");
  return { hub: url.origin, code };
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

export function readCredentials(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(credentialsFile(stateDir), "utf8"));
    if (value && value.v === 1 && TOKEN_PATTERN.test(value.token) && typeof value.hub === "string") return value;
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
  if (code === "ingestion_unavailable" && status === 429) return { kind: "paced", text: `the hub is pacing uploads${progress}; continuing shortly` };
  if (code === "ingestion_unavailable" && status !== null && status >= 500) return { kind: "hub-error", text: `the hub answered with an error (HTTP ${status})${progress}; will keep trying` };
  if (code === "ingestion_unavailable" && status !== null) return { kind: "hub-busy", text: `the hub did not accept the upload yet (HTTP ${status})${progress}; will keep trying` };
  if (!code || code === "ingestion_unavailable" || code === "retry_interrupted") return { kind: "unreachable", text: `cannot reach the hub at ${hub}${progress}; will keep trying` };
  return { kind: "refused", text: `the hub did not accept this report (${code}${status ? " " + status : ""}) — will keep trying.\n           If this persists, check that this machine and the hub run the same Agent Console version.` };
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

async function exchange(hub, code, name, allowHttp) {
  const target = endpoint(hub + "/api/join", { allowHttp });
  let response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-console": "1" },
      body: JSON.stringify({ code, ...(name ? { name } : {}) }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Could not reach the hub at ${hub}.\n  Check that this machine is on the same network, and that the hub was started with --listen.`);
  }
  let body = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    throw new Error((body && typeof body.reason === "string" ? body.reason : `The hub refused the join (${response.status}).`));
  }
  if (!body || !TOKEN_PATTERN.test(body.token) || !body.device || typeof body.orgSalt !== "string") {
    throw new Error("The hub's answer was not a join. Is that address really an Agent Console?");
  }
  return body;
}

function enrolmentDir(stateDir, deviceId) {
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
  return directory;
}

/**
 * The one opt-in: a project folder's last name, reduced to [a-z0-9-], written
 * into the collector's own labels.json so it travels as the record's
 * `engagement` label. Off unless --share-project-names is passed; the path, the
 * branch and everything else stay on this machine either way.
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

async function reportLoop({ credentials, stateDir, roots, intervalS, once, allowHttp, output, shareProjectNames = false }) {
  const directory = writeEnrolment(stateDir, credentials);
  clearDeadLock(directory);
  const labels = shareProjectNames ? labelWriter(directory) : null;
  const token = process.env.AGENT_CONSOLE_TOKEN || credentials.token;
  const retentionMs = Math.max(1, Number(credentials.retentionDays) || 8) * 86_400_000;
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
        directory, roots, token, allowHttp,
        post: credentials.hub + "/api/ingest",
        watch: true,
        compact: true,
        sinceMs: Date.now() - retentionMs,
        onProgress,
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
          (r.duplicate ? ` (${r.duplicate} already on the hub)` : ""));
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
          "\n  The hub no longer accepts this machine — it was removed from the console.\n  Ask for a new join link, then run: agent-console join <link>\n");
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
  const hubUrl = new URL(credentials.hub);
  const plain = hubUrl.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(hubUrl.hostname);
  output.event(joined ? "joined" : "resumed", {
    hub: credentials.hub, device: { id: credentials.deviceId, label: credentials.label, person: credentials.person || null },
  }, [
    "",
    `  ${productTitle("reporter")}`,
    `  ${joined ? "Joined" : "Reporting to"} ${credentials.hub} as “${credentials.label}”${credentials.person ? ` for ${credentials.person}` : ""}.`,
    `  Reporting this machine's Claude Code and Codex usage every ${intervalS} seconds.`,
    `  ${PRIVACY}`,
    shareProjectNames ? "  You also chose --share-project-names: each project folder's name (not its path) is sent as its label." : null,
    plain ? "  The connection is plain HTTP on your local network." : null,
    "  Leave this window open. Ctrl+C stops; `agent-console report` starts it again.",
    "",
  ].filter((line) => line !== null).join("\n"));
}

export async function main(command, argv) {
  let parsed;
  try { parsed = parse(argv); } catch (error) { process.stderr.write("\n  " + error.message + "\n\n"); process.exitCode = 2; return; }
  const { positional, flags } = parsed;
  if (flags.get("help") || flags.get("h")) { process.stdout.write(HELP); return; }
  const stateDir = stateDirOf(flags);
  const output = createOutput(Boolean(flags.get("json")));
  const intervalS = Math.max(2, Math.min(3600, Number(flags.get("interval")) || DEFAULT_INTERVAL_S));
  const allowHttp = Boolean(flags.get("allow-http"));
  const once = Boolean(flags.get("once"));

  try {
    if (command === "leave") {
      const existing = readCredentials(stateDir);
      if (!existing) { output.event("left", {}, "\n  This machine is not enrolled with any hub.\n"); return; }
      fs.rmSync(credentialsFile(stateDir), { force: true });
      output.event("left", { hub: existing.hub }, `\n  Forgot the enrolment with ${existing.hub}. Nothing more will be sent.\n  (The console keeps what it already received; the owner can remove this machine there.)\n`);
      return;
    }

    let credentials;
    if (command === "join") {
      const { hub, code } = parseJoinTarget(positional[0], positional[1]);
      const url = new URL(hub);
      if (url.protocol === "http:" && !isPrivateHost(url.hostname) && !allowHttp) {
        throw usage(`${hub} is not on a private network, and plain HTTP would send this machine's credential in the clear.\n  Use an https:// address, or add --allow-http if you understand the risk.`);
      }
      const answer = await exchange(hub, code, flags.get("name") ? String(flags.get("name")) : null, allowHttp);
      credentials = {
        v: 1,
        hub,
        token: answer.token,
        deviceId: answer.device.id,
        label: answer.device.label,
        person: answer.device.person || null,
        organizationId: answer.organizationId,
        orgSalt: answer.orgSalt,
        retentionDays: answer.retentionDays,
        joinedAt: new Date().toISOString(),
      };
      writePrivate(credentialsFile(stateDir), credentials);
      announce(output, credentials, intervalS, true, Boolean(flags.get("share-project-names")));
    } else {
      credentials = readCredentials(stateDir);
      if (flags.get("hub") && credentials && new URL(String(flags.get("hub"))).origin !== credentials.hub) {
        throw usage("This machine is enrolled with a different hub. Run `agent-console leave`, then join the new one with its link.");
      }
      if (!credentials) throw usage("This machine has not joined a console yet. Open the join link you were sent, or run:\n  agent-console join <join link>");
      announce(output, credentials, intervalS, false, Boolean(flags.get("share-project-names")));
    }
    await reportLoop({ credentials, stateDir, roots: rootsOf(flags), intervalS, once, allowHttp, output,
      shareProjectNames: Boolean(flags.get("share-project-names")) });
  } catch (error) {
    process.stderr.write("\n  " + String(error && error.message) + "\n\n");
    process.exitCode = error && error.usage ? 2 : 1;
  }
}
