#!/usr/bin/env node

/*
 * End-to-end benchmarks against real processes, on data from generate.mjs.
 *
 *   node bench/run.mjs cold --home <home> [--retention-days 30]
 *        a hub reading one heavy machine: time to first paint, to a complete
 *        first read, peak memory, CPU, how long a new line takes to show,
 *        idle CPU, and a restart on the same state
 *   node bench/run.mjs team --homes <dir with home-1..home-N>
 *        a hub with no local reading and N reporters: catch-up time, hub CPU
 *        and memory while they catch up and once they are steady, and the
 *        console's answer time and size with N machines
 *
 * Wall-clock numbers depend on the machine; they are printed, not gated.
 * bench/check.mjs gates what does not: bytes read, files opened, bytes
 * written, payload sizes.
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "agent-console.mjs");
const INTENT = { "x-agent-console": "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { o[argv[i].slice(2)] = argv[i + 1]; i++; } else o._.push(argv[i]);
  }
  return o;
}

/** Resident set size (KB) and CPU seconds of a process, from ps (macOS and Linux). */
function sample(pid) {
  try {
    const [rss, time] = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/u);
    const parts = time.split(/[:-]/u).map(Number);
    let cpu = 0;
    for (const p of parts) cpu = cpu * 60 + p;   // [[dd-]hh:]mm:ss(.xx)
    if (time.includes("-")) cpu = parts[0] * 86400 + parts.slice(1).reduce((s, p) => s * 60 + p, 0);
    return { rssKb: Number(rss), cpuS: cpu };
  } catch { return null; }
}

function watchProcess(pid) {
  const w = { peakRssKb: 0, cpuS: 0, stop: null };
  const timer = setInterval(() => { const s = sample(pid); if (s) { w.peakRssKb = Math.max(w.peakRssKb, s.rssKb); w.cpuS = s.cpuS; } }, 100);
  w.stop = () => clearInterval(timer);
  w.now = () => { const s = sample(pid); if (s) { w.peakRssKb = Math.max(w.peakRssKb, s.rssKb); w.cpuS = s.cpuS; } return w; };
  return w;
}

export function startHub(extra, env = {}) {
  const t0 = performance.now();
  const child = spawn(process.execPath, [BIN, "--json", "--port", "0", ...extra], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let out = "", err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  const ready = new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      if (!out.includes("\n")) return;
      clearInterval(timer);
      const listenMs = performance.now() - t0;
      try {
        const meta = JSON.parse(out.split("\n")[0]).dashboard;
        const login = await fetch(meta.signIn, { redirect: "manual" });
        resolve({ ...meta, cookie: login.headers.get("set-cookie").split(";")[0], listenMs, t0 });
      } catch (error) { reject(error); }
    }, 5);
    child.on("exit", (code) => { clearInterval(timer); reject(new Error("hub exited " + code + ": " + out + err)); });
  });
  return { child, ready, output: () => out + err };
}

async function consoleView(hub) {
  const t = performance.now();
  const r = await fetch(`${hub.url}/api/console`, { headers: { ...INTENT, cookie: hub.cookie } });
  const text = await r.text();
  return { ms: performance.now() - t, bytes: Buffer.byteLength(text), view: JSON.parse(text) };
}

const localTotal = (v) => v.devices.filter((d) => d.local).reduce((s, d) => s + d.day.tokens.total, 0);

