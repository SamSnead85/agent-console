#!/usr/bin/env node
/**
 * The console — one view of the AI coding agents on this machine and on every
 * machine that reports to it.
 *
 * Node standard library only: no npm dependency, no build step, nothing to
 * install. Two halves share this process:
 *
 *   the hub      reads this machine through the collector, accepts reports
 *                from enrolled machines, and serves /api/console — the band,
 *                the lanes, the machines and the people (lib/hub/).
 *   the detail   the v0.1 scanner behind /api and /api/history, which reads
 *                this machine's transcripts and Git history in full for the
 *                Projects view. It runs only when that view asks.
 *
 * The console answers only on this machine. `--listen` lets other machines
 * reach the join exchange and token-checked reporting, and nothing else.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { HELP, readConfig } from "./lib/config.js";
import { createRegistry as createHubRegistry } from "./lib/hub/registry.js";
import { createStore } from "./lib/hub/store.js";
import { createNames, startLocalCollection } from "./lib/hub/local.js";
import { startDemo } from "./lib/hub/demo.js";
import { createHubRoutes, isLocalRequest, isPublicPath, hubAddresses } from "./lib/hub/routes.js";
import { choosePort } from "./lib/hub/port.js";
import { defaultRoots } from "./lib/collector/collector.js";
import {
  contentSecurityPolicy,
  corsHeaders,
  crossOriginResourcePolicy,
} from "./lib/embed.js";
import { PRODUCT_NAME, productTitle } from "./lib/brand.js";
import { redactDeep } from "./lib/redact.js";
import { createSeries } from "./lib/series.js";
import {
  buildSessions,
  createClaudeStore,
  readPidSessions,
  scanClaude,
} from "./lib/claude.js";
import { buildThreads, createCodexStore, scanCodex } from "./lib/codex.js";
import { listAgents, PS_ARGS } from "./lib/procs.js";
import { createShipStore, refreshShipped } from "./lib/ship.js";
import { createTracker, acknowledge } from "./lib/state.js";
import { assemble, dayKeyOf } from "./lib/snapshot.js";
import {
  FLUSH_MS,
  PERIODS,
  assembleHistory,
  createHistoryStore,
  flushHistory,
  loadHistory,
  periodStart,
} from "./lib/history.js";
import { createGitStatsStore, gitStatsForPeriod } from "./lib/gitstats.js";
import { createFleetStore, refreshFleet } from "./lib/fleet.js";
import { readProgress } from "./lib/progress.js";
import {
  createProgressHistory,
  loadProgressHistory,
  observeProgress,
  progressSeries,
} from "./lib/proghistory.js";
import { createRegistry, readRegistry } from "./lib/ingest.js";
import { createMusterStore, refreshMuster } from "./lib/muster.js";
import { buildAttribution } from "./lib/attribution.js";
import { buildProjects } from "./lib/projects.js";
import { createDemoHistory, createDemoSnapshot } from "./lib/demo.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const config = readConfig(process.argv.slice(2), process.env);
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).version;

if (config.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

// A rejected origin must never degrade into "embedding is off". An operator
// who passed --embed expects a door; a typo that silently leaves the wall
// intact is the same failure shape as a control that reports a pass it did
// not earn.
if (config.embedErrors.length || config.listenErrors.length) {
  for (const problem of [...config.embedErrors, ...config.listenErrors]) {
    process.stderr.write("\n  " + problem + "\n");
  }
  process.stderr.write("\n");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The port, before anything opens a file
// ---------------------------------------------------------------------------

const portChoice = await choosePort({ port: config.port, host: config.listen, explicit: config.portExplicit, demo: config.demo });
if (portChoice.action === "already-running") {
  const url = "http://127.0.0.1:" + portChoice.port;
  if (config.json) {
    process.stdout.write(JSON.stringify({ ok: true, alreadyRunning: true, dashboard: { name: PRODUCT_NAME, version: portChoice.running.version, url, port: portChoice.port } }) + "\n");
  } else {
    process.stdout.write("\n  " + PRODUCT_NAME + " is already running at " + url + (config.open ? " — opening it." : " — open that address in your browser.") + "\n\n");
  }
  if (config.open) openBrowser(url);
  process.exit(0);
}
if (portChoice.action === "busy") {
  process.stderr.write(
    "\n  Port " + config.port + " is already in use by another program.\n" +
      "  Start the console on another port:  node bin/agent-console.mjs --port " + (config.port + 1) + "\n\n",
  );
  process.exit(1);
}
const movedFrom = portChoice.movedFrom ?? null;
config.port = portChoice.port;

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

const PRICES = JSON.parse(fs.readFileSync(path.join(HERE, "lib", "collector", "prices.json"), "utf8"));
const hubRegistry = createHubRegistry({ dir: config.stateDir });
const hubStore = createStore({ dir: config.stateDir, retentionMs: config.retentionDays * 86_400_000, prices: PRICES });
if (!config.demo) hubStore.load();
let hubNames = config.demo ? null : createNames(config.stateDir);
let localCollection = null;
if (config.demo) {
  hubNames = startDemo({ registry: hubRegistry, store: hubStore }).names;
} else if (config.local) {
  const roots = defaultRoots(config.home);
  roots[0].directory = config.claudeRoot;
  roots[1].directory = config.codexRoot;
  localCollection = startLocalCollection({
    registry: hubRegistry, store: hubStore, names: hubNames, stateDir: config.stateDir, roots,
    label: config.machineName, person: config.person,
    onError: (error) => process.stderr.write("  this machine: " + String(error && error.message) + "\n"),
  });
}
const hubRoutes = createHubRoutes({
  config, registry: hubRegistry, store: hubStore, names: hubNames, local: localCollection,
  version: VERSION, root: HERE,
});
if (!config.demo) {
  process.on("exit", () => { try { hubRegistry.flush(); hubNames && hubNames.save(); } catch { /* exiting */ } });
}

