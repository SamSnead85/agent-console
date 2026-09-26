/**
 * What a first-time user meets, from a real-data run against an independent
 * tally and a first-install review: the 30 days on a first install, archived
 * Codex threads, CLAUDE_CONFIG_DIR and CODEX_HOME, Projects against the
 * Console, a console of an older version still running, the join address on
 * Windows and WSL, and plain remedies for a failed start. Synthetic
 * transcripts and records only; the only network is 127.0.0.1.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createStore, firstDay } from "../lib/hub/store.js";
import { createRegistry } from "../lib/hub/registry.js";
import { createNames, startLocalCollection } from "../lib/hub/local.js";
import { buildConsole } from "../lib/hub/aggregate.js";
import { projectsPayload } from "../lib/hub/projects.js";
import { createReportingHandler, hubAddresses, coverageOf, priceTableInfo } from "../lib/hub/routes.js";
import { runOnce, transcriptRoots, defaultRoots } from "../lib/collector/collector.js";
import { createScanner } from "../lib/collector/scanner.js";
import { eventMeasurement } from "../lib/collector/measurement.js";
import { emptyReadNotice, olderConsoleNotice, compareVersions, stopCommand, remedy } from "../lib/hub/notices.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server.js");
const PRICES = JSON.parse(fs.readFileSync(new URL("../lib/collector/prices.json", import.meta.url), "utf8"));
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const h = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function scratch(t, name = "agent-console-first-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rec({ device = "dev_a", session = "s1", parent = null, tool = "claude-code", model = "claude-sonnet-5", at, tokens = 100, id = null }) {
  const r = { id: id || h(`${device}|${session}|${at}|${tokens}`), tool, model, sessionHash: h(session), parentSessionHash: parent ? h(parent) : null,
    isSubagent: Boolean(parent), projectHash: h("project"), engagement: null, reportingDevice: device, executionOrigin: "unknown",
    at: new Date(Math.floor(at / MINUTE) * MINUTE).toISOString(), fresh: tokens, output: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null,
    ttl: "unknown", cacheRead: 0, observed: true, continuation: false, tier: "standard", cumulative: false };
  r.measurement = eventMeasurement(r);
  return r;
}

/** Tokens per UTC day and machine in the daily rollup. */
function days(store, device = "dev_a") {
  const out = {};
  store.eachDay("0000-01-01", "9999-12-31", (day, b) => { if (b.deviceId === device) out[day] = (out[day] || 0) + b.fresh + b.output + b.cacheWrite + b.cacheRead; });
  return out;
}

// ---------------------------------------------------------------------------
// 1. The 30 days on a first install
// ---------------------------------------------------------------------------

test("a first read fills the 30 days: days past minute retention go straight into the daily totals, and a re-read adds nothing", (t) => {
  const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
  const dir = scratch(t);
  const store = createStore({ dir, retentionMs: 8 * DAY, prices: PRICES, now: () => NOW });
  store.load();
  const rows = [rec({ at: NOW - 20 * DAY, tokens: 100 }), rec({ at: NOW - 20 * DAY + MINUTE, tokens: 50 }),
    rec({ at: NOW - 12 * DAY, tokens: 30 }), rec({ at: NOW - 2 * DAY, tokens: 7 })];
  const receipt = store.ingest("dev_a", rows, { backfill: firstDay(NOW) });
  assert.deepEqual(receipt, { accepted: 4, duplicate: 0, expired: 0, rejected: [] });
  store.endBackfill("dev_a");
  const expected = { [dayOf(NOW - 20 * DAY)]: 150, [dayOf(NOW - 12 * DAY)]: 30, [dayOf(NOW - 2 * DAY)]: 7 };
  assert.deepEqual(days(store), expected, "43% was what the 8 days held; the month is whole now");
  assert.equal(store.dailySince, firstDay(NOW), "the rollup says it is whole from the first read's first day");
  // A re-read of the same history — as a first read again, and as an ordinary delivery — adds nothing.
  store.ingest("dev_a", rows, { backfill: firstDay(NOW) });
  store.endBackfill("dev_a");
  store.ingest("dev_a", rows);
  assert.deepEqual(days(store), expected);
  assert.equal(store.dropped.pastRetention, 0, "a day a first read made whole is not reported as a drop");
  store.flush();
  // After a restart the month is still whole, and still counted once.
  const again = createStore({ dir, retentionMs: 8 * DAY, prices: PRICES, now: () => NOW });
  again.load();
  assert.deepEqual(days(again), expected);
  assert.equal(again.dailySince, firstDay(NOW));
});

