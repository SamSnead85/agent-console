import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createClaudeStore, scanClaude, buildSessions } from "../lib/claude.js";
import { assemble, dayKeyOf } from "../lib/snapshot.js";
import { createSeries } from "../lib/series.js";
import { createTracker } from "../lib/state.js";
import {
  scratchHome,
  removeTree,
  writeJsonl,
  assistantLine,
} from "./helpers.js";

function snapshotOf(home, now, extra) {
  const fleetSeries = createSeries();
  const store = createClaudeStore({
    root: path.join(home, ".claude", "projects"),
    sessionsDir: path.join(home, ".claude", "sessions"),
    windowMs: 36 * 3600 * 1000,
    fleetSeries,
  });
  scanClaude(store, now, dayKeyOf);
  const day = dayKeyOf(now);
  return assemble({
    now,
    day,
    sessions: buildSessions(store, now, day, new Map()),
    codexThreads: (extra && extra.codexThreads) || [],
    codexAvailable: true,
    codexReason: null,
    procs: [],
    ship: { repos: [], prs: [], prCount: 0, commitCount: 0, errors: [] },
    tracker: createTracker(),
    fleetSeries,
    scan: { ms: 1, bytes: 0, files: 1, error: null },
    dedupSpanMax: 0,
    config: { pollMs: 10_000, killEnabled: true },
  });
}

/**
 * lib/prices.js returns null for a model with no rate row precisely so an
 * unpriced model can be REPORTED rather than valued at zero. The roster row
 * then carried `priced: true` as a hardcoded literal, so the branch that
 * consults it rendered "$0.00" — the largest token producer on the screen shown
 * as free, bar-scaled as free, and silently left out of the fleet total.
 */
test("a model with no rate row is never rendered as free", () => {
  const home = scratchHome("unpriced");
  const now = Date.now();
  writeJsonl(path.join(home, ".claude", "projects", "-tmp-u", "s.jsonl"), [
    assistantLine({
      id: "msg_U",
      at: now,
      model: "claude-nimbus-6",
      in: 22_000,
      out: 5_000_000,
      cr: 0,
      cw: 0,
    }),
  ]);
  const snap = snapshotOf(home, now);
  const row = snap.rows[0];

  assert.equal(row.unpriced, true, "the session was not marked unpriced");
  assert.equal(
    row.priced,
    false,
    "an unpriced row still claims a price, so the UI prints $0.00",
  );
  assert.equal(row.cost, 0, "no dollar figure can be claimed for it");
  assert.equal(snap.header.unpriced, true);
  assert.equal(
    snap.master.word,
    "ATTENTION",
    "an unpriced model must reach the master readout",
  );
  assert.ok(snap.master.secondary.includes("unpriced model in use"));

  // The model breakdown must be able to say the word at all: `cost: null` sorts
  // last, and the UI only ever showed the top three entries.
  const nimbus = snap.header.models.find((m) => m.model === "claude-nimbus-6");
  assert.equal(nimbus.cost, null);
  removeTree(home);
});

test("a priced row still reports priced, and its cost is the sum of its classes", () => {
  const home = scratchHome("priced");
  const now = Date.now();
  writeJsonl(path.join(home, ".claude", "projects", "-tmp-p", "s.jsonl"), [
    assistantLine({
      id: "msg_P",
      at: now,
      model: "claude-opus-5",
      in: 1000,
      out: 2000,
      cr: 500_000,
      cw: 10_000,
    }),
  ]);
  const snap = snapshotOf(home, now);
  const row = snap.rows[0];
  assert.equal(row.priced, true);
  assert.equal(row.unpriced, false);
  const split = row.costSplit;
  assert.ok(
    Math.abs(row.cost - (split.in + split.out + split.cw + split.cr)) < 1e-12,
  );
  removeTree(home);
});

test("codex rows reach the roster with disjoint columns and no dollar claim", () => {
  const home = scratchHome("mix");
  const now = Date.now();
  writeJsonl(path.join(home, ".claude", "projects", "-tmp-m", "s.jsonl"), [
    assistantLine({ id: "msg_M", at: now, in: 100, out: 200 }),
  ]);
  const thread = {
    id: "thread-1",
    project: "repo",
    path: "/tmp/repo",
    cwd: "/tmp/repo",
    model: "gpt-5",
    effort: "high",
    cliVersion: "0.147.0",
    git: { branch: "main", commit: "abc", repo: null },
    contextWindow: 0,
    rateLimits: null,
    tokens: {
      in: 1_572_041_731,
      cachedIn: 1_547_780_352,
      cw: 0,
      out: 2_401_665,
      reasoning: 899_176,
      total: 1_574_443_396,
    },
    hot: 0,
    agents: [],
    agentLive: 0,
    agentCount: 0,
    lastTs: now,
    mtime: now,
    bad: 0,
    startedAt: now - 1000,
    patches: 0,
    patchFailures: 0,
    fileCount: 0,
    filesTouched: [],
    calls: 0,
    series: createSeries(),
    live: true,
  };
  const snap = snapshotOf(home, now, { codexThreads: [thread] });
  const codexRow = snap.rows.find((r) => r.vendor === "codex");
  assert.ok(codexRow, "the codex thread did not reach the roster");
  assert.equal(
    codexRow.tok.in + codexRow.tok.out + codexRow.tok.cw + codexRow.tok.cr,
    codexRow.total,
    "the four columns still disagree with the total in the same row",
  );
  assert.equal(codexRow.cost, null, "a dollar figure was claimed for Codex");
  assert.equal(codexRow.priced, false);
  assert.equal(codexRow.cumulative, true);

  // The Claude header total is day-scoped and must not absorb the thread.
  assert.equal(snap.header.total, 300);
  removeTree(home);
});

/**
 * The bundled price table has an explicit review deadline. Past it the
 * dollars stay on screen — there is nothing truer to compute from — but every
 * one of them must carry a visible drift warning. Rates are never invented to
 * make the warning go away.
 */
test("past the table's review deadline the payload carries the drift warning", () => {
  const bare = (now) =>
    assemble({
      now,
      day: dayKeyOf(now),
      sessions: [],
      codexThreads: [],
      codexAvailable: true,
      codexReason: null,
      procs: [],
      ship: { repos: [], prs: [], prCount: 0, commitCount: 0, errors: [] },
      tracker: createTracker(),
      fleetSeries: createSeries(),
      scan: { ms: 1, bytes: 0, files: 0, error: null },
      dedupSpanMax: 0,
      config: { pollMs: 10_000, killEnabled: true },
    });

  // 2026-12-03T12:00Z is past 2026-12-01 in every timezone this can run in.
  const after = bare(Date.parse("2026-12-03T12:00:00Z"));
  assert.equal(after.instrument.priceTableExpired, true);
  assert.equal(
    after.instrument.priceTableWarning,
    "price table dated 2026-09-01 — estimate drift possible",
  );
  assert.equal(after.instrument.priceTableExpiry, "2026-12-01");

  // 2026-08-15T12:00Z is before it in every timezone.
  const before = bare(Date.parse("2026-08-15T12:00:00Z"));
  assert.equal(before.instrument.priceTableExpired, false);
  assert.equal(before.instrument.priceTableWarning, null);
});
