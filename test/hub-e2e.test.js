/**
 * Many machines, one console — end to end, with real processes.
 *
 * One hub process and several reporter processes, each with its own home
 * directory of real-shaped synthetic transcripts and its own state directory,
 * talking to each other exactly as they would across a network: over TLS,
 * pinned to the hub's certificate. Every request a reporter sends passes
 * through a recording relay that holds the hub's own certificate (read from
 * the hub's state directory, as only a test can), so the privacy promise is
 * checked against the plaintext of what actually went over the wire.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CANARIES, writeHome } from "./fixtures/transcripts.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-console.mjs");
const INTENT = { "x-agent-console": "1" };

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

function run(args, { env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timed out: " + args.join(" ") + "\n" + out + err)); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** Starts a hub; resolves with its ports, fingerprint and a signed-in cookie. */
function startHub(args) {
  const child = spawn(process.execPath, [BIN, "--json", "--port", "0", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const ready = new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      if (!out.includes("\n")) return;
      clearInterval(timer);
      try {
        const meta = JSON.parse(out.split("\n")[0]).dashboard;
        const login = await fetch(meta.signIn, { redirect: "manual" });
        resolve({ ...meta, cookie: login.headers.get("set-cookie").split(";")[0] });
      } catch (error) { reject(error); }
    }, 50);
    child.on("exit", (code) => { clearInterval(timer); reject(new Error("hub exited " + code + ": " + out)); });
  });
  return { child, ready, output: () => out };
}

/**
 * A relay in front of the hub's reporting port that keeps the plaintext of
 * every request (method, path, headers and body) and of every answer the hub
 * sent back. It presents the hub's own certificate, so a reporter that pins
 * that certificate talks through it unchanged.
 */
function relay(hub, stateDir) {
  const bodies = [];
  const answers = [];
  const cert = fs.readFileSync(path.join(stateDir, "tls-cert.pem"));
  const key = fs.readFileSync(path.join(stateDir, "tls-key.pem"));
  const server = https.createServer({ cert, key }, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      bodies.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: body.toString("utf8"), authorization: req.headers.authorization || "" });
      const upstream = https.request({ host: "127.0.0.1", port: hub.reportPort, method: req.method, path: req.url, ca: cert,
        checkServerIdentity: () => undefined, headers: req.headers }, (up) => {
        const back = [];
        up.on("data", (c) => back.push(c));
        up.on("end", () => answers.push({ url: req.url, status: up.statusCode, headers: { ...up.headers }, body: Buffer.concat(back).toString("utf8") }));
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      upstream.on("error", () => { res.writeHead(502); res.end(); });
      upstream.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, bodies, answers })));
}

/** Everything a request carried: its method, path, every header and the body. */
const wholeRequest = (b) => [b.method, b.url, JSON.stringify(b.headers), b.body].join("\n");
/** Everything an answer carried: status, every header and the body. */
const wholeAnswer = (a) => [a.status, JSON.stringify(a.headers), a.body].join("\n");

/*
 * Every read the console serves, and every path the reporting port serves.
 * The privacy checks below read all of them; the last test in this file fails
 * when lib/hub/routes.js gains a GET route that is not listed here, so a new
 * way for data to reach a screen or another machine cannot skip the canaries.
 */
const CONSOLE_READS = ["/api/console", "/api/projects?period=24h", "/api/projects?period=3d", "/api/hello"];
const REPORTING_READS = ["/join", "/join.js", "/join.css", "/house.css", "/brand/mark.svg", "/favicon.svg", "/api/join/info"];

async function consoleReads(hub) {
  let text = "";
  for (const url of CONSOLE_READS) {
    const r = await fetch(hub.url + url, { headers: { ...INTENT, cookie: hub.cookie } });
    assert.equal(r.status, 200, url);
    text += `${url}\n${JSON.stringify([...r.headers])}\n${await r.text()}\n`;
  }
  return text;
}

async function reportingReads(hub) {
  let text = "";
  for (const url of REPORTING_READS) {
    const r = await fetch(`http://127.0.0.1:${hub.reportPort}${url}`);
    assert.equal(r.status, 200, url);
    text += `${url}\n${JSON.stringify([...r.headers])}\n${await r.text()}\n`;
  }
  return text;
}

async function invite(hub, person, machine) {
  const r = await fetch(`${hub.url}/api/invitations`, {
    method: "POST", headers: { ...INTENT, cookie: hub.cookie, "content-type": "application/json" },
    body: JSON.stringify({ person, machine, minutes: 30 }),
  });
  assert.equal(r.status, 200);
  return r.json();
}

