/**
 * Deterministic, privacy-safe data for screenshots, evaluation and tours.
 *
 * This module is the complete data source in `--demo` mode. It reads no home
 * directory, transcript, process table, repository, ledger, history file or
 * network service. All names, paths, ids, timestamps and measurements below
 * are fictional. The fixed clock makes two launches byte-for-byte comparable.
 */

import {
  PRICE_TABLE_DATE,
  PRICE_TABLE_EXPIRY,
  PRICE_TABLE_SOURCE,
  CACHE_READ_MULT,
  CACHE_WRITE_1H_MULT,
  CACHE_WRITE_5M_MULT,
  addCost,
  addTokens,
  costSplit,
  isPriceTableExpired,
  sumTokens,
  zeroCost,
  zeroTokens,
} from "./prices.js";
import { dayKeyOf } from "./day.js";
import {
  BUCKET_MS,
  PERIODS,
  addHistorySample,
  assembleHistory,
  createHistoryStore,
} from "./history.js";
import { buildProjects } from "./projects.js";
import { buildAttribution } from "./attribution.js";
import { glossaryPayload } from "./glossary.js";

/** A fixed review clock. Never Date.now(), so captures remain reproducible. */
export const DEMO_NOW = Date.UTC(2026, 8, 1, 18, 50, 0);
export const DEMO_LABEL = "DEMO DATA";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PROJECTS = {
  "demo-muster": { label: "Agent Console", path: "demo/muster" },
  "demo-atlas-checkout": {
    label: "Atlas Checkout",
    path: "demo/atlas-checkout",
  },
  "demo-docs": { label: "Developer Portal", path: "demo/developer-portal" },
};

const SESSION_NAMES = new Map([
  ["demo-muster|demo-claude-console-0001", "Agent Console"],
  ["demo-atlas-checkout|demo-claude-reliability-0002", "Atlas Checkout"],
  ["demo-docs|demo-claude-docs-0003", "Developer Portal"],
]);

function tokens(input) {
  return {
    in: input.in || 0,
    out: input.out || 0,
    cr: input.cr || 0,
    cw: input.cw || 0,
    cw1h: input.cw1h || 0,
    think: input.think || 0,
  };
}

function costTotal(split) {
  return split ? split.in + split.out + split.cw + split.cr : null;
}

function spark(seed, scale) {
  return Array.from({ length: 30 }, (_, i) =>
    Math.round(
      scale *
        (0.24 + ((i * (seed + 5)) % 17) / 23 + (i > 21 ? 0.22 : 0)),
    ),
  );
}

function rowBase(input) {
  return {
    key: input.key,
    vendor: input.vendor,
    id: input.id,
    short: input.id.slice(0, 12),
    name: input.name,
    project: input.project,
    path: input.path,
    pathExact: true,
    branch: input.branch,
    version: input.version,
    state: input.state,
    stateSince: input.stateSince,
    glyph: input.glyph,
    edge: input.edge,
    rank: input.rank,
    models: input.models,
    tok: input.tok,
    total: input.total,
    cost: input.cost,
    costSplit: input.costSplit,
    unpriced: false,
    priced: input.priced,
    cumulative: input.cumulative,
    hot: input.hot,
    spark: input.spark,
    ratio: input.ratio || 0,
    baseline: input.baseline || 0,
    runCause: null,
    lastTs: input.lastTs,
    startedAt: input.startedAt,
    agentCount: input.agentCount || 0,
    agentLive: input.agentLive || 0,
    swarm: false,
    agents: input.agents || [],
    last: input.last,
    pid: input.pid || null,
    pidAlive: input.pid ? true : null,
    killable: false,
    fingerprint: null,
    prsOpened: input.prsOpened || 0,
    responses: input.responses || 0,
    usageLines: input.usageLines || 0,
    retries: input.retries || 0,
    hookErrors: 0,
    errors: input.errors || [],
    tools: input.tools || [],
    cacheMiss: input.cacheMiss || [],
    serverTools: input.serverTools || { search: 0, fetch: 0 },
    compactions: input.compactions || [],
    contextPeak: input.contextPeak || 0,
    quota: null,
    bad: 0,
    deadhead: false,
    deadheadReason: null,
    quietMs: 0,
  };
}

function claudeRow(input, day) {
  const split = costSplit(input.model, input.tok, day);
  return rowBase({
    ...input,
    vendor: "claude",
    models: [input.model],
    total: sumTokens(input.tok),
    cost: costTotal(split),
    costSplit: split,
    priced: true,
    cumulative: false,
  });
}

function measuredRosterEntry(row, sources, joinedBy, author, ledgerPackage) {
  return {
    key: row.key,
    id: row.short,
    fullId: row.id,
    name: row.name,
    vendor: row.vendor,
    model: row.models[0] || null,
    models: row.models,
    machine: "demo-studio",
    project: row.project,
    branch: row.branch,
    state: row.state,
    glyph: row.glyph,
    agentsLive: row.agentLive,
    agentsTotal: row.agentCount,
    tokens: row.total,
    cumulative: row.cumulative,
    cost: row.priced ? row.cost : null,
    lastSeen: row.lastTs,
    pid: row.pid,
    sources,
    scannable: true,
    joinedBy: joinedBy || null,
    deadhead: false,
    deadheadReason: null,
    author: author || null,
    note: "Synthetic observed session for product demonstration.",
    ledgerStatus: "active",
    ledgerPackage: ledgerPackage || null,
    declaredStale: false,
    measured: true,
    stateReason: null,
    declaredState: sources.length > 1 ? "active" : null,
    lastMentionedAt: sources.includes("declared")
      ? DEMO_NOW - 4 * MINUTE
      : null,
    lastMentionedDoing: row.last,
    lastMentionedBasis: sources.includes("declared")
      ? "synthetic ledger identity, matched on name"
      : null,
    role: row.name && row.name.includes("ORCHESTRATOR") ? "orchestrator" : "worker",
    unmatchedLocal: false,
    liveness: row.state === "IDLE" ? "idle" : "live",
  };
}

