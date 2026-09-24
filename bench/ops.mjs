#!/usr/bin/env node

/*
 * The collector and the hub's store, in one process, counted in operations
 * rather than milliseconds: files opened, bytes read, bytes written, and the
 * size of what is kept. These numbers do not depend on the machine running
 * them, so CI can hold them to a budget (bench/check.mjs).
 *
 *   node bench/ops.mjs --lines 100000 [--sessions 80] [--days 8]
 *
 * It generates a history (generate.mjs, fixed seed and clock), then runs what
 * the hub runs every five seconds for its own machine (runOnce into the
 * store): a first read, an idle pass with nothing new, and a pass after one
 * new response in five files. It prints one JSON object.
 */

import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// --- counting file operations, before the collector binds to node:fs --------
export const io = { opens: 0, reads: 0, bytesRead: 0, writes: 0, bytesWritten: 0, stats: 0, jsonParses: 0 };
{
  const parse = JSON.parse;
  JSON.parse = function (...a) { io.jsonParses++; return parse.apply(this, a); };
}
const size = (data) => (typeof data === "string" ? Buffer.byteLength(data) : data?.byteLength ?? 0);
{
  const p = fs.promises;
  const probe = await p.open(fileURLToPath(import.meta.url), "r");
  const FH = Object.getPrototypeOf(probe);
  await probe.close();
  const wrap = (obj, name, fn) => { const orig = obj[name]; obj[name] = function (...a) { return fn.call(this, orig, a); }; };
  wrap(FH, "read", async function (orig, a) { const r = await orig.apply(this, a); io.reads++; io.bytesRead += r.bytesRead; return r; });
  wrap(FH, "readFile", async function (orig, a) { const r = await orig.apply(this, a); io.reads++; io.bytesRead += size(r); return r; });
  wrap(FH, "write", async function (orig, a) { io.writes++; io.bytesWritten += size(a[0]); return orig.apply(this, a); });
  wrap(FH, "appendFile", async function (orig, a) { io.writes++; io.bytesWritten += size(a[0]); return orig.apply(this, a); });
  wrap(FH, "writeFile", async function (orig, a) { io.writes++; io.bytesWritten += size(a[0]); return orig.apply(this, a); });
  wrap(p, "open", async function (orig, a) { io.opens++; return orig.apply(this, a); });
  wrap(p, "readFile", async function (orig, a) { io.opens++; io.reads++; const r = await orig.apply(this, a); io.bytesRead += size(r); return r; });
  wrap(p, "writeFile", async function (orig, a) { io.opens++; io.writes++; io.bytesWritten += size(a[1]); return orig.apply(this, a); });
  wrap(p, "appendFile", async function (orig, a) { io.opens++; io.writes++; io.bytesWritten += size(a[1]); return orig.apply(this, a); });
  wrap(p, "stat", async function (orig, a) { io.stats++; return orig.apply(this, a); });
  wrap(fs, "createReadStream", function (orig, a) { io.opens++; const s = orig.apply(this, a); s.on("data", (c) => { io.reads++; io.bytesRead += c.length; }); return s; });
  wrap(fs, "openSync", function (orig, a) { io.opens++; return orig.apply(this, a); });
  wrap(fs, "readSync", function (orig, a) { const n = orig.apply(this, a); io.reads++; io.bytesRead += n; return n; });
  wrap(fs, "writeSync", function (orig, a) { io.writes++; io.bytesWritten += size(a[1]); return orig.apply(this, a); });
  wrap(fs, "readFileSync", function (orig, a) { io.opens++; io.reads++; const r = orig.apply(this, a); io.bytesRead += size(r); return r; });
  wrap(fs, "writeFileSync", function (orig, a) { io.opens++; io.writes++; io.bytesWritten += size(a[1]); return orig.apply(this, a); });
  module.syncBuiltinESMExports();
}

const { generate } = await import("./generate.mjs");
const { runOnce } = await import("../lib/collector/collector.js");
const { createStore } = await import("../lib/hub/store.js");
const { buildConsole } = await import("../lib/hub/aggregate.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRICES = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "collector", "prices.json"), "utf8"));
const NOW = Date.parse("2026-09-20T12:00:00.000Z");

const snapshot = () => ({ ...io });
const delta = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - a[k]]));

