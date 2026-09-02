#!/usr/bin/env node
/**
 * The console — a glass cockpit for the AI coding sessions on this machine.
 *
 * Node standard library only: no npm dependency, no build step, nothing to
 * install. Binds 127.0.0.1 and exposes coordination-read-only telemetry. Ledger
 * refresh may contact the configured Git origin; the console never mutates a
 * process, session, repository, or remote coordination record.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BIND_ADDRESS, HELP, readConfig } from "./lib/config.js";
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

if (config.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

// A rejected origin must never degrade into "embedding is off". An operator
// who passed --embed expects a door; a typo that silently leaves the wall
// intact is the same failure shape as a control that reports a pass it did
// not earn.
if (config.embedErrors.length) {
  for (const problem of config.embedErrors) {
    process.stderr.write("\n  " + problem + "\n");
  }
  process.stderr.write("\n");
  process.exit(2);
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
  if (config.demo) return createDemoSnapshot({ pollMs: config.pollMs });
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

const MIN_REBUILD_MS = 1500;

function snapshot() {
  if (config.demo) {
    if (!cached) cached = createDemoSnapshot({ pollMs: config.pollMs });
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

function sendJson(res, status, body, origin) {
  // Everything the browser receives passes through redaction first. Doing it
  // here rather than at each call site means a field added upstream is covered
  // without anyone having to remember.
  const { value, count, kinds } = redactDeep(body);
  if (value && typeof value === "object") {
    value.redaction = { count, kinds };
  }
  const text = JSON.stringify(value);
  res.writeHead(status, headers("application/json; charset=utf-8", origin));
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
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
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/u, "");
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

const server = http.createServer((req, res) => {
  // The request's own origin, kept for the response's CORS headers. It is a
  // claim the browser makes on the page's behalf and is never trusted for
  // anything but matching the operator's allowlist.
  const origin = req.headers.origin;

  if (!hostAllowed(req)) {
    /* No origin is threaded here, deliberately. The Host pin is the outer
       wall — it is what stops a public page resolving its own name to
       127.0.0.1 and reading this server out of the victim's browser — and a
       request that failed it has earned nothing, including permission to read
       the refusal. Today's body is a fixed sentence and leaks nothing either
       way; the layering is the point, because the next person to add detail
       to this message should not have to rediscover it. */
    res.writeHead(421, headers("text/plain; charset=utf-8"));
    res.end("this server answers only to a loopback host\n");
    return;
  }
  const url = String(req.url || "/").split("?")[0];
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

  if (req.method === "GET" && url === "/api") {
    snapshot().then(
      (value) => sendJson(res, 200, value, origin),
      (error) =>
        sendJson(res, 500, { error: String(error && error.message) }, origin),
    );
    return;
  }
  if (req.method === "GET" && url === "/api/history") {
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
    // Like the main demo snapshot, history is a separate deterministic source,
    // not a sanitized view of the operator's history or repository.
    if (config.demo) {
      sendJson(
        res,
        200,
        createDemoHistory({
          period,
          project,
        }),
        origin,
      );
      return;
    }
    // The ordinary snapshot runs first so the history reflects the newest
    // scan pass, and so session keys can be named from the live roster.
    snapshot().then(
      async (snap) => {
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
        sendJson(
          res,
          200,
          {
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
          },
          origin,
        );
      },
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
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    process.stderr.write(
      "\n  port " +
        config.port +
        " is already in use on " +
        BIND_ADDRESS +
        ".\n  Another " + PRODUCT_NAME + " is probably already running; open http://localhost:" +
        config.port +
        "\n  or start this one with --port <n>.\n\n",
    );
    process.exit(1);
  }
  process.stderr.write("\n  server error: " + error.message + "\n\n");
  process.exit(1);
});

server.listen(config.port, BIND_ADDRESS, () => {
  const address = "http://localhost:" + config.port;
  if (config.json) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        dashboard: {
          name: PRODUCT_NAME,
          url: address,
          host: BIND_ADDRESS,
          port: config.port,
          refreshMs: config.pollMs,
          access: "loopback-only",
          demo: config.demo,
          readOnly: true,
          outbound: config.demo
            ? "disabled — deterministic in-memory demo"
            : networkPosture(),
        },
      }) + "\n",
    );
  } else {
    process.stdout.write(
      "\n  " + productTitle() + "  ->  " +
        address +
        "\n  bound to " +
        BIND_ADDRESS +
        (config.demo
          ? " · DEMO DATA · deterministic in-memory fixture\n"
          : "") +
        (config.demo
          ? "  no transcript, process, repository, ledger, or history scans\n" +
            "  outbound network disabled; alert acknowledgement is in-memory only\n\n"
          : "  coordination read-only; process and session mutation routes are not exposed\n" +
            "  network: " +
            networkPosture() +
            "\n  first scan reads recent local session logs and may refresh the coordination ledger\n\n"),
    );
  }
  snapshot().then(
    (value) => {
      if (!config.json) {
        process.stdout.write(
          "  ready: " +
            value.roster.headline +
            " · " +
            value.header.sessionCount +
            " rows · " +
            value.header.total.toLocaleString() +
            " Claude tokens today · $" +
            value.header.costTotal.toFixed(2) +
            " estimated · scan " +
            value.meta.scan.ms +
            "ms\n\n",
        );
      }
      if (config.open) openBrowser(address);
    },
    (error) =>
      process.stderr.write("  first scan failed: " + error.message + "\n"),
  );
});