const fleetSeries = createSeries();
const historyStore = config.demo
  ? null
  : createHistoryStore({ dir: config.historyDir });
// Persisted snapshots are read back before the first scan, so history the
// transcripts no longer hold (log pruning) is on screen from the first poll.
if (!config.demo) loadHistory(historyStore);
const claudeStore = config.demo
  ? null
  : createClaudeStore({
      root: config.claudeRoot,
      sessionsDir: config.claudeSessions,
      windowMs: config.windowMs,
      fleetSeries,
      history: historyStore,
    });
const codexStore = config.demo
  ? null
  : createCodexStore({
      root: config.codexRoot,
      windowMs: config.windowMs,
      // One shared baseline for both vendors. See lib/codex.js.
      fleetSeries,
    });
const shipStore = config.demo ? null : createShipStore();
const gitStatsStore = config.demo ? null : createGitStatsStore();
const fleetStore = config.demo ? null : createFleetStore();
const musterStore = config.demo ? null : createMusterStore();
const registry = config.demo
  ? null
  : createRegistry({ dir: config.historyDir });
// The trend behind the orchestrator's percentage. Read back before the first
// scan so the line is on screen from the first poll rather than starting flat.
const progressHistory = config.demo
  ? null
  : createProgressHistory({ dir: config.historyDir });
if (!config.demo) loadProgressHistory(progressHistory);
const tracker = createTracker();

// The dashboard's own repository is always a candidate for period code stats,
// so the panel works before any session has been observed.
// The console is embedded inside the installed Muster package, so deriving the
// coordinated repository from this source file would inspect the package
// installation instead of the operator's checkout. The CLI passes the verified
// project root explicitly; direct runs default to the current working directory.
const OWN_REPO_DIR = config.repoRoot;
let lastCwds = [];

// Flush the token-history store about every five minutes while running, and
// once more on the way out, so a restart costs at most a few minutes of the
// current bucket. appendFileSync keeps the exit path safe.
if (!config.demo) {
  setInterval(() => flushHistory(historyStore, Date.now()), FLUSH_MS).unref();
  process.on("exit", () => flushHistory(historyStore, Date.now()));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      flushHistory(historyStore, Date.now());
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

let cached = null;
let building = null;
// Cumulative across the life of the process, so the strip can show BOTH the
// first scan's size and what each incremental pass costs — which is the pair
// the README promises and the pair that makes "a refresh costs milliseconds"
// checkable rather than asserted.
let bytesRead = 0;

function ps() {
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      PS_ARGS,
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? "" : String(stdout)),
    );
  });
}