/** Appends one streamed Claude response to the newest n transcript files. */
function appendActivity(home, n, marker) {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".jsonl")) files.push(p); } };
  walk(path.join(home, ".claude", "projects"));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const now = new Date().toISOString();
  for (const file of files.slice(0, n)) {
    const last = JSON.parse(fs.readFileSync(file, "utf8").trimEnd().split("\n").at(-1));
    const line = { ...last, type: "assistant", uuid: `bench-${marker}-${path.basename(file)}`, timestamp: now, requestId: `req_bench_${marker}`,
      message: { id: `msg_bench_${marker}_${path.basename(file)}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "x" }],
        stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } };
    fs.appendFileSync(file, JSON.stringify(line) + "\n");
  }
  return files.slice(0, n).length;
}

async function cold(o) {
  const home = path.resolve(o.home);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "ac-bench-cold-"));
  const extra = ["--home", home, "--state-dir", state, "--retention-days", String(o["retention-days"] || 30)];
  const result = { scenario: "cold", node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length };
  try {
    let hub = startHub(extra);
    const h = await hub.ready;
    const w = watchProcess(hub.child.pid);
    result.listenMs = Math.round(h.listenMs);
    // First paint: the page and its data answer.
    const page = await fetch(h.url + "/");
    await page.text();
    const first = await consoleView(h);
    result.firstPaintMs = Math.round(performance.now() - h.t0);
    // A complete first read, and how responsive the console stays meanwhile.
    let worst = first.ms, v = first.view, polls = 0;
    while (!(v.hub.local.firstRunComplete && localTotal(v) > 0)) {
      await sleep(250);
      const c = await consoleView(h);
      worst = Math.max(worst, c.ms); v = c.view; polls += 1;
      if (performance.now() - h.t0 > 30 * 60_000) throw new Error("first read did not finish in 30 minutes");
    }
    result.firstReadMs = Math.round(performance.now() - h.t0);
    result.worstConsoleAnswerDuringFirstReadMs = Math.round(worst);
    w.now();
    result.firstRead = { peakRssMb: Math.round(w.peakRssKb / 1024), cpuS: +w.cpuS.toFixed(1), records: v.day.records, tokens24h: v.day.tokens.total };
    // Steady state: how long a new response takes to show, and idle cost.
    const lat = [];
    for (let i = 0; i < 3; i++) {
      const before = localTotal((await consoleView(h)).view);
      const t = performance.now();
      appendActivity(home, 5, `${Date.now()}-${i}`);
      for (;;) {
        await sleep(50);
        if (localTotal((await consoleView(h)).view) > before) break;
        if (performance.now() - t > 120_000) throw new Error("a new line never showed");
      }
      lat.push(Math.round(performance.now() - t));
    }
    result.newLineVisibleMs = lat;
    const idle0 = w.now().cpuS, t0 = performance.now();
    await sleep(30_000);
    const idle1 = w.now().cpuS;
    result.idleCpuPercent = +((idle1 - idle0) / ((performance.now() - t0) / 1000) * 100).toFixed(1);
    const c = await consoleView(h);
    result.console = { answerMs: Math.round(c.ms), bytes: c.bytes };
    result.peakRssMb = Math.round(w.peakRssKb / 1024);
    result.stateBytes = dirBytes(state);
    w.stop();
    hub.child.kill("SIGTERM");
    await new Promise((r) => hub.child.once("exit", r));
    // Restart on the same state.
    hub = startHub(extra);
    const h2 = await hub.ready;
    const w2 = watchProcess(hub.child.pid);
    await consoleView(h2);
    result.restart = { listenMs: Math.round(h2.listenMs), firstPaintMs: Math.round(performance.now() - h2.t0) };
    for (;;) {
      const r = await consoleView(h2);
      if (r.view.hub.local.firstRunComplete) break;
      await sleep(100);
    }
    result.restart.readyMs = Math.round(performance.now() - h2.t0);
    result.restart.peakRssMb = Math.round(w2.now().peakRssKb / 1024);
    w2.stop();
    hub.child.kill("SIGTERM");
    await new Promise((r) => hub.child.once("exit", r));
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
  return result;
}

function dirBytes(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) total += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
  return total;
}

async function team(o) {
  const homesDir = path.resolve(o.homes);
  const homes = fs.readdirSync(homesDir).filter((n) => /^home-\d+$/u.test(n)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).map((n) => path.join(homesDir, n));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-bench-team-"));
  const result = { scenario: "team", reporters: homes.length, node: process.version, platform: `${process.platform}-${process.arch}` };
  const reporters = [];
  const hub = startHub(["--no-local", "--state-dir", path.join(root, "hub"), "--retention-days", String(o["retention-days"] || 8)]);
  try {
    const h = await hub.ready;
    const w = watchProcess(hub.child.pid);
    const t0 = performance.now();
    for (const [i, home] of homes.entries()) {
      const inv = await (await fetch(`${h.url}/api/invitations`, { method: "POST", headers: { ...INTENT, cookie: h.cookie, "content-type": "application/json" },
        body: JSON.stringify({ person: `Engineer ${i + 1}`, machine: `Machine ${i + 1}`, minutes: 30 }) })).json();
      const child = spawn(process.execPath, [BIN, "join", inv.link, "--json", "--home", home, "--state-dir", path.join(root, `r${i}`), "--interval", "10"], { stdio: ["ignore", "ignore", "pipe"] });
      reporters.push(child);
    }
    const watchers = reporters.map((r) => watchProcess(r.pid));
    for (;;) {
      await sleep(500);
      const { view } = await consoleView(h);
      const done = view.devices.length === homes.length && view.devices.every((d) => d.status === "reporting");
      if (done) break;
      if (performance.now() - t0 > 30 * 60_000) throw new Error("reporters did not catch up in 30 minutes");
    }
    result.catchUpMs = Math.round(performance.now() - t0);
    w.now();
    result.catchUp = { hubCpuS: +w.cpuS.toFixed(1), hubPeakRssMb: Math.round(w.peakRssKb / 1024),
      reporterPeakRssMb: Math.max(...watchers.map((x) => x.now().peakRssKb)) >> 10, reporterCpuS: +watchers.reduce((s, x) => s + x.cpuS, 0).toFixed(1) };
    // Steady: every home gets a new response every 10 seconds for a minute.
    const c0 = w.now().cpuS, s0 = performance.now();
    for (let k = 0; k < 6; k++) { for (const home of homes) appendActivity(home, 1, `team-${k}`); await sleep(10_000); }
    result.steadyHubCpuPercent = +((w.now().cpuS - c0) / ((performance.now() - s0) / 1000) * 100).toFixed(1);
    const c = await consoleView(h);
    result.console = { answerMs: Math.round(c.ms), bytes: c.bytes, devices: c.view.devices.length, lanes: c.view.laneCount, records24h: c.view.day.records };
    result.hubPeakRssMb = Math.round(w.peakRssKb / 1024);
    w.stop(); watchers.forEach((x) => x.stop());
  } finally {
    for (const r of reporters) r.kill("SIGTERM");
    hub.child.kill("SIGTERM");
    await sleep(500);
    fs.rmSync(root, { recursive: true, force: true });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = args(process.argv.slice(2));
  const run = { cold, team }[o._[0]];
  if (!run) { process.stderr.write("usage: node bench/run.mjs cold --home <dir> | team --homes <dir>\n"); process.exit(2); }
  run(o).then((r) => process.stdout.write(JSON.stringify(r, null, 2) + "\n"), (e) => { process.stderr.write(String(e.stack || e) + "\n"); process.exit(1); });
}