test("a first read replaces what the rollup held for that machine and day, so a machine read again is not counted twice", () => {
  let clock = Date.UTC(2026, 8, 10, 12, 0, 0);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => clock });
  const day = clock - 2 * DAY;
  const rows = [rec({ at: day, tokens: 100 }), rec({ at: day + HOUR, tokens: 20 })];
  store.ingest("dev_a", rows);          // delivered live while the day was inside retention
  clock += 15 * DAY;                    // the minutes and their ids are long gone
  store.prune();
  store.ingest("dev_a", rows, { backfill: firstDay(clock) });   // the same machine reads its history again from nothing
  store.endBackfill("dev_a");
  assert.equal(days(store)[dayOf(day)], 120, "replaced, not 240");
});

test("a first read survives a lost answer and a hub restart in the middle, and still counts every record once", (t) => {
  const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
  const dir = scratch(t);
  const open = () => { const s = createStore({ dir, retentionMs: 8 * DAY, prices: PRICES, now: () => NOW }); s.load(); return s; };
  const first = [rec({ device: "dev_r", at: NOW - 15 * DAY, tokens: 10 }), rec({ device: "dev_r", at: NOW - 15 * DAY + MINUTE, tokens: 20 })];
  const second = [rec({ device: "dev_r", at: NOW - 15 * DAY + 2 * MINUTE, tokens: 40 }), rec({ device: "dev_r", at: NOW - 25 * DAY, tokens: 80 })];
  let store = open();
  store.ingest("dev_r", first, { backfill: firstDay(NOW) });
  assert.deepEqual(store.ingest("dev_r", first, { backfill: firstDay(NOW) }), { accepted: 0, duplicate: 2, expired: 0, rejected: [] }, "a lost answer, resent");
  store = open();                       // the hub restarts; the reporter resends its unanswered batch, then the rest
  assert.equal(store.backfilling("dev_r"), true);
  assert.equal(store.ingest("dev_r", first, { backfill: firstDay(NOW) }).duplicate, 2);
  store.ingest("dev_r", second, { backfill: firstDay(NOW) });
  store.endBackfill("dev_r");
  assert.deepEqual(days(store, "dev_r"), { [dayOf(NOW - 15 * DAY)]: 70, [dayOf(NOW - 25 * DAY)]: 80 });
});

