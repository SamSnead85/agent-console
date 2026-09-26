/**
 * The hub's own machine is read every two seconds. Walking and stat-ing
 * every transcript each time kept about 42% of a core busy on a history of
 * 21,000 files. The scanner looks between sweeps only where something can be
 * changing, and sweeps everything in budgeted slices once a minute.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createScanner, scanRoots } from "../lib/collector/scanner.js";

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = new Date(Date.now() - 2 * 3_600_000);
  for (let p = 0; p < 20; p += 1) {
    for (let f = 0; f < 10; f += 1) {
      const file = path.join(root, `project-${p}`, `session-${f}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{}\n");
      fs.utimesSync(file, old, old);
    }
  }
  fs.writeFileSync(path.join(root, "project-0", "live.jsonl"), "{}\n");
  return root;
}

function countStats() {
  let n = 0;
  const real = fs.statSync;
  fs.statSync = (...args) => { n += 1; return real(...args); };
  return { get n() { return n; }, restore() { fs.statSync = real; } };
}

test("between sweeps only changing files are looked at; a new transcript is seen at once, a resumed quiet one within the sweep", (t) => {
  const root = tree(t);
  const roots = [{ tool: "claude-code", directory: root }];
  let clock = Date.now();
  const scanner = createScanner({ now: () => clock, budgetMs: 1_000 });
  return (async () => {
    const first = await scanner.scan(roots);
    assert.equal(first.whole, true);
    assert.equal(first.all.length, 201, "the first pass lists everything");
    clock += 2_000;
    const stats = countStats();
    let quick;
    try { quick = await scanner.scan(roots); } finally { stats.restore(); }
    assert.equal(quick.whole, false);
    assert.deepEqual(quick.entries, [], "nothing changed");
    assert.ok(stats.n <= 25, `a pass between sweeps stats ${stats.n} things, not 200 files`);
    // The live session grows, and a new session starts in a quiet project.
    fs.appendFileSync(path.join(root, "project-0", "live.jsonl"), "{}\n");
    fs.writeFileSync(path.join(root, "project-7", "new.jsonl"), "{}\n");
    clock += 2_000;
    const next = await scanner.scan(roots);
    assert.deepEqual(next.entries.map((e) => path.relative(root, e.filename)).sort(), [path.join("project-0", "live.jsonl"), path.join("project-7", "new.jsonl")]);
    // A quiet session resumed: seen by the next sweep, within a minute.
    fs.appendFileSync(path.join(root, "project-3", "session-4.jsonl"), "{}\n");
    clock += 2_000;
    assert.deepEqual((await scanner.scan(roots)).entries, []);
    clock += 60_000;
    const swept = await scanner.scan(roots);
    assert.equal(swept.whole, true);
    assert.deepEqual(swept.entries.map((e) => path.relative(root, e.filename)), [path.join("project-3", "session-4.jsonl")]);
    assert.equal(swept.all.length, 202);
  })();
});

test("a sweep is cut into budgeted slices, and only a finished sweep lets a missing file go", async (t) => {
  const root = tree(t);
  const roots = [{ tool: "claude-code", directory: root }];
  let clock = Date.now();
  const scanner = createScanner({ now: () => clock, budgetMs: 0 });
  await scanner.scan(roots);
  fs.rmSync(path.join(root, "project-5", "session-1.jsonl"));
  clock += 61_000;
  let passes = 0, done = null;
  while (!done && passes < 500) {
    passes += 1;
    const listing = await scanner.scan(roots);
    if (listing.whole) done = listing;
    else assert.equal(listing.all, undefined, "a partial sweep never says which files are gone");
    clock += 2_000;
  }
  assert.ok(passes > 1, "the sweep took more than one pass");
  assert.equal(done.all.length, 200);
  // The one-shot walk (a first read, a reporter's first delivery) lists everything in walk order.
  const once = await scanRoots(roots);
  assert.equal(once.entries.length, 200);
  assert.equal(once.whole, true);
});

test("a replaced transcript is read even when its size and modification time match", async (t) => {
  const root = tree(t);
  const file = path.join(root, "project-0", "live.jsonl");
  const roots = [{ tool: "claude-code", directory: root }];
  let clock = Date.now();
  const scanner = createScanner({ now: () => clock, budgetMs: 1000 });
  await scanner.scan(roots);
  const stat = fs.statSync(file);
  const realStat = fs.statSync;
  // Model a new file identity without relying on filesystem timestamp resolution.
  t.mock.method(fs, "statSync", (...args) => {
    const current = realStat(...args);
    if (args[0] === file) return Object.assign(current, { size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs + 1000 });
    return current;
  });
  clock += 2000;
  const quick = await scanner.scan(roots);
  assert.deepEqual(quick.entries.map((entry) => entry.filename), [file]);
  clock += 60_000;
  const sweep = await scanner.scan(roots);
  assert.equal(sweep.whole, true);
  assert.deepEqual(sweep.entries, [], "the replacement was already delivered by the quick pass");
});