function appendActivity(home, n, marker, at) {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".jsonl")) files.push(p); } };
  walk(path.join(home, ".claude", "projects"));
  files.sort();
  let bytes = 0;
  for (const file of files.slice(0, n)) {
    const line = JSON.stringify({ parentUuid: null, isSidechain: false, userType: "external", cwd: "/home/dev/work/bench", sessionId: `bench-${path.basename(file)}`, version: "2.1.0",
      type: "assistant", uuid: `bench-${marker}-${path.basename(file)}`, timestamp: new Date(at).toISOString(), requestId: `req_${marker}`,
      message: { id: `msg_${marker}_${path.basename(file)}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "x" }],
        stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } }) + "\n";
    fs.appendFileSync(file, line);
    bytes += Buffer.byteLength(line);
  }
  return bytes;
}

export async function measure({ lines = 100_000, sessions = 80, days = 8, seed = 3 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-bench-ops-"));
  try {
    const gen = generate({ out: path.join(root, "data"), lines, sessions, days, homes: 1, seed, now: NOW, bytesPerLine: 1800 });
    const home = path.join(root, "data", "home-1");
    const roots = [{ tool: "claude-code", directory: path.join(home, ".claude", "projects") }, { tool: "codex", directory: path.join(home, ".codex", "sessions") }];
    const state = path.join(root, "state");
    const directory = path.join(state, "local");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "enrollment.json"), JSON.stringify({ v: 1, organizationId: "org_bench", device: { id: "dev_bench", label: "Bench" },
      orgSalt: crypto.createHash("sha256").update("bench").digest().toString("base64url") }));
    const store = createStore({ dir: state, retentionMs: (days + 1) * 86_400_000, prices: PRICES, now: () => NOW + 60_000 });
    const pass = () => runOnce({ directory, roots, watch: true, compact: true, sinceMs: NOW - (days + 1) * 86_400_000, sinkName: "hub",
      deliver: async (device, records) => store.ingest(device.id, records) });

    const out = { lines: gen.lines, files: gen.files, sourceBytes: gen.bytes };
    let before = snapshot(), t = performance.now();
    const first = await pass();
    out.first = { ...delta(before, snapshot()), ms: Math.round(performance.now() - t), records: first.emitted };
    out.cursorBytes = fs.statSync(path.join(directory, "cursor-v2.json")).size;

    before = snapshot(); t = performance.now();
    await pass();
    out.idle = { ...delta(before, snapshot()), ms: Math.round(performance.now() - t) };

    const appended = appendActivity(home, 5, "one", NOW);
    before = snapshot(); t = performance.now();
    const next = await pass();
    out.fiveNewLines = { ...delta(before, snapshot()), ms: Math.round(performance.now() - t), appendedBytes: appended, records: next.emitted };

    // Restart cost: reading the stored records back, relative to the bare
    // JSON.parse of the same lines (a floor no store can beat). A ratio, so it
    // holds on a slow or a fast machine; each is the best of three runs.
    const storedLines = fs.readdirSync(state).filter((n) => /^records-.*\.ndjson$/u.test(n))
      .flatMap((n) => fs.readFileSync(path.join(state, n), "utf8").split("\n").filter(Boolean));
    const best = (fn) => Math.min(...[0, 1, 2].map(() => { const s = performance.now(); fn(); return performance.now() - s; }));
    const parseMs = best(() => { for (const line of storedLines) JSON.parse(line); });
    const loadMs = best(() => createStore({ dir: state, retentionMs: (days + 1) * 86_400_000, prices: PRICES, now: () => NOW + 60_000 }).load());
    out.storeLoad = { records: storedLines.length, parseMs: Math.round(parseMs), loadMs: Math.round(loadMs), ratio: +(loadMs / parseMs).toFixed(2) };

    const view = buildConsole({ store, registry: { list: () => [{ id: "dev_bench", label: "Bench", local: true, lastContactAt: NOW, mode: "live" }], invitations: () => [] },
      names: null, now: NOW + 60_000, hub: {} });
    out.consoleBytes = Buffer.byteLength(JSON.stringify(view));
    out.storedRecords = store.recordCount;
    if (global.gc) global.gc();
    out.heapMb = Math.round(process.memoryUsage().heapUsed / 1048576);
    return out;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i === -1 ? d : Number(a[i + 1]); };
  const r = await measure({ lines: get("--lines", 100_000), sessions: get("--sessions", 80), days: get("--days", 8) });
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
}
