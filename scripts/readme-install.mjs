#!/usr/bin/env node

/*
 * Runs the README's install line exactly as a newcomer would, against the
 * published release, and checks that the console it starts answers with this
 * version. `--open` becomes `--demo --json --port 0`, so it reads nothing and
 * opens no browser. Used by the "README install line" workflow.
 *
 * A release file that is not there is a failure: the README tells every
 * newcomer to run it. Two moments are the exception, and are reported and
 * skipped: the run for the release event itself, which can start before the
 * release job has attached the file, and a push within a day of the commit
 * that bumped the version, before its release is published. The weekly run
 * and any later push fail until the release exists.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUMP_GRACE_MS = 24 * 3600_000;

/** Whether a missing release file may be skipped for this run, and why. */
export function missingRelease({ event, bumpedAt = null, now = Date.now() }) {
  if (event === "release") return { skip: true, why: "the release job may not have attached it yet" };
  if (event === "push" && bumpedAt !== null && now - bumpedAt < BUMP_GRACE_MS) {
    return { skip: true, why: "this version was bumped less than a day ago and its release is not published yet" };
  }
  return { skip: false, why: "the README tells every newcomer to run it" };
}

/** When the commit that set package.json to this version was made, or null. */
function versionBumpedAt(version) {
  const log = spawnSync("git", ["log", "-1", "--format=%ct", `-S"version": "${version}"`, "--", "package.json"], { encoding: "utf8" });
  const seconds = Number(String(log.stdout || "").trim());
  return log.status === 0 && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

async function main() {
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const line = readme.split("\n").find((l) => /^npx --yes https:\/\/github\.com\/\S+\.tgz --open$/u.test(l.trim()));
if (!line) { process.stderr.write("README: no install line of the form `npx --yes <release .tgz> --open`\n"); process.exit(1); }
const url = line.trim().split(/\s+/u)[2];
const head = await fetch(url, { method: "HEAD", redirect: "follow" });
if (head.status === 404) {
  const missing = missingRelease({ event: process.env.GITHUB_EVENT_NAME || "", bumpedAt: versionBumpedAt(version) });
  if (missing.skip) {
    process.stdout.write(`README install line: ${url} is not published yet; skipped (${missing.why}).\n`);
    process.exit(0);
  }
  process.stderr.write(`README install line: ${url} is not published (404), and ${missing.why}. Publish the v${version} release.\n`);
  process.exit(1);
}
if (!head.ok) { process.stderr.write(`README install line: ${url} answered ${head.status}\n`); process.exit(1); }

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(npx, ["--yes", url, "--demo", "--json", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
let out = "";
child.stdout.on("data", (c) => { out += c; });
child.stderr.on("data", (c) => { out += c; });
const timer = setTimeout(() => { child.kill("SIGKILL"); process.stderr.write("README install line: no console within 180 s\n" + out); process.exit(1); }, 180_000);
const meta = await new Promise((resolve, reject) => {
  const poll = setInterval(() => {
    const first = out.split("\n").find((l) => l.startsWith("{"));
    if (!first) return;
    clearInterval(poll);
    try { resolve(JSON.parse(first).dashboard); } catch (error) { reject(error); }
  }, 100);
  child.on("exit", (code) => { clearInterval(poll); reject(new Error(`the console exited ${code}\n${out}`)); });
});
const hello = await (await fetch(meta.url + "/api/hello")).json();
clearTimeout(timer);
child.kill("SIGTERM");
if (hello.version !== version || hello.demo !== true) {
  process.stderr.write(`README install line: started ${hello.version}, expected ${version}\n`);
  process.exit(1);
}
process.stdout.write(`README install line: ${url} starts Agent Console ${hello.version}.\n`);
process.exit(0);
}