function networkPosture() {
  if (config.githubEnabled && config.musterEnabled) {
    return "coordination read-only · hosted-forge checks and ledger refresh may contact configured origins";
  }
  if (config.githubEnabled) {
    return "coordination read-only · hosted-forge checks may contact GitHub";
  }
  if (config.musterEnabled) {
    return "coordination read-only · ledger refresh may contact the configured Git origin";
  }
  return "coordination read-only · hosted coordination refresh disabled";
}

async function build() {
  // This branch is intentionally first. Demo mode is not a filter over a real
  // scan; it is a separate in-memory data source with no access to local state.
  if (config.demo) return createDemoSnapshot({ pollMs: config.pollMs, observability: true });
  const started = Date.now();
  const now = started;
  const day = dayKeyOf(now);
  const scan = {
    ms: 0,
    bytes: 0,
    files: 0,
    error: null,
    bytesTotal: 0,
    claudeMissing: false,
    roots: { claude: config.claudeRoot, codex: config.codexRoot },
  };

  let claudeResult = { bytes: 0, fileCount: 0 };
  try {
    claudeResult = scanClaude(claudeStore, now, dayKeyOf);
    // An unreadable root is an instrument failure, not a quiet fleet. It is
    // reported here so the strip turns amber and the master says ATTENTION.
    if (claudeResult.error) scan.error = claudeResult.error;
    scan.claudeMissing = !!claudeResult.missing;
  } catch (error) {
    scan.error = "claude scan: " + (error && error.message);
  }
  let codexResult = { available: false, reason: "not scanned" };
  try {
    codexResult = scanCodex(codexStore, now);
  } catch (error) {
    codexResult = { available: false, reason: String(error && error.message) };
  }

  const pidSessions = readPidSessions(config.claudeSessions);
  const sessions = buildSessions(claudeStore, now, day, pidSessions);
  const codexThreads = codexResult.available
    ? buildThreads(codexStore, now)
    : [];

  const procs = listAgents(await ps(), process.pid).map((p) => ({
    ...p,
    // Keep the established process shape while making the capability
    // permanently unavailable at the public boundary.
    killable: false,
    protectedReason: "read-only process telemetry",
  }));

  // Attach the session each process is running, and that session's day spend.
  const spendBySession = new Map(sessions.map((s) => [s.id, s]));
  for (const proc of procs) {
    const record = pidSessions.get(proc.pid);
    proc.sessionId = record ? record.sessionId : null;
    proc.sessionName = record ? record.name : null;
    proc.sessionCwd = record ? record.cwd : null;
    proc.startedAt = record ? record.startedAt : null;
    const session =
      record && record.sessionId ? spendBySession.get(record.sessionId) : null;
    proc.tokens = session ? session.total : null;
    proc.cost = session ? session.costTotal : null;
    proc.agentCount = session ? session.agentCount : null;
    proc.agentLive = session ? session.agentLive : null;
  }
  const cwds = [];
  for (const session of sessions) {
    if (session.cwd && !cwds.includes(session.cwd)) cwds.push(session.cwd);
  }
  for (const thread of codexThreads) {
    if (thread.cwd && !cwds.includes(thread.cwd)) cwds.push(thread.cwd);
  }
  lastCwds = cwds.slice();
  const prLinks = new Map();
  for (const session of sessions) {
    for (const [number, pr] of session.prLinks) prLinks.set(number, pr);
  }
  let ship;
  try {
    ship = await refreshShipped(shipStore, cwds, prLinks, now);
  } catch (error) {
    ship = {
      repos: [],
      prs: [],
      prCount: 0,
      commitCount: 0,
      errors: [String(error.message)],
    };
  }

  scan.ms = Date.now() - started;
  scan.bytes = claudeResult.bytes;
  bytesRead += claudeResult.bytes || 0;
  scan.bytesTotal = bytesRead;
  scan.files = claudeResult.fileCount;

  // Stale-while-revalidate: never blocks on GitHub; the TTL refresh runs in
  // the background and the NEXT snapshot carries its result.
  const fleet = refreshFleet(fleetStore, {
    enabled: config.githubEnabled,
    repoDir: OWN_REPO_DIR,
    issue: config.fleetIssue,
    now,
  });

  // The muster ledger: the roster and the work-package claims, declared by each
  // session rather than inferred from prose. Same stale-while-revalidate rule
  // as the fleet panel — a snapshot never waits on a subprocess.
  const muster = refreshMuster(musterStore, {
    enabled: config.musterEnabled,
    repoDir: OWN_REPO_DIR,
    binPath: config.musterBin,
    now,
  });

  // Orchestrator-maintained project progress. Read-only, local, absent when
  // the file is missing or malformed — never a fabricated figure.
  const progress = readProgress(config.historyDir, now);
  // Observing it is what turns a single estimate into a trend. Only a CHANGED
  // record is recorded, so a ten-second poll does not manufacture history.
  observeProgress(progressHistory, progress, now);
  if (progress.available) {
    progress.history = progressSeries(progressHistory, {
      fromMs: null,
      max: 300,
    });
  }

  // Sessions that declared themselves — the ones this machine cannot scan.
  const registered = readRegistry(registry, now);

  const result = assemble({
    fleet,
    muster,
    registry: registered,
    progress,
    now,
    day,
    sessions,
    codexThreads,
    codexAvailable: codexResult.available,
    codexReason: codexResult.reason,
    procs,
    ship,
    tracker,
    fleetSeries,
    scan,
    dedupSpanMax: claudeStore.dedupSpanMax,
    config,
  });
  // Snapshot assembly predates the shared Muster ledger and can only describe
  // the optional GitHub panel. The server owns the complete network posture.
  result.meta.network = networkPosture();
  return result;
}