function remoteRosterEntry(input) {
  return {
    key: input.key,
    id: input.id,
    fullId: input.fullId,
    name: input.name,
    vendor: input.vendor,
    model: input.models[0] || null,
    models: input.models,
    machine: input.machine,
    project: input.project,
    branch: input.branch,
    state: "UNKNOWN",
    glyph: "?",
    agentsLive: input.agentsLive || 0,
    agentsTotal: input.agentsTotal || 0,
    // Null is intentional: declared elsewhere is not measured here.
    tokens: null,
    cumulative: false,
    cost: null,
    lastSeen: input.lastSeen,
    pid: null,
    sources: input.sources,
    scannable: false,
    joinedBy: null,
    deadhead: false,
    deadheadReason: null,
    author: input.author || null,
    note:
      input.note ||
      "Liveness and token use are unknown because this machine cannot scan it.",
    ledgerStatus: "active",
    ledgerPackage: input.ledgerPackage || null,
    declaredStale: false,
    measured: false,
    stateReason:
      "Declared on another synthetic machine; this console has no local measurement.",
    declaredState: "active",
    lastMentionedAt: input.lastSeen,
    lastMentionedDoing: input.doing,
    lastMentionedBasis: "synthetic ledger identity, matched on name",
    role: "worker",
    unmatchedLocal: false,
    liveness: "unknown",
  };
}