/** A synthetic Claude Code transcript: one usage line per `at`. */
function claudeTranscript(file, times, { session = "synthetic-session" } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = times.map((at, i) => JSON.stringify({ type: "assistant", uuid: `${session}-u${i}`, sessionId: session, cwd: "/synthetic/project",
    timestamp: new Date(at).toISOString(), isSidechain: false,
    message: { id: `${session}-m${i}`, model: "claude-sonnet-5", content: "synthetic", usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }));
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const last = new Date(Math.max(...times));
  fs.utimesSync(file, last, last);
}

test("the console's first read of this machine goes back 30 UTC days, and the 30-day view says so whole", async (t) => {
  const base = scratch(t);
  const now = Date.now();
  const root = path.join(base, "claude");
  claudeTranscript(path.join(root, "old", "a.jsonl"), [now - 20 * DAY, now - 20 * DAY + MINUTE]);
  claudeTranscript(path.join(root, "new", "b.jsonl"), [now - HOUR], { session: "recent-session" });
  const stateDir = path.join(base, "state");
  const registry = createRegistry({ dir: stateDir });
  const store = createStore({ dir: stateDir, retentionMs: 8 * DAY, prices: PRICES });
  store.load();
  const names = createNames(stateDir);
  const local = startLocalCollection({ registry, store, names, stateDir, roots: [{ tool: "claude-code", directory: root }], intervalMs: 3_600_000 });
  t.after(() => local.stop());
  await local.ready;
  const id = local.status.device.id;
  assert.equal(days(store, id)[dayOf(now - 20 * DAY)], 220, "twenty days ago, past the 8 days of minutes");
  assert.equal(local.status.backfill.complete, true);
  const view = buildConsole({ store, registry, now: Date.now(), hub: {} });
  assert.equal(view.windows["30d"].since, firstDay(Date.now()));
  assert.equal(view.windows["30d"].partial, false);
  assert.ok(view.series["30d"].whole.every(Boolean), "every day of the month is whole, the edge day too");
  assert.equal(view.windows["30d"].tokens.total, 330);
});

test("a reporter's first delivery goes back 30 days and says so until it is complete; the next one does not", async (t) => {
  const base = scratch(t);
  const now = Date.now();
  const registry = createRegistry({ dir: null });
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES });
  const config = { demo: false, listen: "0.0.0.0", retentionDays: 8, inviteMinutes: 30, allowPublic: false };
  const handle = createReportingHandler({ config, registry, store, version: "0.0.0", publicDir: process.cwd() });
  const server = http.createServer((req, res) => { handle(req, res, { secure: true }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { code } = registry.invite({ person: "Platform engineer", machine: "Laptop" });
  const { device, token } = registry.redeem(code);
  const directory = path.join(base, "state");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "enrollment.json"), JSON.stringify({ v: 1, organizationId: registry.organizationId,
    device: { id: device.id, label: device.label }, orgSalt: registry.orgSalt }), { mode: 0o600 });
  const root = path.join(base, "claude");
  claudeTranscript(path.join(root, "p", "a.jsonl"), [now - 18 * DAY, now - 30 * MINUTE]);
  const bodies = [];
  const fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return globalThis.fetch(url, init); };
  const pass = () => runOnce({ directory, roots: [{ tool: "claude-code", directory: root }], token, post: `http://127.0.0.1:${server.address().port}/api/ingest`,
    compact: true, sinceMs: now - 8 * DAY, backfillFromMs: Date.parse(firstDay(now) + "T00:00:00Z"), transport: { fetch, sleep: async () => {} } });
  await pass();
  assert.ok(bodies.length > 0 && bodies.every((b) => b.backfill && b.backfill.from === firstDay(now)), "every envelope of the first delivery says so");
  assert.equal(days(store, device.id)[dayOf(now - 18 * DAY)], 110);
  assert.equal(store.backfilling(device.id), false, "closed with its last envelope");
  bodies.length = 0;
  await pass();
  assert.ok(bodies.every((b) => !("backfill" in b)), "a later delivery is an ordinary one");
});

// ---------------------------------------------------------------------------
// 2. Archived Codex threads
// ---------------------------------------------------------------------------

function codexRollout(file, thread, turns, start) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const totals = (input, output) => ({ input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
  const at = (s) => new Date(start + s * 1000).toISOString();
  const rows = [{ timestamp: at(0), type: "session_meta", payload: { id: thread, cwd: "/synthetic/project" } },
    { timestamp: at(0), ordinal: 1, type: "turn_context", payload: { model: "gpt-5.6-sol", cwd: "/synthetic/project" } }];
  for (let i = 1; i <= turns; i += 1) {
    rows.push({ timestamp: at(i * 10), ordinal: i + 1, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: totals(100 * i, 10 * i), last_token_usage: totals(100, 10) } } });
  }
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows;
}

