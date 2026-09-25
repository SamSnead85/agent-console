#!/usr/bin/env node

// Check the README's actual release archive. A missing archive fails unless
// an unreleased development push explicitly opts into a distinct pending result.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE = "@lockedinlabs/agent-console";
const REPOSITORY = "https://github.com/SamSnead85/agent-console";
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const fail = (code) => Object.assign(new Error(code), { code });

export function parseArguments(args) {
  const result = { allowPendingRelease: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--allow-pending-release") result.allowPendingRelease = true;
    else if (args[i] === "--expected-version" && args[i + 1] && result.expectedVersion === undefined) result.expectedVersion = args[++i];
    else throw fail("invalid_arguments");
  }
  return result;
}

export function releaseIdentity({ readme, manifest, expectedVersion }) {
  const expected = expectedVersion === undefined ? manifest.version : String(expectedVersion).replace(/^v/u, "");
  if (!VERSION.test(expected) || manifest.name !== PACKAGE || manifest.version !== expected) throw fail("identity_mismatch");
  const url = `${REPOSITORY}/releases/download/v${expected}/lockedinlabs-agent-console-${expected}.tgz`;
  const commands = String(readme).split("\n").map((line) => line.trim())
    .filter((line) => /^npx --yes /u.test(line) && / --open$/u.test(line));
  if (!commands.length || commands.some((line) => line !== `npx --yes ${url} --open`)) throw fail("identity_mismatch");
  return { version: expected, url };
}

/** Locate a JavaScript npm entry point, never interpolate a URL into a shell. */
export function resolveNpmCli({ env = process.env, execPath = process.execPath } = {}) {
  const bin = path.dirname(execPath);
  const candidates = [env.npm_execpath, path.join(bin, "node_modules/npm/bin/npm-cli.js"),
    path.resolve(bin, "../lib/node_modules/npm/bin/npm-cli.js")];
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "npm"), path.join(dir, "node_modules/npm/bin/npm-cli.js"));
  }
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const real = fs.realpathSync(candidate);
      if (path.basename(real) === "npm-cli.js" && fs.statSync(real).isFile()) return real;
    } catch { /* Try the next installed location. */ }
  }
  throw fail("npm_unavailable");
}

async function bounded(operation, milliseconds, code, abortSignal) {
  if (abortSignal?.aborted) throw fail("check_cancelled");
  const controller = new AbortController();
  let timer, cancel;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(fail(code)); }, milliseconds);
    cancel = () => { reject(fail("check_cancelled")); controller.abort(); };
    abortSignal?.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), expired]); }
  finally { clearTimeout(timer); abortSignal?.removeEventListener("abort", cancel); controller.abort(); }
}

const childClosures = new WeakMap();
function observeClose(child) {
  if (!childClosures.has(child)) {
    childClosures.set(child, new Promise((resolve) => child.once("close", resolve)));
  }
  return childClosures.get(child);
}

/** Kill only this check's process group/tree, including npm's console child. */
export async function terminateTree(child, {
  platform = process.platform, kill = process.kill.bind(process), spawnSyncImpl = spawnSync,
  graceMs = 500, env = process.env,
} = {}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return; // Spawn failed.
  const closed = observeClose(child);
  const waitClosed = () => bounded(() => closed, 10_000, "cleanup_failed");
  if (platform === "win32") {
    const command = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    const result = spawnSyncImpl(command, ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true, timeout: 10_000, shell: false,
    });
    // A process that already exited has no tree for taskkill to terminate.
    if (result.error || (result.status !== 0 && child.exitCode === null && child.signalCode === null)) throw fail("cleanup_failed");
    await waitClosed();
    return;
  }
  const signal = (name) => {
    try { kill(-child.pid, name); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw fail("cleanup_failed"); }
  };
  if (signal("SIGTERM")) {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    signal("SIGKILL");
  }
  await waitClosed();
}