/**
 * The v0.1 period history for this machine: tokens by project from its own
 * transcripts, and delivery evidence from its own Git history. It is the
 * detail behind the Projects view, and it never leaves this machine.
 */
async function historyPayload(period, project) {
  // Like the main demo snapshot, history is a separate deterministic source,
  // not a sanitized view of the operator's history or repository.
  if (config.demo) return createDemoHistory({ period, project });
  // The ordinary snapshot runs first so the history reflects the newest
  // scan pass, and so session keys can be named from the live roster.
  const snap = await snapshot();
  const now = Date.now();
  const sessionNames = new Map();
  for (const row of snap.rows || []) {
    if (row.vendor === "claude") sessionNames.set(row.key, row.project);
  }
  const history = assembleHistory(historyStore, {
    now,
    period,
    sessionNames,
    project,
  });
  let code = null;
  try {
    code = await gitStatsForPeriod(
      gitStatsStore,
      [OWN_REPO_DIR, ...lastCwds],
      periodStart(period, now),
    );
  } catch (error) {
    code = {
      repos: [],
      authors: [],
      totals: { commits: 0, prsMerged: 0, added: 0, removed: 0 },
      errors: [String(error && error.message)],
    };
  }
  const registered = readRegistry(registry, now);
  const projects = buildProjects({
    projects: history.projects,
    code,
    rows: snap.rows || [],
    period: history.period,
    selected: project,
  });
  const attribution = buildAttribution({
    code,
    bySession: history.bySession,
    rows: snap.rows || [],
    registrations: registered.sessions,
    period: history.period,
  });
  return {
    ...history,
    code,
    projects,
    attribution,
    // The progress trend, scoped to the same period as everything else
    // on this response. The banner's own copy is unscoped; this one
    // answers "how far did the estimate move in the last 24 hours".
    progress: progressSeries(progressHistory, {
      fromMs: history.period.fromMs,
      max: 300,
    }),
    instrument: {
      priceTableDate: snap.instrument.priceTableDate,
      priceTableExpiry: snap.instrument.priceTableExpiry,
      priceTableExpired: snap.instrument.priceTableExpired,
      priceTableWarning: snap.instrument.priceTableWarning,
      estimateNote: snap.instrument.estimateNote,
    },
  };
}

/** The Projects view's shape: one row per project, with its Git evidence. */
async function projectsPayload(period) {
  if (config.demo) return demoProjects(period);
  const history = await historyPayload(period, null);
  const list = (history.projects && history.projects.projects) || [];
  const totals = (history.code && history.code.totals) || { commits: 0, prsMerged: 0, added: 0, removed: 0 };
  return {
    demo: false,
    period: history.period,
    tokens: list.reduce((sum, x) => sum + (x.tokens || 0), 0),
    sessions: list.reduce((sum, x) => sum + (x.sessions || 0), 0),
    withRepo: list.filter((x) => x.repo).length,
    totals,
    projects: list.map((x) => ({
      name: x.label || x.slug,
      tokens: x.tokens || 0,
      usd: typeof x.cost === "number" ? x.cost : null,
      sessions: x.sessions || 0,
      branches: x.branches || [],
      repo: x.repo ? { name: x.repo.name, commits: x.repo.commits, added: x.repo.added, removed: x.repo.removed, prsMerged: x.repo.prsMerged ?? null } : null,
    })),
  };
}

