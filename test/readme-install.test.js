import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { checkInstall, parseArguments, releaseIdentity, terminateTree } from "../scripts/readme-install.mjs";

const version = "0.2.2";
const url = `https://github.com/SamSnead85/agent-console/releases/download/v${version}/lockedinlabs-agent-console-${version}.tgz`;
const options = { readme: `npx --yes ${url} --open\n`, manifest: { name: "@lockedinlabs/agent-console", version }, expectedVersion: `v${version}` };
const meta = { name: "Agent Console", version, demo: true, port: 19000, url: "http://127.0.0.1:19000", signIn: "SENSITIVE_CHILD_OUTPUT" };
const hello = { product: "Agent Console", version, demo: true };
function harness({ head = 200, metadata = meta, answer = hello, startup = "ready", helloStatus = 200 } = {}) {
  const calls = { fetch: [], spawn: [], cleanup: [] };
  const child = new EventEmitter();
  Object.assign(child, { pid: 12345, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
  const deps = {
    npmCli: "/synthetic/npm-cli.js", requestTimeoutMs: 30, startupTimeoutMs: 30,
    async fetchImpl(target, init) {
      calls.fetch.push({ target, init });
      if (init.method === "HEAD") return { status: head, ok: head >= 200 && head < 300 };
      return { ok: helloStatus === 200, json: async () => answer };
    },
    spawnImpl(command, args, spec) {
      calls.spawn.push({ command, args, spec });
      queueMicrotask(() => {
        child.stderr.write("SENSITIVE_CHILD_OUTPUT\n");
        if (startup === "error") { child.pid = undefined; child.emit("error", new Error("SENSITIVE_CHILD_OUTPUT")); child.emit("error", new Error("SECOND_SENSITIVE_CHILD_OUTPUT")); }
        else if (startup === "exit") { child.exitCode = 1; child.emit("exit", 1); }
        else if (startup === "ready") child.stdout.write(JSON.stringify({ dashboard: metadata }) + "\n");
        else if (startup === "flood") child.stdout.write("x".repeat(65537));
      });
      return child;
    },
    async cleanupTree(target) { calls.cleanup.push(target); target.exitCode = 0; target.stdout.destroy(); target.stderr.destroy(); },
  };
  return { calls, child, deps };
}
function checkCleanup(h) {
  assert.deepEqual(h.calls.cleanup, [h.child]);
  assert.equal(fs.existsSync(h.calls.spawn[0].spec.cwd), false, "temporary install cache survives cleanup");
}

test("import is inert and CLI arguments expose strict default, exact version and explicit pending mode", () => {
  assert.deepEqual(parseArguments([]), { allowPendingRelease: false });
  assert.deepEqual(parseArguments(["--expected-version", "v0.2.2", "--allow-pending-release"]), { expectedVersion: "v0.2.2", allowPendingRelease: true });
  for (const args of [["--expected-version"], ["--unknown"], ["--expected-version", "v0.2.2", "--expected-version", "v0.3.0"]]) {
    assert.throws(() => parseArguments(args), { code: "invalid_arguments" });
  }
});

test("identity mismatches fail before any network or installation action", async () => {
  for (const change of [
    { expectedVersion: "v0.3.0" },
    { manifest: { ...options.manifest, name: "another-package" } },
    { readme: options.readme.replace("SamSnead85", "other-owner") },
    { readme: options.readme.replace("/v0.2.2/", "/v0.2.1/") },
    { readme: options.readme.replace("agent-console-0.2.2.tgz", "agent-console-0.2.1.tgz") },
    { readme: options.readme + options.readme.replaceAll("0.2.2", "0.2.1") },
  ]) {
    const h = harness();
    await assert.rejects(checkInstall({ ...options, ...change }, h.deps), { code: "identity_mismatch" });
    assert.equal(h.calls.fetch.length, 0); assert.equal(h.calls.spawn.length, 0);
  }
  assert.deepEqual(releaseIdentity(options), { version, url });
});

test("missing download fails strictly; only explicit development mode returns pending", async () => {
  const strict = harness({ head: 404 });
  await assert.rejects(checkInstall(options, strict.deps), { code: "release_asset_missing" });
  assert.equal(strict.calls.spawn.length, 0);
  const pending = harness({ head: 404 });
  assert.deepEqual(await checkInstall({ ...options, allowPendingRelease: true }, pending.deps), { status: "pending", version, url, reason: "release_asset_missing" });
  assert.equal(pending.calls.spawn.length, 0);
  const unavailable = harness({ head: 503 });
  await assert.rejects(checkInstall({ ...options, allowPendingRelease: true }, unavailable.deps), { code: "download_failed" });
});

test("a stalled HEAD request is bounded even if the transport ignores abort", async () => {
  const h = harness(); let signal;
  h.deps.fetchImpl = (_target, init) => { signal = init.signal; return new Promise(() => {}); };
  await assert.rejects(checkInstall(options, h.deps), { code: "download_timeout" });
  assert.equal(signal.aborted, true); assert.equal(h.calls.spawn.length, 0);
});

test("spawn errors, early exit, startup timeout and output floods fail with safe reasons and cleanup", async () => {
  for (const [startup, code] of [["error", "startup_failed"], ["exit", "startup_failed"], ["silent", "startup_timeout"], ["flood", "startup_output_limit"]]) {
    const h = harness({ startup });
    await assert.rejects(checkInstall(options, h.deps), (error) => error.code === code && !error.message.includes("SENSITIVE_CHILD_OUTPUT"));
    checkCleanup(h);
  }
});

test("invalid runtime metadata is refused before it can direct a hello request", async () => {
  for (const change of [{ version: "0.1.0" }, { demo: false }, { name: "other" }, { url: "https://example.invalid" }, { port: 0 }]) {
    const h = harness({ metadata: { ...meta, ...change } });
    await assert.rejects(checkInstall(options, h.deps), { code: "runtime_identity_mismatch" });
    assert.equal(h.calls.fetch.length, 1); checkCleanup(h);
  }
});

test("hello must answer successfully with the expected product, version and demo state", async () => {
  for (const change of [{ product: "other" }, { version: "0.1.0" }, { demo: false }]) {
    const h = harness({ answer: { ...hello, ...change } });
    await assert.rejects(checkInstall(options, h.deps), { code: "runtime_identity_mismatch" }); checkCleanup(h);
  }
  const h = harness({ helloStatus: 500 });
  await assert.rejects(checkInstall(options, h.deps), { code: "hello_failed" }); checkCleanup(h);
});

test("a stalled hello body is bounded and cleanup still runs", async () => {
  const h = harness(); const original = h.deps.fetchImpl;
  h.deps.fetchImpl = (target, init) => init.method === "HEAD" ? original(target, init) : Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
  await assert.rejects(checkInstall(options, h.deps), { code: "hello_timeout" }); checkCleanup(h);
});

test("successful verification invokes the exact README archive without a shell and clears its private cache", async () => {
  const h = harness();
  assert.deepEqual(await checkInstall(options, h.deps), { status: "verified", version, url });
  const invocation = h.calls.spawn[0];
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ["/synthetic/npm-cli.js", "exec", "--yes", "--", url, "--demo", "--json", "--port", "0", "--report-port", "0"]);
  assert.equal(invocation.spec.shell, false);
  assert.equal(invocation.spec.detached, process.platform !== "win32");
  assert.equal(invocation.spec.env.npm_config_cache, path.join(invocation.spec.cwd, "npm-cache"));
  assert.equal(h.calls.fetch[1].target, meta.url + "/api/hello");
  assert.equal(h.calls.fetch[1].init.redirect, "error");
  checkCleanup(h);
});

test("POSIX cleanup signals only the created process group, escalating when needed", async () => {
  const signals = [];
  const child = Object.assign(new EventEmitter(), { pid: 12345 });
  await terminateTree(child, { platform: "linux", graceMs: 1, kill: (...args) => { signals.push(args); if (args[1] === "SIGKILL") queueMicrotask(() => child.emit("close", 0)); } });
  assert.deepEqual(signals, [[-12345, "SIGTERM"], [-12345, "SIGKILL"]]);
  let count = 0;
  const exited = Object.assign(new EventEmitter(), { pid: 12345 });
  await terminateTree(exited, { platform: "linux", kill: () => { count += 1; queueMicrotask(() => exited.emit("close", 0)); throw Object.assign(new Error(), { code: "ESRCH" }); } });
  assert.equal(count, 1);
});

test("Windows cleanup uses only the created PID and tree; no shell or broad image kill", async () => {
  const calls = [];
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null });
  let closed = false;
  await terminateTree(child, { platform: "win32", env: { SystemRoot: "C:\\Windows" }, spawnSyncImpl: (...args) => { calls.push(args); setTimeout(() => { closed = true; child.emit("close", 0); }, 10); return { status: 0 }; } });
  assert.equal(closed, true, "cleanup returned before process handles closed");
  assert.equal(calls[0][0], "C:\\Windows\\System32\\taskkill.exe");
  assert.deepEqual(calls[0][1], ["/PID", "12345", "/T", "/F"]);
  assert.equal(calls[0][2].shell, false);
  await assert.rejects(terminateTree(Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null }), { platform: "win32", spawnSyncImpl: () => ({ status: 1 }) }), { code: "cleanup_failed" });
});

test("cancellation during startup cleans up the checker process and temporary state", async () => {
  const h = harness({ startup: "silent" });
  const controller = new AbortController();
  const original = h.deps.spawnImpl;
  h.deps.spawnImpl = (...args) => { const child = original(...args); queueMicrotask(() => controller.abort()); return child; };
  await assert.rejects(checkInstall(options, { ...h.deps, signal: controller.signal }), { code: "check_cancelled" });
  checkCleanup(h);
});