function startup(child, timeoutMs, abortSignal) {
  return new Promise((resolve, reject) => {
    let pending = "", bytes = 0, finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      pending = "";
      child.off("exit", onExit);
      abortSignal?.removeEventListener("abort", onAbort);
      // Drain remaining output without retaining or ever printing it.
      child.stdout?.resume();
      error ? reject(error) : resolve(result);
    };
    const onAbort = () => finish(fail("check_cancelled"));
    const onError = () => finish(fail("startup_failed"));
    const onExit = () => finish(fail("startup_failed"));
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { finish(fail("startup_output_limit")); return; }
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        try {
          const value = JSON.parse(line);
          if (value.dashboard) { finish(null, value.dashboard); return; }
        } catch { finish(fail("startup_failed")); return; }
      }
    };
    const timer = setTimeout(() => finish(fail("startup_timeout")), timeoutMs);
    // Keep a safe listener for late process errors even after startup settles.
    child.on("error", onError);
    child.once("exit", onExit);
    child.stdout?.on("data", onData);
    child.stderr?.resume();
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Injected process/transport seams keep regression tests offline and synthetic. */
export async function checkInstall(options, {
  fetchImpl = globalThis.fetch, spawnImpl = spawn, cleanupTree = terminateTree,
  npmCli, requestTimeoutMs = 15_000, startupTimeoutMs = 180_000,
  execPath = process.execPath, platform = process.platform, signal,
} = {}) {
  const identity = releaseIdentity(options);
  let head;
  try {
    head = await bounded((signal) => fetchImpl(identity.url, { method: "HEAD", redirect: "follow", signal }), requestTimeoutMs, "download_timeout", signal);
  } catch (error) { throw fail(["download_timeout", "check_cancelled"].includes(error.code) ? error.code : "download_failed"); }
  if (head.status === 404 && options.allowPendingRelease === true) return { status: "pending", ...identity, reason: "release_asset_missing" };
  if (head.status === 404) throw fail("release_asset_missing");
  if (!head.ok) throw fail("download_failed");

  if (signal?.aborted) throw fail("check_cancelled");
  const entry = npmCli || resolveNpmCli();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "console-install-check-"));
  let child;
  try {
    try {
      child = spawnImpl(execPath, [entry, "exec", "--yes", "--", identity.url,
        "--demo", "--json", "--port", "0", "--report-port", "0"], {
        stdio: ["ignore", "pipe", "pipe"], cwd: scratch,
        detached: platform !== "win32", windowsHide: true, shell: false,
        env: { ...process.env, npm_config_cache: path.join(scratch, "npm-cache"), npm_config_update_notifier: "false" },
      });
    } catch { throw fail("startup_failed"); }
    observeClose(child);
    const meta = await startup(child, startupTimeoutMs, signal);
    if (meta.name !== "Agent Console" || meta.version !== identity.version || meta.demo !== true
      || !Number.isInteger(meta.port) || meta.port < 1 || meta.port > 65535
      || meta.url !== `http://127.0.0.1:${meta.port}`) throw fail("runtime_identity_mismatch");
    let hello;
    try {
      hello = await bounded(async (signal) => {
        const response = await fetchImpl(meta.url + "/api/hello", { redirect: "error", signal });
        if (!response.ok) throw fail("hello_failed");
        return response.json();
      }, requestTimeoutMs, "hello_timeout", signal);
    } catch (error) { throw fail(["hello_timeout", "check_cancelled"].includes(error.code) ? error.code : "hello_failed"); }
    if (hello.product !== "Agent Console" || hello.version !== identity.version || hello.demo !== true) throw fail("runtime_identity_mismatch");
    if (child.exitCode !== null || child.signalCode !== null) throw fail("startup_failed");
    if (signal?.aborted) throw fail("check_cancelled");
    return { status: "verified", ...identity };
  } finally {
    try { if (child) await cleanupTree(child); }
    finally { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  }
}

export async function main(args = process.argv.slice(2)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const options = parseArguments(args);
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const result = await checkInstall({ ...options, readme, manifest }, { signal: controller.signal });
    if (controller.signal.aborted) throw fail("check_cancelled");
    process.stdout.write(JSON.stringify({ event: "readme-install", ...result }) + "\n");
    process.stdout.write(result.status === "verified"
      ? `README install verified: Agent Console ${result.version} installed and answered in demo mode.\n`
      : `README install PENDING: Agent Console ${result.version} has no release asset; installation was NOT verified.\n`);
    return 0;
  } catch (error) {
    // Error details and child output can contain credentials. Emit only our
    // fixed reason codes, never a caught message, metadata or stack trace.
    const reasons = new Set(["invalid_arguments", "identity_mismatch", "npm_unavailable", "download_timeout", "download_failed",
      "release_asset_missing", "startup_failed", "startup_timeout", "startup_output_limit", "runtime_identity_mismatch", "hello_failed", "hello_timeout", "cleanup_failed", "check_cancelled"]);
    const reason = reasons.has(error.code) ? error.code : "check_failed";
    process.stderr.write(JSON.stringify({ event: "readme-install", status: "failed", reason }) + "\n");
    process.stderr.write(`README install FAILED: ${reason}; installation was NOT verified.\n`);
    return 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