async function consoleView(hub) {
  const r = await fetch(`${hub.url}/api/console`, { headers: { ...INTENT, cookie: hub.cookie } });
  assert.equal(r.status, 200);
  return r.json();
}

/** The same link, pointed at another port (the relay). */
const through = (link, port) => link.replace(/:\d+\/join#/u, `:${port}/join#`);

function readTree(dir) {
  let text = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) text += fs.readFileSync(path.join(entry.parentPath ?? entry.path, entry.name), "utf8");
  }
  return text;
}

test("two machines join by link, report, roll up by person, and nothing private crosses the wire", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-e2e-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const laptop = writeHome(path.join(root, "laptop"), {
    claude: [{ sessionId: "aaaaaaaa-0000-4000-8000-000000000001", cwd: "/home/dev/canary-secret-project-dir", model: "claude-sonnet-5", start: now - 20 * 60_000, turns: 5 }],
    codex: [{ id: "bbbbbbbb-0000-4000-8000-000000000001", cwd: "/home/dev/canary-secret-project-dir", model: "gpt-5.6-sol", start: now - 15 * 60_000, turns: 3 }],
  });
  const workstation = writeHome(path.join(root, "workstation"), {
    claude: [{ sessionId: "cccccccc-0000-4000-8000-000000000001", cwd: "/srv/canary-secret-project-dir", model: "claude-opus-5", start: now - 10 * 60_000, turns: 3, seed: 3 }],
  });

  const hubState = path.join(root, "hub");
  const started = startHub(["--no-local", "--state-dir", hubState]);
  t.after(() => started.child.kill("SIGKILL"));
  const hub = await started.ready;
  const wire = await relay(hub, hubState);
  t.after(() => wire.server.close());

  // The console makes two links; each machine runs the command it was sent,
  // pointed at the relay so every byte it sends is kept.
  const a = await invite(hub, "You", "Laptop");
  const b = await invite(hub, "Platform engineer", "Workstation");
  // The command installs from the GitHub release, never from the hub.
  assert.match(a.command, /^npx --yes https:\/\/github\.com\/SamSnead85\/agent-console\/releases\/download\/v\d+\.\d+\.\d+\/lockedinlabs-agent-console-\d+\.\d+\.\d+\.tgz join 'http:\/\/127\.0\.0\.1:\d+\/join#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}'$/u);
  const via = (inv) => through(inv.link, wire.port);

  const joinA = await run(["join", via(a), "--once", "--json", "--home", laptop, "--state-dir", path.join(root, "laptop-state")]);
  assert.equal(joinA.code, 0, joinA.out + joinA.err);
  const joinB = await run(["join", via(b), "--once", "--json", "--home", workstation, "--state-dir", path.join(root, "ws-state")]);
  assert.equal(joinB.code, 0, joinB.out + joinB.err);
  const eventsA = joinA.out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(eventsA[0].event, "joined");
  assert.ok(eventsA.some((e) => e.event === "sync" && e.accepted > 0), "the laptop's report was accepted");

  // A join code works once.
  const again = await run(["join", via(a), "--once", "--home", laptop, "--state-dir", path.join(root, "again-state")]);
  assert.notEqual(again.code, 0);
  assert.match(again.err, /not valid/u);

  const view = await consoleView(hub);
  assert.equal(view.devices.length, 2);
  for (const d of view.devices) {
    assert.equal(d.status, "reporting", d.label + " is not reporting");
    assert.ok(d.day.tokens.total > 0, d.label + " reported nothing");
    assert.equal(d.joinedVia, "link");
  }
  assert.deepEqual(view.devices.map((d) => d.person).sort(), ["Platform engineer", "You"]);
  assert.equal(view.day.tokens.total, view.devices.reduce((s, d) => s + d.day.tokens.total, 0), "the total is the machines added up");
  assert.ok(view.day.shares.cacheRead > 0.5 && view.day.shares.cacheWrite > 0);
  assert.ok(view.day.models.some((m) => m.model === "gpt-5.6-sol") && view.day.models.some((m) => m.model === "claude-opus-5"));
  assert.equal(view.invitations.filter((i) => i.state === "joined").length, 2, "the console shows who joined");
  for (const lane of view.lanes) {
    assert.deepEqual(Object.keys(lane.context).sort(), ["breaks", "growth", "latest", "priceTable", "samples", "status"]);
    for (const sample of lane.context.samples) {
      assert.deepEqual(Object.keys(sample).sort(), ["at", "tokens"]);
      assert.ok(Number.isFinite(sample.at) && Number.isSafeInteger(sample.tokens));
    }
    for (const signal of lane.context.breaks) {
      assert.deepEqual(Object.keys(signal).sort(), ["at", "estimatedExtraUsd", "gapMinutes", "kind"]);
    }
  }

  // Privacy: nothing private in anything that crossed the wire, in anything
  // the hub stored, or in what the reporters keep on their own disks.
  // "The wire" is every request whole (method, path, headers, body) and every
  // answer the hub sent back; "the console" is every read it serves.
  const sent = wire.bodies.map(wholeRequest).join("\n");
  const answered = wire.answers.map(wholeAnswer).join("\n");
  assert.ok(wire.bodies.some((b) => b.url === "/api/ingest"), "no report went through the relay");
  assert.equal(wire.answers.length, wire.bodies.length, "an answer was not recorded");
  const stored = readTree(hubState);
  const kept = readTree(path.join(root, "laptop-state")) + readTree(path.join(root, "ws-state"));
  const shown = JSON.stringify(view) + await consoleReads(hub);
  for (const canary of CANARIES) {
    assert.ok(!sent.includes(canary), `"${canary}" crossed the wire`);
    assert.ok(!answered.includes(canary), `"${canary}" came back over the wire`);
    assert.ok(!stored.includes(canary), `"${canary}" was stored by the hub`);
    assert.ok(!kept.includes(canary), `"${canary}" was kept by a reporter`);
    assert.ok(!shown.includes(canary), `"${canary}" reached the console`);
  }
  for (const b of wire.bodies.filter((x) => x.url === "/api/ingest")) {
    const envelope = JSON.parse(b.body);
    assert.deepEqual(Object.keys(envelope), ["v", "device", "freshness", "records", "backlog"]);
    // How far a catch-up has got: two counts, nothing else.
    assert.deepEqual(Object.keys(envelope.backlog), ["delivered", "total"]);
    assert.ok(Number.isSafeInteger(envelope.backlog.delivered) && Number.isSafeInteger(envelope.backlog.total));
    for (const r of envelope.records) {
      assert.deepEqual(Object.keys(r).sort(), ["at", "cacheRead", "cacheWrite", "cacheWrite1h", "cacheWrite5m", "continuation", "engagement", "executionOrigin", "fresh",
        "id", "isSubagent", "measurement", "model", "observed", "output", "parentSessionHash", "projectHash", "reportingDevice", "sessionHash", "tool", "ttl"]);
      assert.equal(typeof r.continuation, "boolean");
      assert.match(r.sessionHash, /^[0-9a-f]{64}$/u);
      assert.match(r.projectHash, /^[0-9a-f]{64}$/u);
      assert.equal(r.engagement, null, "a project name left without --share-project-names");
      assert.match(r.at, /:00\.000Z$/u, "a time finer than a minute left the machine");
    }
  }
  // Project hashes use each reporter's own key, not the salt the hub holds, so
  // the hub cannot confirm a guess of a folder path against them.
  const orgSalt = Buffer.from(JSON.parse(fs.readFileSync(path.join(root, "laptop-state", "credentials.json"), "utf8")).orgSalt, "base64url");
  const guess = crypto.createHmac("sha256", orgSalt).update("project|/home/dev/canary-secret-project-dir").digest("hex");
  assert.ok(!sent.includes(guess), "a project hash the hub could reverse by guessing the path");
  // The long-lived token went to the reporter once, and never into a URL or a file the hub keeps.
  const token = JSON.parse(fs.readFileSync(path.join(root, "laptop-state", "credentials.json"), "utf8")).token;
  assert.ok(!stored.includes(token));
  assert.ok(!wire.bodies.some((b) => b.url.includes(token)));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(root, "laptop-state", "credentials.json")).mode & 0o777, 0o600);  // Windows has no POSIX modes
  assert.ok(!joinA.out.includes(token) && !joinA.err.includes(token), "the token was printed");

  // Removing a machine stops it at once, and the reporter says so.
  const laptopId = view.devices.find((d) => d.label === "Laptop").id;
  const removed = await fetch(`${hub.url}/api/devices/${laptopId}/revoke`, { method: "POST", headers: { ...INTENT, cookie: hub.cookie } });
  assert.equal(removed.status, 200);
  const refused = await run(["report", "--once", "--json", "--home", laptop, "--state-dir", path.join(root, "laptop-state")]);
  assert.equal(refused.code, 3);
  assert.match(refused.out, /"event":"revoked"/u);
  const after = await consoleView(hub);
  assert.equal(after.devices.find((d) => d.id === laptopId).status, "revoked");
  assert.ok(after.devices.find((d) => d.id === laptopId).day.tokens.total > 0, "what it reported before removal stays");
});

