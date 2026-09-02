import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildThreads,
  createCodexStore,
  findRollouts,
  scanCodex,
} from "../lib/codex.js";
import { scratchHome, removeTree, writeJsonl } from "./helpers.js";

function rolloutName(startedIso, threadId) {
  return (
    "rollout-" +
    startedIso.replace(/[:.]/gu, "-").slice(0, 19) +
    "-" +
    threadId +
    ".jsonl"
  );
}

function sessionMeta(at, metaId, cwd, branch) {
  return {
    timestamp: new Date(at).toISOString(),
    type: "session_meta",
    payload: {
      id: metaId,
      cwd,
      cli_version: "0.147.0",
      originator: "Codex Desktop",
      git: {
        branch,
        commit_hash: "4cf9fb5100",
        repository_url: "https://example.test/r.git",
      },
    },
  };
}

function tokenCount(at, total, last) {
  return {
    timestamp: new Date(at).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: total,
          output_tokens: 0,
        },
        last_token_usage: { total_tokens: last },
        model_context_window: 258400,
      },
      rate_limits: {
        primary: {
          used_percent: 17,
          window_minutes: 10080,
          resets_at: 1788722914,
        },
        plan_type: "pro",
      },
    },
  };
}

/**
 * A forked thread's own session_meta. `forked_from_id` is the field that means
 * "this thread inherited that thread's history"; `parent_thread_id` alone only
 * means "that thread spawned me", which a fresh sub-agent also carries.
 */
function forkMeta(at, ownId, parentId, options) {
  const opts = options || {};
  return {
    timestamp: new Date(at).toISOString(),
    type: "session_meta",
    payload: {
      id: ownId,
      session_id: parentId,
      forked_from_id: opts.inherits === false ? undefined : parentId,
      parent_thread_id: parentId,
      thread_source: "subagent",
      agent_path: opts.agentPath || "/root/worker",
      cwd: "/tmp/repo",
      cli_version: "0.151.0",
      originator: "Codex Desktop",
    },
  };
}

function subAgent(at, childId, agentPath) {
  return {
    timestamp: new Date(at).toISOString(),
    type: "event_msg",
    payload: {
      type: "sub_agent_activity",
      agent_thread_id: childId,
      agent_path: agentPath,
      kind: "started",
      occurred_at_ms: at,
    },
  };
}

test("a live thread filed under an OLD date directory is still found", () => {
  // Codex files a rollout under the day the THREAD STARTED. Reading only the
  // last two date directories hid a 217 MB thread with 1.57 billion cumulative
  // tokens on this machine — larger than every visible thread combined —
  // because it began a week earlier and never stopped.
  const home = scratchHome("codex-mtime");
  const root = path.join(home, ".codex", "sessions");
  const old = path.join(root, "2026", "08", "23");
  const file = path.join(
    old,
    rolloutName("2026-08-23T16:18:06", "01a03045-old"),
  );
  writeJsonl(file, [
    sessionMeta(Date.now(), "01a03045-old", "/tmp/repo", "main"),
    tokenCount(Date.now(), 1_567_765_731, 1000),
  ]);
  fs.utimesSync(file, new Date(), new Date()); // touched now, filed a week ago

  const found = findRollouts(root, Date.now() - 36 * 3600 * 1000);
  assert.equal(
    found.length,
    1,
    "a recently modified rollout in an old directory was missed",
  );
  assert.equal(found[0].threadId, "01a03045-old");

  const store = createCodexStore({ root, windowMs: 36 * 3600 * 1000 });
  assert.equal(scanCodex(store, Date.now()).available, true);
  const threads = buildThreads(store, Date.now());
  assert.equal(threads.length, 1);
  assert.equal(threads[0].tokens.total, 1_567_765_731);
  assert.equal(threads[0].rateLimits.primary.used_percent, 17);
  removeTree(home);
});

test("a rollout older than the window is ignored", () => {
  const home = scratchHome("codex-old");
  const root = path.join(home, ".codex", "sessions");
  const file = path.join(
    root,
    "2026",
    "01",
    "01",
    rolloutName("2026-01-01T00:00:00", "ancient"),
  );
  writeJsonl(file, [tokenCount(Date.now(), 5, 5)]);
  const stale = new Date(Date.now() - 20 * 24 * 3600 * 1000);
  fs.utimesSync(file, stale, stale);
  assert.equal(findRollouts(root, Date.now() - 36 * 3600 * 1000).length, 0);
  removeTree(home);
});

