/**
 * After the first read, a pass costs what changed, not what exists
 * (docs/PERFORMANCE.md). These hold the parts that make that true without
 * changing a single record: unchanged transcripts are not reopened, the
 * cursor stops growing with history, and a transcript read in two passes,
 * split in the middle of a streamed response, gives exactly the records of
 * one pass.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runOnce, pruneParserState, STATE_WINDOW_MS } from "../lib/collector/collector.js";
import { generate } from "../bench/generate.mjs";

function setup(t, { lines = 3000, days = 0.2, now = Date.now() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-incremental-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  generate({ out: path.join(root, "data"), lines, sessions: 12, days, homes: 1, seed: 21, now, bytesPerLine: 600 });
  const home = path.join(root, "data", "home-1");
  const roots = [{ tool: "claude-code", directory: path.join(home, ".claude", "projects") }, { tool: "codex", directory: path.join(home, ".codex", "sessions") }];
  const state = (name) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "enrollment.json"), JSON.stringify({ v: 1, organizationId: "org_test", device: { id: "dev_test", label: "Test" },
      orgSalt: crypto.createHash("sha256").update("test").digest().toString("base64url") }));
    return directory;
  };
  const pass = async (directory, sinceMs = 0) => {
    const got = [];
    await runOnce({ directory, roots, sinceMs, sinkName: "hub", compact: true, deliver: async (_d, records) => {
      for (const r of records) got.push(r);
      return { accepted: records.length, duplicate: 0, expired: 0, rejected: [] };
    } });
    return got;
  };
  const files = () => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".jsonl")) out.push(p); } };
    walk(home);
    return out.sort();
  };
  return { root, home, state, pass, files };
}

const sorted = (records) => records.map((r) => JSON.stringify(r)).sort();

test("a transcript read in two passes, split mid-response, gives exactly the records of one pass", async (t) => {
  const s = setup(t);
  const whole = new Map(s.files().map((f) => [f, fs.readFileSync(f)]));
  const once = await s.pass(s.state("once"));
  const twice = s.state("twice");
  for (const [f, b] of whole) fs.writeFileSync(f, b.subarray(0, Math.floor(b.length * 0.53)));
  const first = await s.pass(twice);
  for (const [f, b] of whole) fs.appendFileSync(f, b.subarray(Math.floor(b.length * 0.53)));
  const second = await s.pass(twice);
  assert.ok(once.length > 500 && once.some((r) => r.continuation), "the history has streamed responses");
  assert.deepEqual(sorted([...first, ...second]), sorted(once));
});

test("a pass with nothing new rewrites nothing and reopens no transcript", async (t) => {
  const s = setup(t);
  const directory = s.state("idle");
  await s.pass(directory);
  const cursorFile = path.join(directory, "cursor-v2.json");
  const before = fs.statSync(cursorFile);
  const text = fs.readFileSync(cursorFile, "utf8");
  // Make every transcript unreadable in content but identical in size and
  // time: a pass that reopened one would see the change.
  for (const f of s.files()) {
    const st = fs.statSync(f);
    fs.writeFileSync(f, Buffer.alloc(st.size, 0x20));
    fs.utimesSync(f, st.atime, st.mtime);
  }
  const again = await s.pass(directory);
  assert.equal(again.length, 0);
  assert.equal(fs.readFileSync(cursorFile, "utf8"), text, "the cursor was rewritten");
  assert.equal(fs.statSync(cursorFile).mtimeMs, before.mtimeMs);
});

test("the cursor keeps hours, not the whole history, and forgets transcripts outside the window", async (t) => {
  const now = Date.now();
  const s = setup(t, { lines: 6000, days: 6, now });
  const directory = s.state("window");
  await s.pass(directory);
  const cursor = JSON.parse(fs.readFileSync(path.join(directory, "cursor-v2.json"), "utf8"));
  for (const source of Object.values(cursor.sources)) {
    for (const key of ["claudeUsage", "codexEventIds"]) {
      const marks = Object.values(source.parser[key] || {}).map((v) => Date.parse(typeof v === "string" ? v : v.firstAt));
      if (!marks.length) continue;
      assert.ok(Math.max(...marks) - Math.min(...marks) <= STATE_WINDOW_MS, `${key} spans more than the window`);
      assert.ok(Math.max(...marks) >= now - STATE_WINDOW_MS - 60_000, `${key} kept marks of a quiet transcript`);
    }
  }
  const sources = Object.keys(cursor.sources).length;
  await s.pass(directory, now - 2 * 86_400_000);
  const narrowed = JSON.parse(fs.readFileSync(path.join(directory, "cursor-v2.json"), "utf8"));
  assert.ok(Object.keys(narrowed.sources).length < sources, "transcripts outside the window kept their state");
});

test("pruneParserState drops marks hours older than the newest, and all of a quiet transcript's", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");
  const at = (h) => new Date(now - h * 3600_000).toISOString();
  const live = { claudeUsage: { a: { firstAt: at(0.1) }, b: { firstAt: at(7) } }, codexEventIds: { c: at(0.2), d: at(9), e: true } };
  assert.equal(pruneParserState(live, now), true);
  assert.deepEqual(Object.keys(live.claudeUsage), ["a"]);
  assert.deepEqual(Object.keys(live.codexEventIds), ["c", "e"], "an undated mark stays while the transcript is live");
  const quiet = { claudeUsage: { a: { firstAt: at(8) } }, claudeFallbackSent: { f: true }, sessionHash: "x" };
  assert.equal(pruneParserState(quiet, now), true);
  assert.deepEqual(quiet, { sessionHash: "x" });
  assert.equal(pruneParserState({ sessionHash: "x" }, now), false);
});