test("one person's copied transcripts on two machines are counted once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-dup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = { claude: [{ sessionId: "dddddddd-0000-4000-8000-000000000001", cwd: "/home/dev/shared", start: Date.now() - 10 * 60_000, turns: 4 }] };
  const first = writeHome(path.join(root, "one"), spec);
  const second = path.join(root, "two");
  fs.cpSync(first, second, { recursive: true });

  const started = startHub(["--no-local", "--state-dir", path.join(root, "hub")]);
  t.after(() => started.child.kill("SIGKILL"));
  const hub = await started.ready;
  for (const [home, machine] of [[first, "Laptop"], [second, "Desktop"]]) {
    const inv = await invite(hub, "You", machine);
    const r = await run(["join", inv.link, "--once", "--home", home, "--state-dir", path.join(root, machine + "-state")]);
    assert.equal(r.code, 0, r.out + r.err);
  }
  const view = await consoleView(hub);
  const [laptop, desktop] = ["Laptop", "Desktop"].map((l) => view.devices.find((d) => d.label === l));
  assert.ok(laptop.day.tokens.total > 0);
  assert.equal(desktop.day.tokens.total, 0, "the copy added nothing");
  assert.equal(desktop.status, "reporting", "but the second machine is reporting, not missing");
  assert.equal(view.day.tokens.total, laptop.day.tokens.total);
  assert.equal(view.people.length, 1);
});