function demoRows(day) {
  const consoleTokens = tokens({
    in: 2_420_000,
    out: 1_180_000,
    cr: 47_800_000,
    cw: 8_640_000,
    cw1h: 1_920_000,
    think: 410_000,
  });
  const reliabilityTokens = tokens({
    in: 1_080_000,
    out: 680_000,
    cr: 18_400_000,
    cw: 3_260_000,
    cw1h: 620_000,
    think: 260_000,
  });
  const docsTokens = tokens({
    in: 620_000,
    out: 310_000,
    cr: 8_900_000,
    cw: 1_140_000,
    cw1h: 0,
    think: 86_000,
  });

  const rows = [
    claudeRow(
      {
        key: "demo-muster|demo-claude-console-0001",
        id: "demo-claude-console-0001",
        name: "DEMO-STUDIO-ORCHESTRATOR",
        project: "Agent Console",
        path: "demo/muster",
        branch: "feat/console-observability",
        version: "2.1.0-demo",
        model: "claude-sonnet-5",
        state: "LIVE",
        stateSince: DEMO_NOW - 42 * MINUTE,
        glyph: "●",
        edge: "live",
        rank: 3,
        tok: consoleTokens,
        hot: 486_000,
        spark: spark(3, 85_000),
        lastTs: DEMO_NOW - 18_000,
        startedAt: DEMO_NOW - 5.4 * HOUR,
        agentCount: 4,
        agentLive: 3,
        agents: [
          {
            type: "console-ui",
            depth: 1,
            tokens: 8_300_000,
            cost: 18.72,
            live: true,
            described: true,
            desc: "Restore the instrument-grade operations console",
          },
          {
            type: "security-review",
            depth: 1,
            tokens: 5_100_000,
            cost: 12.14,
            live: true,
            described: true,
            desc: "Verify the loopback and read-only trust boundary",
          },
          {
            type: "docs-evidence",
            depth: 1,
            tokens: 3_800_000,
            cost: 7.22,
            live: true,
            described: true,
            desc: "Turn implementation evidence into release documentation",
          },
          {
            type: "pricing-check",
            depth: 1,
            tokens: 1_460_000,
            cost: 2.88,
            live: false,
            described: true,
            desc: "Re-verify public model pricing against primary sources",
          },
        ],
        last: "Integrating privacy-safe demo mode and release evidence",
        pid: 41001,
        prsOpened: 2,
        responses: 284,
        usageLines: 337,
        retries: 2,
        tools: [
          { name: "Read", count: 84 },
          { name: "Edit", count: 31 },
          { name: "Bash", count: 22 },
        ],
        serverTools: { search: 6, fetch: 9 },
        compactions: [{ at: DEMO_NOW - 2 * HOUR, durationMs: 18_000 }],
        contextPeak: 184_000,
      },
      day,
    ),
    claudeRow(
      {
        key: "demo-atlas-checkout|demo-claude-reliability-0002",
        id: "demo-claude-reliability-0002",
        name: "DEMO-STUDIO-RELIABILITY",
        project: "Atlas Checkout",
        path: "demo/atlas-checkout",
        branch: "feat/webhook-retry-policy",
        version: "2.1.0-demo",
        model: "claude-opus-5",
        state: "WARM",
        stateSince: DEMO_NOW - 9 * MINUTE,
        glyph: "◐",
        edge: "warm",
        rank: 4,
        tok: reliabilityTokens,
        hot: 211_000,
        spark: spark(7, 48_000),
        lastTs: DEMO_NOW - 2 * MINUTE,
        startedAt: DEMO_NOW - 3.2 * HOUR,
        agentCount: 2,
        agentLive: 1,
        agents: [
          {
            type: "fault-injection",
            depth: 1,
            tokens: 4_720_000,
            cost: 16.4,
            live: true,
            described: true,
            desc: "Exercise retry idempotency and poison-message handling",
          },
          {
            type: "contract-tests",
            depth: 1,
            tokens: 2_260_000,
            cost: 7.06,
            live: false,
            described: true,
            desc: "Prove compatibility at the queue boundary",
          },
        ],
        last: "Running deterministic failure-injection tests",
        pid: 41002,
        prsOpened: 1,
        responses: 142,
        usageLines: 168,
        tools: [
          { name: "Bash", count: 41 },
          { name: "Read", count: 36 },
          { name: "Edit", count: 14 },
        ],
        cacheMiss: [{ name: "tool_result", count: 118_000 }],
        contextPeak: 156_000,
      },
      day,
    ),
    claudeRow(
      {
        key: "demo-docs|demo-claude-docs-0003",
        id: "demo-claude-docs-0003",
        name: "DEMO-STUDIO-DOCS",
        project: "Developer Portal",
        path: "demo/developer-portal",
        branch: "docs/installation-proof",
        version: "2.1.0-demo",
        model: "claude-haiku-4-5",
        state: "IDLE",
        stateSince: DEMO_NOW - 24 * MINUTE,
        glyph: "○",
        edge: "idle",
        rank: 5,
        tok: docsTokens,
        hot: 0,
        spark: spark(11, 17_000).map((value, i) =>
          i > 24 ? 0 : value,
        ),
        lastTs: DEMO_NOW - 24 * MINUTE,
        startedAt: DEMO_NOW - 2.7 * HOUR,
        agentCount: 1,
        agentLive: 0,
        agents: [
          {
            type: "docs-review",
            depth: 1,
            tokens: 1_820_000,
            cost: 1.64,
            live: false,
            described: true,
            desc: "Validate installation examples and evidence links",
          },
        ],
        last: "Waiting for the release-candidate version number",
        pid: null,
        prsOpened: 1,
        responses: 76,
        usageLines: 84,
        tools: [
          { name: "Read", count: 39 },
          { name: "Edit", count: 18 },
        ],
        contextPeak: 92_000,
      },
      day,
    ),
  ];

  const codexTokens = tokens({
    in: 3_260_000,
    out: 1_460_000,
    cr: 21_800_000,
    cw: 2_200_000,
    think: 720_000,
  });
  rows.push(
    rowBase({
      key: "codex|demo-codex-security-0004",
      vendor: "codex",
      id: "demo-codex-security-0004",
      name: "DEMO-STUDIO-CODEX",
      project: "Agent Console",
      path: "demo/muster",
      branch: "review/console-trust-boundary",
      version: "0.108.0-demo",
      state: "LIVE",
      stateSince: DEMO_NOW - 31 * MINUTE,
      glyph: "●",
      edge: "live",
      rank: 3,
      models: ["gpt-5.6-sol"],
      tok: codexTokens,
      total: sumTokens(codexTokens),
      cost: null,
      costSplit: null,
      priced: false,
      cumulative: true,
      hot: 372_000,
      spark: spark(13, 66_000),
      lastTs: DEMO_NOW - 44_000,
      startedAt: DEMO_NOW - 4.1 * HOUR,
      agentCount: 3,
      agentLive: 2,
      agents: [
        {
          type: "threat-model",
          depth: 1,
          tokens: 6_100_000,
          cost: null,
          live: true,
          described: true,
          desc: "Challenge data boundaries and mutation controls",
        },
        {
          type: "portability",
          depth: 1,
          tokens: 3_900_000,
          cost: null,
          live: true,
          described: true,
          desc: "Audit Node and operating-system portability",
        },
        {
          type: "test-review",
          depth: 1,
          tokens: 2_400_000,
          cost: null,
          live: false,
          described: true,
          desc: "Check failure-mode coverage and test credibility",
        },
      ],
      last: "Reviewing local-only API and private-state guarantees",
      pid: null,
      prsOpened: 0,
      errors: [],
      tools: [],
    }),
  );
  Object.assign(rows[3], {
    effort: "high",
    rateLimits: {
      usedPercent: 38,
      windowMinutes: 300,
      resetsAt: DEMO_NOW + 96 * MINUTE,
      planType: "demo",
    },
    contextWindow: 272_000,
    patches: 24,
    patchFailures: 1,
    filesTouched: ["demo/security.js", "demo/server.js", "demo/server.test.js"],
    calls: { total: 132 },
  });
  return rows;
}

function modelTotals(rows, day) {
  const byModel = new Map();
  for (const row of rows.filter((item) => item.vendor === "claude")) {
    const model = row.models[0];
    let value = byModel.get(model);
    if (!value) {
      value = zeroTokens();
      byModel.set(model, value);
    }
    addTokens(value, row.tok);
  }
  return Array.from(byModel, ([model, value]) => {
    const split = costSplit(model, value, day);
    return {
      model,
      tokens: value,
      total: sumTokens(value),
      cost: costTotal(split),
      costSplit: split,
    };
  }).sort((a, b) => b.cost - a.cost);
}

function headerOf(rows, day) {
  const grandTokens = zeroTokens();
  const grandCost = zeroCost();
  for (const row of rows.filter((item) => item.vendor === "claude")) {
    addTokens(grandTokens, row.tok);
    addCost(grandCost, row.costSplit);
  }
  const totalCost = costTotal(grandCost);
  return {
    tokens: grandTokens,
    total: sumTokens(grandTokens),
    cost: grandCost,
    costTotal: totalCost,
    unpriced: false,
    models: modelTotals(rows, day),
    sessionCount: 6,
    liveCount: 3,
    fleetHot: rows.reduce((sum, row) => sum + row.hot, 0),
    fleetMedianPerMinute: 184_000,
  };
}

