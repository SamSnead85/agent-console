import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireStateLock } from "../lib/hub/state-lock.js";
import { createRegistry } from "../lib/hub/registry.js";
import { pinnedFetch } from "../lib/collector/pinned.js";

const BIN = fileURLToPath(new URL("../bin/agent-console.mjs", import.meta.url));
const LOCK_MODULE = new URL("../lib/hub/state-lock.js", import.meta.url).href;

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function childProcess(t, args) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output, errors }));
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("synthetic hub startup timed out")); }, 15_000);
    child.stdout.on("data", () => {
      if (!output.includes("\n")) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(output.split("\n")[0])); }
      catch { reject(new Error("synthetic hub returned invalid startup metadata")); }
    });
    closed.then((result) => { clearTimeout(timer); reject(new Error("synthetic hub exited before startup: " + result.code)); }, reject);
  });
  // A refusal is expected in several cases; callers inspect closed instead.
  ready.catch(() => {});
  async function stop(signal = "SIGTERM") {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return closed;
  }
  t.after(() => stop("SIGKILL"));
  return { child, ready, closed, stop };
}

function hub(t, dir, extra = []) {
  return childProcess(t, [BIN, "--json", "--no-local", "--state-dir", dir, "--port", "0", "--report-port", "0", ...extra]);
}

function ownerProcess(t, dir) {
  return childProcess(t, ["--input-type=module", "-e", `
    import { acquireStateLock } from ${JSON.stringify(LOCK_MODULE)};
    const lock = acquireStateLock(process.argv[1]);
    process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
    setInterval(() => {}, 1000);
  `, dir]);
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function signIn(meta) {
  const response = await fetch(meta.signIn, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";")[0];
}

async function ingestStatus(meta, dir, token) {
  const request = pinnedFetch({ certificate: fs.readFileSync(path.join(dir, "tls-cert.pem"), "utf8"), fingerprint: meta.fingerprint });
  const response = await request("https://127.0.0.1:" + meta.reportPort + "/api/ingest", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(5000),
  });
  return response.status;
}

test("one physical directory has one live owner, including symlink aliases and old locks", (t) => {
  const root = scratch(t);
  const dir = path.join(root, "state");
  const first = acquireStateLock(dir);
  t.after(() => first.release());
  const alias = path.join(root, "alias");
  fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
  fs.utimesSync(path.join(dir, "hub.lock"), new Date(0), new Date(0));
  assert.throws(() => acquireStateLock(alias), { code: "ELOCKED" });
  first.release();
  const second = acquireStateLock(alias);
  assert.equal(second.dir, fs.realpathSync(dir));
  first.release(); // an old cleanup cannot release its successor
  assert.throws(() => acquireStateLock(dir), { code: "ELOCKED" });
  second.release();
});

test("ambiguous or foreign-host ownership fails closed", (t) => {
  const dir = scratch(t);
  const lock = path.join(dir, "hub.lock");
  fs.writeFileSync(lock, "{");
  assert.throws(() => acquireStateLock(dir), { code: "ELOCKED" });
  fs.writeFileSync(lock, JSON.stringify({ v: 1, pid: process.pid, host: os.hostname() + "-other", nonce: "a".repeat(32) }));
  assert.throws(() => acquireStateLock(dir), { code: "ELOCKED" });
});

test("a killed owner is recovered, and simultaneous recovery never admits two owners", async (t) => {
  const dir = scratch(t);
  const initial = ownerProcess(t, dir);
  await initial.ready;
  await initial.stop("SIGKILL");
  const a = ownerProcess(t, dir), b = ownerProcess(t, dir);
  const results = await Promise.allSettled([a.ready, b.ready]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const winner = results[0].status === "fulfilled" ? a : b;
  const loser = winner === a ? b : a;
  assert.equal((await loser.closed).code, 1);
  assert.throws(() => acquireStateLock(dir), { code: "ELOCKED" });
  await winner.stop("SIGKILL");
  const recovered = acquireStateLock(dir);
  recovered.release();
});

test("startup errors release the directory before persisted components finish initializing", async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, "hub.json"), "{}");
  const failed = hub(t, dir);
  assert.equal((await failed.closed).code, 1);
  assert.equal(fs.existsSync(path.join(dir, "hub.lock")), false);
  const lock = acquireStateLock(dir);
  lock.release();
});

test("recovery also survives a crashed recovery claimant", async (t) => {
  const root = scratch(t);
  const dir = path.join(root, "state");
  const initial = ownerProcess(t, dir);
  await initial.ready;
  const original = JSON.parse(fs.readFileSync(path.join(dir, "hub.lock"), "utf8"));
  await initial.stop("SIGKILL");
  const otherDir = path.join(root, "claimant");
  const claimant = ownerProcess(t, otherDir);
  await claimant.ready;
  const claimRecord = fs.readFileSync(path.join(otherDir, "hub.lock"));
  await claimant.stop("SIGKILL");
  // The first recovery process crashed after claiming the old owner but before
  // removing its lock. Both PIDs are real children that have already exited.
  const recovery = path.join(dir, ".hub-lock-recovery");
  fs.mkdirSync(recovery);
  fs.writeFileSync(path.join(recovery, original.nonce), claimRecord);
  const recovered = acquireStateLock(dir);
  assert.throws(() => acquireStateLock(dir), { code: "ELOCKED" });
  recovered.release();
});

test("different-port and port-zero hub starts cannot resurrect a revoked device", async (t) => {
  const dir = scratch(t);
  const registry = createRegistry({ dir });
  const invitation = registry.invite({ machine: "Synthetic device" });
  const enrolled = registry.redeem(invitation.linkCode);
  const first = hub(t, dir);
  const { dashboard } = await first.ready;
  const cookie = await signIn(dashboard);
  assert.equal(await ingestStatus(dashboard, dir, enrolled.token), 400, "the enrolled token passes authentication before revocation");

  for (const extra of [[], ["--port", String(await unusedPort())]]) {
    const competing = hub(t, dir, extra);
    const refusal = await competing.closed;
    assert.equal(refusal.code, 1);
    // Named, with the process holding it and the command that stops it (lib/hub/notices.js).
    assert.match(refusal.errors, /Another Agent Console \(process \d+[^)]*\) is using .*\n.*stop it first: +(kill|taskkill)/u);
  }
  const revoke = await fetch(dashboard.url + "/api/devices/" + enrolled.device.id + "/revoke", {
    method: "POST", headers: { "x-agent-console": "1", cookie }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(revoke.status, 200);
  assert.equal(await ingestStatus(dashboard, dir, enrolled.token), 401);
  await first.stop();
  if (process.platform !== "win32") assert.equal(fs.existsSync(path.join(dir, "hub.lock")), false);

  const restarted = hub(t, dir);
  const next = (await restarted.ready).dashboard;
  assert.equal(await ingestStatus(next, dir, enrolled.token), 401);
  await restarted.stop();
});

test("starting again on the running console's port preserves verified sign-in and its lock", async (t) => {
  const dir = scratch(t);
  const first = hub(t, dir);
  const { dashboard } = await first.ready;
  const before = fs.readFileSync(path.join(dir, "hub.lock"), "utf8");
  const repeated = hub(t, dir, ["--port", String(dashboard.port)]);
  const result = await repeated.closed;
  assert.equal(result.code, 0);
  const answer = JSON.parse(result.output.trim());
  assert.equal(answer.alreadyRunning, true);
  assert.equal(answer.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "hub.lock"), "utf8"), before);
  await first.stop();
});
