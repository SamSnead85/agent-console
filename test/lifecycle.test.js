/**
 * Where the console meets people and other programs: mistakes are refused,
 * input the console changes is said, one reporter runs per state directory,
 * removed machines are not silent ones, and a signed-out console can be
 * signed into again — a demo one too.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { readConfig, closest } from "../lib/config.js";
import { parse, failureReason, findMovedHub, takeReporterLock, runningReporter, backgroundArgs } from "../lib/reporter.js";
import { createRegistry, labelProblem, cleanLabel } from "../lib/hub/registry.js";
import { createStore } from "../lib/hub/store.js";
import { buildConsole, deviceStatus, RECONNECT_GRACE_MS } from "../lib/hub/aggregate.js";
import { postRecords } from "../lib/collector/transport.js";
import { isCertificateError } from "../lib/collector/pinned.js";
import { createGitStatsStore, gitStatsForPeriod, authorArgs } from "../lib/gitstats.js";
import { eventMeasurement } from "../lib/collector/measurement.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "agent-console.mjs");
const CONSOLE_JS = fs.readFileSync(path.join(HERE, "..", "public", "console.js"), "utf8");
const PRICES = JSON.parse(fs.readFileSync(path.join(HERE, "..", "lib", "collector", "prices.json"), "utf8"));
const INTENT = { "x-agent-console": "1" };

function scratch(t, prefix = "agent-console-life-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// L4: mistakes are refused
// ---------------------------------------------------------------------------

test("a mistyped command is refused, not taken as a start of the console", () => {
  const r = spawnSync(process.execPath, [BIN, "joni", "http://127.0.0.1:1/join#x"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /"joni" is not an Agent Console command\. Did you mean "join"\?/u);
  assert.doesNotMatch(r.stdout, /Agent Console/u, "a console started");
  const json = spawnSync(process.execPath, [BIN, "reprot", "--json"], { encoding: "utf8" });
  assert.equal(json.status, 2);
  assert.equal(JSON.parse(json.stdout.trim()).kind, "usage");
  // metrics-token is a command, so a near miss is pointed at it.
  const near = spawnSync(process.execPath, [BIN, "metrics-tokn"], { encoding: "utf8" });
  assert.equal(near.status, 2);
  assert.match(near.stderr, /Did you mean "metrics-token"\?.*policy and metrics-token/su);
});

test("the console refuses unknown options and values out of range, and says which", () => {
  assert.deepEqual(readConfig(["--demo", "--port", "0", "--json"], {}).errors, []);
  assert.match(readConfig(["--nmae", "x"], {}).errors[0], /--nmae is not an option.*Did you mean --name\?/u);
  assert.match(readConfig(["--port", "abc"], {}).errors[0], /--port needs a whole number from 0 to 65535/u);
  assert.match(readConfig(["--retention-days", "400"], {}).errors[0], /from 1 to 90/u);
  assert.match(readConfig(["stray"], {}).errors[0], /"stray" is not an option/u);
  assert.equal(readConfig(["--alert-spike-factor", "2.5"], {}).errors.length, 0);
  assert.equal(closest("intervall", ["interval", "name"]), "interval");
  const r = spawnSync(process.execPath, [BIN, "--demo", "--port", "0", "--json", "--intervall", "3"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout.trim()).errors[0], /--intervall is not an option/u);
});

test("the reporter refuses unknown options, other commands' options and bad values", () => {
  assert.throws(() => parse(["--intervall", "3"], "report"), /--intervall is not an option of report\. Did you mean --interval\?/u);
  assert.throws(() => parse(["--name", "Laptop"], "report"), /--name applies to join, not report/u);
  assert.throws(() => parse(["--interval", "abc"], "report"), /whole number of seconds from 2 to 3600; got "abc"/u);
  assert.throws(() => parse(["--interval", "1"], "report"), /from 2 to 3600/u);
  assert.throws(() => parse(["link", "--name", "<script>"], "join"), /--name cannot be used: it contains < or >/u);
  assert.throws(() => parse(["link", "--name", "🙂".repeat(41)], "join"), /longer than 40 characters/u);
  assert.throws(() => parse(["extra"], "leave"), /leave takes no link/u);
  assert.throws(() => parse(["--background", "--once"], "report"), /do not go together/u);
  assert.equal(parse(["link", "--name", "🙂".repeat(20), "--interval", "120"], "join").flags.get("interval"), "120");
});

test("under --json a reporter's mistake is a JSON line on stdout", () => {
  const r = spawnSync(process.execPath, [BIN, "report", "--json", "--intervall", "3"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  const line = JSON.parse(r.stdout.trim());
  assert.equal(line.event, "error");
  assert.equal(line.kind, "usage");
  assert.match(line.message, /--intervall/u);
  assert.equal(r.stderr, "");
});

test("a background reporter is started with the arguments its runtime expects", (t) => {
  const state = scratch(t);
  const carried = ["--state-dir", state, "--interval", "30"];
  // Under node, the script comes first; a standalone executable carries its own
  // entry, so what it is given starts at the command.
  assert.deepEqual(backgroundArgs(carried, { sea: false, entry: BIN }), [BIN, "report", ...carried]);
  assert.deepEqual(backgroundArgs(carried, { sea: true, entry: BIN }), ["report", ...carried]);
  // What each child then sees, run for real: packaging/sea/main.cjs puts the
  // unpacked entry at argv[1] ahead of the given arguments, which node does
  // for a script. Either way the dispatcher reaches `report` (here refusing an
  // unenrolled state directory), never "not an Agent Console command".
  for (const [sea, argv] of [[false, backgroundArgs([...carried, "--json"], { sea: false, entry: BIN })],
    [true, [BIN, ...backgroundArgs([...carried, "--json"], { sea: true, entry: BIN })]]]) {
    const r = spawnSync(process.execPath, argv, { encoding: "utf8" });
    const line = JSON.parse(r.stdout.trim());
    assert.equal(r.status, 2, `sea=${sea}: ${r.stdout}`);
    assert.doesNotMatch(line.message, /is not an Agent Console command/u, `sea=${sea}`);
    assert.match(line.message, /has not joined a console yet/u, `sea=${sea}`);
  }
});

// ---------------------------------------------------------------------------
// L6 and L1: names, re-joins and leaving, in the registry
// ---------------------------------------------------------------------------

test("a name is measured as a person counts it, and a refused one says why", () => {
  assert.equal(labelProblem("🙂".repeat(40)), null, "forty emoji are forty characters");
  assert.match(labelProblem("🙂".repeat(41)), /longer than 40/u);
  assert.match(labelProblem("<script>"), /< or >/u);
  assert.equal(cleanLabel("  Build   box "), "Build box");
});

test("joins: an unusable name is said, a duplicate is numbered, and the default is the smallest free Machine N", () => {
  const registry = createRegistry({ dir: null });
  const code = () => registry.invite({ person: "Platform engineer" }).code;
  const bad = registry.redeem(code(), { name: "<b>box</b>" });
  assert.equal(bad.device.label, "Machine 1");
  assert.deepEqual(bad.renamed, { asked: "<b>box</b>", used: "Machine 1", reason: "it contains < or >" });
  const first = registry.redeem(code(), { name: "Laptop" });
  const second = registry.redeem(code(), { name: "Laptop" });
  assert.equal(first.device.label, "Laptop");
  assert.equal(second.device.label, "Laptop 2");
  assert.match(second.renamed.reason, /already has that name/u);
  registry.revoke(bad.device.id);
  assert.equal(registry.redeem(code()).device.label, "Machine 1", "a removed machine's name is free again");
});

test("joining again with the current or last token keeps the machine's entry; leaving keeps only a verifier", () => {
  const registry = createRegistry({ dir: null });
  const joined = registry.redeem(registry.invite({ person: "You", machine: "Laptop" }).code);
  const again = registry.redeem(registry.invite({ person: "You", machine: "Laptop" }).code, { previousToken: joined.token });
  assert.equal(again.reattached, true);
  assert.equal(again.device.id, joined.device.id);
  assert.equal(registry.authenticate(joined.token), null, "the old token stops working");
  assert.equal(registry.list().length, 1, "no second machine of the same name");

  assert.equal(registry.leave(again.device.id), true);
  const left = registry.get(again.device.id);
  assert.ok(left.leftAt && left.revokedAt);
  assert.equal(left.retiredTokenHash, undefined, "no verifier leaves the registry");
  assert.equal(registry.authenticate(again.token), null);
  const back = registry.redeem(registry.invite({ person: "You" }).code, { previousToken: again.token });
  assert.equal(back.device.id, joined.device.id);
  assert.equal(registry.get(back.device.id).revokedAt, null);
  assert.equal(registry.redeem(registry.invite({}).code, { previousToken: "acd_" + "x".repeat(43) }).reattached, false);
});

// ---------------------------------------------------------------------------
// L5: removed machines and restarts
// ---------------------------------------------------------------------------

function record(device, at) {
  const h = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
  const row = {
    id: h("r" + device + at), tool: "claude-code", model: "claude-sonnet-5", sessionHash: h("s" + device), parentSessionHash: null, isSubagent: false,
    projectHash: h("p"), engagement: null, reportingDevice: device, executionOrigin: "unknown",
    at: new Date(Math.floor(at / 60_000) * 60_000).toISOString(),
    fresh: 10, output: 5, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 0, observed: true,
  };
  row.measurement = eventMeasurement(row);
  return row;
}

test("a removed machine does not make the chart incomplete or count among the machines left out", (t) => {
  const now = Date.now();
  const registry = createRegistry({ dir: null, now: () => now });
  const store = createStore({ dir: scratch(t), retentionMs: 8 * 86_400_000, prices: PRICES, now: () => now });
  const a = registry.redeem(registry.invite({ person: "You", machine: "Laptop" }).code);
  const b = registry.redeem(registry.invite({ person: "You", machine: "Desktop" }).code);
  for (const d of [a, b]) {
    store.ingest(d.device.id, [record(d.device.id, now - 3 * 3600_000)]);
    registry.touch(d.device.id, { at: now - 3 * 3600_000 });
  }
  registry.revoke(a.device.id);
  const view = buildConsole({ store, registry, now, hub: { demo: false } });
  assert.deepEqual(view.burn.excluded.map((d) => d.label), ["Desktop"], "only the silent machine is left out");
  assert.ok(view.silentSince, "the silent machine still marks the chart");
  registry.revoke(b.device.id);
  const after = buildConsole({ store, registry, now, hub: { demo: false } });
  assert.equal(after.silentSince, null, "no machine is silent once both are removed");
  assert.deepEqual(after.burn.excluded, []);
});

test("for a short while after a restart, a machine that was reporting is reconnecting, not silent", () => {
  const start = 10_000_000_000;
  const device = { lastContactAt: start - 5 * 60_000, mode: "live" };
  const restart = { startedAt: start, previousRunSeenAt: start - 5 * 60_000 + 10_000 };
  assert.equal(deviceStatus(device, start + 30_000, restart), "reconnecting");
  assert.equal(deviceStatus(device, start + RECONNECT_GRACE_MS + 1, restart), "silent");
  assert.equal(deviceStatus({ ...device, lastContactAt: start - 3 * 3600_000 }, start + 30_000, restart), "silent",
    "one already silent before the restart stays silent");
  assert.equal(deviceStatus(device, start + 30_000), "silent");
});

test("the burn is the average of the last fifteen minutes; a lane's five minutes stay five", (t) => {
  const now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
  const registry = createRegistry({ dir: null, now: () => now });
  const store = createStore({ dir: scratch(t), retentionMs: 8 * 86_400_000, prices: PRICES, now: () => now });
  const d = registry.redeem(registry.invite({ machine: "Laptop" }).code);
  store.ingest(d.device.id, [record(d.device.id, now - 10 * 60_000)]);
  registry.touch(d.device.id, { at: now });
  const view = buildConsole({ store, registry, now, hub: { demo: false } });
  assert.equal(view.burn.windowMinutes, 15);
  assert.ok(view.burn.tokensPerMinute > 0, "ten minutes ago is inside the burn");
  assert.equal(view.lanes[0].tokens5m, 0, "and outside a lane's five minutes");
});

// ---------------------------------------------------------------------------
// L1: one reporter per state directory
// ---------------------------------------------------------------------------

test("one reporter per state directory: a live holder is named, a dead one is cleared", async (t) => {
  const dir = scratch(t);
  // A stand-in reporter: its command line names Agent Console, as a real one's does.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "agent-console.mjs", "report"], { stdio: "ignore" });
  t.after(() => holder.kill("SIGKILL"));
  fs.writeFileSync(path.join(dir, "reporter.lock"), JSON.stringify({ pid: holder.pid }));
  assert.equal(runningReporter(dir), holder.pid);
  assert.throws(() => takeReporterLock(dir), (error) => error.code === "locked" && error.pid === holder.pid);
  const r = spawnSync(process.execPath, [BIN, "report", "--once", "--json", "--state-dir", dir], { encoding: "utf8" });
  assert.equal(r.status, 4);
  assert.equal(JSON.parse(r.stdout.trim()).pid, holder.pid);
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  const release = takeReporterLock(dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "reporter.lock"), "utf8")).pid, process.pid);
  release();
  assert.equal(fs.existsSync(path.join(dir, "reporter.lock")), false);
});

// ---------------------------------------------------------------------------
// L2: certificate changed, and a console that moved
// ---------------------------------------------------------------------------

test("a changed certificate is said as one, and is not retried", async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; throw Object.assign(new Error("certificate mismatch"), { code: "certificate_mismatch" }); };
  await assert.rejects(postRecords("https://127.0.0.1:6788/api/ingest", { id: "dev", label: "d" }, [], { token: "acd_" + "x".repeat(43), fetch, freshness: { lastObservedAt: null, lastSyncedAt: null, mode: "live" }, sleep: async () => {} }),
    (error) => error.code === "certificate_mismatch");
  assert.equal(calls, 1);
  assert.equal(failureReason({ code: "certificate_mismatch" }, "https://h:1").kind, "certificate");
  assert.match(failureReason({ code: "certificate_mismatch" }, "https://h:1").text, /different certificate.*new join link/su);
  assert.ok(isCertificateError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) && !isCertificateError({ code: "ECONNREFUSED" }));
});

test("--once never says it will keep trying", () => {
  for (const error of [{}, { code: "ingestion_unavailable", status: 503 }, { code: "ingestion_unavailable", status: 429 }]) {
    const text = failureReason(error, "https://h:1", { once: true }).text;
    assert.doesNotMatch(text, /keep trying|continuing shortly/u);
    assert.match(text, /not retrying \(--once\)/u);
  }
});

test("a reporter looks for its console's certificate on nearby ports only", async () => {
  const tried = [];
  const probe = async (url) => { tried.push(Number(new URL(url).port)); if (url.endsWith(":6791")) return "cert"; throw new Error("no"); };
  assert.equal(await findMovedHub("https://192.168.1.20:6788", "fp", { probe }), "https://192.168.1.20:6791");
  assert.equal(Math.min(...tried), 6778);
  assert.equal(Math.max(...tried), 6798);
  assert.ok(!tried.includes(6788));
  assert.equal(await findMovedHub("https://192.168.1.20:6788", "fp", { probe: async () => { throw new Error("no"); } }), null);
});

// ---------------------------------------------------------------------------
// F4: Projects counts this machine's author only
// ---------------------------------------------------------------------------

test("Git figures beside this machine's tokens count only commits by its Git email", async (t) => {
  const repo = scratch(t, "agent-console-git-");
  const git = (args, env = {}) => execFileSync(process.platform === "win32" ? "git" : "/usr/bin/git", args, { cwd: repo, stdio: "pipe",
    env: { ...process.env, GIT_COMMITTER_NAME: "c", GIT_COMMITTER_EMAIL: "c@example.invalid", ...env } });
  git(["init", "-q"]);
  const commitAs = (email, file, subject) => {
    fs.writeFileSync(path.join(repo, file), "a\nb\n");
    git(["add", file]);
    git(["commit", "-q", "-m", subject], { GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: email });
  };
  commitAs("me@example.invalid", "one.txt", "Mine (#1)");
  commitAs("someone@example.invalid", "two.txt", "Theirs (#2)");
  commitAs("me+x@example.invalid", "three.txt", "Near miss");
  const since = Date.now() - 3600_000;
  const all = await gitStatsForPeriod(createGitStatsStore(), [repo], since);
  assert.equal(all.totals.commits, 3);
  git(["config", "user.email", "me@example.invalid"]);
  const mine = await gitStatsForPeriod(createGitStatsStore(), [repo], since, { mineOnly: true });
  assert.equal(mine.totals.commits, 1, "only the configured author's commit, matched exactly");
  assert.equal(mine.totals.prsMerged, 1);
  assert.equal(mine.author, "me@example.invalid");
  assert.deepEqual(authorArgs(null), []);
});

// ---------------------------------------------------------------------------
// F6, F7, F8: the screen's words
// ---------------------------------------------------------------------------

test("pausing motion never stops the polling, and the words agree across views", () => {
  const poll = CONSOLE_JS.slice(CONSOLE_JS.indexOf("async function poll()"), CONSOLE_JS.indexOf("function onData()"));
  assert.doesNotMatch(poll, /paused/u, "poll() depends on the pause");
  assert.doesNotMatch(CONSOLE_JS, /" people"|sessions? today/u);
  assert.match(CONSOLE_JS, /plural\(D\.people\.length, "person", "people"\)/u);
  assert.match(CONSOLE_JS, /in the last 24 h/u);
  assert.match(CONSOLE_JS, /Commits referencing #N/u);
});

// ---------------------------------------------------------------------------
// F2: a signed-out console, a demo one included, can be signed into again
// ---------------------------------------------------------------------------

function startDemo(port) {
  // Reporting on any free port: the one after `port` can be taken or reserved
  // (Windows reserves port ranges), which is not what this test is about.
  const child = spawn(process.execPath, [BIN, "--demo", "--json", "--port", String(port), "--report-port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const lines = () => out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const ready = new Promise((resolve, reject) => {
    const timer = setInterval(() => { const first = lines()[0]; if (first) { clearInterval(timer); resolve(first.dashboard); } }, 20);
    child.on("exit", (code) => { clearInterval(timer); reject(new Error("exited " + code + ": " + out)); });
  });
  return { child, ready, lines };
}

test("a demo console prints a new sign-in link on request, from its page or from a second start", async (t) => {
  const probe = spawnSync(process.execPath, ["-e", "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: "utf8" });
  const port = Number(probe.stdout.trim());
  const demo = startDemo(port);
  t.after(() => demo.child.kill("SIGKILL"));
  const meta = await demo.ready;
  const asked = await fetch(meta.url + "/api/sign-in/print", { method: "POST", headers: INTENT });
  assert.equal(asked.status, 200);
  const answer = await asked.text();
  assert.equal(JSON.parse(answer).printed, true);
  assert.doesNotMatch(answer, /ticket|login/u, "the link is never sent back to the page");
  let event;
  for (let i = 0; i < 100 && !(event = demo.lines().find((l) => l.event === "sign-in")); i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(event, "no sign-in event was printed");
  const login = await fetch(event.signIn, { redirect: "manual" });
  assert.equal(login.status, 303);
  assert.equal((await fetch(meta.url + "/api/sign-in/print", { method: "POST", headers: INTENT })).status, 429, "paced");
  assert.equal((await fetch(meta.url + "/api/sign-in/print", { method: "POST" })).status, 403, "needs the console's own header");

  await new Promise((r) => setTimeout(r, 3100));
  const second = spawnSync(process.execPath, [BIN, "--demo", "--port", String(port), "--report-port", "0"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /A demo of Agent Console is already running at .*\n.*printed a new sign-in link in the window where it runs/u);
});

test("after leave, a link for the same person and machine name brings back the entry that left, with its history", () => {
  const registry = createRegistry({ dir: null });
  const joined = registry.redeem(registry.invite({ person: "Reviewer", machine: "Second box" }).code);
  assert.equal(registry.leave(joined.device.id), true);
  // The reporter deleted its enrolment, token included: no proof, only the same person and name.
  const back = registry.redeem(registry.invite({ person: "Reviewer", machine: "Second box" }).code);
  assert.equal(back.reattached, true);
  assert.equal(back.device.id, joined.device.id);
  assert.equal(registry.list().filter((d) => d.label === "Second box").length, 1, "no second machine of the same name");
  // A machine the console removed is not brought back, and another person's name is not matched.
  registry.revoke(back.device.id);
  const removedName = registry.redeem(registry.invite({ person: "Reviewer", machine: "Second box" }).code);
  assert.notEqual(removedName.device.id, joined.device.id);
  assert.equal(registry.leave(removedName.device.id), true);
  const otherPerson = registry.redeem(registry.invite({ person: "Someone else", machine: "Second box" }).code);
  assert.notEqual(otherPerson.device.id, removedName.device.id);
});

test("a stale lock whose process id now belongs to another program is cleared, and that program is never signalled", { skip: process.platform === "win32" }, async (t) => {
  const dir = scratch(t);
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => other.kill("SIGKILL"));
  let ended = null;
  other.once("exit", (code, signal) => { ended = signal || code; });
  const lock = path.join(dir, "reporter.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: other.pid }));
  // Old enough that no heartbeat vouches for it either.
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(runningReporter(dir), null);
  const stop = spawnSync(process.execPath, [BIN, "stop", "--state-dir", dir], { encoding: "utf8" });
  assert.equal(stop.status, 0);
  assert.match(stop.stdout, /No reporter is running/u);
  const report = spawnSync(process.execPath, [BIN, "report", "--once", "--json", "--state-dir", dir], { encoding: "utf8" });
  assert.notEqual(report.status, 4, "refused as if another reporter held the lock");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(ended, null, "the unrelated program was signalled");
});
