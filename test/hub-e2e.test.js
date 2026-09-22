/**
 * Many machines, one console — end to end, with real processes.
 *
 * One hub process and several reporter processes, each with its own home
 * directory of real-shaped synthetic transcripts and its own state directory,
 * talking HTTP exactly as they would across a network. Every byte a reporter
 * sends passes through a recording relay, so the privacy promise is checked
 * against what actually went over the wire — not against a function's return
 * value.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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

function startHub(args) {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const ready = new Promise((resolve, reject) => {
    const timer = setInterval(() => { if (out.includes("ready:")) { clearInterval(timer); resolve(out); } }, 50);
    child.on("exit", (code) => { clearInterval(timer); reject(new Error("hub exited " + code + ": " + out)); });
  });
  return { child, ready, output: () => out };
}

/** A relay in front of the hub that keeps a copy of every request body. */
function relay(targetPort) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      bodies.push({ url: req.url, body: body.toString("utf8"), authorization: req.headers.authorization || "" });
      const upstream = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url,
        headers: { ...req.headers, host: "127.0.0.1:" + targetPort } }, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      upstream.on("error", () => { res.writeHead(502); res.end(); });
      upstream.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, bodies })));
}

async function invite(port, person, machine) {
  const r = await fetch(`http://127.0.0.1:${port}/api/invitations`, {
    method: "POST", headers: { ...INTENT, "content-type": "application/json" },
    body: JSON.stringify({ person, machine, minutes: 30 }),
  });
  assert.equal(r.status, 200);
  return r.json();
}

async function consoleView(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/console`, { headers: INTENT });
  assert.equal(r.status, 200);
  return r.json();
}

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

  const port = await freePort();
  const hubState = path.join(root, "hub");
  const hub = startHub(["--no-local", "--port", String(port), "--state-dir", hubState]);
  t.after(() => hub.child.kill("SIGKILL"));
  await hub.ready;
  const wire = await relay(port);
  t.after(() => wire.server.close());

  // The owner makes two links; each machine runs the command it was sent,
  // pointed at the relay so every byte it sends is kept.
  const a = await invite(port, "You", "Laptop");
  const b = await invite(port, "Platform engineer", "Workstation");
  assert.match(a.npx, /^npx --yes http:\/\/127\.0\.0\.1:\d+\/agent-console-\d+\.\d+\.\d+\.tgz join http:\/\/127\.0\.0\.1:\d+ [2-9A-Z]{4}-[2-9A-Z]{4}$/u);
  const via = (inv) => `http://127.0.0.1:${wire.port}/join#${inv.code}`;

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

  const view = await consoleView(port);
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

  // Privacy: nothing private in anything that crossed the wire, in anything
  // the hub stored, or in what the reporters keep on their own disks.
  const sent = wire.bodies.map((b) => b.body).join("\n");
  assert.ok(wire.bodies.some((b) => b.url === "/api/ingest"), "no report went through the relay");
  const stored = readTree(hubState);
  const kept = readTree(path.join(root, "laptop-state")) + readTree(path.join(root, "ws-state"));
  const shown = JSON.stringify(view);
  for (const canary of CANARIES) {
    assert.ok(!sent.includes(canary), `"${canary}" crossed the wire`);
    assert.ok(!stored.includes(canary), `"${canary}" was stored by the hub`);
    assert.ok(!kept.includes(canary), `"${canary}" was kept by a reporter`);
    assert.ok(!shown.includes(canary), `"${canary}" reached the console`);
  }
  for (const b of wire.bodies.filter((x) => x.url === "/api/ingest")) {
    const envelope = JSON.parse(b.body);
    assert.deepEqual(Object.keys(envelope), ["v", "device", "freshness", "records"]);
    for (const r of envelope.records) {
      assert.deepEqual(Object.keys(r).sort(), ["at", "cacheRead", "cacheWrite", "cacheWrite1h", "cacheWrite5m", "engagement", "executionOrigin", "fresh",
        "id", "isSubagent", "measurement", "model", "observed", "output", "parentSessionHash", "projectHash", "reportingDevice", "sessionHash", "tool", "ttl"]);
      assert.match(r.sessionHash, /^[0-9a-f]{64}$/u);
      assert.match(r.projectHash, /^[0-9a-f]{64}$/u);
      assert.equal(r.engagement, null, "a project name left without --share-project-names");
      assert.match(r.at, /:00\.000Z$/u, "a time finer than a minute left the machine");
    }
  }
  // The long-lived token went to the reporter once, and never into a URL or a file the hub keeps.
  const token = JSON.parse(fs.readFileSync(path.join(root, "laptop-state", "credentials.json"), "utf8")).token;
  assert.ok(!stored.includes(token));
  assert.ok(!wire.bodies.some((b) => b.url.includes(token)));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(root, "laptop-state", "credentials.json")).mode & 0o777, 0o600);  // Windows has no POSIX modes
  assert.ok(!joinA.out.includes(token) && !joinA.err.includes(token), "the token was printed");

  // Removing a machine stops it at once, and the reporter says so.
  const laptopId = view.devices.find((d) => d.label === "Laptop").id;
  const removed = await fetch(`http://127.0.0.1:${port}/api/devices/${laptopId}/revoke`, { method: "POST", headers: INTENT });
  assert.equal(removed.status, 200);
  const refused = await run(["report", "--once", "--json", "--home", laptop, "--state-dir", path.join(root, "laptop-state")]);
  assert.equal(refused.code, 3);
  assert.match(refused.out, /"event":"revoked"/u);
  const after = await consoleView(port);
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

  const port = await freePort();
  const hub = startHub(["--no-local", "--port", String(port), "--state-dir", path.join(root, "hub")]);
  t.after(() => hub.child.kill("SIGKILL"));
  await hub.ready;
  const base = `http://127.0.0.1:${port}`;
  for (const [home, machine] of [[first, "Laptop"], [second, "Desktop"]]) {
    const inv = await invite(port, "You", machine);
    const r = await run(["join", `${base}/join#${inv.code}`, "--once", "--home", home, "--state-dir", path.join(root, machine + "-state")]);
    assert.equal(r.code, 0, r.out + r.err);
  }
  const view = await consoleView(port);
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
  const port = await freePort();
  const hub = startHub(["--no-local", "--port", String(port), "--state-dir", path.join(root, "hub")]);
  t.after(() => hub.child.kill("SIGKILL"));
  await hub.ready;
  const inv = await invite(port, "You", "Laptop");
  const state = path.join(root, "state");
  const joined = await run(["join", `http://127.0.0.1:${port}/join#${inv.code}`, "--once", "--share-project-names", "--home", home, "--state-dir", state]);
  assert.equal(joined.code, 0, joined.out + joined.err);
  // labels apply from the next record on
  fs.appendFileSync(path.join(home, ".claude", "projects", "-home-dev-canary-secret-project-dir", "eeeeeeee-0000-4000-8000-000000000001.jsonl"),
    fs.readFileSync(path.join(home, ".claude", "projects", "-home-dev-canary-secret-project-dir", "eeeeeeee-0000-4000-8000-000000000001.jsonl"), "utf8")
      .replaceAll("eeeeeeee-0000-4000-8000-000000000001-", "eeeeeeee-0000-4000-8000-000000000001-again-").replaceAll("msg_", "msg_again_"));
  const resumed = await run(["report", "--once", "--share-project-names", "--home", home, "--state-dir", state]);
  assert.equal(resumed.code, 0, resumed.out + resumed.err);
  const view = await consoleView(port);
  const lane = view.lanes[0];
  assert.deepEqual(lane.project, { name: "canary-secret-project-dir", source: "label" });
  const shown = JSON.stringify(view);
  for (const canary of CANARIES.filter((c) => c !== "canary-secret-project-dir")) assert.ok(!shown.includes(canary), canary);
  assert.ok(!shown.includes("/home/dev"), "a path left the machine");
});

