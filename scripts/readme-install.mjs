#!/usr/bin/env node

/*
 * Runs the README's install line exactly as a newcomer would, against the
 * published release, and checks that the console it starts answers with this
 * version. `--open` becomes `--demo --json --port 0`, so it reads nothing and
 * opens no browser. Used by the "README install line" workflow.
 *
 * A version whose release is not published yet (the minutes between merging
 * a version bump and publishing the release) is reported and skipped; the
 * workflow runs again when the release is published.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";

const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const line = readme.split("\n").find((l) => /^npx --yes https:\/\/github\.com\/\S+\.tgz --open$/u.test(l.trim()));
if (!line) { process.stderr.write("README: no install line of the form `npx --yes <release .tgz> --open`\n"); process.exit(1); }
const url = line.trim().split(/\s+/u)[2];
const head = await fetch(url, { method: "HEAD", redirect: "follow" });
if (head.status === 404) {
  process.stdout.write(`README install line: ${url} is not published yet; skipped until the release is.\n`);
  process.exit(0);
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
