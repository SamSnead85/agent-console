/**
 * Every console option works in --demo (docs/PRINCIPLES.md §4).
 *
 * The options are read from the console's own --help, so an option added
 * later without a demo check here fails this test instead of going unseen.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-console.mjs");
const INTENT = { "x-agent-console": "1" };

/** The value each option is tried with, alongside --demo. */
function samples(tmp) {
  return {
    "--port": null,             // every run uses --port 0
    "--json": null,             // every run uses --json
    "--report-port": ["0"],
    "--listen": ["127.0.0.1"],
    "--allow-public": [],
    "--demo": [],
    "--name": ["Build box"],
    "--person": ["Platform engineer"],
    "--no-local": [],
    "--state-dir": [path.join(tmp, "state")],
    "--retention-days": ["3"],
    "--invite-minutes": ["10"],
    "--claude-root": [path.join(tmp, "claude")],
    "--codex-root": [path.join(tmp, "codex")],
    "--desktop-alerts": [],     // demo runs no local alert engine, so nothing is shown
    "--alert-repeat": ["3"],
    "--alert-spike-factor": ["4"],
    "--alert-stall-minutes": ["2"],
  };
}
/** Options that do not start a console, or would act outside the test. */
const NOT_A_CONSOLE = new Set(["--help", "--version", "--open"]);

function consoleOptions() {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" }).stdout;
  const section = help.slice(help.indexOf("Console options"), help.indexOf("Run the reporter"));
  return [...section.matchAll(/^\s{2}(--[a-z][a-z-]*)/gmu)].map((m) => m[1]);
}

function startDemo(args) {
  const child = spawn(process.execPath, [BIN, "--demo", "--json", "--port", "0", ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
      } catch (error) { reject(new Error(out || String(error))); }
    }, 20);
    child.on("exit", (code) => { clearInterval(timer); reject(new Error(`exited ${code}: ${out}`)); });
  });
  return { child, ready };
}

test("every console option in --help has a demo check here", () => {
  const tmp = os.tmpdir();
  const known = samples(tmp);
  const options = consoleOptions();
  assert.ok(options.includes("--demo") && options.length > 10, "could not read the options from --help");
  const missing = options.filter((o) => !(o in known) && !NOT_A_CONSOLE.has(o));
  assert.deepEqual(missing, [], "add these to samples() in test/demo-flags.test.js");
});

test("--demo starts, serves every screen and stamps DEMO with each console option", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-flags-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  for (const [option, value] of Object.entries(samples(tmp))) {
    if (value === null || option === "--demo") continue;
    const hub = startDemo([option, ...value]);
    try {
      const h = await hub.ready;
      const headers = { ...INTENT, cookie: h.cookie };
      const page = await fetch(h.url + "/");
      assert.equal(page.status, 200, option);
      const view = await (await fetch(h.url + "/api/console", { headers })).json();
      assert.equal(view.hub.demo, true, option);
      assert.ok(view.devices.length > 1 && view.day.tokens.total > 0, `${option}: the demo shows no team`);
      for (const period of ["24h", "3d"]) {
        const projects = await fetch(`${h.url}/api/projects?period=${period}`, { headers });
        assert.equal(projects.status, 200, `${option}: projects ${period}`);
      }
      const join = await fetch(`http://127.0.0.1:${h.reportPort}/join`);
      assert.equal(join.status, 200, `${option}: the join page`);
    } finally {
      hub.child.kill("SIGKILL");
    }
  }
});