test("--share-project-names sends a folder's name — and still nothing else", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-names-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = writeHome(path.join(root, "home"), {
    claude: [{ sessionId: "eeeeeeee-0000-4000-8000-000000000001", cwd: "/home/dev/canary-secret-project-dir", start: Date.now() - 10 * 60_000, turns: 2 }],
  });
  const started = startHub(["--no-local", "--state-dir", path.join(root, "hub")]);
  t.after(() => started.child.kill("SIGKILL"));
  const hub = await started.ready;
  const inv = await invite(hub, "You", "Laptop");
  const state = path.join(root, "state");
  const joined = await run(["join", inv.link, "--once", "--share-project-names", "--home", home, "--state-dir", state]);
  assert.equal(joined.code, 0, joined.out + joined.err);
  // labels apply from the next record on
  fs.appendFileSync(path.join(home, ".claude", "projects", "-home-dev-canary-secret-project-dir", "eeeeeeee-0000-4000-8000-000000000001.jsonl"),
    fs.readFileSync(path.join(home, ".claude", "projects", "-home-dev-canary-secret-project-dir", "eeeeeeee-0000-4000-8000-000000000001.jsonl"), "utf8")
      .replaceAll("eeeeeeee-0000-4000-8000-000000000001-", "eeeeeeee-0000-4000-8000-000000000001-again-").replaceAll("msg_", "msg_again_"));
  const resumed = await run(["report", "--once", "--share-project-names", "--home", home, "--state-dir", state]);
  assert.equal(resumed.code, 0, resumed.out + resumed.err);
  const view = await consoleView(hub);
  const lane = view.lanes[0];
  assert.deepEqual(lane.project, { name: "canary-secret-project-dir", source: "label" });
  const shown = JSON.stringify(view);
  for (const canary of CANARIES.filter((c) => c !== "canary-secret-project-dir")) assert.ok(!shown.includes(canary), canary);
  assert.ok(!shown.includes("/home/dev"), "a path left the machine");
});

