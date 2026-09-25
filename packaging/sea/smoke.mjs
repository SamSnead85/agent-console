#!/usr/bin/env node
/*
 * Start a built executable the way a person would, on the machine it was built
 * for, with a Node.js-free PATH, and check what npm run smoke:pack checks of
 * the package: it prints its version, starts in demo mode, serves the console,
 * signs a browser in and serves the join page. Also: it unpacks into its cache
 * once, repairs a file changed there, and names itself (not node) in the
 * commands it prints.
 *
 *   node packaging/sea/smoke.mjs dist/sea/dist/agent-console-<platform>-<arch>[.exe]
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const exe = path.resolve(process.argv[2] || "");
assert.ok(fs.existsSync(exe), `no executable at ${exe}`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-sea-smoke-"));
const cache = path.join(scratch, "cache");
// No node on PATH: the executable must not lean on one.
const env = { ...process.env, AGENT_CONSOLE_CACHE_DIR: cache, AGENT_CONSOLE_HOME: path.join(scratch, "home"), PATH: path.dirname(exe) };
const runExe = (args) => spawnSync(exe, args, { env, cwd: scratch, encoding: "utf8", timeout: 30_000 });

try {
  const first = runExe(["--version"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, `agent-console ${version}\n`);

  const unpacked = fs.readdirSync(cache).filter((d) => !d.startsWith("."));
  assert.equal(unpacked.length, 1, "unpacks into exactly one folder");
  const dir = path.join(cache, unpacked[0]);
  assert.match(unpacked[0], new RegExp(`^${version.replace(/\./gu, "\\.")}-[0-9a-f]{16}$`, "u"));
  for (const f of ["server.js", "bin/agent-console.mjs", "public/index.html", "LICENSE", "LICENSE.node"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `unpacked copy has ${f}`);
  }

  // A file changed in the cache is noticed and put back before anything runs.
  const server = path.join(dir, "server.js");
  fs.appendFileSync(server, "\nthrow new Error('tampered');\n");
  const again = runExe(["--version"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(server, "utf8"), fs.readFileSync(path.join(ROOT, "server.js"), "utf8"), "server.js restored");

  // Commands it prints name the executable, never node.
  const usage = runExe(["join"]);
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr + usage.stdout, /agent-console(?:-[a-z0-9]+-[a-z0-9]+)?(?:\.exe)? join '/u);
  assert.doesNotMatch(usage.stderr + usage.stdout, /node "/u);

  const child = spawn(exe, ["--demo", "--json", "--port", "0"], { env, cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  try {
    const meta = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("startup timed out\n" + errors)), 30_000);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => finish(new Error(`exited early: ${code}\n${errors}`)));
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (!output.includes("\n")) return;
        try { finish(null, JSON.parse(output.split("\n")[0]).dashboard); } catch (error) { finish(error); }
      });
    });
    const timeout = () => AbortSignal.timeout(10_000);
    const page = await fetch(meta.url, { signal: timeout() });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent Console/u);
    const login = await fetch(meta.signIn, { redirect: "manual", signal: timeout() });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const view = await fetch(meta.url + "/api/console", { headers: { "X-Agent-Console": "1", cookie }, signal: timeout() });
    assert.equal(view.status, 200);
    const data = await view.json();
    assert.equal(data.hub.demo, true);
    assert.ok(data.devices.length > 1 && data.day.tokens.total > 0);
    const join = await fetch(`http://127.0.0.1:${meta.reportPort}/join`, { signal: timeout() });
    assert.equal(join.status, 200);
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
  const size = (fs.statSync(exe).size / 1048576).toFixed(1);
  process.stdout.write(`${path.basename(exe)} (${size} MB): version, unpack, repair, own name in commands, demo console, sign-in, join page: all fine\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