test("sub-agent threads nest under their parent, from sub_agent_activity", () => {
  // Every rollout on this disk repeats the PARENT's id in session_meta and
  // never sets thread_source or parent_thread_id, so the documented fields are
  // useless. The real edges are the parent's sub_agent_activity events, and the
  // graph they describe contains cycles: a sub-agent reports on its parent too.
  const home = scratchHome("codex-tree");
  const root = path.join(home, ".codex", "sessions");
  const dir = path.join(root, "2026", "08", "30");
  const at = Date.now();
  const parentId = "01a05425-parent";
  const kids = ["01a05437-aaa", "01a05437-bbb"];

  writeJsonl(path.join(dir, rolloutName("2026-08-30T15:28:50", parentId)), [
    sessionMeta(at, parentId, "/tmp/repo", "codex/track-d"),
    subAgent(at, kids[0], "/root/deployment_posture_112"),
    subAgent(at, kids[1], "/root/flow_graph_145"),
    tokenCount(at, 200_000, 1000),
  ]);
  kids.forEach((kid, index) => {
    writeJsonl(path.join(dir, rolloutName("2026-08-30T15:48:4" + index, kid)), [
      // The child repeats the parent's id here — that is what the real logs do.
      sessionMeta(at, parentId, "/tmp/repo", "codex/track-d"),
      // …and reports back on its parent, which makes the edge set cyclic.
      subAgent(at, parentId, "/root"),
      tokenCount(at, 100_000 + index, 500),
    ]);
  });

  const store = createCodexStore({ root, windowMs: 36 * 3600 * 1000 });
  scanCodex(store, at);
  const threads = buildThreads(store, at);
  assert.equal(
    threads.length,
    1,
    "the fan-out split into " + threads.length + " rows",
  );
  const group = threads[0];
  assert.equal(group.id, parentId, "the wrong thread was elected root");
  assert.equal(group.agentCount, 2, "sub-agents did not nest");
  assert.deepEqual(
    group.agents.map((a) => a.desc).sort(),
    ["deployment_posture_112", "flow_graph_145"],
    "the agent_path label was lost",
  );
  assert.equal(group.tokens.total, 200_000 + 100_000 + 100_001);
  assert.equal(group.git.branch, "codex/track-d");
  removeTree(home);
});

test("the first token_count after a cold read uses the exact per-turn figure", () => {
  // Diffing a cumulative total against zero would report a 1.5-billion-token
  // thread's entire lifetime as one turn's burn. The log carries the per-turn
  // number; use it.
  const home = scratchHome("codex-hot");
  const root = path.join(home, ".codex", "sessions");
  const at = Date.now();
  writeJsonl(
    path.join(
      root,
      "2026",
      "08",
      "30",
      rolloutName("2026-08-30T10:00:00", "hot-thread"),
    ),
    [
      sessionMeta(at, "hot-thread", "/tmp/repo", "main"),
      tokenCount(at - 30_000, 1_500_000_000, 4200),
      tokenCount(at - 10_000, 1_500_004_000, 4000),
    ],
  );
  const store = createCodexStore({ root, windowMs: 36 * 3600 * 1000 });
  scanCodex(store, at);
  const group = buildThreads(store, at)[0];
  assert.equal(
    group.hot,
    4200 + 4000,
    "the cumulative total leaked into the burn window",
  );
  removeTree(home);
});

/**
 * Forking a Codex thread rewrites the parent's ENTIRE turn history into the new
 * rollout under the fork's own clock. Read at face value, a day of the parent's
 * work lands in the minute the fork opened.
 *
 * Straight off this machine: three forks of one 534-million-token thread opened
 * together at 19:08 and put 1,602,584,732 tokens into that single minute bucket,
 * which the banner rendered as "BURNING · 1.60B/5m". Their real combined burn in
 * that minute was 313,528. Across a 72-hour window, 48.4 billion of the 53.7
 * billion tokens the reader placed in minute buckets — 90% — were replayed
 * history that the parent's own rollout had already counted.
 */
