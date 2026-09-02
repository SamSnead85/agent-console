import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readConfig } from "../lib/config.js";
import {
  DEMO_LABEL,
  createDemoHistory,
  createDemoSnapshot,
} from "../lib/demo.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startDemo(port, args, env) {
  const child = spawn(
    process.execPath,
    [SERVER, "--demo", "--port", String(port), ...(args || [])],
    {
      env: { ...process.env, ...(env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (!output.includes("ready:")) return;
      clearInterval(timer);
      resolve(output);
    }, 25);
    child.once("exit", (code) => {
      clearInterval(timer);
      reject(new Error("demo server exited with " + code + ": " + output));
    });
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error("demo server never became ready: " + output));
    }, 15_000).unref();
  });
  return { child, ready, output: () => output };
}

test("demo payload is deterministic, rich and contains no operator identity", () => {
  const first = createDemoSnapshot();
  const second = createDemoSnapshot();
  assert.deepEqual(second, first, "the fixture changed between two builds");

  assert.deepEqual(first.demo, {
    enabled: true,
    label: DEMO_LABEL,
    synthetic: true,
    notice:
      "Every identity, project, path, token, cost, process, commit and package on this screen is synthetic.",
  });
  assert.match(first.meta.host, /^DEMO DATA\b/u);
  assert.equal(first.meta.scan.files, 0);
  assert.equal(first.meta.scan.bytes, 0);
  assert.equal(first.meta.killEnabled, false);
  assert.equal(first.fleet.enabled, false);
  assert.equal(first.header.total > 50_000_000, true);
  assert.equal(first.header.costTotal > 0, true);
  assert.equal(first.burn.minutes.length, 60);
  assert.equal(
    first.header.total,
    first.rows
      .filter((row) => row.vendor === "claude")
      .reduce((sum, row) => sum + row.total, 0),
    "thread-cumulative Codex counters leaked into the Claude day total",
  );
  assert.ok(
    Math.abs(
      first.header.costTotal -
        first.rows
          .filter((row) => row.priced)
          .reduce((sum, row) => sum + row.cost, 0),
    ) < 1e-9,
    "header cost does not reconcile to the priced rows",
  );
  for (const row of first.rows) {
    assert.equal(
      row.total,
      row.tok.in + row.tok.out + row.tok.cr + row.tok.cw,
      row.id + " token classes do not reconcile to its total",
    );
  }

  const vendors = new Set();
  for (const machine of first.roster.machines) {
    for (const session of machine.sessions) vendors.add(session.vendor);
  }
  assert.deepEqual([...vendors].sort(), [
    "claude",
    "codex",
    "gemini",
    "human",
  ]);
  assert.equal(first.roster.machines.length, 3);
  assert.equal(first.roster.counts.sessions, 6);
  assert.equal(first.roster.counts.vendors, 4);
  assert.equal(first.roster.counts.unknown, 2);
  assert.match(first.roster.headline, /3 AI vendors \+ human/u);
  assert.ok(
    first.roster.machines
      .flatMap((machine) => machine.sessions)
      .some(
        (session) =>
          session.name === "DEMO-LAPTOP-HUMAN" &&
          session.vendor === "human" &&
          session.tokens === null &&
          session.models.length === 0,
      ),
    "the fixture must show a human and AI agents on the same ledger",
  );
  assert.ok(
    first.roster.machines
      .flatMap((machine) => machine.sessions)
      .some(
        (session) =>
          session.state === "UNKNOWN" && session.tokens === null,
      ),
    "the fixture must demonstrate an honest unmeasured remote session",
  );

  const packages = first.muster.packages;
  assert.ok(packages.some((item) => item.dependsOn.length > 0));
  assert.ok(packages.some((item) => item.blockedByIds.length > 0));
  assert.ok(packages.every((item) => Array.isArray(item.writes)));
  assert.ok(first.muster.flagged.some((item) => item.kind === "BLOCKED"));
  const packageIds = new Set(packages.map((item) => item.id));
  const sessionNames = new Set(
    first.muster.sessions.map((session) => session.name),
  );
  for (const item of packages) {
    for (const dependency of item.dependsOn) {
      assert.ok(packageIds.has(dependency), item.id + " has a missing dependency");
    }
    for (const blocker of item.blockedByIds) {
      assert.ok(packageIds.has(blocker), item.id + " has a missing blocker");
    }
    if (item.owner) {
      assert.ok(sessionNames.has(item.owner), item.id + " has an unknown owner");
    }
  }
  for (const session of first.muster.sessions) {
    assert.ok(
      !session.package || packageIds.has(session.package),
      session.name + " holds a package absent from the board",
    );
  }
  assert.match(first.master.cause, /^DEMO DATA\b/u);
  assert.match(first.roster.headline, /^DEMO DATA\b/u);
  assert.match(first.muster.source, /^DEMO DATA\b/u);

  const serialized = JSON.stringify({
    snapshot: first,
    history: createDemoHistory({ period: "all" }),
  });
  assert.equal(serialized.includes("gpt-5.6-codex"), false);
  assert.equal(serialized.includes("gpt-5.6-sol"), true);
  const forbidden = [
    os.homedir(),
    process.cwd(),
    "/Users/",
    "ssweilem",
    "SamSnead",
    "PRIVATE_CANARY_DO_NOT_READ",
  ];
  for (const value of forbidden) {
    assert.equal(
      serialized.includes(value),
      false,
      "demo payload disclosed operator text: " + value,
    );
  }
});