/* The demo's own machine: the same projects its lanes show, with Git
   figures that are as synthetic as everything else in demo mode. */
const DEMO_GIT = {
  "atlas-api": { commits: 14, added: 2480, removed: 612, prsMerged: 3 },
  "atlas-web": { commits: 9, added: 1310, removed: 402, prsMerged: 2 },
  "docs-site": { commits: 4, added: 540, removed: 96, prsMerged: 1 },
};
function demoProjects(period) {
  const now = Date.now();
  const span = period === "hour" ? 3600_000 : period === "3d" ? 3 * 86_400_000 : 86_400_000;
  const local = hubRegistry.list().find((d) => d.local);
  const byProject = new Map();
  hubStore.eachBucket(now - span, now + 60_000, (minute, bucket) => {
    if (!local || bucket.deviceId !== local.id) return;
    const session = hubStore.sessions.get(bucket.sessionHash);
    const top = session && session.isSubagent && hubStore.sessions.get(session.parentSessionHash) || session;
    const name = top ? hubNames.project(top.projectHash) : null;
    if (!name) return;
    let p = byProject.get(name);
    if (!p) { p = { name, tokens: 0, usd: 0, sessions: new Set(), branches: new Set() }; byProject.set(name, p); }
    p.tokens += bucket.fresh + bucket.output + bucket.cacheWrite + bucket.cacheRead;
    p.usd += bucket.usd;
    p.sessions.add(top.sessionHash);
    const branch = hubNames.branch(top.sessionHash);
    if (branch) p.branches.add(branch);
  });
  const scale = period === "3d" ? 2.6 : period === "hour" ? 0.1 : 1;
  const projects = [...byProject.values()].sort((a, b) => b.tokens - a.tokens).map((p) => {
    const g = DEMO_GIT[p.name];
    return {
      name: p.name, tokens: p.tokens, usd: p.usd, sessions: p.sessions.size, branches: [...p.branches],
      repo: g ? { name: p.name, commits: Math.round(g.commits * scale), added: Math.round(g.added * scale), removed: Math.round(g.removed * scale), prsMerged: Math.round(g.prsMerged * scale) } : null,
    };
  });
  const sum = (key) => projects.reduce((a, p) => a + (p.repo ? p.repo[key] : 0), 0);
  return {
    demo: true,
    period: { id: period, label: PERIODS[period].label },
    tokens: projects.reduce((a, p) => a + p.tokens, 0),
    sessions: projects.reduce((a, p) => a + p.sessions, 0),
    withRepo: projects.filter((p) => p.repo).length,
    totals: { commits: sum("commits"), added: sum("added"), removed: sum("removed"), prsMerged: sum("prsMerged") },
    projects,
  };
}

const MIN_REBUILD_MS = 1500;

