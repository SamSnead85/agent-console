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
import { createStore } from "./lib/hub/store.js";
import { createNames, startLocalCollection } from "./lib/hub/local.js";
import { startDemo } from "./lib/hub/demo.js";
import { createConsoleHandler, createReportingHandler, hubAddresses, joinAssetsPresent } from "./lib/hub/routes.js";
import { choosePort, chooseFreePort } from "./lib/hub/port.js";
import { createAdmin, readAdminKey, requestSignIn } from "./lib/hub/admin.js";
import { hubCertificate } from "./lib/hub/tls.js";
import { defaultRoots } from "./lib/collector/collector.js";
import { createGitStatsStore } from "./lib/gitstats.js";
import { PRODUCT_NAME, productTitle } from "./lib/brand.js";
import { invocation } from "./lib/invocation.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).version;
const COMMAND = invocation(VERSION);
const config = readConfig(process.argv.slice(2), process.env);

if (config.help) {
  process.stdout.write(help(COMMAND));
  process.exit(0);
}
if (config.listenErrors.length) {
  for (const problem of config.listenErrors) process.stderr.write("\n  " + problem + "\n");
  process.stderr.write("\n");
  process.exit(2);
}
if (!joinAssetsPresent(PUBLIC)) {
  process.stderr.write("\n  This copy of " + PRODUCT_NAME + " is missing files from public/. Download it again.\n\n");
  process.exit(1);
}

/** Open the page in the platform's default browser. Best effort, never fatal. */
function openBrowser(address) {
  if (process.platform === "darwin") execFile("/usr/bin/open", [address], () => {});
  else if (process.platform === "win32") execFile("cmd", ["/c", "start", "", address.replace(/&/gu, "^&")], () => {});
  else execFile("xdg-open", [address], () => {});
}

// ---------------------------------------------------------------------------
// Ports, before anything opens a file
// ---------------------------------------------------------------------------

const consoleChoice = await choosePort({ port: config.port, host: "127.0.0.1", explicit: config.portExplicit, demo: config.demo });
if (consoleChoice.action === "already-running") {
  const base = "http://127.0.0.1:" + consoleChoice.port;
  // The same user can read the running console's key, and proves it without
  // sending it: whatever answers on the port gets no secret, and the browser
  // opens only on a console that proved it holds the same key.
  const key = config.stateDir ? readAdminKey(config.stateDir) : null;
  const answer = key ? await requestSignIn({ port: consoleChoice.port, key }) : { verified: false };
  if (key && !answer.verified) {
    if (config.json) {
      process.stdout.write(JSON.stringify({ ok: false, alreadyRunning: true, verified: false, dashboard: { name: PRODUCT_NAME, url: base, port: consoleChoice.port } }) + "\n");
    } else {
      process.stderr.write("\n  Something on port " + consoleChoice.port + " answers as " + PRODUCT_NAME + ", but it is not the console for\n"
        + "  " + config.stateDir + " (it could not prove it holds that console's key). Nothing was sent to it.\n"
        + "  If it is an older copy of the console, or one with another --state-dir, stop it first.\n"
        + "  Otherwise start on another port:  " + COMMAND + " --port " + (consoleChoice.port + 2) + "\n\n");
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
// Reporting sits next to the console unless told otherwise.
const reportChoice = await chooseFreePort({
  port: config.reportPortExplicit ? config.reportPort : config.port === 0 ? 0 : config.port + 1,
  host: config.listen, explicit: config.reportPortExplicit, avoid: config.port ? [config.port] : [],
});
if (reportChoice.action === "busy") {
  process.stderr.write("\n  Port " + config.reportPort + " (for other machines to report on) is already in use.\n"
    + "  Choose another:  " + COMMAND + " --report-port " + (config.reportPort + 2) + "\n\n");
  process.exit(1);
}
config.reportPort = reportChoice.port;

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

const PRICES = JSON.parse(fs.readFileSync(path.join(HERE, "lib", "collector", "prices.json"), "utf8"));
const retentionMs = config.retentionDays * 86_400_000;
const registry = createRegistry({ dir: config.stateDir });
const store = createStore({ dir: config.stateDir, retentionMs, prices: PRICES });
if (!config.demo) store.load();
const admin = createAdmin({ dir: config.stateDir });
const certificate = hubCertificate(config.stateDir);
let names = config.demo ? null : createNames(config.stateDir, { retentionMs });
let local = null;
if (config.demo) {
  names = startDemo({ registry, store }).names;
} else if (config.local) {
  const roots = defaultRoots(config.home);
  roots[0].directory = config.claudeRoot;
  roots[1].directory = config.codexRoot;
  local = startLocalCollection({
    registry, store, names, stateDir: config.stateDir, roots,
    label: config.machineName, person: config.person,
    onError: (error) => process.stderr.write("  this machine: " + String(error && error.message) + "\n"),
  });
}
if (!config.demo) {
  process.on("exit", () => { try { registry.flush(); names && names.save(); } catch { /* exiting */ } });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(signal === "SIGINT" ? 130 : 143));
}

// Filled in with the real ports once both listeners are up.
const reportingInfo = { port: config.reportPort, consolePort: config.port, fingerprint: certificate.fingerprint };
const consoleHandler = createConsoleHandler({
  config, registry, store, names, local, admin, version: VERSION, publicDir: PUBLIC,
  reporting: reportingInfo,
  git: config.demo ? null : createGitStatsStore(),
});
const reportingHandler = createReportingHandler({
  config, registry, store, version: VERSION, publicDir: PUBLIC, onChange: () => consoleHandler.invalidate(),
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
    else process.stderr.write("\n  " + what + ": " + error.message + "\n\n");
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

const address = "http://127.0.0.1:" + config.port;
const signIn = () => address + "/login?ticket=" + admin.ticket();
const reach = hubAddresses(config.listen, config.reportPort);

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
    if (reportChoice.movedFrom && registry.list().some((d) => !d.local && !d.revokedAt)) {
      lines.push("  port " + reportChoice.movedFrom + " was in use: machines that joined earlier report there, and reach this console again once it runs on it");
    }
  } else if (!config.demo) {
    lines.push("  this machine only — to connect other machines, restart with --listen 0.0.0.0");
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
      + " · " + store.recordCount.toLocaleString("en-US") + " records in the last " + config.retentionDays + " days\n\n");
  }
  openOnce();
});