function burnOf() {
  const minutes = Array.from({ length: 60 }, (_, i) => {
    const wave = ((i * 37) % 23) / 23;
    const lift = i > 42 ? (i - 42) * 7_200 : 0;
    const t = Math.round(96_000 + wave * 132_000 + lift);
    return {
      m: Math.floor((DEMO_NOW - (59 - i) * MINUTE) / MINUTE),
      t,
      c: Number((t * 0.0000028).toFixed(4)),
    };
  });
  const penultimate = minutes[minutes.length - 2];
  return {
    minutes,
    median: 184_000,
    tokensPerMinute: penultimate.t,
    costPerMinute: penultimate.c,
    minuteMs: MINUTE,
  };
}

function rosterOf(rows) {
  const local = [
    measuredRosterEntry(
      rows[0],
      ["observed", "declared"],
      "branch",
      "Demo Engineer A",
      "console-demo",
    ),
    measuredRosterEntry(
      rows[1],
      ["observed", "declared"],
      "branch",
      "Demo Engineer B",
      "retry-policy",
    ),
    measuredRosterEntry(
      rows[2],
      ["observed", "declared"],
      "branch",
      "Demo Engineer A",
      "docs-proof",
    ),
    measuredRosterEntry(
      rows[3],
      ["observed", "registered", "declared"],
      "session id",
      "Demo Engineer B",
      "security-boundary",
    ),
  ];
  const laptop = remoteRosterEntry({
    key: "reg|demo-laptop-human-0005",
    id: "laptop-0005",
    fullId: "demo-laptop-human-0005",
    name: "DEMO-LAPTOP-HUMAN",
    vendor: "human",
    models: [],
    machine: "demo-laptop",
    project: "Agent Console",
    branch: "docs/operator-guide",
    lastSeen: DEMO_NOW - 5 * MINUTE,
    sources: ["registered", "declared"],
    author: "Demo Engineer C",
    ledgerPackage: "operator-guide",
    doing: "Reviewing the cross-machine operator guide",
    note:
      "Human participant declared on the shared ledger; liveness and token use are not applicable or measured.",
  });
  const runner = remoteRosterEntry({
    key: "muster|demo-ci-reviewer-0006",
    id: "ci-reviewer",
    fullId: "demo-ci-reviewer-0006",
    name: "DEMO-CI-REVIEWER",
    vendor: "gemini",
    models: [],
    machine: "demo-build-runner",
    project: "Atlas Checkout",
    branch: "verify/compatibility-matrix",
    lastSeen: DEMO_NOW - 7 * MINUTE,
    sources: ["declared"],
    ledgerPackage: "compatibility-matrix",
    doing: "Waiting for the Windows compatibility job",
    note:
      "Model, liveness and tokens were not reported; only the ledger declaration is shown.",
  });

  return {
    headline:
      "DEMO DATA · 6 participants · 3 machines · 3 AI vendors + human",
    counts: {
      sessions: 6,
      machines: 3,
      machinesListed: 3,
      vendors: 4,
      live: 3,
      unknown: 2,
      stale: 0,
      deadhead: 0,
      observed: 4,
      registered: 2,
      declared: 6,
      joined: 5,
      unmatchedLocal: 0,
      cold: 0,
      coldTokens: 0,
    },
    vendors: ["claude", "codex", "gemini", "human"],
    machines: [
      {
        name: "demo-studio",
        isLocal: true,
        scannable: true,
        sessions: local,
        counts: {
          sessions: 4,
          live: 3,
          deadhead: 0,
          listedNotCounted: 0,
        },
      },
      {
        name: "demo-build-runner",
        isLocal: false,
        scannable: false,
        sessions: [runner],
        counts: {
          sessions: 1,
          live: 0,
          deadhead: 0,
          listedNotCounted: 0,
        },
      },
      {
        name: "demo-laptop",
        isLocal: false,
        scannable: false,
        sessions: [laptop],
        counts: {
          sessions: 1,
          live: 0,
          deadhead: 0,
          listedNotCounted: 0,
        },
      },
    ],
    localHost: "demo-studio",
    derivation:
      "DEMO DATA — 4 observed · 2 registered · all 6 declared · 5 joined across sources and counted once · 0 unmatched local declarations · 0 cold transcripts",
    note:
      "Synthetic roster. Remote rows deliberately retain UNKNOWN liveness and unreported measurements.",
  };
}

