/**
 * The token-accounting conformance suite (docs/accounting.md §11), run against
 * this package: its collector reads the synthetic logs machine by machine, in
 * the manifest's delivery order, and hands each delivery to a hub store; the
 * hub's accounting and its console screen must then reproduce expected.json —
 * totals summed from declared ground truth, not from any counter — exactly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, collectDeliveries, CANARIES } from "./conformance/build.mjs";
import * as conformance from "./conformance/index.js";
import { createStore, MINUTE } from "../lib/hub/store.js";
import { createRegistry } from "../lib/hub/registry.js";
import { accountingReport, dailyTotals, personOf, rollupDailyTotals } from "../lib/hub/accounting.js";
import { buildConsole, periodRange } from "../lib/hub/aggregate.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const prices = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "lib", "collector", "prices.json"), "utf8"));
const { manifest, expected } = conformance;
const W0 = Date.parse(manifest.window.from), W1 = Date.parse(manifest.window.to);
const TOKEN_KEYS = ["total", "fresh", "output", "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h", "cacheWriteUnknownTtl", "messages"];
const RECORD_KEYS = ["id", "tool", "model", "sessionHash", "parentSessionHash", "isSubagent", "projectHash", "engagement", "at",
  "reportingDevice", "executionOrigin", "ttl", "continuation", "fresh", "output", "cacheWrite", "cacheRead", "cacheWrite5m", "cacheWrite1h", "observed", "measurement", "tier"].sort();

function hub(order = manifest.deliveries.map((d) => d.step), deliveries) {
  const store = createStore({ dir: null, retentionMs: 30 * 86_400_000, prices, now: () => W1 - 1 });
  const registry = createRegistry({ dir: null, now: () => W1 - 1 });
  for (const device of Object.values(manifest.devices)) registry.addSynthetic({ id: device.id, label: device.label, person: device.person, createdAt: W0 });
  const receipts = new Map();
  for (const step of order) {
    const delivery = deliveries.find((d) => d.step === step);
    receipts.set(step, store.ingest(delivery.deviceId, delivery.records));
    // What the collector could not count travels with each delivery (§3.2).
    registry.touch(delivery.deviceId, { coverage: delivery.coverage, at: W1 - 1 });
  }
  return { store, registry, receipts };
}

/** Compares one totals object with its expected counterpart, class by class and in dollars. */
function same(actual, wanted, where) {
  assert.ok(actual, `${where}: missing`);
  for (const key of TOKEN_KEYS) assert.equal(actual[key], wanted[key], `${where}: ${key}`);
  assert.ok(Math.abs(actual.usd - wanted.usd) < 1e-9, `${where}: usd ${actual.usd} != ${wanted.usd}`);
  assert.equal(actual.unknownClassRecords ?? 0, 0, `${where}: a class went unreported`);
  // A model or tier with no verified rate: its tokens count, its dollars do not.
  assert.equal(actual.unpricedMessages ?? 0, wanted.unpricedMessages, `${where}: unpriced messages`);
  assert.equal(actual.unpricedTokens ?? 0, wanted.unpricedTokens, `${where}: unpriced tokens`);
}

const byLabel = (hashMap) => {
  const labels = Object.fromEntries(Object.entries(expected.sessions).map(([label, s]) => [s.hash, label]));
  return Object.fromEntries(Object.entries(hashMap).map(([hash, value]) => [labels[hash] ?? `unknown:${hash}`, value]));
};

function assertWindow(report, block, name) {
  same(report.team, block.team, `${name} team`);
  for (const group of ["people", "devices", "models"]) {
    assert.deepEqual(Object.keys(report[group]).sort(), Object.keys(block[group]).sort(), `${name} ${group}`);
    for (const [key, wanted] of Object.entries(block[group])) same(report[group][key], wanted, `${name} ${group} ${key}`);
  }
  for (const group of ["sessions", "sessionTrees"]) {
    const actual = byLabel(report[group]);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(block[group]).sort(), `${name} ${group}`);
    for (const [key, wanted] of Object.entries(block[group])) same(actual[key], wanted, `${name} ${group} ${key}`);
  }
}

const deliveries = await collectDeliveries({ fixtureRoot: conformance.root, manifest });

test("the fixtures are what the builder writes, and the collector still sends exactly collector-records.json", async () => {
  assert.deepEqual(await build({ check: true }), [], "run `node test/conformance/build.mjs` and read the diff");
  assert.deepEqual(deliveries, conformance.collectorRecords.deliveries);
  assert.equal(conformance.suite, "1.1.0");
});