test("a forked thread's inherited history is not burn in the minute it forked", async () => {
  const { createSeries, recent } = await import("../lib/series.js");
  const home = scratchHome("codex-fork");
  const root = path.join(home, ".codex", "sessions");
  const dir = path.join(root, "2026", "08", "31");
  const at = Date.now();
  const forkAt = at - 60_000;
  const parentId = "01a05425-parent";
  const forkId = "01a05939-fork";

  // The parent earned 534M over a previous day. Its own rollout already put
  // those tokens in the series, at the minutes they were actually spent.
  writeJsonl(path.join(dir, rolloutName("2026-08-30T15:28:50", parentId)), [
    sessionMeta(at - 86_400_000, parentId, "/tmp/repo", "main"),
    tokenCount(at - 86_400_000, 533_000_000, 90_000),
    tokenCount(forkAt - 5_000, 534_000_000, 1_000_000),
  ]);

  // The fork replays all of it in one burst at open, then does its own work.
  const replay = [];
  for (let i = 1; i <= 40; i += 1) {
    replay.push(tokenCount(forkAt + 1, i * 13_350_000, 13_350_000));
  }
  writeJsonl(path.join(dir, rolloutName("2026-08-31T15:08:24", forkId)), [
    forkMeta(forkAt, forkId, parentId),
    ...replay,
    // …and only now does it burn anything of its own, one model round-trip
    // after the fork.
    tokenCount(forkAt + 9_000, 534_000_000 + 80_000, 80_000),
    tokenCount(forkAt + 31_000, 534_000_000 + 145_000, 65_000),
  ]);

  const fleetSeries = createSeries();
  const store = createCodexStore({
    root,
    windowMs: 72 * 3600 * 1000,
    fleetSeries,
  });
  scanCodex(store, at);

  const fork = store.files.get(
    path.join(dir, rolloutName("2026-08-31T15:08:24", forkId)),
  );
  assert.equal(fork.forkedFrom, parentId, "the fork marker was not read");
  assert.equal(
    fork.inheritedTokens,
    534_000_000,
    "the inherited cumulative total was not carried to the fork point",
  );

  // The fork's own contribution is what it spent AFTER the fork, and nothing
  // else. Before this rule it was 534,145,000 — the parent's whole life again.
  const own = [...fork.series.buckets.values()].reduce(
    (sum, b) => sum + b.tokens,
    0,
  );
  assert.equal(own, 80_000 + 65_000, "replayed history was counted as burn");

  // The banner reads the shared fleet series, which is where the impossible
  // figure was rendered.
  assert.equal(
    recent(fleetSeries, at, 5 * 60_000),
    1_000_000 + 80_000 + 65_000,
    "the fleet baseline still carries the replayed history",
  );
  removeTree(home);
});

/**
 * The distinction the rule turns on. A sub-agent SPAWNED fresh carries a
 * `parent_thread_id` but no `forked_from_id`, and its counter starts at zero —
 * so its first turn is real burn. The validation sample separates fork lineage
 * from ordinary parent links; keying suppression on the parent link would
 * silence fresh sub-agents that have nothing to suppress.
 */
test("a sub-agent spawned fresh is not a fork, and keeps its first turn", () => {
  const home = scratchHome("codex-spawn");
  const root = path.join(home, ".codex", "sessions");
  const dir = path.join(root, "2026", "08", "31");
  const at = Date.now();
  const childId = "01a04ad4-fresh";
  writeJsonl(path.join(dir, rolloutName("2026-08-31T15:08:24", childId)), [
    forkMeta(at - 120_000, childId, "01a05425-parent", { inherits: false }),
    // Inside the replay window a fork would be inside, but this thread inherited
    // nothing: its cumulative total starts at its own first turn.
    tokenCount(at - 119_000, 19_000, 19_000),
    tokenCount(at - 60_000, 44_000, 25_000),
  ]);
  const store = createCodexStore({ root, windowMs: 72 * 3600 * 1000 });
  scanCodex(store, at);
  const group = buildThreads(store, at)[0];
  assert.equal(
    group.hot,
    19_000 + 25_000,
    "a freshly spawned sub-agent's own burn was suppressed as inherited",
  );
  removeTree(home);
});

/**
 * The oldest Codex rule in this file, and the one the fork fix must not bend:
 * `total_token_usage` is THREAD-CUMULATIVE. It is reported as a sigma and is
 * never a period quantity — not a bucket, not a burn, not a daily total.
 *
 * Suppressing replayed history changes only WHEN tokens are attributed. The
 * thread's own cumulative figure is read straight off the log and must come back
 * byte-identical, or the fix has quietly turned a counter into a sum.
 */