test("an archived Codex thread is read, and a thread that moves when it is archived is recognised as already counted", async (t) => {
  const home = scratch(t);
  const directory = path.join(home, "state");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "enrollment.json"), JSON.stringify({ v: 1, organizationId: "synthetic-org",
    device: { id: "dev_codex", label: "Laptop" }, orgSalt: Buffer.alloc(32, 5).toString("base64url") }), { mode: 0o600 });
  const roots = transcriptRoots({ home, env: {} });
  assert.ok(roots.some((r) => r.tool === "codex" && r.directory === path.join(home, ".codex", "archived_sessions") && r.optional));
  const thread = "d0000099-0000-4000-8000-000000000099";
  const start = Date.now() - 30 * MINUTE;
  const live = path.join(home, ".codex", "sessions", "2026", "09", "25", `rollout-2026-09-25T10-00-00-${thread}.jsonl`);
  codexRollout(live, thread, 3, start);
  // Already archived before the first read: read too.
  codexRollout(path.join(home, ".codex", "archived_sessions", "rollout-older.jsonl"), "d0000098-0000-4000-8000-000000000098", 2, start);
  const delivered = [];
  const pass = () => runOnce({ directory, roots, sinkName: "hub", deliver: async (_d, records) => { delivered.push(...records); return { accepted: records.length, duplicate: 0, expired: 0, rejected: [] }; } });
  await pass();
  assert.equal(delivered.length, 5, "three responses in the live thread, two in the archived one");
  // Codex archives the thread: the same file, moved.
  const archived = path.join(home, ".codex", "archived_sessions", path.basename(live));
  fs.renameSync(live, archived);
  delivered.length = 0;
  const moved = await pass();
  assert.equal(delivered.length, 0, "nothing in it is read or counted again");
  assert.equal(moved.coverage.filesMoved, 1);
  // And it goes on from where it was.
  fs.appendFileSync(archived, JSON.stringify({ timestamp: new Date(start + 60_000).toISOString(), ordinal: 9, type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 400, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0, total_tokens: 440 },
      last_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 } } } }) + "\n");
  await pass();
  assert.equal(delivered.length, 1, "only the new response");
});

test("with the console's scanner, a thread moved between sweeps waits for the sweep, and is then known, not read again", async (t) => {
  const home = scratch(t);
  const directory = path.join(home, "state");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "enrollment.json"), JSON.stringify({ v: 1, organizationId: "synthetic-org",
    device: { id: "dev_codex", label: "Laptop" }, orgSalt: Buffer.alloc(32, 6).toString("base64url") }), { mode: 0o600 });
  const roots = transcriptRoots({ home, env: {} });
  fs.mkdirSync(path.join(home, ".codex", "archived_sessions"), { recursive: true });
  const thread = "d0000097-0000-4000-8000-000000000097";
  const start = Date.now() - 20 * MINUTE;
  const live = path.join(home, ".codex", "sessions", "2026", "09", "25", `rollout-${thread}.jsonl`);
  codexRollout(live, thread, 3, start);
  let clock = Date.now();
  const scanner = createScanner({ now: () => clock, budgetMs: 1_000 });
  const delivered = [];
  const pass = () => runOnce({ directory, roots, scanner, sinkName: "hub", deliver: async (_d, records) => { delivered.push(...records); return { accepted: records.length, duplicate: 0, expired: 0, rejected: [] }; } });
  await pass();
  assert.equal(delivered.length, 3);
  const archived = path.join(home, ".codex", "archived_sessions", path.basename(live));
  fs.renameSync(live, archived);
  delivered.length = 0;
  clock += 2_000;
  await pass();                               // seen at once, but only a whole listing can say the old path is gone
  assert.equal(delivered.length, 0);
  clock += 61_000;
  const swept = await pass();
  assert.equal(delivered.length, 0, "known by its first line: nothing counted twice");
  assert.equal(swept.coverage.filesMoved, 1);
});

// ---------------------------------------------------------------------------
// 3. CLAUDE_CONFIG_DIR, CODEX_HOME, and the folders named when nothing is found
// ---------------------------------------------------------------------------

