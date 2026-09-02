/**
 * The muster ledger — declarations, not scraping.
 *
 * The fleet panel reads GitHub issue comments and infers who is doing what from
 * the shape of a header line. That works, but it is archaeology: it recovers an
 * intention from prose somebody typed. The `muster` CLI keeps the same fleet
 * state as an append-only ledger on an orphan git branch — a roster of sessions
 * and a board of work packages, each with an explicit owner and status. Reading
 * that is reading a declaration.
 *
 * Two ways in, tried in order, so the panel works on a machine that has the
 * ledger but not the CLI:
 *
 *   1. `muster status --json` — the supported interface, and the one that
 *      applies the CLI's own staleness and holding rules.
 *   2. `git show muster:sessions.jsonl` and `packages.jsonl` — the ledger
 *      itself. Every muster command is a line in these files, so folding them
 *      newest-wins per id reproduces the roster without the binary.
 *
 * Absent gracefully otherwise: `available: false` with a reason, never an error
 * and never a stale claim presented as fresh. Same stale-while-revalidate
 * discipline as lib/fleet.js — a snapshot build never waits on a subprocess.
 *
 * Ledger text is written by other sessions. It is masked and clipped on the way
 * in, like every other foreign string in this program.
 */

import { execFile } from "node:child_process";
import { redactAndClip } from "./redact.js";

export const MUSTER_TTL_MS = 60_000;
const LINE_MAX = 160;
const MAX_PACKAGES = 40;
const MAX_SESSIONS = 40;

function defaultRunner(cmd, args, options) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: (options && options.cwd) || undefined,
        timeout: (options && options.timeoutMs) || 10_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1" },
      },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        }),
    );
  });
}

export function createMusterStore(options) {
  return {
    ttlMs: (options && options.ttlMs) || MUSTER_TTL_MS,
    runner: (options && options.runner) || defaultRunner,
    at: 0,
    data: null,
    inFlight: null,
    refreshCount: 0,
  };
}

function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return redactAndClip(trimmed, max || LINE_MAX);
}

function parseAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Shape one roster entry. `stale` is the CLI's own verdict where it gave one —
 * this module does not re-derive a staleness rule the CLI already owns and
 * would only disagree with.
 */
export function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = clip(raw.name, 80);
  if (!name) return null;
  return {
    name,
    role: clip(raw.role, 32) || "worker",
    machine: clip(raw.machine, 80) || "unknown",
    vendor: clip(raw.vendor, 40) || "unknown",
    model: clip(raw.model, 60) || null,
    status: clip(raw.status, 32) || "unknown",
    branch: clip(raw.currentBranch, 120) || null,
    package: clip(raw.currentPackage, 80) || null,
    holding: Array.isArray(raw.holding)
      ? raw.holding
          .map((h) => clip(h, 80))
          .filter(Boolean)
          .slice(0, 8)
      : [],
    note: clip(raw.note, LINE_MAX),
    runway: clip(raw.runway, 24),
    protocolVersion: clip(raw.protocolVersion, 32),
    protocolMismatch: !!raw.protocolMismatch,
    clockIssue: clip(raw.clockIssue, 80),
    at: parseAt(raw.lastEventAt || raw.at || raw.joinedAt),
    joinedAt: parseAt(raw.joinedAt),
    stale: !!raw.stale,
  };
}

export function normalizePackage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = clip(raw.id, 80);
  if (!id) return null;
  return {
    id,
    title: clip(raw.title, LINE_MAX) || id,
    status: clip(raw.status, 32) || "unknown",
    owner: clip(raw.owner, 80) || null,
    dispatchedTo: clip(raw.dispatchedTo, 80) || null,
    dependsOn: Array.isArray(raw.dependsOn)
      ? raw.dependsOn
          .map((d) => clip(d, 80))
          .filter(Boolean)
          .slice(0, 8)
      : [],
    // The write fence is the whole point of a package board: it is the reason
    // two sessions do not land on the same file. It is shown, not summarized.
    writes: Array.isArray(raw.writes)
      ? raw.writes
          .map((w) => clip(w, 120))
          .filter(Boolean)
          .slice(0, 12)
      : [],
    blockedByIds: Array.isArray(raw.blockedByIds)
      ? raw.blockedByIds.map((d) => clip(d, 80)).filter(Boolean).slice(0, 8)
      : [],
    // Tri-state on purpose. The CLI computes readiness; the raw-ledger
    // fallback below cannot, and coercing its silence to `false` printed
    // "not ready" for packages that were ready — an unknown rendered as a
    // finding, which is the one thing this program refuses everywhere else.
    ready: typeof raw.ready === "boolean" ? raw.ready : null,
    leaseExpired: !!raw.leaseExpired,
    assignmentExpired: !!raw.assignmentExpired,
    branch: clip(raw.branch, 120),
    headSha: clip(raw.headSha, 64),
    at: parseAt(raw.updatedAt || raw.at || raw.createdAt),
  };
}