function musterOf() {
  const packages = [
    {
      id: "console-demo",
      title: "Privacy-safe console demo mode",
      status: "in-progress",
      owner: "DEMO-STUDIO-ORCHESTRATOR",
      dispatchedTo: null,
      dependsOn: [],
      writes: ["lib/dashboard/console/**"],
      blockedByIds: [],
      ready: true,
      leaseExpired: false,
      assignmentExpired: false,
      branch: "feat/console-observability",
      headSha: "d3adbeef01",
      at: DEMO_NOW - 4 * MINUTE,
    },
    {
      id: "security-boundary",
      title: "Harden the local API trust boundary",
      status: "in-progress",
      owner: "DEMO-STUDIO-CODEX",
      dispatchedTo: null,
      dependsOn: [],
      writes: ["lib/dashboard/console/server.js"],
      blockedByIds: [],
      ready: true,
      leaseExpired: false,
      assignmentExpired: false,
      branch: "review/console-trust-boundary",
      headSha: null,
      at: DEMO_NOW - 6 * MINUTE,
    },
    {
      id: "retry-policy",
      title: "Prove idempotent webhook recovery",
      status: "in-progress",
      owner: "DEMO-STUDIO-RELIABILITY",
      dispatchedTo: null,
      dependsOn: [],
      writes: ["src/webhooks/**", "test/webhooks/**"],
      blockedByIds: [],
      ready: true,
      leaseExpired: false,
      assignmentExpired: false,
      branch: "feat/webhook-retry-policy",
      headSha: "fa11afe003",
      at: DEMO_NOW - 8 * MINUTE,
    },
    {
      id: "operator-guide",
      title: "Write the cross-machine operator guide",
      status: "in-progress",
      owner: "DEMO-LAPTOP-HUMAN",
      dispatchedTo: null,
      dependsOn: [],
      writes: ["docs/OPERATOR-GUIDE.md"],
      blockedByIds: [],
      ready: true,
      leaseExpired: false,
      assignmentExpired: false,
      branch: "docs/operator-guide",
      headSha: null,
      at: DEMO_NOW - 5 * MINUTE,
    },
    {
      id: "compatibility-matrix",
      title: "Prove Node and operating-system compatibility",
      status: "assigned",
      owner: "DEMO-CI-REVIEWER",
      dispatchedTo: null,
      dependsOn: ["security-boundary"],
      writes: [".github/workflows/**", "test/compatibility/**"],
      blockedByIds: ["security-boundary"],
      ready: false,
      leaseExpired: false,
      assignmentExpired: false,
      branch: "verify/compatibility-matrix",
      headSha: null,
      at: DEMO_NOW - 7 * MINUTE,
    },
    {
      id: "docs-proof",
      title: "Replace claims with installation evidence",
      status: "completed",
      owner: "DEMO-STUDIO-DOCS",
      dispatchedTo: null,
      dependsOn: [],
      writes: ["README.md", "docs/**"],
      blockedByIds: [],
      ready: true,
      leaseExpired: false,
      assignmentExpired: false,
      branch: "docs/installation-proof",
      headSha: "c0ffee0021",
      at: DEMO_NOW - 26 * MINUTE,
    },
    {
      id: "release-candidate",
      title: "Cut the first evidence-backed release",
      status: "open",
      owner: null,
      dispatchedTo: null,
      dependsOn: [
        "console-demo",
        "compatibility-matrix",
        "docs-proof",
        "retry-policy",
        "operator-guide",
      ],
      writes: ["CHANGELOG.md", "package.json"],
      blockedByIds: ["compatibility-matrix"],
      ready: false,
      leaseExpired: false,
      assignmentExpired: false,
      branch: null,
      headSha: null,
      at: DEMO_NOW - 3 * MINUTE,
    },
  ];
  const sessions = [
    {
      name: "DEMO-STUDIO-ORCHESTRATOR",
      role: "orchestrator",
      machine: "demo-studio",
      vendor: "claude",
      model: "claude-sonnet-5",
      status: "active",
      branch: "feat/console-observability",
      package: "console-demo",
      holding: ["console-demo"],
      note: "Synthetic demo session",
      runway: "high",
      protocolVersion: "1",
      protocolMismatch: false,
      clockIssue: null,
      at: DEMO_NOW - 4 * MINUTE,
      joinedAt: DEMO_NOW - 5.4 * HOUR,
      stale: false,
    },
    {
      name: "DEMO-STUDIO-CODEX",
      role: "reviewer",
      machine: "demo-studio",
      vendor: "codex",
      model: "gpt-5.6-sol",
      status: "active",
      branch: "review/console-trust-boundary",
      package: "security-boundary",
      holding: ["security-boundary"],
      note: "Synthetic demo session",
      runway: "medium",
      protocolVersion: "1",
      protocolMismatch: false,
      clockIssue: null,
      at: DEMO_NOW - 6 * MINUTE,
      joinedAt: DEMO_NOW - 4.1 * HOUR,
      stale: false,
    },
    {
      name: "DEMO-STUDIO-RELIABILITY",
      role: "worker",
      machine: "demo-studio",
      vendor: "claude",
      model: "claude-opus-5",
      status: "active",
      branch: "feat/webhook-retry-policy",
      package: "retry-policy",
      holding: ["retry-policy"],
      note: "Synthetic demo session",
      runway: "medium",
      protocolVersion: "1",
      protocolMismatch: false,
      clockIssue: null,
      at: DEMO_NOW - 8 * MINUTE,
      joinedAt: DEMO_NOW - 3.2 * HOUR,
      stale: false,
    },
    {
      name: "DEMO-STUDIO-DOCS",
      role: "writer",
      machine: "demo-studio",
      vendor: "claude",
      model: "claude-haiku-4-5",
      status: "active",
      branch: "docs/installation-proof",
      package: "docs-proof",
      holding: ["docs-proof"],
      note: "Synthetic demo session; measured state is idle",
      runway: "low",
      protocolVersion: "1",
      protocolMismatch: false,
      clockIssue: null,
      at: DEMO_NOW - 24 * MINUTE,
      joinedAt: DEMO_NOW - 2.7 * HOUR,
      stale: false,
    },
    {
      name: "DEMO-LAPTOP-HUMAN",
      role: "maintainer",
      machine: "demo-laptop",
      vendor: "human",
      model: null,
      status: "active",
      branch: "docs/operator-guide",
      package: "operator-guide",
      holding: ["operator-guide"],
      note: "Synthetic human participant on the shared ledger",
      runway: "low",
      protocolVersion: "1",
      protocolMismatch: false,
      clockIssue: null,
      at: DEMO_NOW - 5 * MINUTE,
      joinedAt: DEMO_NOW - 2.2 * HOUR,
      stale: false,
    },
    {
      name: "DEMO-CI-REVIEWER",
      role: "reviewer",
      machine: "demo-build-runner",
      vendor: "gemini",
      model: null,
      status: "active",
      branch: "verify/compatibility-matrix",
      package: "compatibility-matrix",
      holding: ["compatibility-matrix"],
      note: "Model and token use intentionally unreported",
      runway: "medium",
      protocolVersion: "1",
      protocolMismatch: false,
      clockIssue: null,
      at: DEMO_NOW - 7 * MINUTE,
      joinedAt: DEMO_NOW - 58 * MINUTE,
      stale: false,
    },
  ];
  return {
    available: true,
    enabled: true,
    at: DEMO_NOW,
    source: "DEMO DATA — in-memory synthetic Muster ledger",
    sourceState: "synthetic",
    sourceReason: "No repository or ledger was read.",
    sourceHeadSha: null,
    remoteConfirmed: false,
    localOnly: false,
    protocolVersion: "1",
    generatedAt: DEMO_NOW,
    sessions,
    packages,
    counts: {
      open: 1,
      assigned: 1,
      inProgress: 4,
      completed: 1,
      released: 0,
      done: 1,
      other: 0,
    },
    sessionCount: sessions.length,
    activeCount: sessions.length,
    machines: ["demo-build-runner", "demo-laptop", "demo-studio"],
    claims: packages
      .filter((item) => item.owner)
      .map((item) => ({
        id: item.id,
        title: item.title,
        owner: item.owner,
        status: item.status,
        at: item.at,
      })),
    flagged: [
      {
        kind: "BLOCKED",
        from: "DEMO-CI-REVIEWER",
        to: "DEMO-STUDIO-ORCHESTRATOR",
        body:
          "compatibility-matrix is waiting on security-boundary; dependency is explicit and no conflicting write fence was assigned.",
        at: DEMO_NOW - 7 * MINUTE,
      },
    ],
    note:
      "DEMO DATA — declarations, dependencies, write fences and blockers are synthetic.",
  };
}