test("the network sees only the join page, the package, the join exchange and token-checked reporting", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-wall-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const port = await freePort();
  const hub = startHub(["--no-local", "--port", String(port), "--state-dir", path.join(root, "hub")]);
  t.after(() => hub.child.kill("SIGKILL"));
  await hub.ready;
  // A request that claims another Host is what a page on another origin (or
  // another machine) produces; the console must refuse it, the join path must not.
  const as = (p, init = {}) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: init.method || "GET",
      headers: { host: "192.168.1.20:" + port, ...(init.headers || {}) } }, (res) => {
      let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.end(init.body);
  });
  for (const p of ["/", "/api/console", "/api", "/api/history", "/console.js"]) {
    assert.equal((await as(p, { headers: INTENT })).status, 421, p + " answered a foreign host");
  }
  assert.equal((await as("/api/invitations", { method: "POST", headers: INTENT, body: "{}" })).status, 421);
  for (const p of ["/join", "/join.js", "/house.css", "/api/join/info"]) assert.equal((await as(p)).status, 200, p);
  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const tgz = await as(`/agent-console-${version}.tgz`);
  assert.equal(tgz.status, 200);
  assert.equal((await as("/agent-console-0.0.1.tgz")).status, 404, "a version this hub does not serve");
  assert.equal((await as("/api/ingest", { method: "POST", headers: { authorization: "Bearer acd_" + "x".repeat(43) }, body: "{}" })).status, 401);
  // guessing codes is rate limited
  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    const r = await as("/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "AAAA-AAAA" }) });
    if (r.status === 429) { limited = true; break; }
    assert.equal(r.status, 404);
  }
  assert.ok(limited, "ten wrong codes did not slow the guesser down");
});
