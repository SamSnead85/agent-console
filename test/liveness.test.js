import test from "node:test";
import assert from "node:assert/strict";

import {
  DECLARED_STATES,
  MEASURED_LIVE,
  MEASURED_STATES,
  classifyDeclared,
  isMeasuredLive,
  livenessRule,
} from "../lib/liveness.js";
import { LIVE_MS, STATES, rawState } from "../lib/state.js";
import { REGISTRY_STALE_MS } from "../lib/ingest.js";
import { buildRoster } from "../lib/roster.js";

const NOW = 1_788_000_000_000;

function scanned(over) {
  return {
    mtime: NOW,
    hot: 1000,
    runaway: false,
    agentLive: 0,
    pidAlive: null,
    pidVanished: false,
    ...over,
  };
}

/** LIVE is earned only by current measured activity. */
test("LIVE requires BOTH halves of the rule: a recent write and tokens", () => {
  // Recent write, tokens produced — the only combination that earns the word.
  assert.equal(rawState(scanned({ mtime: NOW, hot: 1 }), NOW), "LIVE");
  // Recent write, no tokens. Motion, not work — and it is not called LIVE.
  assert.equal(rawState(scanned({ mtime: NOW, hot: 0 }), NOW), "WARM");
  // Tokens in the window but the file has gone quiet past the live threshold.
  assert.equal(
    rawState(scanned({ mtime: NOW - LIVE_MS - 1, hot: 500_000 }), NOW),
    "IDLE",
    "a stale transcript claimed LIVE on the strength of an old burn figure",
  );
});

test("a declaration can never produce LIVE, WARM, or any measured word", () => {
  const cases = [
    { standDown: false, stale: false, machine: "studio.local" },
    { standDown: false, stale: true, machine: "studio.local" },
    { standDown: true, stale: false, machine: "studio.local" },
    {},
  ];
  for (const input of cases) {
    const out = classifyDeclared(input);
    assert.ok(
      DECLARED_STATES.has(out.state),
      "classifyDeclared invented the state " + out.state,
    );
    assert.equal(
      MEASURED_LIVE.has(out.state),
      false,
      out.state + " would be counted as a live session",
    );
    assert.notEqual(out.state, "LIVE");
    assert.notEqual(out.state, "WARM");
    assert.ok(out.reason && out.reason.length > 20, "no reason was given");
    assert.equal(
      out.glyph,
      STATES[out.state].glyph,
      "the glyph disagreed with the word beside it",
    );
  }
});

test("the three declared answers are distinct, and each says why", () => {
  const fresh = classifyDeclared({ machine: "studio.local" });
  assert.equal(fresh.state, "UNKNOWN");
  assert.equal(fresh.liveness, "unknown");
  assert.match(fresh.reason, /studio\.local/);
  assert.match(fresh.reason, /cannot scan/);

  const stale = classifyDeclared({ stale: true, machine: "studio.local" });
  assert.equal(stale.state, "STALE");
  assert.match(
    stale.reason,
    new RegExp(String(Math.round(REGISTRY_STALE_MS / 60_000))),
    "the STALE reason does not quote the threshold that produced it",
  );

  const down = classifyDeclared({ standDown: true, machine: "studio.local" });
  assert.equal(down.state, "COLD");
  assert.match(down.reason, /stood down/);
});

test("the measured and declared vocabularies do not overlap except at COLD", () => {
  const both = [...DECLARED_STATES].filter((s) => MEASURED_STATES.has(s));
  assert.deepEqual(both, ["COLD"]);
  // Every word either vocabulary can produce has an entry in the state map, or
  // the row would render a blank glyph beside it.
  for (const word of [...MEASURED_STATES, ...DECLARED_STATES]) {
    assert.ok(STATES[word], word + " has no entry in STATES");
  }
});