test("demo history is deterministic, period-scoped and project-scoped", () => {
  const first = createDemoHistory({ period: "24h" });
  assert.deepEqual(first, createDemoHistory({ period: "24h" }));
  assert.equal(first.demo.label, DEMO_LABEL);
  assert.equal(first.period.id, "24h");
  assert.equal(first.series.length, 288);
  assert.equal(first.totals.total > 0, true);
  assert.equal(first.totals.costTotal > 0, true);
  assert.equal(first.projects.projects.length, 3);
  assert.equal(first.code.repos.length, 3);
  assert.equal(first.attribution.sessions.length > 0, true);
  assert.match(first.coverage.note, /^DEMO DATA\b/u);
  assert.equal(first.coverage.snapshotFile, null);

  const scoped = createDemoHistory({
    period: "24h",
    project: "demo-muster",
  });
  assert.equal(scoped.scope.slug, "demo-muster");
  assert.equal(scoped.scope.label, "Muster");
  assert.ok(scoped.totals.total > 0);
  assert.ok(scoped.totals.total < first.totals.total);
  assert.ok(scoped.bySession.every((row) => row.project === "Muster"));
});

test("--demo and MUSTER_CONSOLE_DEMO force every capability off", () => {
  for (const config of [
    readConfig(
      [
        "--demo",
        "--allow-terminate",
        "--home",
        "/private/operator-home",
        "--repo",
        "/private/operator-repo",
        "--history-dir",
        "/private/operator-history",
      ],
      {},
    ),
    readConfig([], {
      MUSTER_CONSOLE_DEMO: "1",
      MUSTER_CONSOLE_ALLOW_TERMINATE: "1",
    }),
  ]) {
    assert.equal(config.demo, true);
    assert.equal(config.killEnabled, false);
    assert.equal(config.githubEnabled, false);
    assert.equal(config.musterEnabled, false);
    assert.equal(config.ingestEnabled, false);
    assert.equal(config.historyDir, null);
    assert.equal(config.home.includes("operator"), false);
    assert.equal(config.repoRoot.includes("operator"), false);
  }
});