function progressOf() {
  const points = [
    { t: DEMO_NOW - 22 * HOUR, percent: 48, carried: false },
    { t: DEMO_NOW - 16 * HOUR, percent: 56, carried: false },
    { t: DEMO_NOW - 10 * HOUR, percent: 68, carried: false },
    { t: DEMO_NOW - 5 * HOUR, percent: 76, carried: false },
    { t: DEMO_NOW - 80 * MINUTE, percent: 72, carried: false },
  ];
  return {
    available: true,
    percent: 72,
    summary:
      "Usage collection and model pricing are complete; installation checks remain.",
    remaining: [
      "Complete the Windows compatibility run",
      "Verify the install path in a clean environment",
      "Approve the sanitized public screenshots",
    ],
    updatedAt: DEMO_NOW - 80 * MINUTE,
    source: "DEMO DATA — synthetic orchestrator estimate",
    stale: false,
    history: {
      points,
      count: points.length,
      totalObservations: points.length,
      firstAt: points[0].t,
      delta: 24,
      direction: "up",
      peakPercent: 76,
      regressed: true,
      regressedBy: 4,
      file: null,
      badLines: 0,
      writeError: null,
      note:
        "DEMO DATA — the setback is deliberate, showing that honest estimates may fall.",
    },
  };
}

function shippedOf() {
  return {
    at: DEMO_NOW,
    source: "DEMO DATA — synthetic local git evidence; no repository was read",
    commitCount: 14,
    mergeCount: 3,
    repos: [
      {
        name: "muster",
        path: "demo/muster",
        branch: "feat/console-observability",
        commits: 9,
        merges: 2,
        recent: [
          {
            hash: "d3adbee",
            subject: "feat(console): add deterministic privacy-safe demo",
            at: DEMO_NOW - 18 * MINUTE,
          },
        ],
      },
      {
        name: "atlas-checkout",
        path: "demo/atlas-checkout",
        branch: "feat/webhook-retry-policy",
        commits: 5,
        merges: 1,
        recent: [
          {
            hash: "c0ffee0",
            subject: "test: prove idempotent webhook recovery",
            at: DEMO_NOW - 43 * MINUTE,
          },
        ],
      },
    ],
    prs: [
      { number: 42, repo: "muster", ts: DEMO_NOW - 34 * MINUTE },
      { number: 118, repo: "atlas-checkout", ts: DEMO_NOW - 91 * MINUTE },
    ],
    prCount: 2,
    prCountWindow: 3,
    errors: [],
  };
}

function processesOf(rows) {
  return [
    {
      pid: 41001,
      vendor: "claude",
      role: "session",
      sessionName: rows[0].name,
      sessionId: rows[0].id,
      tokens: rows[0].total,
      cost: rows[0].cost,
      agentCount: rows[0].agentCount,
      agentLive: rows[0].agentLive,
      etime: "05:24:18",
      cpu: 7.2,
      rssMb: 684,
      cmd: "DEMO DATA — synthetic claude session",
      killable: false,
      fingerprint: null,
      protectedReason: "demo mode has no real process and termination is disabled",
    },
    {
      pid: 41002,
      vendor: "claude",
      role: "session",
      sessionName: rows[1].name,
      sessionId: rows[1].id,
      tokens: rows[1].total,
      cost: rows[1].cost,
      agentCount: rows[1].agentCount,
      agentLive: rows[1].agentLive,
      etime: "03:12:41",
      cpu: 3.8,
      rssMb: 512,
      cmd: "DEMO DATA — synthetic claude session",
      killable: false,
      fingerprint: null,
      protectedReason: "demo mode has no real process and termination is disabled",
    },
  ];
}