test("CLAUDE_CONFIG_DIR and CODEX_HOME are read, --claude-root and --codex-root override them, and a --home ignores this user's", () => {
  const home = "/synthetic/home";
  const env = { CLAUDE_CONFIG_DIR: "/synthetic/work-claude", CODEX_HOME: "~/codex-home" };
  const roots = transcriptRoots({ home, env });
  const of = (tool) => roots.filter((r) => r.tool === tool).map((r) => [r.directory, r.optional]);
  assert.deepEqual(of("claude-code"), [[path.resolve("/synthetic/work-claude/projects"), false],
    [path.resolve(home, ".claude/projects"), true], [path.resolve(home, ".config/claude/projects"), true]]);
  assert.deepEqual(of("codex"), [[path.resolve(home, "codex-home/sessions"), false], [path.resolve(home, "codex-home/archived_sessions"), true],
    [path.resolve(home, ".codex/sessions"), true], [path.resolve(home, ".codex/archived_sessions"), true]]);
  const overridden = transcriptRoots({ home, env, claudeRoot: "/synthetic/elsewhere", codexRoot: "/synthetic/codex" });
  assert.deepEqual(overridden.map((r) => r.directory), [path.resolve("/synthetic/elsewhere"), path.resolve("/synthetic/codex")]);
  assert.deepEqual(defaultRoots("/synthetic/other-home").map((r) => r.kind), ["default", "xdg", "default", "default"], "another home: no environment");
});

test("the console reads CLAUDE_CONFIG_DIR/projects, names every folder it read, and says where it looked when it found nothing", async (t) => {
  const home = scratch(t);
  const configured = path.join(home, "work-claude");
  claudeTranscript(path.join(configured, "projects", "p", "a.jsonl"), [Date.now() - HOUR]);
  const stateDir = path.join(home, "state");
  const registry = createRegistry({ dir: stateDir });
  const store = createStore({ dir: stateDir, retentionMs: 8 * DAY, prices: PRICES });
  store.load();
  const roots = transcriptRoots({ home, env: { CLAUDE_CONFIG_DIR: configured } });
  const local = startLocalCollection({ registry, store, names: createNames(stateDir), stateDir, roots, intervalMs: 3_600_000 });
  t.after(() => local.stop());
  await local.ready;
  assert.ok(store.recordCount > 0, "CLAUDE_CONFIG_DIR's transcripts were read");
  const read = local.status.rootsRead.find((r) => r.directory === path.join(configured, "projects"));
  assert.deepEqual([read.exists, read.files], [true, 1]);
  assert.ok(local.status.rootsRead.some((r) => r.tool === "codex" && r.exists === false));
  const notice = emptyReadNotice([{ tool: "claude-code", directory: "/synthetic/.claude/projects", optional: false, exists: false, files: 0 },
    { tool: "codex", directory: "/synthetic/.codex/sessions", optional: false, exists: true, files: 0 },
    { tool: "codex", directory: "/synthetic/.codex/archived_sessions", optional: true, exists: false, files: 0 }], "agent-console");
  assert.match(notice, /Claude Code +\/synthetic\/\.claude\/projects +\(not there\)/u);
  assert.match(notice, /Codex +\/synthetic\/\.codex\/sessions +\(0 files\)/u);
  assert.ok(!notice.includes("archived_sessions"), "an optional folder that is absent is not listed");
  assert.match(notice, /--claude-root <folder> or --codex-root <folder>/u);
});

test("a console that finds nothing says, in its window, where it looked and how to point it elsewhere", async (t) => {
  const home = scratch(t);
  const child = spawn(process.execPath, [SERVER, "--port", "0", "--report-port", "0", "--home", home, "--state-dir", path.join(home, "state")], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGINT"));
  let out = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no ready line: " + out)), 20_000);
    child.stdout.on("data", (d) => { out += d; if (/--codex-root <folder>/u.test(out)) { clearTimeout(timer); resolve(); } });
  });
  assert.match(out, /ready: 1 machine · 0 records/u);
  assert.match(out, /No Claude Code or Codex transcripts were found on this machine\. Looked in:/u);
  assert.ok(out.includes(path.join(home, ".claude", "projects")) && out.includes(path.join(home, ".codex", "sessions")), out);
  assert.match(out, /start with --claude-root <folder> or --codex-root <folder>/u);
});