function snapshot() {
  if (config.demo) {
    if (!cached) cached = createDemoSnapshot({ pollMs: config.pollMs, observability: true });
    return Promise.resolve(cached);
  }
  if (building) return building;
  if (cached && Date.now() - cached.meta.now < MIN_REBUILD_MS)
    return Promise.resolve(cached);
  building = build()
    .then((value) => {
      cached = value;
      building = null;
      return value;
    })
    .catch((error) => {
      building = null;
      throw error;
    });
  return building;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CSP = contentSecurityPolicy(config.embed);
const CORP = crossOriginResourcePolicy(config.embed);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function headers(type, origin) {
  return {
    "content-type": type,
    "cache-control": "no-store",
    "content-security-policy": CSP,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": CORP,
    ...corsHeaders(config.embed, origin),
  };
}

/**
 * Only a loopback Host is accepted.
 *
 * Binding to 127.0.0.1 stops other machines connecting, but not a page on the
 * public internet resolving its own hostname to 127.0.0.1 and talking to this
 * server from the victim's browser. Pinning the Host header closes that.
 */
function hostAllowed(req) {
  const host = String(req.headers.host || "");
  const name = host.replace(/:\d+$/u, "").replace(/^\[|\]$/gu, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

function sendJson(res, status, body, origin, options = {}) {
  // Everything the browser receives passes through redaction first. Doing it
  // here rather than at each call site means a field added upstream is covered
  // without anyone having to remember. The two exceptions are answers that ARE
  // a credential by design — a join code to this machine's own browser, and a
  // device token to the machine that just spent a join code — and they opt out
  // by name at their single call site in lib/hub/routes.js.
  let text;
  if (options.redact === false) {
    text = JSON.stringify(body);
  } else {
    const { value, count, kinds } = redactDeep(body);
    if (value && typeof value === "object") {
      value.redaction = { count, kinds };
    }
    text = JSON.stringify(value);
  }
  res.writeHead(status, headers("application/json; charset=utf-8", origin));
  res.end(text);
}

function send(res, status, type, body, extra = {}, origin) {
  res.writeHead(status, { ...headers(type, origin), ...extra });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(
          chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
            : {},
        );
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Require explicit Console request intent for every telemetry API request.
 * A cross-origin form cannot set this header, and the server emits no CORS
 * permission, so browser-originated cross-site reads fail before data is sent.
 */
function hasConsoleIntent(req) {
  return (
    req.headers["x-agent-console"] === "1" ||
    // The console was called Muster Console before it was its own package.
    // Anything already sending the old header keeps working; both are named
    // in the CORS allow-headers list so a preflight cannot pass one and
    // refuse the other.
    req.headers["x-muster-console"] === "1"
  );
}

function serveStatic(req, res, urlPath, origin) {
  const rel = urlPath === "/" ? "index.html"
    : urlPath === "/join" ? "join.html"
    : urlPath.replace(/^\/+/u, "");
  const target = path.resolve(PUBLIC, rel);
  if (target !== PUBLIC && !target.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403, headers("text/plain; charset=utf-8", origin));
    res.end("forbidden\n");
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, headers("text/plain; charset=utf-8", origin));
      res.end("not found\n");
      return;
    }
    const head = headers(
      TYPES[path.extname(target)] || "application/octet-stream",
      origin,
    );
    // Stating the scope makes the worker registration explicit rather than
    // implicit in where the file happens to sit.
    if (path.basename(target) === "sw.js") head["service-worker-allowed"] = "/";
    res.writeHead(200, head);
    res.end(data);
  });
}

/** Open the page in the platform's default browser. Best effort, never fatal. */
function openBrowser(address) {
  if (process.platform === "darwin")
    execFile("/usr/bin/open", [address], () => {});
  else if (process.platform === "win32")
    execFile("cmd", ["/c", "start", "", address], () => {});
  else execFile("xdg-open", [address], () => {});
}