/** Fold the CLI's `status --json` into the panel's shape. */
export function assembleMuster(status, now) {
  const s = (status && status.status) || status || {};
  const sessions = (s.roster || [])
    .map(normalizeSession)
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_SESSIONS);
  const packages = (s.packages && s.packages.all ? s.packages.all : [])
    .map(normalizePackage)
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_PACKAGES);

  const counts = {
    open: 0,
    assigned: 0,
    inProgress: 0,
    completed: 0,
    released: 0,
    done: 0,
    other: 0,
  };
  for (const p of packages) {
    if (p.status === "open") counts.open += 1;
    else if (p.status === "assigned") counts.assigned += 1;
    else if (p.status === "in-progress" || p.status === "inProgress")
      counts.inProgress += 1;
    else if (p.status === "completed" || p.status === "done") {
      counts.completed += 1;
      counts.done += 1;
    } else if (p.status === "released") counts.released += 1;
    else counts.other += 1;
  }

  const active = sessions.filter((x) => x.status === "active");
  const machines = Array.from(new Set(sessions.map((x) => x.machine))).sort();

  return {
    available: true,
    enabled: true,
    at: now,
    source: s.__source || "muster status --json",
    sourceState: clip(s.source && s.source.state, 40),
    sourceReason: clip(s.source && s.source.reason, 80),
    sourceHeadSha: clip(s.source && s.source.headSha, 64),
    remoteConfirmed: !!(s.source && s.source.remoteConfirmed),
    localOnly: !!(s.source && s.source.localOnly),
    protocolVersion: clip(s.protocolVersion, 32) || null,
    generatedAt: parseAt(s.generatedAt) || now,
    sessions,
    packages,
    counts,
    sessionCount: sessions.length,
    activeCount: active.length,
    machines,
    // A claim is a package with an owner: that is the authoritative answer to
    // "who owns what right now", and it does not depend on anyone remembering
    // to write a comment.
    claims: packages
      .filter((p) => p.owner || p.dispatchedTo)
      .map((p) => ({
        id: p.id,
        title: p.title,
        owner: p.owner || p.dispatchedTo,
        status: p.status,
        at: p.at,
      })),
    flagged: (((s.messages || {}).flagged) || [])
      .slice(0, 20)
      .map((message) => ({
        kind: clip(message.kind, 24) || "flagged",
        from: clip(message.from, 80) || "unknown",
        to: clip(message.to, 80) || "all",
        body: clip(message.body, LINE_MAX) || "",
        at: parseAt(message.at),
      })),
    note: "declared by each session through the muster CLI, read from the ledger branch · cached 60s",
  };
}

/**
 * Fold raw ledger JSONL into the same shape the CLI would report.
 *
 * The ledger is append-only, so the newest line per identity wins. This is the
 * fallback path and it is deliberately conservative: it does not attempt the
 * CLI's staleness or readiness rules, and every session it produces is marked
 * `stale: false` because it has no basis to claim otherwise.
 */
export function assembleFromLedger(sessionsJsonl, packagesJsonl, now) {
  const fold = (text) => {
    const byId = new Map();
    for (const line of String(text || "").split("\n")) {
      if (!line.trim()) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const key = d && (d.name || d.id);
      if (!key) continue;
      const prior = byId.get(key) || {};
      byId.set(key, { ...prior, ...d });
    }
    return Array.from(byId.values());
  };
  const roster = fold(sessionsJsonl).map((d) => ({
    ...d,
    lastEventAt: d.at,
    status: d.type === "stand-down" ? "stood-down" : d.status || "active",
  }));
  const all = fold(packagesJsonl);
  return assembleMuster(
    {
      status: {
        __source: "muster ledger branch (CLI not on PATH)",
        roster,
        packages: { all },
      },
    },
    now,
  );
}

async function collect(store, options) {
  const now = options.now;
  const cwd = options.repoDir;
  /* The supported interface is the CLI, and the console is launched BY it, so
     its exact entry point is known rather than guessed. Resolving `muster` on
     PATH instead meant that on any machine where the CLI is not installed
     globally — a source checkout, an npx run, a linked worktree — every ledger
     read silently degraded to the JSONL fallback below, which cannot apply the
     CLI's staleness, readiness, or lease rules. That degradation was invisible:
     the panel still said "available". */
  const cli = options.binPath
    ? await store.runner(
        options.node || process.execPath,
        [options.binPath, "status", "--json"],
        { cwd, timeoutMs: 10_000 },
      )
    : await store.runner(options.bin || "muster", ["status", "--json"], {
        cwd,
        timeoutMs: 10_000,
      });
  if (cli.ok) {
    try {
      const parsed = JSON.parse(cli.stdout);
      if (parsed && parsed.ok !== false) return assembleMuster(parsed, now);
    } catch {
      /* fall through to the ledger */
    }
  }
  const branch = options.branch || "muster";
  const [sessions, packages] = await Promise.all([
    store.runner("git", ["-C", cwd, "show", branch + ":sessions.jsonl"], {
      timeoutMs: 8000,
    }),
    store.runner("git", ["-C", cwd, "show", branch + ":packages.jsonl"], {
      timeoutMs: 8000,
    }),
  ]);
  if (!sessions.ok && !packages.ok) {
    return {
      available: false,
      enabled: true,
      at: now,
      reason:
        "no muster ledger here — run `muster init` in this repository, or install the CLI: " +
        redactAndClip(
          (cli.stderr || sessions.stderr || "not found").trim(),
          120,
        ),
    };
  }
  return assembleFromLedger(sessions.stdout, packages.stdout, now);
}

/** Stale-while-revalidate. A snapshot build never waits on the CLI. */
export function refreshMuster(store, options) {
  if (options.enabled === false) {
    return { enabled: false, available: false, reason: "disabled" };
  }
  const now = options.now;
  if (!store.inFlight && now - store.at >= store.ttlMs) {
    store.refreshCount += 1;
    store.inFlight = collect(store, options)
      .catch((error) => ({
        available: false,
        enabled: true,
        at: now,
        reason: String((error && error.message) || error),
      }))
      .then((data) => {
        store.data = data;
        store.at = Date.now();
        store.inFlight = null;
        return data;
      });
  }
  if (store.data) return { ...store.data, stale: now - store.at > store.ttlMs };
  return {
    enabled: true,
    available: false,
    loading: true,
    reason: "first muster read in progress",
  };
}