// ---------------------------------------------------------------------------
// 4. Projects counts sessions as the Console counts lanes
// ---------------------------------------------------------------------------

test("Projects counts a Codex thread with subagents nested three deep as one session, as the Console does", async () => {
  const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
  const store = createStore({ dir: null, retentionMs: 8 * DAY, prices: PRICES, now: () => NOW });
  const registry = createRegistry({ dir: null, now: () => NOW });
  registry.addSynthetic({ id: "dev_a", label: "Studio", person: "You", local: true, createdAt: new Date(NOW - 9 * DAY).toISOString() });
  registry.touch("dev_a", { at: NOW, freshness: { mode: "live", lastObservedAt: null, lastSyncedAt: null }, coverage: {} });
  store.ingest("dev_a", [rec({ tool: "codex", model: "gpt-5.6-sol", session: "root", at: NOW - 10 * MINUTE }),
    rec({ tool: "codex", model: "gpt-5.6-sol", session: "c1", parent: "root", at: NOW - 9 * MINUTE }),
    rec({ tool: "codex", model: "gpt-5.6-sol", session: "c2", parent: "c1", at: NOW - 8 * MINUTE }),
    rec({ tool: "codex", model: "gpt-5.6-sol", session: "c3", parent: "c2", at: NOW - 7 * MINUTE })]);
  const names = { project: () => "atlas", branch: () => null, path: () => null };
  const view = buildConsole({ store, registry, now: NOW, hub: {} });
  for (const period of ["1h", "24h"]) {
    const p = await projectsPayload({ store, registry, names, period, demo: false, now: NOW });
    assert.equal(p.sessions, 1, period);
    assert.equal(p.subagents, 3, period);
    assert.equal(p.sessions, view.laneTotals.periods?.[period]?.sessions ?? view.laneCount, `${period}: Projects equals the Console`);
  }
});

// ---------------------------------------------------------------------------
// 6. An older console still running
// ---------------------------------------------------------------------------

test("a newer version never opens an older console that is still running: it names it and gives the exact stop command", async (t) => {
  assert.equal(compareVersions("0.3.0", "0.4.0"), -1);
  assert.equal(compareVersions("0.4.0", "0.4.0"), 0);
  assert.equal(compareVersions("0.4.1-rc.1", "0.4.1"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(stopCommand({ pid: 4242, platform: "darwin" }), "kill 4242");
  assert.equal(stopCommand({ pid: 4242, platform: "win32" }), "taskkill /PID 4242 /F");
  assert.equal(stopCommand({ port: 6787, platform: "linux" }), "kill $(lsof -ti tcp:6787 -sTCP:LISTEN)");
  assert.equal(olderConsoleNotice({ running: { version: "0.5.0" }, version: "0.4.1", url: "http://127.0.0.1:6787" }), null, "a newer one is not called older");
  // A console of 0.3.0 answers on the port this start is told to use.
  const old = http.createServer((req, res) => {
    if (req.url === "/api/hello") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ product: "Agent Console", version: "0.3.0", demo: false })); return; }
    res.writeHead(404); res.end();
  });
  old.listen(0, "127.0.0.1");
  await once(old, "listening");
  t.after(() => old.close());
  const port = old.address().port;
  const state = scratch(t);
  const child = spawn(process.execPath, [SERVER, "--port", String(port), "--no-local", "--state-dir", state], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENT_CONSOLE_DEMO: "" } });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const [codeExit] = await once(child, "exit");
  assert.equal(codeExit, 1);
  assert.match(err, /An older Agent Console \(0\.3\.0\) is still running at http:\/\/127\.0\.0\.1:\d+; this is \d+\.\d+\.\d+/u);
  assert.match(err, /It was not opened\./u);
  assert.match(err, process.platform === "win32" ? /Stop-Process -Id/u : /kill \$\(lsof -ti tcp:\d+ -sTCP:LISTEN\)/u);
  assert.ok(!/Sign in|opening it/u.test(out + err), "never offered as if it were this one");
});