function handleRequest(req, res) {
  // The request's own origin, kept for the response's CORS headers. It is a
  // claim the browser makes on the page's behalf and is never trusted for
  // anything but matching the operator's allowlist.
  const origin = req.headers.origin;

  const url = String(req.url || "/").split("?")[0];

  // The four things another machine may reach when the hub listens on the
  // network: the join page and its assets, the package, the join exchange and
  // token-checked reporting. Everything else is behind the loopback wall below.
  if (isPublicPath(url)) {
    if (url.startsWith("/api/") || url.endsWith(".tgz")) {
      hubRoutes(req, res, url, {
        sendJson: (r, status, body, options) => sendJson(r, status, body, undefined, options),
        readBody,
        send: (r, status, type, body, extra) => send(r, status, type, body, extra),
        port: config.port,
      }).catch((error) => sendJson(res, 500, { ok: false, reason: String(error && error.message) }));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, headers("text/plain; charset=utf-8"));
      res.end("method not allowed\n");
      return;
    }
    serveStatic(req, res, url, undefined);
    return;
  }

  if (!hostAllowed(req) || !isLocalRequest(req)) {
    /* No origin is threaded here, deliberately. The Host pin is the outer
       wall — it is what stops a public page resolving its own name to
       127.0.0.1 and reading this server out of the victim's browser — and a
       request that failed it has earned nothing, including permission to read
       the refusal. Today's body is a fixed sentence and leaks nothing either
       way; the layering is the point, because the next person to add detail
       to this message should not have to rediscover it. */
    res.writeHead(421, headers("text/plain; charset=utf-8"));
    res.end("the console answers only on the machine it runs on\n");
    return;
  }
  const isApi = url === "/api" || url.startsWith("/api/");

  // A cross-origin GET carrying a custom header is preflighted. Answering it
  // is not a permission grant: `headers()` attaches CORS only for an origin
  // the operator named, so an unlisted origin gets a 204 with no permission
  // and the browser stops there.
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers("text/plain; charset=utf-8", origin));
    res.end();
    return;
  }

  if (isApi && !hasConsoleIntent(req)) {
    sendJson(
      res,
      403,
      {
        ok: false,
        reason: "missing X-Agent-Console header",
      },
      origin,
    );
    return;
  }

  if (url.startsWith("/api/console") || url.startsWith("/api/invitations") || url.startsWith("/api/devices")) {
    hubRoutes(req, res, url, {
      sendJson: (r, status, body, options) => sendJson(r, status, body, origin, options),
      readBody,
      send: (r, status, type, body, extra) => send(r, status, type, body, extra, origin),
      port: config.port,
    }).catch((error) => sendJson(res, 500, { ok: false, reason: String(error && error.message) }, origin));
    return;
  }

  if (req.method === "GET" && url === "/api") {
    snapshot().then(
      (value) => sendJson(res, 200, value, origin),
      (error) =>
        sendJson(res, 500, { error: String(error && error.message) }, origin),
    );
    return;
  }
  if (req.method === "GET" && (url === "/api/history" || url === "/api/projects")) {
    const query = new URLSearchParams(
      String(req.url || "").split("?")[1] || "",
    );
    const period = query.get("period") || "24h";
    // An empty or "all" project means the whole machine. A slug that matches
    // nothing is NOT an error — a project can legitimately have no activity in
    // the selected period, and 400ing on that would break the selector every
    // time someone narrowed the period.
    const project =
      query.get("project") && query.get("project") !== "all"
        ? query.get("project")
        : null;
    if (!PERIODS[period]) {
      sendJson(
        res,
        400,
        {
          ok: false,
          reason: "unknown period; use one of " + Object.keys(PERIODS).join(", "),
        },
        origin,
      );
      return;
    }
    const answer = url === "/api/projects"
      ? projectsPayload(period)
      : historyPayload(period, project);
    answer.then(
      (value) => sendJson(res, 200, value, origin),
      (error) =>
        sendJson(res, 500, { error: String(error && error.message) }, origin),
    );
    return;
  }
  if (req.method === "POST" && url === "/api/ack") {
    const run = async () => {
      const body = await readBody(req);
      const cleared = acknowledge(
        tracker,
        body.id === "all" ? "all" : Number(body.id),
      );
      sendJson(res, 200, { ok: true, cleared, events: tracker.events }, origin);
      return undefined;
    };
    run().catch((error) =>
      sendJson(res, 400, { ok: false, reason: String(error.message) }, origin),
    );
    return;
  }
  if (isApi) {
    sendJson(res, 404, { ok: false, reason: "no such endpoint" }, origin);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, headers("text/plain; charset=utf-8", origin));
    res.end("method not allowed\n");
    return;
  }
  serveStatic(req, res, url, origin);
}

const server = http.createServer(handleRequest);

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    process.stderr.write(
      "\n  Port " + config.port + " is already in use.\n" +
        "  Another " + PRODUCT_NAME + " is probably already running — open http://127.0.0.1:" + config.port + "\n" +
        "  or start this one on another port:  node bin/agent-console.mjs --port " + (config.port + 1) + "\n\n",
    );
    process.exit(1);
  }
  if (error.code === "EADDRNOTAVAIL") {
    process.stderr.write("\n  This machine has no network address " + config.listen + ". Try --listen 0.0.0.0.\n\n");
    process.exit(1);
  }
  process.stderr.write("\n  server error: " + error.message + "\n\n");
  process.exit(1);
});