test("the hub's accounting reproduces every expected total for the window and both halves of it", () => {
  const { store, registry } = hub(undefined, deliveries);
  assertWindow(accountingReport({ store, registry, from: W0, to: W1, prices }), expected.window, "window");
  for (const block of expected.windows) {
    assertWindow(accountingReport({ store, registry, from: Date.parse(block.from), to: Date.parse(block.to), prices }), block, `window ${block.from}`);
  }
});

test("context readings reconcile with the conformance suite's per-event input totals", () => {
  const { store } = hub(undefined, deliveries);
  const bySession = new Map();
  for (const event of expected.events) {
    const hash = expected.sessions[event.session].hash;
    const input = event.usage.fresh + event.usage.cacheRead + event.usage.cacheWrite5m
      + event.usage.cacheWrite1h + event.usage.cacheWriteUnknownTtl;
    if (!bySession.has(hash)) bySession.set(hash, []);
    bySession.get(hash).push(input);
  }
  assert.equal(bySession.size, store.sessions.size);
  for (const [hash, inputs] of bySession) {
    const readings = store.sessions.get(hash)?.contextSamples.map((s) => s.tokens);
    assert.deepEqual(readings?.sort((a, b) => a - b), inputs.sort((a, b) => a - b), hash);
  }
});

test("calendar days are counted in a named time zone", () => {
  const { store } = hub(undefined, deliveries);
  for (const [timeZone, days] of Object.entries(expected.days)) {
    const actual = dailyTotals({ store, from: W0 - 2 * 86_400_000, to: W1 + 2 * 86_400_000, timeZone });
    assert.deepEqual(Object.keys(actual.days), Object.keys(days), timeZone);
    for (const [day, wanted] of Object.entries(days)) same(actual.days[day], wanted, `${timeZone} ${day}`);
  }
});

test("every way of slicing the window adds up to the team, and each class adds up to the total", () => {
  const { store, registry } = hub(undefined, deliveries);
  const report = accountingReport({ store, registry, from: W0, to: W1, prices });
  for (const group of ["people", "devices", "models", "sessions", "sessionTrees"]) {
    const sum = Object.values(report[group]).reduce((a, t) => a + t.total, 0);
    assert.equal(sum, report.team.total, group);
  }
  const t = report.team;
  assert.equal(t.fresh + t.output + t.cacheRead + t.cacheWrite, t.total);
  assert.equal(t.cacheWrite5m + t.cacheWrite1h + t.cacheWriteUnknownTtl, t.cacheWrite);
});

test("re-reports, a second machine's copy and a re-joined machine add nothing; only new work is accepted", () => {
  const { receipts } = hub(undefined, deliveries);
  const sent = (step) => deliveries.find((d) => d.step === step).records.length;
  assert.equal(receipts.get(3).accepted, 0, "a machine that lost its cursor re-sent records already counted");
  assert.equal(receipts.get(3).duplicate, sent(3));
  assert.equal(receipts.get(7).accepted + receipts.get(7).duplicate, 0, "a report with its cursor intact sends nothing");
  // The laptop's synced copy of a studio session and the re-joined studio's history are duplicates.
  assert.ok(receipts.get(2).duplicate > 0 && receipts.get(6).duplicate > 0);
  const newWork = deliveries.find((d) => d.step === 6).records.filter((r) => r.sessionHash === expected.sessions[`claude-code:c0000009-0000-4000-8000-000000000009`].hash);
  assert.equal(receipts.get(6).accepted, newWork.length);
});

test("delivery order moves credit between one person's machines, never the team's or a person's total", () => {
  const reversed = [...manifest.deliveries.map((d) => d.step)].reverse();
  const forward = hub(undefined, deliveries), backward = hub(reversed, deliveries);
  const a = accountingReport({ store: forward.store, registry: forward.registry, from: W0, to: W1, prices });
  const b = accountingReport({ store: backward.store, registry: backward.registry, from: W0, to: W1, prices });
  same(b.team, expected.window.team, "reversed team");
  for (const [person, wanted] of Object.entries(expected.window.people)) same(b.people[person], wanted, `reversed ${person}`);
  // First writer wins: reversed, the re-joined studio id is credited with the studio's history.
  assert.notEqual(a.devices["dev_personA-studio02"].total, b.devices["dev_personA-studio02"].total);
});

