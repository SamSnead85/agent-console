/**
 * The demonstration team: five synthetic machines, three people, nine lanes.
 *
 * Demo mode is a separate data source, never a filter over a real one. The
 * hub started with --demo reads no transcript, opens no state directory and
 * refuses every join and every report — nothing measured can mix with what is
 * generated here, and every surface of the console carries the DEMO stamp.
 *
 * The records it generates are real-shaped: the same fields, the same salted
 * 64-character hashes, the same minute-rounded times and the same four token
 * classes a reporter sends, so the store, the pricing and the aggregation are
 * exercised exactly as they are for measured data. Each lane has its own pace
 * and its own bursts, so nothing on the screen moves in step with anything else.
 *
 * Names are deliberately generic: roles instead of people, invented project
 * names, generic machine names.
 */

import crypto from "node:crypto";
import { eventMeasurement } from "../collector/measurement.js";

const MINUTE = 60_000;
const hash = (value) => crypto.createHash("sha256").update("agent-console-demo|" + value).digest("hex");

/* shares: what each synthetic machine's reporter was run with. The build box
   says it shares neither; the design laptop runs an older reporter that says
   nothing about sharing and sends no coverage (both unknown, never zero). */
export const DEMO_DEVICES = [
  { id: "dev_demo_studio", label: "Studio", person: "You", local: true, joinedDaysAgo: 21, shares: { alerts: true, activity: true } },
  { id: "dev_demo_laptop", label: "Laptop", person: "You", joinedDaysAgo: 12, shares: { alerts: true, activity: true } },
  { id: "dev_demo_workstation", label: "Workstation", person: "Platform engineer", joinedDaysAgo: 9, shares: { alerts: true, activity: true } },
  { id: "dev_demo_buildbox", label: "Build box", person: "Platform engineer", joinedDaysAgo: 9, silentMinutes: 38, shares: {} },
  { id: "dev_demo_design", label: "Design laptop", person: "Design engineer", joinedDaysAgo: 3, shares: {}, oldReporter: true },
];

/* The mix of tool kinds each lane calls, and how often a result fails. */
const TOOL_MIX = {
  "atlas-api": [["edit", 4], ["read", 5], ["shell", 3], ["search", 2], ["agent", 1]],
  "atlas-web": [["edit", 5], ["read", 4], ["shell", 2], ["web", 1], ["mcp", 1]],
  "docs-site": [["edit", 3], ["read", 3], ["search", 1]],
  "mobile-app": [["edit", 3], ["read", 4], ["shell", 2], ["agent", 1]],
  infra: [["shell", 6], ["read", 2], ["edit", 1]],
  "data-pipeline": [["read", 3], ["shell", 3], ["edit", 2], ["agent", 2]],
};
const FAIL_RATE = { infra: 0.6 };

/* rate: messages per minute at full tilt. idleMinutes: the lane last worked that long ago. */
const LANES = [
  { device: "dev_demo_studio", project: "atlas-api", branch: "main", tool: "claude-code", model: "claude-opus-5", rate: 7.5, fastEvery: 6, agents: 3, agentModel: "claude-haiku-4-5-20251001" },
  { device: "dev_demo_studio", project: "atlas-web", branch: "feat/checkout-flow", tool: "claude-code", model: "claude-fable-5-1", rate: 5.2, agents: 2, agentModel: "claude-sonnet-5" },
  { device: "dev_demo_studio", project: "docs-site", branch: "main", tool: "claude-code", model: "claude-sonnet-5", rate: 2.4, idleMinutes: 26 },
  { device: "dev_demo_laptop", label: "mobile-app", tool: "claude-code", model: "claude-opus-5", rate: 4.1, agents: 1, agentModel: "claude-haiku-4-5-20251001" },
  { device: "dev_demo_laptop", label: null, tool: "codex", model: "gpt-5.6-sol", rate: 2.8 },
  { device: "dev_demo_workstation", label: "infra", tool: "codex", model: "gpt-6-astra", rate: 5.6 },
  { device: "dev_demo_workstation", label: "data-pipeline", tool: "claude-code", model: "claude-sonnet-5", rate: 3.4, agents: 4, agentModel: "claude-haiku-4-5-20251001" },
  { device: "dev_demo_buildbox", label: "ci-agents", tool: "claude-code", model: "claude-haiku-4-5-20251001", rate: 6.0 },
  { device: "dev_demo_design", label: "design-system", tool: "claude-code", model: "claude-sonnet-5", rate: 2.2 },
];

/* Token profile per message, by model family: [fresh, output, cacheWrite, cacheRead] means. */
const PROFILE = {
  "claude-opus-5": [900, 1500, 9000, 118000],
  "claude-fable-5-1": [1100, 1900, 11000, 136000],
  "claude-sonnet-5": [700, 1200, 7000, 84000],
  "claude-haiku-4-5-20251001": [400, 700, 3000, 36000],
  "gpt-6-astra": [2600, 1600, 4000, 92000],
  "gpt-5.6-sol": [2100, 1300, 3000, 70000],
};