test("only measured states are ever counted as live", () => {
  assert.equal(isMeasuredLive("LIVE"), true);
  assert.equal(isMeasuredLive("WARM"), true);
  assert.equal(isMeasuredLive("RUN"), true);
  assert.equal(isMeasuredLive("STALL"), true);
  assert.equal(isMeasuredLive("UNKNOWN"), false);
  assert.equal(isMeasuredLive("STALE"), false);
  assert.equal(isMeasuredLive("IDLE"), false);
  assert.equal(isMeasuredLive("COLD"), false);
});

/**
 * The defect in its original shape: `reg.state || "LIVE"`. A registration that
 * said nothing at all about its own state was printed LIVE, in the same green
 * as a row measured off this disk.
 */
test("a registration that declares nothing is UNKNOWN, not LIVE", () => {
  const r = buildRoster({
    rows: [],
    registry: {
      sessions: [
        {
          id: "kimi",
          sessionId: null,
          name: "Kimi",
          vendor: "kimi",
          machine: "studio.local",
          project: null,
          branch: null,
          state: null,
          stale: false,
          agents: { live: 0, total: 0 },
          total: 0,
          at: NOW,
          author: null,
        },
      ],
    },
    muster: { available: false },
    host: "laptop.local",
    now: NOW,
  });
  const entry = r.machines.find((m) => m.name === "studio.local").sessions[0];
  assert.equal(entry.state, "UNKNOWN");
  assert.equal(entry.liveness, "unknown");
  assert.equal(r.counts.live, 0);
  assert.equal(r.counts.unknown, 1);
  assert.equal(
    r.counts.sessions,
    1,
    "an unknown session is still a session — it exists, we just cannot measure it",
  );
});

/**
 * The second shape of the same defect: the muster ledger's "active" status
 * rendered WARM, and WARM was inside the set the roster counted as live.
 */
test("a ledger entry that says active is not a measurement of liveness", () => {
  const r = buildRoster({
    rows: [],
    registry: { sessions: [] },
    muster: {
      available: true,
      sessions: [
        {
          name: "STUDIO-ORCH",
          role: "orchestrator",
          machine: "studio.local",
          vendor: "claude-code",
          model: null,
          status: "active",
          branch: "main",
          package: "W3",
          stale: false,
          at: NOW,
        },
      ],
    },
    host: "laptop.local",
    now: NOW,
  });
  const entry = r.machines.find((m) => m.name === "studio.local").sessions[0];
  assert.equal(entry.state, "UNKNOWN");
  assert.equal(
    r.counts.live,
    0,
    "the ledger's word for itself was counted as a live session",
  );
  assert.equal(entry.declaredState, "active");
});

test("a session stood down in the ledger is COLD, and not a session at all", () => {
  const r = buildRoster({
    rows: [],
    registry: { sessions: [] },
    muster: {
      available: true,
      sessions: [
        {
          name: "OLD-WORKER",
          role: "worker",
          machine: "studio.local",
          vendor: "claude-code",
          model: null,
          status: "stood-down",
          branch: "main",
          package: null,
          stale: false,
          at: NOW - 3600_000,
        },
      ],
    },
    host: "laptop.local",
    now: NOW,
  });
  const entry = r.machines.find((m) => m.name === "studio.local").sessions[0];
  assert.equal(entry.state, "COLD");
  assert.equal(r.counts.sessions, 0);
  assert.equal(r.counts.live, 0);
});

test("the rule the glossary prints is the rule the code enforces", () => {
  const rule = livenessRule();
  const live = String(Math.round(LIVE_MS / 60_000));
  const stale = String(Math.round(REGISTRY_STALE_MS / 60_000));
  assert.match(rule.short, new RegExp(live));
  assert.match(rule.body, new RegExp(live));
  assert.match(rule.body, new RegExp(stale));
  for (const word of ["LIVE", "WARM", "UNKNOWN", "STALE", "COLD"]) {
    assert.match(rule.body, new RegExp("\\b" + word + "\\b"));
  }
  // The sentence that makes the rule checkable rather than decorative.
  assert.match(rule.short, /Nothing declared can be LIVE/);
});