test("--share-project-names stops at once when it is left off, and leave deletes everything", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-optout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = "/home/dev/canary-secret-project-dir";
  const home = writeHome(path.join(root, "home"), { claude: [{ sessionId: "ffffffff-0000-4000-8000-000000000001", cwd, start: Date.now() - 10 * 60_000, turns: 2 }] });
  const hubState = path.join(root, "hub");
  const started = startHub(["--no-local", "--state-dir", hubState]);
  t.after(() => started.child.kill("SIGKILL"));
  const hub = await started.ready;
  const wire = await relay(hub, hubState);
  t.after(() => wire.server.close());
  const inv = await invite(hub, "You", "Laptop");
  const state = path.join(root, "state");
  assert.equal((await run(["join", through(inv.link, wire.port), "--once", "--share-project-names", "--home", home, "--state-dir", state])).code, 0);
  wire.bodies.length = 0;
  // More work in the same project, then a run WITHOUT the flag.
  writeHome(home, { claude: [{ sessionId: "ffffffff-0000-4000-8000-000000000002", cwd, start: Date.now() - 2 * 60_000, turns: 2 }] });
  const plain = await run(["report", "--once", "--json", "--home", home, "--state-dir", state]);
  assert.equal(plain.code, 0, plain.out + plain.err);
  const sent = wire.bodies.filter((b) => b.url === "/api/ingest").flatMap((b) => JSON.parse(b.body).records);
  assert.ok(sent.length > 0);
  assert.ok(sent.every((r) => r.engagement === null), "a name went out after the opt-in was turned off");
  assert.ok(!wire.bodies.some((b) => b.body.includes("canary-secret-project-dir")));

  const left = await run(["leave", "--state-dir", state]);
  assert.equal(left.code, 0);
  const remaining = fs.existsSync(state) ? fs.readdirSync(state, { recursive: true }) : [];
  assert.deepEqual(remaining, [], "leave left files behind: " + remaining.join(", "));
});

test("the hub's own machine: nothing of it leaves through the reporting port", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-hubown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  // The hub reads its own canary-filled transcripts, as a hub on a laptop does.
  const hubHome = writeHome(path.join(root, "hub-home"), {
    claude: [{ sessionId: "abababab-0000-4000-8000-000000000001", cwd: "/home/dev/canary-secret-project-dir", start: now - 12 * 60_000, turns: 3 }],
    codex: [{ id: "cdcdcdcd-0000-4000-8000-000000000001", cwd: "/home/dev/canary-secret-project-dir", start: now - 8 * 60_000, turns: 2 }],
  });
  const reporterHome = writeHome(path.join(root, "reporter-home"), {
    claude: [{ sessionId: "efefefef-0000-4000-8000-000000000001", cwd: "/home/dev/other", start: now - 5 * 60_000, turns: 2 }],
  });
  const hubState = path.join(root, "hub");
  const started = startHub(["--state-dir", hubState, "--home", hubHome]);
  t.after(() => started.child.kill("SIGKILL"));
  const hub = await started.ready;
  let view;
  for (let i = 0; i < 200; i += 1) {
    view = await consoleView(hub);
    if (view.hub.local.firstRunComplete && view.day.tokens.total > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(view.devices.some((d) => d.local && d.day.tokens.total > 0), "the hub did not read its own machine");

  const wire = await relay(hub, hubState);
  t.after(() => wire.server.close());
  const inv = await invite(hub, "Platform engineer", "Workstation");
  const joined = await run(["join", through(inv.link, wire.port), "--once", "--json", "--home", reporterHome, "--state-dir", path.join(root, "reporter-state")]);
  assert.equal(joined.code, 0, joined.out + joined.err);

  // Everything the reporting port gave another machine: the join exchange, the
  // receipts, the join page and its assets, and the join info.
  const given = wire.answers.map(wholeAnswer).join("\n") + await reportingReads(hub);
  const kept = readTree(path.join(root, "reporter-state")) + joined.out + joined.err;
  assert.ok(wire.answers.some((a) => a.url === "/api/join" && a.status === 200));
  for (const canary of CANARIES) {
    assert.ok(!given.includes(canary), `"${canary}" from the hub's own machine left through the reporting port`);
    assert.ok(!kept.includes(canary), `"${canary}" from the hub's own machine reached the reporter`);
  }
});

test("every GET route the hub serves is read by the privacy checks above", () => {
  const source = fs.readFileSync(new URL("../lib/hub/routes.js", import.meta.url), "utf8");
  const routes = new Set();
  for (const m of source.matchAll(/url === (["'])(\/[^"']+)\1 && req\.method === (["'])GET\3/gu)) routes.add(m[2]);
  for (const m of source.matchAll(/\[(["'])(\/[^"']+)\1, (["'])[^"']+\3\]/gu)) routes.add(m[2]);   // the join page's assets
  const read = new Set([...CONSOLE_READS, ...REPORTING_READS].map((u) => u.split("?")[0]));
  // /login answers a single-use ticket with a redirect or a fixed refusal: no data.
  const unchecked = [...routes].filter((r) => !read.has(r) && r !== "/login");
  assert.ok(routes.has("/api/console") && routes.has("/join"), "the route pattern no longer matches lib/hub/routes.js");
  assert.deepEqual(unchecked, [], "add these to CONSOLE_READS or REPORTING_READS so the canaries cover them");
});