/** A small seeded generator, so the demo is the same shape every start. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How busy a working day is at a given local hour: people sleep, agents mostly do too. */
function dayShape(ms) {
  const d = new Date(ms);
  const hour = d.getHours() + d.getMinutes() / 60;
  const weekend = d.getDay() === 0 || d.getDay() === 6 ? 0.35 : 1;
  const work = Math.exp(-((hour - 13.5) ** 2) / 18);           // broad midday hump
  const evening = 0.35 * Math.exp(-((hour - 21) ** 2) / 3);     // a second, smaller one
  return weekend * Math.max(0.03, work + evening);
}

function poisson(mean, random) {
  if (mean <= 0) return 0;
  if (mean > 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * (random() * 2 - 1) * 1.7));
  const limit = Math.exp(-mean);
  let k = 0, p = 1;
  do { k += 1; p *= random(); } while (p > limit);
  return k - 1;
}

/**
 * Seeds the registry and store with a week of history, then keeps generating.
 * Returns the local-names provider (the demo's own machine names its lanes)
 * and a stop function.
 */
export function startDemo({ registry, store, fleet = null, activity = null, now = () => Date.now(), tickMs = 1000 }) {
  const random = rng(20260922);
  const start = now();
  let counter = 0;

  for (const d of DEMO_DEVICES) {
    registry.addSynthetic({
      id: d.id, label: d.label, person: d.person, local: Boolean(d.local),
      createdAt: new Date(start - d.joinedDaysAgo * 86_400_000).toISOString(),
    });
  }
  // One invitation still open, so the join flow has something to show.
  registry.invite({ person: "Contractor", machine: "Laptop", ttlMs: 22 * MINUTE, demo: true });

  const sessions = [];
  LANES.forEach((lane, i) => {
    const name = lane.project || lane.label || "unlabelled-" + i;
    const top = {
      lane, index: i,
      sessionHash: hash("session|" + i),
      projectHash: hash("project|" + name),
      parentSessionHash: null,
      isSubagent: false,
      model: lane.model,
      // every lane its own pace: a phase, a drift frequency and a burstiness
      phase: random() * Math.PI * 2,
      freq: 0.004 + random() * 0.012,
      burst: 0.03 + random() * 0.05,
      spike: 0,
    };
    sessions.push(top);
    for (let a = 0; a < (lane.agents || 0); a += 1) {
      sessions.push({
        ...top,
        sessionHash: hash("session|" + i + "|agent|" + a),
        parentSessionHash: top.sessionHash,
        isSubagent: true,
        model: lane.agentModel,
        phase: random() * Math.PI * 2,
        freq: 0.01 + random() * 0.02,
        agentShare: 0.35 / (lane.agents || 1),
      });
    }
  });

  const names = {
    project(projectHash) {
      const s = sessions.find((x) => x.projectHash === projectHash && x.lane.project);
      return s ? s.lane.project : null;
    },
    // A synthetic folder, so the Projects view can show a parent segment.
    path(projectHash) {
      const s = sessions.find((x) => x.projectHash === projectHash && x.lane.project);
      return s ? "/demo/work/" + s.lane.project : null;
    },
    branch(sessionHash) {
      const s = sessions.find((x) => x.sessionHash === sessionHash && !x.isSubagent);
      return s ? s.lane.branch || null : null;
    },
  };

  function makeRecord(session, minuteMs, scale) {
    const [f, o, w, r] = PROFILE[session.model] || [800, 1200, 6000, 80000];
    const jitter = () => 0.45 + random() * 1.1;
    const fresh = Math.round(f * jitter() * scale);
    const output = Math.round(o * jitter() * scale);
    const cacheRead = Math.round(r * jitter() * scale);
    const cacheWrite = Math.round(w * jitter() * scale * (random() < 0.3 ? 2.2 : 0.6));
    const claude = session.lane.tool === "claude-code";
    const oneHour = claude ? Math.round(cacheWrite * (random() < 0.5 ? 0 : 0.4)) : null;
    const lane = session.lane;
    const row = {
      id: hash("record|" + counter++),
      tool: lane.tool,
      model: session.model,
      sessionHash: session.sessionHash,
      parentSessionHash: session.parentSessionHash,
      isSubagent: session.isSubagent,
      projectHash: session.projectHash,
      engagement: lane.project ? null : lane.label || null,
      reportingDevice: lane.device,
      executionOrigin: "unknown",
      at: new Date(Math.floor(minuteMs / MINUTE) * MINUTE).toISOString(),
      fresh, output, cacheWrite,
      cacheWrite5m: claude ? cacheWrite - oneHour : null,
      cacheWrite1h: claude ? oneHour : null,
      ttl: claude ? "split" : "unknown",
      cacheRead,
      // Some of one lane's responses ran in fast mode, priced at its own rates.
      tier: claude ? (lane.fastEvery && !session.isSubagent && counter % lane.fastEvery === 0 ? "fast" : "standard") : null,
      observed: true,
      continuation: false,
    };
    row.measurement = eventMeasurement(row);
    return row;
  }

  const silentAt = (session) => {
    const device = DEMO_DEVICES.find((d) => d.id === session.lane.device);
    return device.silentMinutes ? start - device.silentMinutes * MINUTE : null;
  };
  const idleAt = (session) => (session.lane.idleMinutes ? start - session.lane.idleMinutes * MINUTE : null);

  /** Messages this session sends in one minute at time t, before noise. */
  function intensity(session, t) {
    const wave = 0.62 + 0.28 * Math.sin(t / MINUTE * session.freq * 6 + session.phase)
      + 0.14 * Math.sin(t / MINUTE * session.freq * 17 + session.phase * 1.7);
    return session.lane.rate * (session.agentShare || 1) * Math.max(0.05, wave);
  }

  // --- a week of history: per-message for the last day, per-minute before ---
  const byDevice = new Map();
  const push = (row) => {
    let list = byDevice.get(row.reportingDevice);
    if (!list) { list = []; byDevice.set(row.reportingDevice, list); }
    list.push(row);
  };
  const weekAgo = start - 7 * 86_400_000;
  for (const session of sessions) {
    const stopAt = Math.min(silentAt(session) ?? Infinity, idleAt(session) ?? Infinity, start);
    for (let t = Math.floor(weekAgo / MINUTE) * MINUTE; t < stopAt; t += MINUTE) {
      const mean = intensity(session, t) * dayShape(t);
      if (start - t > 86_400_000) {
        // Older than a day: one record per minute carrying the minute's tokens.
        const count = poisson(mean, random);
        if (count > 0) push(makeRecord(session, t, count));
      } else {
        const count = poisson(mean, random);
        for (let k = 0; k < count; k += 1) push(makeRecord(session, t, 1));
      }
    }
  }
  // A synthetic burn spike on the workstation's infra lane eleven minutes
  // before the start, so the spike alert below measures as "× normal".
  const spikeLane = sessions.find((s) => s.lane.label === "infra" && !s.isSubagent);
  const spikeAt = Math.floor((start - 11 * MINUTE) / MINUTE) * MINUTE;
  for (let k = 0; k < 3; k += 1) push(makeRecord(spikeLane, spikeAt - k * MINUTE, 7));
  // A visible synthetic cache break and heavy context in an existing lane.
  const contextLane = sessions.find((s) => s.lane.project === "docs-site" && !s.isSubagent);
  // Keep this inside the lane's existing activity span so the example does
  // not change its idle time or its position among the other demo lanes.
  const breakRow = makeRecord(contextLane, start - 35 * MINUTE, 1);
  Object.assign(breakRow, { fresh: 1_000, cacheRead: 0, cacheWrite: 189_000,
    cacheWrite5m: 189_000, cacheWrite1h: 0 });
  breakRow.measurement = eventMeasurement(breakRow);
  push(breakRow);
  for (const [deviceId, rows] of byDevice) {
    for (let i = 0; i < rows.length; i += 500) store.ingest(deviceId, rows.slice(i, i + 500));
  }
  // --- days 8 to 29: the daily rollup only, as a hub keeps them after their
  // minute detail is pruned, so the 30-day view has a month to show.
  for (let d = 8; d < 30; d += 1) {
    for (const session of sessions) {
      // Nothing from before a machine joined.
      if (d >= DEMO_DEVICES.find((x) => x.id === session.lane.device).joinedDaysAgo) continue;
      for (let h = 0; h < 24; h += 1) {
        const t = start - d * 86_400_000 - h * 3_600_000;
        const count = poisson(intensity(session, t) * dayShape(t) * 60, random);
        if (count > 0) store.seedDaily(session.lane.device, makeRecord(session, t, count));
      }
    }
  }
  store.dailySince = new Date(start - 29 * 86_400_000).toISOString().slice(0, 10);
  for (const d of DEMO_DEVICES) {
    const last = d.silentMinutes ? start - d.silentMinutes * MINUTE : start;
    // The build box's collector reports lines it could not count (synthetic);
    // the design laptop's older reporter says nothing about coverage at all.
    registry.touch(d.id, { at: last, freshness: { mode: "live", lastObservedAt: new Date(last).toISOString(), lastSyncedAt: null },
      ...(d.oldReporter ? {} : { coverage: d.id === "dev_demo_buildbox" ? { sidechainWithoutAgent: 2, unreadableLine: 1 } : {} }) });
    if (!d.local) {
      const said = (on) => (d.oldReporter ? "undeclared" : on ? "on" : "off");
      fleet?.markDemo(d.id, { alerts: said(d.shares.alerts), activity: said(d.shares.activity) }, start - 86_400_000);
    }
  }
  // The synthetic console has been running for a day, so its readings cover the windows shown.
  fleet?.markDemoStart(start - 86_400_000);

  // --- tool activity: counts by kind, as a machine sharing them sends ---------
  const bookOf = (session) => {
    const device = DEMO_DEVICES.find((d) => d.id === session.lane.device);
    return device.local ? activity : device.shares.activity ? fleet?.bookFor(device.id) : null;
  };
  function toolCalls(session, t, count) {
    const book = bookOf(session);
    const mix = TOOL_MIX[session.lane.project || session.lane.label] || [["read", 3], ["edit", 2], ["shell", 2]];
    if (!book || !mix) return;
    const local = DEMO_DEVICES.find((d) => d.id === session.lane.device).local;
    // A joined machine sends minutes; only this machine's own reading has seconds.
    const at = local ? t : Math.floor(t / MINUTE) * MINUTE;
    const total = mix.reduce((a, [, w]) => a + w, 0);
    for (let k = 0; k < count; k += 1) {
      let r = random() * total, kind = mix[0][0];
      for (const [name, w] of mix) { if ((r -= w) <= 0) { kind = name; break; } }
      book.note(session.sessionHash, at, { kind });
      const failed = random() < (FAIL_RATE[session.lane.project || session.lane.label] ?? 0.04) && kind === "shell";
      book.note(session.sessionHash, at, failed ? { error: 1 } : { ok: 1 });
    }
  }
  for (const session of sessions) {
    if (silentAt(session) !== null || idleAt(session) !== null) continue;
    for (let t = start - 14 * MINUTE; t < start; t += 20_000) toolCalls(session, t, poisson(intensity(session, t) / 3, random));
  }

  /* The demo's alerts, tied to its own lanes: a loop happening now, the
     workstation's spike (measured against the burst above), a stall three
     hours ago, and a loop replayed from the laptop's first read yesterday. */
  const top = (pick) => sessions.find((s) => !s.isSubagent && pick(s.lane));
  const alertOf = (kind, session, at, count, { historical = false, seenAt = at } = {}) => ({
    id: hash("alert|" + kind + "|" + session.index), kind, at, seenAt, historical, sessionHash: session.sessionHash,
    laneHash: session.sessionHash, projectHash: session.projectHash, deviceId: session.lane.device, count, tokens: count,
  });
  function alerts(t = now()) {
    return [
      alertOf("loop", top((l) => l.project === "atlas-web"), t - 4 * MINUTE, 5),
      alertOf("spike", spikeLane, spikeAt, 440_000, { historical: t - spikeAt > 60 * MINUTE }),
      alertOf("stall", top((l) => l.label === "data-pipeline"), start - 3 * 60 * MINUTE, 650_000, { historical: true }),
      alertOf("loop", top((l) => l.label === "mobile-app"), start - 20 * 60 * MINUTE, 10, { historical: true, seenAt: start - 60_000 }),
    ].sort((a, b) => b.at - a.at);
  }

  // --- then keep going, one second at a time, each lane at its own tempo ----
  const timer = setInterval(() => {
    const t = now();
    const fresh = new Map();
    for (const session of sessions) {
      if (silentAt(session) !== null || idleAt(session) !== null) continue;
      toolCalls(session, t, poisson(intensity(session, t) / 180, random));
      // a burst decays; a new one arrives at this lane's own odds
      if (session.spike > 0.01) session.spike *= 0.9;
      else if (random() < session.burst / 6) session.spike = 0.6 + random() * 1.4;
      const perSecond = (intensity(session, t) * (1 + session.spike) * Math.max(0.55, dayShape(t))) / 60;
      const count = poisson(perSecond, random);
      for (let k = 0; k < count; k += 1) {
        const row = makeRecord(session, t, 1);
        let list = fresh.get(row.reportingDevice);
        if (!list) { list = []; fresh.set(row.reportingDevice, list); }
        list.push(row);
      }
    }
    for (const [deviceId, rows] of fresh) store.ingest(deviceId, rows);
    for (const d of DEMO_DEVICES) {
      if (d.silentMinutes) continue;
      registry.touch(d.id, { at: t, freshness: { mode: "live", lastObservedAt: new Date(t).toISOString(), lastSyncedAt: null } });
    }
  }, tickMs);
  timer.unref?.();

  return { names, alerts, stop: () => clearInterval(timer) };
}