test("the sigma total is thread-cumulative and never a period sum", async () => {
  const { createSeries, recent } = await import("../lib/series.js");
  const home = scratchHome("codex-sigma");
  const root = path.join(home, ".codex", "sessions");
  const dir = path.join(root, "2026", "08", "31");
  const at = Date.now();
  const forkAt = at - 120_000;
  const forkId = "01a05939-sigma";
  writeJsonl(path.join(dir, rolloutName("2026-08-31T15:08:24", forkId)), [
    forkMeta(forkAt, forkId, "01a05425-parent"),
    tokenCount(forkAt + 1, 900_000_000, 5_000),
    tokenCount(forkAt + 2, 950_000_000, 50_000_000),
    tokenCount(forkAt + 20_000, 950_400_000, 400_000),
  ]);
  const fleetSeries = createSeries();
  const store = createCodexStore({
    root,
    windowMs: 72 * 3600 * 1000,
    fleetSeries,
  });
  scanCodex(store, at);
  const group = buildThreads(store, at)[0];

  // 1. The sigma is the log's own final cumulative figure — untouched.
  assert.equal(
    group.tokens.total,
    950_400_000,
    "suppressing replay must not reduce the cumulative sigma",
  );

  // 2. …and that sigma is nowhere in any period quantity.
  assert.equal(group.hot, 400_000, "the cumulative sigma leaked into the burn");
  assert.equal(
    recent(fleetSeries, at, 5 * 60_000),
    400_000,
    "the cumulative sigma leaked into the fleet baseline",
  );
  assert.ok(
    group.hot < group.tokens.total,
    "a period total the size of the cumulative counter is the defect this pins",
  );

  // 3. No dollars: no OpenAI price table is bundled, so no Codex rate exists to
  //    invent. Every agent row a Codex group produces carries a null cost.
  for (const agent of group.agents) assert.equal(agent.cost, null);
  removeTree(home);
});

test("a missing ~/.codex directory is out of service, not zero", () => {
  const store = createCodexStore({
    root: "/definitely/not/here",
    windowMs: 1000,
  });
  const result = scanCodex(store, Date.now());
  assert.equal(result.available, false);
  assert.equal(result.reason, "no-directory");
});

/**
 * Codex and Anthropic report cached input with OPPOSITE semantics, and the
 * roster shows both vendors under one set of column headers.
 *
 * Anthropic's `cache_read_input_tokens` is DISJOINT from `input_tokens`, so
 * in + out + cw + cr is the response total. Codex's `cached_input_tokens` is a
 * SUBSET of `input_tokens` — on this disk `total_tokens` is exactly
 * `input_tokens + output_tokens` — so copying the fields across unchanged made
 * the four cells of a Codex row add up to roughly twice the total printed in
 * the row's own total column.
 */
test("codex token columns are disjoint and sum to the row's own total", async () => {
  const { codexTokens } = await import("../lib/snapshot.js");
  // Captured rollout-shaped cumulative counters.
  const raw = {
    in: 1_572_041_731,
    cachedIn: 1_547_780_352,
    cw: 0,
    out: 2_401_665,
    reasoning: 899_176,
    total: 1_574_443_396,
  };
  const tok = codexTokens(raw);
  assert.equal(
    tok.in + tok.out + tok.cw + tok.cr,
    raw.total,
    "the four displayed columns do not add up to the displayed total",
  );
  assert.equal(tok.cr, raw.cachedIn, "the cached figure must survive intact");
  assert.equal(tok.think, raw.reasoning);
  assert.ok(tok.in < raw.in, "cached input was not carved out of input");
});

test("a cache write is carved out of input too, and nothing goes negative", async () => {
  const { codexTokens } = await import("../lib/snapshot.js");
  const tok = codexTokens({
    in: 1000,
    cachedIn: 600,
    cw: 300,
    out: 50,
    reasoning: 0,
  });
  assert.deepEqual(tok, {
    in: 100,
    out: 50,
    cr: 600,
    cw: 300,
    cw1h: 0,
    think: 0,
  });
  const odd = codexTokens({ in: 10, cachedIn: 40, cw: 0, out: 5 });
  assert.equal(odd.in, 0, "a nonsensical report must clamp, not go negative");
});

test("codex activity reaches the shared fleet baseline, not only its own series", async () => {
  const { createSeries, recent } = await import("../lib/series.js");
  const home = scratchHome("codex-fleet");
  const at = Date.now();
  const dir = path.join(home, ".codex", "sessions", "2026", "08", "30");
  fs.mkdirSync(dir, { recursive: true });
  writeJsonl(path.join(dir, rolloutName(new Date(at).toISOString(), "t-1")), [
    sessionMeta(at - 120_000, "t-1", "/tmp/repo", "main"),
    tokenCount(at - 120_000, 1_000_000, 1_000_000),
    tokenCount(at - 60_000, 4_000_000, 3_000_000),
  ]);

  const fleetSeries = createSeries();
  const store = createCodexStore({
    root: path.join(home, ".codex", "sessions"),
    windowMs: 36 * 3600 * 1000,
    fleetSeries,
  });
  scanCodex(store, at);
  // The master's burn test compares a numerator summed over EVERY row against
  // this baseline. A vendor in the numerator and absent from the baseline made
  // the headline read BURNING while the instrument under it read zero.
  assert.ok(
    recent(fleetSeries, at, 5 * 60_000) > 0,
    "no Codex sample reached the fleet series",
  );
  assert.equal(recent(fleetSeries, at, 5 * 60_000), 4_000_000);
  removeTree(home);
});