test("the console's own screen shows the same day, people, machines, models and cost", () => {
  const { store, registry } = hub(undefined, deliveries);
  const view = buildConsole({ store, registry, now: W1 - 1, hub: { version: "conformance" } });
  const w = expected.window;
  assert.equal(view.day.from, W0, "the console's day is the 1,440 minutes ending with the current one");
  for (const key of ["total", "fresh", "output", "cacheRead", "cacheWrite"]) assert.equal(view.day.tokens[key], w.team[key], `day ${key}`);
  assert.equal(view.day.messages, w.team.messages);
  assert.ok(Math.abs(view.day.cost.usd - w.team.usd) < 1e-9, "day cost");
  assert.equal(view.day.cost.status, w.team.unpricedMessages ? "partial" : "estimated");
  assert.equal(view.day.cost.unpricedMessages, w.team.unpricedMessages, "messages, not records, are counted as unpriced");
  assert.equal(view.day.cost.unpricedTokens, w.team.unpricedTokens);
  for (const [model, wanted] of Object.entries(w.models)) {
    const row = view.day.models.find((m) => m.model === model);
    assert.equal(row.tokens, wanted.total, `model ${model}`);
    assert.equal(row.messages, wanted.messages, `model ${model} messages`);
  }
  for (const [person, wanted] of Object.entries(w.people)) {
    const row = view.people.find((p) => p.person === person);
    assert.equal(row.day.tokens.total, wanted.total, `person ${person}`);
    assert.ok(Math.abs(row.day.cost.usd - wanted.usd) < 1e-9, `person ${person} cost`);
  }
  for (const [deviceId, wanted] of Object.entries(w.devices)) {
    assert.equal(view.devices.find((d) => d.id === deviceId).day.tokens.total, wanted.total, `device ${deviceId}`);
  }
});

test("attribution: a machine enrolled to nobody is Unassigned, and subagents belong to their orchestrator's person", () => {
  assert.equal(personOf({ person: null }), "Unassigned");
  const { store, registry } = hub(undefined, deliveries);
  const report = accountingReport({ store, registry, from: W0, to: W1, prices });
  for (const [label, s] of Object.entries(expected.sessions)) {
    if (!report.sessionFacts[s.hash]) continue;
    assert.equal(report.sessionFacts[s.hash].person, s.person, label);
    assert.equal(report.sessionFacts[s.hash].root, expected.sessions[s.root].hash, `${label} root`);
  }
});

test("privacy canary: no prompt, reply, path, branch or file name from the logs reaches a record or a report", () => {
  const { store, registry } = hub(undefined, deliveries);
  // What a hub keeps on disk, too.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-conformance-store-"));
  let stored = "";
  try {
    const disk = createStore({ dir, retentionMs: 30 * 86_400_000, prices, now: () => W1 - 1 });
    disk.load();
    for (const delivery of deliveries) disk.ingest(delivery.deviceId, delivery.records);
    for (const name of fs.readdirSync(dir)) stored += fs.readFileSync(path.join(dir, name), "utf8");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.ok(stored.length > 0);
  const out = stored + JSON.stringify([deliveries, conformance.collectorRecords, accountingReport({ store, registry, from: W0, to: W1, prices }),
    buildConsole({ store, registry, now: W1 - 1, hub: {} })]);
  for (const canary of [...CANARIES, ...manifest.canaries, "msg_conf_", "req_conf_", "toolu_conf_", "c0000001-0000", "d0000003-0000"]) {
    assert.equal(out.includes(canary), false, `"${canary}" left the machine`);
  }
  for (const delivery of deliveries) for (const record of delivery.records) {
    assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS, "a record carries a field outside the documented projection");
    assert.equal(Date.parse(record.at) % MINUTE, 0, "a record's time is finer than a minute");
  }
});