// ---------------------------------------------------------------------------
// 7. The join address on Windows and WSL
// ---------------------------------------------------------------------------

test("the join link carries a LAN address: Wi-Fi before WSL's and Docker's virtual switches, --advertise first, and WSL is said", () => {
  const v4 = (address) => [{ family: "IPv4", address, internal: false }];
  const windows = { "vEthernet (WSL)": v4("172.29.64.1"), "vEthernet (Default Switch)": v4("172.20.48.1"), "Ethernet 2": v4("169.254.10.2"),
    "Wi-Fi": v4("192.168.1.23"), "Loopback Pseudo-Interface 1": [{ family: "IPv4", address: "127.0.0.1", internal: true }] };
  const win = hubAddresses("0.0.0.0", 6788, { interfaces: windows, wsl: false });
  assert.equal(win.urls[0], "http://192.168.1.23:6788", "the Wi-Fi adapter, not the WSL switch");
  assert.ok(!win.urls.some((u) => u.includes("169.254.")), "a link-local address is never offered");
  assert.equal(hubAddresses("0.0.0.0", 6788, { interfaces: { docker0: v4("172.17.0.1"), en0: v4("192.168.1.5") }, wsl: false }).urls[0], "http://192.168.1.5:6788");
  const inside = hubAddresses("0.0.0.0", 6788, { interfaces: { eth0: v4("172.21.144.5") }, wsl: true });
  assert.equal(inside.wsl, true, "inside WSL the console says its address is likely this computer's only");
  const told = hubAddresses("0.0.0.0", 6788, { interfaces: { eth0: v4("172.21.144.5") }, wsl: true, advertise: "192.168.1.23" });
  assert.deepEqual([told.urls[0], told.advertised], ["http://192.168.1.23:6788", true]);
});

// ---------------------------------------------------------------------------
// 8. A failed start says what to do
// ---------------------------------------------------------------------------

test("a first start that cannot write its folder says so in one line, with the remedy, and no stack trace", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const base = scratch(t);
  const locked = path.join(base, "read-only");
  fs.mkdirSync(locked, { mode: 0o500 });
  t.after(() => { try { fs.chmodSync(locked, 0o700); } catch { /* already removed */ } });
  const child = spawn(process.execPath, [SERVER, "--port", "0", "--report-port", "0", "--no-local", "--state-dir", path.join(locked, "state")], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const [codeExit] = await once(child, "exit");
  assert.equal(codeExit, 1);
  assert.match(err, /Permission denied opening the console's data folder \(.*read-only.*\)\. Give your user read and write access to it, or start with --state-dir <a folder you own>\./u);
  assert.ok(!/\n\s+at /u.test(err), "no stack trace");
  assert.equal(err.trim().split("\n").length, 1, "one line");
  assert.match(remedy(Object.assign(new Error("listen EACCES"), { code: "EACCES", syscall: "listen" }), { port: 80 }), /Port 80 needs administrator rights/u);
  assert.match(remedy(Object.assign(new Error("no space"), { code: "ENOSPC" }), { what: "saving", path: "/synthetic/state" }), /disk is full/u);
});

// ---------------------------------------------------------------------------
// (b) The price table, and a first start that is not a restart
// ---------------------------------------------------------------------------

test("the console names its offline price table, and a first start is never called a restart", () => {
  const info = priceTableInfo(PRICES);
  assert.equal(info.v, PRICES.v);
  assert.equal(info.checkedOn, PRICES.inventoryCheckedOn);
  assert.equal(info.models, PRICES.rows.length);
  assert.match(info.lastVerifiedOn, /^\d{4}-\d{2}-\d{2}$/u);
  const startedAt = Date.UTC(2026, 8, 25, 12, 0, 0);
  const declared = { state: "on", since: startedAt + 5_000 };
  assert.equal(coverageOf(declared, startedAt - 4 * MINUTE, startedAt).reason, "console-restarted");
  assert.equal(coverageOf(declared, startedAt - 4 * MINUTE, startedAt, { firstStart: true }).reason, "first-start");
});
