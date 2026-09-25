#!/usr/bin/env node
/*
 * Start the team hub image the way docs/docker-hub.md does and prove it runs:
 * the container reaches "healthy" (its own HEALTHCHECK), the reporting port
 * serves the join page to the host, and the process is not root.
 *
 *   node scripts/docker-smoke.mjs IMAGE [--platform linux/arm64] [--port 6900]
 *
 * Runs `docker` with argument arrays, never a shell. Removes its container.
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const image = args[0];
const option = (name, fallback) => { const i = args.indexOf(name); return i > 0 && args[i + 1] ? args[i + 1] : fallback; };
const platform = option("--platform", "");
const port = Number(option("--port", "6900"));
if (!image || image.startsWith("-") || !Number.isInteger(port) || port < 1024 || port > 65535) {
  process.stderr.write("usage: node scripts/docker-smoke.mjs IMAGE [--platform linux/arm64] [--port 6900]\n");
  process.exit(2);
}
const docker = (...argv) => execFileSync("docker", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const name = `agent-console-smoke-${process.pid}`;
const fail = (message) => { throw new Error(message); };

let started = false;
try {
  docker("run", "-d", "--name", name, ...(platform ? ["--platform", platform] : []),
    "-p", `127.0.0.1:${port}:6788`, image);
  started = true;
  const deadline = Date.now() + 180_000; // arm64 under emulation starts slowly
  let health = "";
  while (Date.now() < deadline) {
    health = docker("inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.Running}}", name);
    if (health.startsWith("healthy|")) break;
    if (health.endsWith("|false")) fail(`the container stopped:\n${docker("logs", name)}`);
    await sleep(2000);
  }
  if (!health.startsWith("healthy|")) fail(`never became healthy (${health}):\n${docker("logs", name)}`);

  const response = await fetch(`http://127.0.0.1:${port}/join`, { signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  if (response.status !== 200 || !/<html/iu.test(body)) fail(`the join page answered ${response.status}`);

  const uid = docker("exec", name, "id", "-u");
  if (uid === "0") fail("the hub runs as root");
  const arch = docker("image", "inspect", "--format", "{{.Architecture}}", image);
  if (platform && `linux/${arch}` !== platform) fail(`expected ${platform}, the image is linux/${arch}`);
  process.stdout.write(`${image} (linux/${arch}): healthy, join page 200 on 127.0.0.1:${port}, uid ${uid}\n`);
} catch (error) {
  process.stderr.write(`docker smoke failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (started) { try { docker("rm", "-f", name); } catch { /* already gone */ } }
}