test("A1: forked subagents' copies of a message count once, whatever order the files are read in", async () => {
  // Reading each subagents/ folder as its own root, first, reverses the order:
  // every fork copy is read before the transcript it was copied from.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-conformance-reversed-"));
  try {
    const { runOnce } = await import("../lib/collector/collector.js");
    const studio = manifest.devices["personA-studio"];
    fs.writeFileSync(path.join(scratch, "enrollment.json"), JSON.stringify({ v: 1, orgSalt: manifest.organization.orgSalt,
      organizationId: manifest.organization.id, device: { id: studio.id, label: studio.label } }), { mode: 0o600 });
    const projects = path.join(conformance.logsRoot, "personA-studio", "claude", "projects");
    const forks = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) { if (e.name === "subagents") forks.push(path.join(dir, e.name)); else walk(path.join(dir, e.name)); } };
    walk(projects);
    let sent = [];
    await runOnce({ directory: scratch, sinkName: "reversed", roots: [...forks.map((directory) => ({ tool: "claude-code", directory })), { tool: "claude-code", directory: projects }],
      deliver: async (_d, records) => { sent = records; return { accepted: records.length, duplicate: 0, rejected: [] }; } });
    const labels = Object.entries(expected.sessions).filter(([label, s]) => s.device === studio.id && label.startsWith("claude-code:")).map(([, s]) => s.hash);
    const tree = new Set(labels);
    const got = sent.filter((r) => tree.has(r.sessionHash) || tree.has(r.parentSessionHash));
    const want = expected.events.filter((e) => e.session.startsWith("claude-code:") && expected.sessions[e.session].device === studio.id);
    const sum = (rows, key) => rows.reduce((a, r) => a + (r[key] ?? 0), 0);
    assert.equal(sum(got, "fresh"), want.reduce((a, e) => a + e.usage.fresh, 0), "input");
    assert.equal(sum(got, "output"), want.reduce((a, e) => a + e.usage.output, 0), "output");
    assert.equal(sum(got, "cacheRead"), want.reduce((a, e) => a + e.usage.cacheRead, 0), "cache read");
    assert.equal(sum(got, "cacheWrite"), want.reduce((a, e) => a + e.usage.cacheWrite5m + e.usage.cacheWrite1h + e.usage.cacheWriteUnknownTtl, 0), "cache write");
    assert.equal(got.filter((r) => !r.continuation).length, want.length, "messages");
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("A2: every line that could not be counted is counted, by machine and reason, and shown", () => {
  const { store, registry } = hub(undefined, deliveries);
  const report = accountingReport({ store, registry, from: W0, to: W1, prices });
  assert.deepEqual(report.coverage.devices, expected.dropped.devices);
  assert.equal(report.coverage.dropped, expected.dropped.total);
  const view = buildConsole({ store, registry, now: W1 - 1, hub: { version: "conformance" } });
  assert.equal(view.coverage.dropped, expected.dropped.total);
  for (const [deviceId, kinds] of Object.entries(expected.dropped.devices)) {
    const row = view.devices.find((d) => d.id === deviceId);
    assert.equal(row.coverage.dropped, Object.values(kinds).reduce((a, n) => a + n, 0), deviceId);
    for (const r of row.coverage.reasons) assert.ok(typeof r.label === "string" && r.label.length > 0, r.kind);
  }
  // The recovered over-long line is not a drop.
  assert.ok(view.coverage.recovered >= 1);
});

test("F3: every period's chart adds up to its headline, and the daily rollup matches the UTC days", () => {
  const { store, registry } = hub(undefined, deliveries);
  const now = W1 - 1;
  const view = buildConsole({ store, registry, now, hub: { version: "conformance" } });
  for (const key of ["1h", "24h", "7d", "30d"]) {
    const bars = view.series[key].values.reduce((a, v) => a + v, 0);
    assert.equal(bars, view.windows[key].tokens.total, `${key}: the bars add up to the headline`);
  }
  assert.equal(view.windows["24h"].tokens.total, expected.window.team.total);
  assert.equal(view.windows["24h"].from, W0);
  // 30 days: the last 30 UTC days, from the rollup.
  const month = periodRange("30d", now);
  const utc = expected.days.UTC;
  const inMonth = Object.entries(utc).filter(([day]) => day >= month.fromDay && day <= month.toDay);
  assert.equal(view.windows["30d"].tokens.total, inMonth.reduce((a, [, t]) => a + t.total, 0));
  assert.ok(Math.abs(view.windows["30d"].cost.usd - inMonth.reduce((a, [, t]) => a + t.usd, 0)) < 1e-9);
  const rolled = rollupDailyTotals({ store, fromDay: "2026-09-01", toDay: "2026-09-30" });
  assert.deepEqual(Object.keys(rolled.days), Object.keys(utc));
  for (const [day, wanted] of Object.entries(utc)) same(rolled.days[day], wanted, `rollup ${day}`);
  // Team and people answer for the same period as the headline.
  for (const key of ["1h", "24h", "7d", "30d"]) {
    assert.equal(view.devices.reduce((a, d) => a + d.windows[key].tokens.total, 0), view.windows[key].tokens.total, `${key} machines`);
    assert.equal(view.people.reduce((a, p) => a + p.windows[key].tokens.total, 0), view.windows[key].tokens.total, `${key} people`);
  }
});

test("F5: fast mode is priced at the fast rates, and a tier with no rate is unpriced, never standard", () => {
  const { store, registry } = hub(undefined, deliveries);
  const report = accountingReport({ store, registry, from: W0, to: W1, prices });
  const fast = expected.events.find((e) => e.tier === "fast");
  const s = byLabel(report.sessions)[fast.session];
  same(s, expected.window.sessions[fast.session], "fast-mode session");
  const other = expected.events.find((e) => e.tier === "other");
  assert.ok(expected.window.sessions[other.session].unpricedMessages >= 1);
});