function instrumentOf(day) {
  const expired = isPriceTableExpired(day);
  return {
    responses: 502,
    usageLines: 589,
    dedupRatio: 589 / 502,
    dedupSpanMax: 4,
    badLines: 0,
    priceTableDate: PRICE_TABLE_DATE,
    priceTableSource: PRICE_TABLE_SOURCE,
    priceTableExpiry: PRICE_TABLE_EXPIRY,
    priceTableExpired: expired,
    priceTableWarning: expired
      ? "price table dated " + PRICE_TABLE_DATE + " — estimate drift possible"
      : null,
    cacheWrite5m: CACHE_WRITE_5M_MULT,
    cacheWrite1h: CACHE_WRITE_1H_MULT,
    cacheRead: CACHE_READ_MULT,
    estimateNote:
      "DEMO DATA. Dollar figures are synthetic estimates computed from the bundled price table; they are not a bill.",
  };
}

/** Build the main `/api` payload. Pure and byte-stable across invocations. */
export function createDemoSnapshot(options = {}) {
  const now = options.now === undefined ? DEMO_NOW : Number(options.now);
  const day = dayKeyOf(now);
  const rows = demoRows(day);
  const header = headerOf(rows, day);
  const roster = rosterOf(rows);
  const progress = progressOf();
  if (options.observability) {
    roster.machines = roster.machines.filter((machine) => machine.isLocal);
    for (const machine of roster.machines) {
      for (const session of machine.sessions) {
        session.sources = ["observed"];
        session.ledgerPackage = null;
      }
    }
    Object.assign(roster.counts, {sessions: 4, machines: 1, machinesListed: 1,
      vendors: 2, unknown: 0, registered: 0, declared: 0, joined: 0});
    roster.vendors = ["claude", "codex"];
    roster.headline = "DEMO DATA · 4 sessions · this device · Claude + Codex";
    roster.derivation = "DEMO DATA — 4 locally observed sessions; no remote collection";
    roster.note = "Synthetic local observability; no machine is being scanned.";
  }
  const instrument = instrumentOf(day);
  return {
    demo: {
      enabled: true,
      label: DEMO_LABEL,
      synthetic: true,
      notice:
        "Every identity, project, path, token, cost, process, commit and package on this screen is synthetic.",
    },
    meta: {
      now,
      day,
      host: "DEMO DATA · demo-studio",
      platform: "demo",
      scan: {
        ms: 0,
        bytes: 0,
        files: 0,
        error: null,
        bytesTotal: 0,
        claudeMissing: false,
        roots: {
          claude: "DEMO DATA — no transcript directory read",
          codex: "DEMO DATA — no session directory read",
        },
        source: "synthetic in-memory fixture",
      },
      pollMs: Number(options.pollMs) || 10_000,
      killEnabled: false,
      network:
        "none — DEMO DATA is in memory; no files, processes, git repositories, private state, ledger, or network are read",
    },
    master: {
      word: "NOMINAL",
      glyph: "●",
      cause: "DEMO DATA · 3 measured-live sessions · 1.07M tokens/5m",
      secondary: ["DEMO DATA · synthetic values only"],
      fleetThreshold: 4_600_000,
    },
    header,
    burn: burnOf(),
    rows,
    procs: processesOf(rows),
    ship: shippedOf(),
    fleet: {
      enabled: false,
      available: false,
      at: now,
      reason: "disabled in demo mode; no GitHub request is made",
    },
    progress,
    muster: options.observability ? {enabled: false, available: false} : musterOf(),
    roster,
    stall: {
      stalled: false,
      reason: null,
      fleetWindowTokens: 2_140_000,
      liveCount: 3,
    },
    projects: {
      available: false,
      reason: "period-scoped synthetic projects are served by /api/history",
    },
    registry: {
      count: 2,
      badFiles: 0,
      dir: null,
      error: null,
      note: "DEMO DATA — in-memory registration, no state directory",
    },
    glossary: glossaryPayload({
      fleetThreshold: 4_600_000,
      fleetMedianPerMinute: header.fleetMedianPerMinute,
    }),
    events: [],
    codex: {
      available: true,
      reason: null,
      threadCount: 2,
      note:
        "DEMO DATA. Exact-looking counters are synthetic; Codex rows remain cumulative and unpriced to preserve the real product's semantics.",
    },
    instrument,
  };
}

function makeHistoryStore(now) {
  const store = createHistoryStore({});
  const start = now - 72 * HOUR;
  // Five-minute samples produce a real-looking dense trace without random
  // values. The modular patterns are intentionally uneven and repeatable.
  for (let i = 0; i < (72 * HOUR) / BUCKET_MS; i += 1) {
    const at = start + i * BUCKET_MS;
    addHistorySample(
      store,
      at,
      "claude-sonnet-5",
      "demo-muster|demo-claude-console-0001",
      tokens({
        in: 2_600 + ((i * 83) % 2_700),
        out: 820 + ((i * 47) % 980),
        cr: 54_000 + ((i * 1_907) % 42_000),
        cw: 4_100 + ((i * 211) % 5_900),
        cw1h: i % 7 === 0 ? 1_400 : 0,
        think: 280 + ((i * 19) % 420),
      }),
    );
    if (i % 2 === 0) {
      addHistorySample(
        store,
        at,
        "claude-opus-5",
        "demo-atlas-checkout|demo-claude-reliability-0002",
        tokens({
          in: 1_400 + ((i * 41) % 1_500),
          out: 520 + ((i * 29) % 620),
          cr: 18_000 + ((i * 809) % 15_000),
          cw: 1_700 + ((i * 101) % 2_300),
          cw1h: i % 10 === 0 ? 700 : 0,
          think: 190 + ((i * 13) % 280),
        }),
      );
    }
    if (i % 6 === 0) {
      addHistorySample(
        store,
        at,
        "claude-haiku-4-5",
        "demo-docs|demo-claude-docs-0003",
        tokens({
          in: 700 + ((i * 17) % 800),
          out: 240 + ((i * 11) % 330),
          cr: 7_500 + ((i * 307) % 6_000),
          cw: 680 + ((i * 37) % 920),
          think: 40 + ((i * 7) % 90),
        }),
      );
    }
  }
  return store;
}