test(
  "demo server does not call filesystem, process, git, ledger or history scanners",
  { timeout: 25_000 },
  async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "muster-demo-proof-"));
    const trap = path.join(temp, "private-state-trap");
    const marker = path.join(temp, "scanner-called.txt");
    const hook = path.join(temp, "deny-private-scans.mjs");
    fs.mkdirSync(path.join(trap, ".claude", "projects", "canary"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(trap, "repo", ".git"), { recursive: true });
    fs.mkdirSync(path.join(trap, "history"), { recursive: true });
    fs.writeFileSync(
      path.join(trap, ".claude", "projects", "canary", "session.jsonl"),
      "PRIVATE_CANARY_DO_NOT_READ\n",
    );
    fs.writeFileSync(
      path.join(trap, "history", "progress.json"),
      '{"summary":"PRIVATE_CANARY_DO_NOT_READ"}\n',
    );

    // Loaded before server.js. It turns any private-state read/write or any
    // scanner subprocess into a marker plus an exception. Static asset reads
    // remain allowed because they live outside the trap directory.
    fs.writeFileSync(
      hook,
      `
import fs from "node:fs";
import cp from "node:child_process";
import net from "node:net";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const trap = path.resolve(process.env.MUSTER_DEMO_TRAP_ROOT);
const marker = process.env.MUSTER_DEMO_TRAP_MARKER;
const rawAppend = fs.appendFileSync.bind(fs);
function hit(kind, target) {
  rawAppend(marker, kind + " " + String(target) + "\\n");
  throw new Error("demo touched private state: " + kind + " " + target);
}
function trapped(target) {
  if (typeof target !== "string" && !(target instanceof URL)) return false;
  const resolved = path.resolve(String(target instanceof URL ? target.pathname : target));
  return resolved === trap || resolved.startsWith(trap + path.sep);
}
for (const name of [
  "accessSync", "appendFileSync", "existsSync", "lstatSync", "mkdirSync",
  "openSync", "readFileSync", "readdirSync", "statSync", "writeFileSync"
]) {
  const original = fs[name].bind(fs);
  fs[name] = function (target, ...args) {
    if (trapped(target)) hit("fs." + name, target);
    return original(target, ...args);
  };
}
for (const name of ["access", "readFile", "readdir", "stat", "lstat", "open"] ) {
  const original = fs[name].bind(fs);
  fs[name] = function (target, ...args) {
    if (trapped(target)) hit("fs." + name, target);
    return original(target, ...args);
  };
}
const rawExecFile = cp.execFile.bind(cp);
cp.execFile = function (file, ...args) {
  const command = path.basename(String(file));
  if (["ps", "git", "gh", "muster"].includes(command)) hit("execFile", file);
  return rawExecFile(file, ...args);
};
for (const name of ["connect", "createConnection"]) {
  const original = net[name].bind(net);
  net[name] = function (...args) {
    const first = args[0];
    const host = typeof first === "object" && first
      ? String(first.host || first.hostname || "")
      : typeof args[1] === "string"
        ? args[1]
        : "";
    if (host && !["127.0.0.1", "localhost", "::1"].includes(host)) {
      hit("net." + name, first || "outbound socket");
    }
    return original(...args);
  };
}
syncBuiltinESMExports();
`,
    );

    const port = await freePort();
    const nodeOptions = [
      process.env.NODE_OPTIONS || "",
      "--import=" + pathToFileURL(hook).href,
    ]
      .filter(Boolean)
      .join(" ");
    const server = startDemo(
      port,
      [
        "--allow-terminate",
        "--home",
        trap,
        "--repo",
        path.join(trap, "repo"),
        "--history-dir",
        path.join(trap, "history"),
      ],
      {
        NODE_OPTIONS: nodeOptions,
        MUSTER_DEMO_TRAP_ROOT: trap,
        MUSTER_DEMO_TRAP_MARKER: marker,
      },
    );
    t.after(() => {
      server.child.kill("SIGKILL");
      fs.rmSync(temp, { recursive: true, force: true });
    });
    await server.ready;
    const base = "http://127.0.0.1:" + port;

    const intent = { "x-muster-console": "1" };
    const apiResponse = await fetch(base + "/api", { headers: intent });
    assert.equal(apiResponse.status, 200);
    const apiText = await apiResponse.text();
    assert.equal(apiText.includes("PRIVATE_CANARY_DO_NOT_READ"), false);
    const api = JSON.parse(apiText);
    assert.equal(api.demo.enabled, true);
    assert.equal(api.meta.scan.files, 0);
    assert.equal(api.meta.killEnabled, false);

    const historyResponse = await fetch(base + "/api/history?period=24h", {
      headers: intent,
    });
    assert.equal(historyResponse.status, 200);
    const historyText = await historyResponse.text();
    assert.equal(historyText.includes("PRIVATE_CANARY_DO_NOT_READ"), false);
    assert.equal(JSON.parse(historyText).demo.enabled, true);

    const register = await fetch(base + "/api/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...intent,
      },
      body: JSON.stringify({ id: "must-not-write" }),
    });
    assert.equal(register.status, 404);

    const terminate = await fetch(base + "/api/kill/prepare", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...intent,
      },
      body: JSON.stringify({ pid: process.pid, fingerprint: "fake" }),
    });
    assert.equal(terminate.status, 404);

    const missingIntent = await fetch(base + "/api");
    assert.equal(missingIntent.status, 403);

    assert.equal(
      fs.existsSync(marker),
      false,
      fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "",
    );

    // The original loopback Host pin is still in force in demo mode.
    const reboundStatus = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api",
          headers: { Host: "attacker.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(reboundStatus, 421);
  },
);