server.listen(config.port, config.listen, () => {
  config.port = server.address().port;
  // Bound to one network address, the process would not answer on loopback —
  // and the console answers ONLY on loopback. A second listener on 127.0.0.1
  // keeps the console reachable here. (0.0.0.0 already includes loopback.)
  if (!["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(config.listen)) {
    http.createServer(handleRequest).on("error", (error) => {
      process.stderr.write("\n  could not also listen on 127.0.0.1:" + config.port + " (" + error.code + "); the console will not open here.\n\n");
    }).listen(config.port, "127.0.0.1");
  }
  const address = "http://127.0.0.1:" + config.port;
  const reach = hubAddresses(config.listen, config.port);
  if (config.json) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        dashboard: {
          name: PRODUCT_NAME,
          version: VERSION,
          url: address,
          host: config.listen,
          port: config.port,
          refreshMs: config.pollMs,
          access: reach.network ? "console loopback-only; join and reporting open to the network" : "loopback-only",
          joinUrls: reach.urls,
          demo: config.demo,
          readOnly: true,
          local: Boolean(localCollection),
          stateDir: config.stateDir,
          outbound: config.demo
            ? "disabled — deterministic in-memory demo"
            : networkPosture(),
        },
      }) + "\n",
    );
  } else {
    const lines = [
      "",
      "  " + productTitle() + "  ->  " + address,
    ];
    if (movedFrom !== null) {
      lines.push("  port " + movedFrom + " is already in use, so this console is on port " + config.port + " instead");
      if (reach.network && hubRegistry.list().some((d) => !d.local && !d.revokedAt)) {
        lines.push("  machines that joined earlier report to port " + movedFrom + " and reach this console again once it runs there");
      }
    }
    if (config.demo) {
      lines.push("  DEMO · a synthetic fleet; nothing on this machine is read, and no machine can join");
    } else {
      lines.push(localCollection
        ? "  reading this machine's Claude Code and Codex usage; data kept in " + config.stateDir
        : "  not reading this machine (--no-local); data kept in " + config.stateDir);
    }
    if (reach.network) {
      lines.push(
        "",
        "  WARNING  listening on " + config.listen + ":" + config.port + " — other machines on this network can reach",
        "           the join page and the reporting endpoint. Only machines holding a join code or a",
        "           device token get in, and the console itself still answers only on this machine.",
        "           Traffic is plain HTTP: use a network you trust, a VPN such as Tailscale or",
        "           WireGuard, or an SSH tunnel.",
        "  Other machines join at  " + reach.urls.join("  ·  "),
      );
    } else if (!config.demo) {
      lines.push("  this machine only — to connect other machines, restart with --listen 0.0.0.0");
    }
    lines.push("  Ctrl+C stops the console.", "");
    process.stdout.write(lines.join("\n") + "\n");
  }
  // "ready" once this machine has been read the first time, so a person (or a
  // test) opening the console sees figures rather than an empty first frame.
  // A first read of months of transcripts can take a while: it prints how far
  // it has got, and the browser opens after two seconds regardless — the
  // console itself shows the same progress.
  let opened = false;
  const openOnce = () => { if (config.open && !opened) { opened = true; openBrowser(address); } };
  const early = setTimeout(openOnce, 2000);
  early.unref?.();
  let progressTimer = null;
  if (localCollection && !config.json) {
    let lastLine = "";
    progressTimer = setInterval(() => {
      const p = localCollection.status.progress;
      if (localCollection.status.firstRunComplete || !p || !p.filesTotal) return;
      const line = "  reading this machine's transcripts · " + p.files.toLocaleString("en-US") + " of " +
        p.filesTotal.toLocaleString("en-US") + " files · " + p.records.toLocaleString("en-US") + " records so far";
      if (line !== lastLine) { lastLine = line; process.stdout.write(line + "\n"); }
    }, 3000);
    progressTimer.unref?.();
  }
  Promise.resolve(localCollection && localCollection.ready).then(() => {
    clearTimeout(early);
    if (progressTimer) clearInterval(progressTimer);
    if (!config.json) {
      const machines = hubRegistry.list().length;
      process.stdout.write(
        "  ready: " + (config.demo ? "demo fleet" : machines + " machine" + (machines === 1 ? "" : "s")) +
          " · " + hubStore.recordCount.toLocaleString("en-US") + " records in the last " + config.retentionDays + " days\n\n",
      );
    }
    openOnce();
  });
});
