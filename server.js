#!/usr/bin/env node
/**
 * The console: one view of the AI coding agents on this machine and on every
 * machine that reports to it.
 *
 * Node standard library only: no npm dependency, no build step. Two listeners:
 *
 *   the console     127.0.0.1:<port>. The pages, the data and every
 *                   administrative action; signed in by cookie (lib/hub/admin.js).
 *   reporting       <listen>:<report port>. The join page over plain HTTP, and
 *                   over TLS with the hub's own certificate, the join exchange
 *                   and token-checked ingestion (lib/hub/routes.js).
 *
 * The hub reads this machine through the collector, stores minute buckets of
 * usage (lib/hub/store.js) and builds the console's view (lib/hub/aggregate.js).
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { help, readConfig } from "./lib/config.js";
import { createRegistry } from "./lib/hub/registry.js";
import { acquireStateLock, stateLockOwner } from "./lib/hub/state-lock.js";
import { createStore } from "./lib/hub/store.js";
import { createNames, startLocalCollection } from "./lib/hub/local.js";
import { startDemo } from "./lib/hub/demo.js";
import { createAlerts } from "./lib/hub/alerts.js";
import { createFleetSignals } from "./lib/hub/fleet.js";
import { createAlertDay } from "./lib/hub/alert-day.js";
import { createActivityBook } from "./lib/collector/activity.js";
import { createConsoleHandler, createReportingHandler, hubAddresses, joinAssetsPresent, isCgnatAddress } from "./lib/hub/routes.js";
import { choosePort, chooseFreePort } from "./lib/hub/port.js";
import { emptyReadNotice, olderConsoleNotice, lockedStateNotice, remedy, compareVersions, stopCommand } from "./lib/hub/notices.js";
import { createAdmin, readAdminKey, requestSignIn } from "./lib/hub/admin.js";
import { hubCertificate } from "./lib/hub/tls.js";
import { transcriptRoots } from "./lib/collector/collector.js";
import { createGitStatsStore } from "./lib/gitstats.js";
import { createInteropStore } from './lib/interop/ingest.js';
import { PRODUCT_NAME, productTitle } from "./lib/brand.js";
import { invocation } from "./lib/invocation.js";
import { REPORTER_SEARCH } from "./lib/reporter-search.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).version;
const COMMAND = invocation(VERSION);
const config = readConfig(process.argv.slice(2), process.env);

if (config.help) {
  process.stdout.write(help(COMMAND));
  process.exit(0);
}
if (config.errors.length) {
  // Under --json a mistake is a JSON line too, so a program starting the console can read it.
  if (config.json) process.stdout.write(JSON.stringify({ ok: false, event: "error", kind: "usage", errors: config.errors }) + "\n");
  else {
    for (const problem of config.errors) process.stderr.write("\n  " + problem + "\n");
    process.stderr.write("\n");
  }
  process.exit(2);
}
if (!joinAssetsPresent(PUBLIC)) {
  process.stderr.write("\n  This copy of " + PRODUCT_NAME + " is missing files from public/. Download it again.\n\n");
  process.exit(1);
}

/** This start's own command, with --listen 0.0.0.0: how to open it to other machines. */
function networkCommand() {
  const argv = process.argv.slice(2);
  const kept = [];
  for (let i = 0; i < argv.length; i += 1) {
    const [name] = argv[i].split("=");
    if (name === "--listen") { if (!argv[i].includes("=")) i += 1; continue; }
    if (name === "--json") continue;
    kept.push(/^[A-Za-z0-9_./:=@%+-]+$/u.test(argv[i]) ? argv[i] : "'" + argv[i].replace(/'/gu, "'\\''") + "'");
  }
  return [COMMAND, ...kept, "--listen", "0.0.0.0"].join(" ");
}

/** Open the page in the platform's default browser. Best effort, never fatal. */
function openBrowser(address) {
  if (process.platform === "darwin") execFile("/usr/bin/open", [address], () => {});
  else if (process.platform === "win32") execFile("cmd", ["/c", "start", "", address.replace(/&/gu, "^&")], () => {});
  else execFile("xdg-open", [address], () => {});
}

/** The reporting port this console used last time: enrolled machines report there. */
const REPORTING_FILE = config.stateDir ? path.join(config.stateDir, "reporting.json") : null;
function rememberedReportPort() {
  try {
    const { port } = JSON.parse(fs.readFileSync(REPORTING_FILE, "utf8"));
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Ports, before anything opens a file
// ---------------------------------------------------------------------------

const remembered = REPORTING_FILE ? rememberedReportPort() : null;
// A console found on a nearby port (where an earlier start moved to) is this
// one only when it proves it holds this state directory's key; a demo has none.
const ownKey = config.stateDir ? readAdminKey(config.stateDir) : null;
const proofs = new Map();
const mine = config.demo ? null : async (port) => {
  if (!ownKey) return false;
  const answer = await requestSignIn({ port, key: ownKey });
  proofs.set(port, answer);
  return answer.verified;
};
const consoleChoice = await choosePort({ port: config.port, host: "127.0.0.1", explicit: config.portExplicit, demo: config.demo,
  // A console that moves off a busy port never lands on the port its machines report to.
  avoid: remembered && !config.reportPortExplicit ? [remembered] : [], mine });
if (consoleChoice.action === "already-running") {
  const base = "http://127.0.0.1:" + consoleChoice.port;
  // The same user can read the running console's key, and proves it without
  // sending it: whatever answers on the port gets no secret, and the browser
  // opens only on a console that proved it holds the same key.
  const key = ownKey;
  const answer = proofs.get(consoleChoice.port) ?? (key ? await requestSignIn({ port: consoleChoice.port, key }) : { verified: false });
  // An older version answering here is never opened, or pointed to, as if it
  // were this one: it is named, with the command that stops it. Its process
  // id is used only when it proved it holds this state directory.
  const lockPid = answer.verified ? stateLockOwner(config.stateDir)?.pid ?? null : null;
  // (One that could not prove this state directory's key is refused below, and named as older there.)
  const older = (answer.verified || !key) && olderConsoleNotice({ running: consoleChoice.running, version: VERSION, url: base, port: consoleChoice.port, pid: lockPid, command: COMMAND });
  if (older) {
    if (config.json) process.stdout.write(JSON.stringify({ ok: false, alreadyRunning: true, older: true, running: consoleChoice.running.version, version: VERSION,
      stop: stopCommand({ pid: lockPid, port: consoleChoice.port }), dashboard: { name: PRODUCT_NAME, url: base, port: consoleChoice.port } }) + "\n");
    else process.stderr.write(older + "\n");
    process.exit(1);
  }
  if (!key) {
    // No key to prove (a demo keeps none): ask the running console to print a
    // new sign-in link in its own window. Nothing secret is sent, and nothing
    // secret comes back; only that window shows the link.
    let printed = false;
    try {
      const r = await fetch(base + "/api/sign-in/print", { method: "POST", headers: { "x-agent-console": "1" }, redirect: "error", signal: AbortSignal.timeout(2000) });
      printed = r.ok;
    } catch { /* said below */ }
    if (config.json) {
      process.stdout.write(JSON.stringify({ ok: true, alreadyRunning: true, verified: false, signInPrinted: printed, dashboard: { name: PRODUCT_NAME, url: base, port: consoleChoice.port, demo: Boolean(consoleChoice.running.demo) } }) + "\n");
    } else {
      process.stdout.write("\n  " + (consoleChoice.running.demo ? "A demo of " : "") + PRODUCT_NAME + " is already running at " + base + ".\n"
        + (printed ? "  It printed a new sign-in link in the window where it runs.\n"
          : "  Use the sign-in link in the window where it runs, or stop it there with Ctrl+C and start again.\n") + "\n");
    }
    process.exit(0);
  }
  if (key && !answer.verified) {
    if (config.json) {
      process.stdout.write(JSON.stringify({ ok: false, alreadyRunning: true, verified: false, dashboard: { name: PRODUCT_NAME, url: base, port: consoleChoice.port } }) + "\n");
    } else {
      const version = consoleChoice.running?.version;
      const olderCopy = typeof version === "string" && compareVersions(version, VERSION) < 0;
      process.stderr.write("\n  " + (olderCopy ? "An older " + PRODUCT_NAME + " (" + version + ")" : "Something that answers as " + PRODUCT_NAME)
        + " is on port " + consoleChoice.port + ", and it is not the console for\n"
        + "  " + config.stateDir + " (it could not prove it holds that console's key). Nothing was sent to it.\n"
        + "  To stop it:  " + stopCommand({ port: consoleChoice.port }) + "\n"
        + "  Or start this one on another port:  " + COMMAND + " --port " + (consoleChoice.port + 2) + "\n\n");
    }
    process.exit(1);
  }
  const url = answer.verified ? answer.url : base;
  if (config.json) {
    process.stdout.write(JSON.stringify({ ok: true, alreadyRunning: true, dashboard: { name: PRODUCT_NAME, version: consoleChoice.running.version, url: base, port: consoleChoice.port } }) + "\n");
  } else {
    const opening = config.open && answer.verified;
    process.stdout.write("\n  " + PRODUCT_NAME + " is already running at " + base + (opening ? " — opening it." : ".") + "\n"
      + (opening || !answer.verified ? "" : "  Sign in with this link (it works once): " + url + "\n") + "\n");
  }
  // Only a console that proved itself is opened: a browser sends its 127.0.0.1 cookies to any port.
  if (config.open && answer.verified) openBrowser(url);
  process.exit(0);
}
if (consoleChoice.action === "busy") {
  process.stderr.write("\n  Port " + config.port + " is already in use by another program.\n"
    + "  Start the console on another port:  " + COMMAND + " --port " + (config.port + 2) + "\n\n");
  process.exit(1);
}
config.port = consoleChoice.port;
// Reporting sits where it sat last time (enrolled machines report there), or
// next to the console, unless told otherwise.
const reportChoice = await chooseFreePort({
  port: config.reportPortExplicit ? config.reportPort : config.port === 0 ? 0 : remembered || config.port + 1,
  host: config.listen, explicit: config.reportPortExplicit, avoid: config.port ? [config.port] : [],
});
if (reportChoice.action === "busy") {
  process.stderr.write("\n  Port " + config.reportPort + " (for other machines to report on) is already in use.\n"
    + "  Choose another:  " + COMMAND + " --report-port " + (config.reportPort + 2) + "\n"
    + "  Machines that joined earlier look for this console on nearby ports (up to " + REPORTER_SEARCH + " either side of the\n"
    + "  port they joined on) and move by themselves; one further away needs a new join link.\n\n");
  process.exit(1);
}
config.reportPort = reportChoice.port;
const movedReporting = remembered && reportChoice.port !== 0 && reportChoice.port !== remembered ? remembered : null;

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

const PRICES = JSON.parse(fs.readFileSync(path.join(HERE, "lib", "collector", "prices.json"), "utf8"));
const retentionMs = config.retentionDays * 86_400_000;
let stateLock;
try {
  stateLock = acquireStateLock(config.stateDir);
  config.stateDir = stateLock.dir;
} catch (error) {
  process.stderr.write(error?.code === "ELOCKED"
    ? lockedStateNotice({ dir: config.stateDir, owner: stateLockOwner(config.stateDir) }) + "\n"
    : "\n  " + remedy(error, { what: "opening the console's data folder", path: config.stateDir, command: COMMAND }) + "\n\n");
  process.exit(1);
}
let registry = null, names = null, store = null, alertDay = null;
if (!config.demo) {
  // Register before initializing any persisted component, including failures
  // during startup. Finish every final write before another hub may acquire it.
  process.on("exit", () => {
    try { registry?.flush(); names?.save(); store?.flush(); alertDay?.flush(); } catch { /* exiting */ }
    finally { try { stateLock.release(); } catch { /* a dead owner is recovered on the next start */ } }
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(signal === "SIGINT" ? 130 : 143));
}
let admin, certificate;
try {
  registry = createRegistry({ dir: config.stateDir });
  store = createStore({ dir: config.stateDir, retentionMs, prices: PRICES });
  if (!config.demo) store.load();
  admin = createAdmin({ dir: config.stateDir });
  certificate = hubCertificate(config.stateDir);
} catch (error) {
  process.stderr.write("\n  " + remedy(error, { what: "reading the console's data", path: config.stateDir, command: COMMAND }) + "\n\n");
  process.exit(1);
}
names = config.demo ? null : createNames(config.stateDir, { retentionMs });
let local = null;
let alertEngine = null;
// Joined machines' opt-in alerts and tool activity (lib/hub/fleet.js), and
// this machine's own tool activity, counted from the transcripts it reads.
// The day's alert count, kept with the state: exact however many alerts the
// lists keep (lib/hub/alert-day.js). A first read of this machine's
// transcripts starts from the beginning, so it counts the whole day.
alertDay = config.demo ? null : createAlertDay({ file: path.join(config.stateDir, "alerts-today.json"),
  fromMidnight: config.local && !fs.existsSync(path.join(config.stateDir, "local", "cursor-v2.json")) });
const fleet = createFleetSignals({ day: alertDay, firstStart: !config.demo && registry.previousRunSeenAt === null });
let activityBook = null;
if (config.demo) {
  activityBook = createActivityBook();
  const demo = startDemo({ registry, store, fleet, activity: activityBook });
  names = demo.names;
  alertEngine = { list: () => demo.alerts() };
  alertDay = { read: (t) => demo.alertDay(t), flush() {} };
} else if (config.local) {
  const roots = transcriptRoots({ home: config.home, env: config.homeGiven ? {} : process.env,
    claudeRoot: config.claudeRoot, codexRoot: config.codexRoot });
  // No alert is live until the first read of this machine's transcripts is
  // done: a first run replays history, and history is not "now".
  alertEngine = createAlerts({ repeat: config.alertRepeat, spikeFactor: config.alertSpikeFactor,
    stallMinutes: config.alertStallMinutes, notify: config.desktopAlerts, names, day: alertDay,
    live: () => local?.status.firstRunComplete === true });
  activityBook = createActivityBook();
  local = startLocalCollection({
    registry, store, names, stateDir: config.stateDir, roots,
    intervalMs: 2_000, onTranscriptLine: (args) => { alertEngine.observeLine(args); activityBook.observeLine(args); },
    journal: activityBook.journal,
    label: config.machineName, person: config.person,
    onError: (error) => process.stderr.write("  this machine: " + (error?.code ? remedy(error, { what: "reading this machine's transcripts", command: COMMAND })
      : String(error && error.message)) + "\n"),
  });
}

// Filled in with the real ports once both listeners are up.
const reportingInfo = { port: config.reportPort, consolePort: config.port, fingerprint: certificate.fingerprint };
const consoleHandler = createConsoleHandler({
  config, registry, store, names, local, admin, version: VERSION, publicDir: PUBLIC,
  reporting: reportingInfo,
  git: config.demo ? null : createGitStatsStore(),
  alerts: alertEngine,
  alertDay,
  fleet,
  activity: activityBook,
  interop: config.interop && !config.demo ? createInteropStore() : null,
  onSignInLink: () => {
    const link = signIn();
    if (config.json) process.stdout.write(JSON.stringify({ event: "sign-in", at: new Date().toISOString(), signIn: link }) + "\n");
    else process.stdout.write("\n  A browser asked for a new sign-in link (it works once):  " + link + "\n\n");
  },
  networkCommand: networkCommand(),
});
const reportingHandler = createReportingHandler({
  config, registry, store, fleet, version: VERSION, publicDir: PUBLIC, onChange: () => consoleHandler.invalidate(),
  onEvent: (event) => {
    // Joins and leaves are said as they happen, in words or as JSON lines.
    if (config.json) { process.stdout.write(JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n"); return; }
    const who = event.device.label + (event.device.person ? " (" + event.device.person + ")" : "");
    const what = event.event === "joined" ? "joined" : event.event === "rejoined" ? "joined again, and keeps its history" : "left";
    process.stdout.write("  " + new Date().toLocaleTimeString("en-GB") + "  " + who.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ") + " " + what + "\n");
  },
});
const fail = (res) => (error) => {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
  res.end("internal error\n");
  process.stderr.write("  request failed: " + String(error && error.message) + "\n");
};

// ---------------------------------------------------------------------------
// The two listeners
// ---------------------------------------------------------------------------

const consoleServer = http.createServer((req, res) => { consoleHandler.handle(req, res).catch(fail(res)); });

/* One reporting port speaks both: the first byte of a TLS connection is always
   22 (a handshake record), and no HTTP request starts with it. */
const plainReporting = http.createServer((req, res) => { reportingHandler(req, res, { secure: false }).catch(fail(res)); });
const tlsReporting = https.createServer({ key: certificate.key, cert: certificate.cert, minVersion: "TLSv1.2" },
  (req, res) => { reportingHandler(req, res, { secure: true }).catch(fail(res)); });
for (const server of [plainReporting, tlsReporting]) {
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
}
const reportingServer = net.createServer((socket) => {
  socket.setTimeout(30_000, () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.once("data", (first) => {
    socket.pause();
    socket.unshift(first);
    (first[0] === 0x16 ? tlsReporting : plainReporting).emit("connection", socket);
    process.nextTick(() => socket.resume());
  });
});

function listenError(what, port) {
  return (error) => {
    if (error.code === "EADDRINUSE") process.stderr.write("\n  Port " + port + " (" + what + ") is already in use.\n\n");
    else if (error.code === "EADDRNOTAVAIL") process.stderr.write("\n  This machine has no network address " + config.listen + ". Try --listen 0.0.0.0.\n\n");
    else process.stderr.write("\n  " + what + ": " + remedy(error, { what: "opening a port", port, command: COMMAND }) + "\n\n");
    process.exit(1);
  };
}
consoleServer.on("error", listenError("the console", config.port));
reportingServer.on("error", listenError("reporting", config.reportPort));

await new Promise((resolve) => consoleServer.listen(config.port, "127.0.0.1", resolve));
config.port = consoleServer.address().port;
await new Promise((resolve) => reportingServer.listen(config.reportPort, config.listen, resolve));
config.reportPort = reportingServer.address().port;
Object.assign(reportingInfo, { port: config.reportPort, consolePort: config.port });
if (REPORTING_FILE && config.reportPort && !config.demo && !(reportChoice.movedFrom && registry.list().some((d) => !d.local && !d.revokedAt))) {
  // Kept, so the next start listens where enrolled machines report. A port
  // taken only for this run (the usual one was busy) is not kept.
  try { fs.writeFileSync(REPORTING_FILE, JSON.stringify({ v: 1, port: config.reportPort }) + "\n", { mode: 0o600 }); } catch { /* best effort */ }
}

const address = "http://127.0.0.1:" + config.port;
const signIn = () => address + "/login?ticket=" + admin.ticket();
const reach = hubAddresses(config.listen, config.reportPort, { advertise: config.advertise });

if (config.json) {
  process.stdout.write(JSON.stringify({
    ok: true,
    dashboard: {
      name: PRODUCT_NAME,
      version: VERSION,
      url: address,
      signIn: signIn(),
      port: config.port,
      reportPort: config.reportPort,
      listen: config.listen,
      joinUrls: reach.urls,
      fingerprint: certificate.fingerprint,
      demo: config.demo,
      local: Boolean(local),
      stateDir: config.stateDir,
      // A demonstration's key lives in memory, so its scrape token is shown here; a real one's by metrics-token.
      ...(config.demo && config.interop ? { metricsToken: admin.demoScrapeToken() } : {}),
    },
  }) + "\n");
} else {
  const lines = ["", "  " + productTitle() + "  ->  " + address];
  if (consoleChoice.movedFrom) lines.push("  port " + consoleChoice.movedFrom + " is already in use, so this console is on port " + config.port + " instead");
  lines.push(config.demo
    ? "  DEMO · a synthetic team; nothing on this machine is read, and no machine can join"
    : local ? "  reading this machine's Claude Code and Codex usage; data kept in " + config.stateDir
    : "  not reading this machine (--no-local); data kept in " + config.stateDir);
  if (reach.network) {
    lines.push(
      "",
      "  Other machines join and report on port " + config.reportPort + " at  " + reach.urls.join("  ·  "),
      "  Only machines holding a join code or a device token get in; reports travel over TLS",
      "  pinned to this console's certificate. The console itself answers only on this machine.",
    );
    if (reach.wsl && !reach.advertised) {
      lines.push("  This is WSL: " + new URL(reach.urls[0]).hostname + " is usually reachable from this computer only. Give other machines",
        "  Windows' own network address with --advertise <address>, and forward port " + config.reportPort + " to WSL (or use WSL's mirrored networking).");
    }
    const cgnat = reach.urls.filter((u) => isCgnatAddress(new URL(u).hostname));
    if (cgnat.length && !config.allowCgnat && !config.allowPublic) {
      lines.push("  " + cgnat.map((u) => new URL(u).hostname).join(", ") + " is in 100.64.0.0/10 (Tailscale or carrier-grade NAT): machines",
        "  there are refused unless you restart with --allow-cgnat");
    }
  } else if (!config.demo) {
    lines.push("  this machine only — to connect other machines, restart with --listen 0.0.0.0");
  }
  if (movedReporting && registry.list().some((d) => !d.local && !d.revokedAt)) {
    const near = Math.abs(config.reportPort - movedReporting) <= REPORTER_SEARCH;
    lines.push("", "  Reporting is on port " + config.reportPort + ", not " + movedReporting + " where machines joined. "
      + (near ? "They look for this console on nearby ports and move here by themselves."
        : "That is too far for them to find it: start with --report-port " + movedReporting + ", or send each a new join link."));
  }
  if (config.interop) {
    lines.push(config.demo
      ? "  /metrics scrape token for this demo (Authorization: Bearer …):  " + admin.demoScrapeToken()
      : "  Telemetry credentials: use metrics-token --scope read or --scope ingest. Command:  " + COMMAND + " metrics-token"
        + (config.stateDir === path.join(config.home, ".agent-console", "hub") ? "" : " --state-dir \"" + config.stateDir + "\""));
  }
  lines.push("", "  Sign in (the link works once):  " + signIn(), "  Ctrl+C stops the console.", "");
  process.stdout.write(lines.join("\n") + "\n");
}

// A first read of months of transcripts can take a while: it prints how far it
// has got, and the browser opens after two seconds regardless — the console
// shows the same progress.
let opened = false;
const openOnce = () => { if (config.open && !opened) { opened = true; openBrowser(signIn()); } };
const early = setTimeout(openOnce, 2000);
early.unref?.();
let progressTimer = null;
if (local && !config.json) {
  let lastLine = "";
  progressTimer = setInterval(() => {
    const p = local.status.progress;
    if (local.status.firstRunComplete || !p || !p.filesTotal) return;
    const line = "  reading this machine's transcripts · " + p.files.toLocaleString("en-US") + " of "
      + p.filesTotal.toLocaleString("en-US") + " files · " + p.records.toLocaleString("en-US") + " records so far";
    if (line !== lastLine) { lastLine = line; process.stdout.write(line + "\n"); }
  }, 3000);
  progressTimer.unref?.();
}
Promise.resolve(local && local.ready).then(() => {
  clearTimeout(early);
  if (progressTimer) clearInterval(progressTimer);
  if (!config.json) {
    const machines = registry.list().length;
    process.stdout.write("  ready: " + (config.demo ? "demo team" : machines + " machine" + (machines === 1 ? "" : "s"))
      + " · " + store.recordCount.toLocaleString("en-US") + " records in the last " + config.retentionDays + " days\n");
    // Nothing found on this machine: say where it looked, and how to point it elsewhere.
    if (local && store.recordCount === 0) process.stdout.write(emptyReadNotice(local.status.rootsRead, COMMAND) + "\n");
    process.stdout.write("\n");
  }
  openOnce();
});