let demoHistoryStore = null;

function historyStore() {
  // Importing demo.js in a normal console must be effectively free. The dense
  // fixture is built only if demo history is actually requested.
  if (!demoHistoryStore) demoHistoryStore = makeHistoryStore(DEMO_NOW);
  return demoHistoryStore;
}

function relabelHistory(history) {
  for (const project of history.projects) {
    const meta = PROJECTS[project.slug];
    if (!meta) continue;
    project.label = meta.label;
    project.path = meta.path;
  }
  if (history.scope && PROJECTS[history.scope.slug]) {
    history.scope.label = PROJECTS[history.scope.slug].label;
    history.scope.path = PROJECTS[history.scope.slug].path;
  }
  history.coverage.snapshotFile = null;
  history.coverage.persistedFromMs = null;
  history.coverage.lastFlushAt = null;
  history.coverage.note =
    "DEMO DATA — deterministic in-memory Claude samples. Codex cumulative counters remain excluded. No transcript or history file was read.";
  history.coverage.scopeNote =
    "DEMO DATA — three synthetic projects across a fixed 72-hour window";
  return history;
}

function codeForPeriod(period) {
  const scale = period === "hour" ? 0.08 : period === "24h" ? 1 : 2.7;
  const whole = (value) => Math.max(value ? 1 : 0, Math.round(value * scale));
  const repos = [
    {
      name: "muster",
      path: "demo/muster",
      commits: whole(14),
      prsMerged: whole(3),
      added: whole(2_480),
      removed: whole(612),
    },
    {
      name: "atlas-checkout",
      path: "demo/atlas-checkout",
      commits: whole(8),
      prsMerged: whole(2),
      added: whole(1_140),
      removed: whole(388),
    },
    {
      name: "developer-portal",
      path: "demo/developer-portal",
      commits: whole(5),
      prsMerged: whole(1),
      added: whole(690),
      removed: whole(124),
    },
  ];
  const totals = repos.reduce(
    (sum, repo) => ({
      commits: sum.commits + repo.commits,
      prsMerged: sum.prsMerged + repo.prsMerged,
      added: sum.added + repo.added,
      removed: sum.removed + repo.removed,
    }),
    { commits: 0, prsMerged: 0, added: 0, removed: 0 },
  );
  const authors = [
    {
      name: "Demo Engineer A",
      commits: whole(15),
      prsMerged: whole(3),
      added: whole(2_420),
      removed: whole(510),
      repos: ["muster", "developer-portal"],
    },
    {
      name: "Demo Engineer B",
      commits: whole(12),
      prsMerged: whole(3),
      added: whole(1_890),
      removed: whole(614),
      repos: ["muster", "atlas-checkout"],
    },
  ];
  return {
    repos,
    authors,
    totals,
    errors: [],
    source: "DEMO DATA — synthetic git statistics; no repository was read",
  };
}

function progressForPeriod(fromMs) {
  const progress = progressOf();
  const points = progress.history.points;
  const visible =
    fromMs === null ? points : points.filter((point) => point.t >= fromMs);
  const selected = visible.length ? visible : [points[points.length - 1]];
  const first = selected[0];
  const last = selected[selected.length - 1];
  const peak = selected.reduce(
    (best, point) => (point.percent > best.percent ? point : best),
    selected[0],
  );
  return {
    ...progress.history,
    points: selected,
    count: selected.length,
    firstAt: first.t,
    delta: last.percent - first.percent,
    direction:
      last.percent > first.percent
        ? "up"
        : last.percent < first.percent
          ? "down"
          : "flat",
    peakPercent: peak.percent,
    regressed: last.percent < peak.percent,
    regressedBy: Math.max(0, peak.percent - last.percent),
  };
}

/** Build the `/api/history` payload without touching persistent history. */
export function createDemoHistory(options = {}) {
  const now = options.now === undefined ? DEMO_NOW : Number(options.now);
  const period = PERIODS[options.period] ? options.period : "24h";
  const project = PROJECTS[options.project] ? options.project : null;
  const history = relabelHistory(
    assembleHistory(historyStore(), {
      now,
      period,
      project,
      sessionNames: SESSION_NAMES,
    }),
  );
  const rows = demoRows(dayKeyOf(now));
  const code = codeForPeriod(period);
  const projects = buildProjects({
    projects: history.projects,
    code,
    rows,
    period: history.period,
    selected: project,
  });
  projects.note = "DEMO DATA — " + projects.note;
  const attribution = buildAttribution({
    code,
    bySession: history.bySession,
    rows,
    registrations: [
      {
        sessionId: "demo-claude-console-0001",
        author: "Demo Engineer A",
      },
      {
        sessionId: "demo-codex-security-0004",
        author: "Demo Engineer B",
      },
    ],
    period: history.period,
  });
  attribution.caveats.unshift(
    "DEMO DATA — code, tokens, authors and ratios in this view are synthetic.",
  );
  return {
    ...history,
    demo: { enabled: true, label: DEMO_LABEL, synthetic: true },
    code,
    projects,
    attribution,
    progress: progressForPeriod(history.period.fromMs),
    instrument: instrumentOf(dayKeyOf(now)),
  };
}
