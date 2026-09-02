/**
 * Fleet visibility — one place to look instead of asking every agent.
 *
 * Reads, via the `gh` CLI, three things about the fleet's shared GitHub state:
 *
 *  - the coordination ledger (an issue whose comments the sessions write),
 *    for each session's newest self-declared header line — "who is doing what",
 *  - the open PRs with their check status,
 *  - the latest rulings and handoffs (ledger comment first-lines).
 *
 * Every call is READ-ONLY (GET endpoints and `gh pr list`), cached with a
 * 2-minute TTL, and refreshed in the background so a snapshot never waits on
 * the network. When gh, the network, or the repository is unavailable the
 * panel is gracefully absent — `available: false` with a reason, never an
 * error and never a stale claim presented as fresh.
 *
 * This is the one part of the dashboard that leaves the machine, and it is
 * off with `--no-github` / FLEET_NO_GITHUB=1, which restores the strict
 * no-outbound-request posture everywhere else in this program.
 *
 * Ledger text is other people's command output. It is clipped with
 * redactAndClip — mask first, cut second — before it is stored, and the whole
 * payload passes through redactDeep at serialization like everything else.
 */

import { execFile } from "node:child_process";
import { redactAndClip } from "./redact.js";

export const FLEET_TTL_MS = 2 * 60_000;
const COMMENT_WINDOW_MS = 48 * 3600 * 1000;
/**
 * Ceiling on ledger comments held in memory, newest first.
 *
 * The read is paginated, so a very loud 48 hours could otherwise stream an
 * unbounded number of comments into a panel that shows five of them. Anything
 * beyond this is dropped from the OLD end and the count of what was dropped is
 * published, so a truncated window says so rather than looking complete.
 */
const COMMENT_MAX = 400;
const LINE_MAX = 200;

function defaultRunner(cmd, args, options) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: (options && options.timeoutMs) || 15_000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
        },
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

export function createFleetStore(options) {
  return {
    ttlMs: (options && options.ttlMs) || FLEET_TTL_MS,
    runner: (options && options.runner) || defaultRunner,
    at: 0,
    data: null,
    inFlight: null,
    refreshCount: 0,
  };
}

/** owner/repo out of a git remote URL, or null. */
export function slugOfRemote(url) {
  const m = /github\.com[:/]([^/\s]+\/[^/\s.]+)(?:\.git)?/u.exec(
    String(url || ""),
  );
  return m ? m[1] : null;
}

/**
 * First non-empty line of a ledger comment, stripped of markdown dressing.
 * Masked before it is clipped — the clip must never cut the anchor a redaction
 * rule needs (see lib/redact.js).
 */
export function firstLineOf(body) {
  for (const raw of String(body || "").split("\n")) {
    const line = raw
      .replace(/^[#>\s]+/u, "")
      .replace(/\*\*/gu, "")
      .replace(/__/gu, "")
      .trim();
    if (line) return redactAndClip(line, LINE_MAX);
  }
  return null;
}

/**
 * The session identity a header line self-declares, or null.
 *
 * The observed convention on the ledger: a machine word (MAC STUDIO, LAPTOP,
 * MAC LAPTOP…) optionally followed by a vendor word (CLAUDE, CODEX, GPT…),
 * followed by a separator and free text. "LAPTOP DB WINDOW ACQUIRED" declares
 * LAPTOP; "MAC STUDIO CODEX CLAIM — #110" declares MAC STUDIO CODEX.
 */
export function identityOf(line) {
  if (!line) return null;
  const m =
    /^((?:MAC\s+)?(?:STUDIO|LAPTOP|MACBOOK|MINI)(?:\s+(?:CLAUDE|CODEX|GPT[\w.-]*|GEMINI))?|ORCHESTRATOR|HOST)\b[\s:·—–-]*(.*)$/u.exec(
      line,
    );
  if (!m) return null;
  return {
    identity: m[1].replace(/\s+/gu, " ").trim(),
    doing: m[2] ? m[2].trim() : "",
  };
}

/** Summarize a gh statusCheckRollup array into pass/fail/pending counts. */
export function summarizeChecks(rollup) {
  const out = { pass: 0, fail: 0, pending: 0 };
  for (const c of rollup || []) {
    const state = String(
      c.conclusion || c.state || c.status || "",
    ).toUpperCase();
    if (state === "SUCCESS" || state === "NEUTRAL" || state === "SKIPPED") {
      out.pass += 1;
    } else if (
      state === "FAILURE" ||
      state === "ERROR" ||
      state === "CANCELLED" ||
      state === "TIMED_OUT" ||
      state === "ACTION_REQUIRED" ||
      state === "STARTUP_FAILURE"
    ) {
      out.fail += 1;
    } else {
      out.pending += 1;
    }
  }
  return out;
}

/**
 * Assemble the panel from raw comment and PR JSON. Pure, so the parsing has
 * tests that need no network and no gh.
 */
export function assembleFleet(input) {
  const now = input.now;
  const all = (input.comments || [])
    .map((c) => ({
      at: Date.parse(c.created_at) || 0,
      first: firstLineOf(c.body),
    }))
    .filter((c) => c.first)
    .sort((a, b) => a.at - b.at);
  // Paginating the read means the ledger is no longer capped by the API page
  // size, so the cap has to live here instead — and it keeps the NEWEST, which
  // is the opposite end from the one a single page gave us.
  const dropped = Math.max(0, all.length - COMMENT_MAX);
  const comments = dropped ? all.slice(-COMMENT_MAX) : all;

  // Newest self-declared header per identity is that session's current word on
  // what it is doing. Older declarations are superseded, not listed.
  const assignments = new Map();
  for (const c of comments) {
    const id = identityOf(c.first);
    if (!id) continue;
    assignments.set(id.identity, {
      identity: id.identity,
      doing: id.doing || c.first,
      at: c.at,
    });
  }

  const rulings = comments
    .filter((c) => /\b(RULING|HANDOFF)\b/iu.test(c.first))
    .slice(-5)
    .reverse()
    .map((c) => ({ at: c.at, text: c.first }));

  const recent = comments
    .slice(-5)
    .reverse()
    .map((c) => ({ at: c.at, text: c.first }));

  const claims = comments
    .filter((c) => /\bCLAIM(?:ED)?\b/iu.test(c.first))
    .slice(-6)
    .reverse()
    .map((c) => ({ at: c.at, text: c.first }));

  const prs = (input.prs || []).map((p) => ({
    number: p.number,
    title: redactAndClip(String(p.title || ""), 120),
    branch: redactAndClip(String(p.headRefName || ""), 80),
    draft: !!p.isDraft,
    updatedAt: Date.parse(p.updatedAt) || null,
    checks: summarizeChecks(p.statusCheckRollup),
  }));
  prs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return {
    available: true,
    enabled: true,
    at: now,
    repo: input.slug || null,
    issue: input.issue || null,
    assignments: Array.from(assignments.values()).sort((a, b) => b.at - a.at),
    rulings,
    recent,
    inFlight: claims,
    prs,
    commentCount: comments.length,
    commentsDropped: dropped,
    // The newest thing the ledger read actually saw. A panel that says when it
    // last heard anything cannot silently go quiet: the freeze that started
    // this was invisible precisely because nothing on screen carried this.
    latestCommentAt: comments.length ? comments[comments.length - 1].at : null,
    note:
      "read-only, from GitHub via gh · ledger headers are self-declared by each session · cached " +
      Math.round(FLEET_TTL_MS / 60_000) +
      " min",
  };
}

async function collect(store, options) {
  const now = options.now;
  const remote = await store.runner(
    "git",
    ["-C", options.repoDir, "remote", "get-url", "origin"],
    { timeoutMs: 5000 },
  );
  const slug = options.slug || (remote.ok ? slugOfRemote(remote.stdout) : null);
  if (!slug) {
    return {
      available: false,
      enabled: true,
      at: now,
      reason: "no GitHub remote could be resolved",
    };
  }
  const since = new Date(now - COMMENT_WINDOW_MS).toISOString();
  const [commentsRes, prsRes] = await Promise.all([
    store.runner(
      "gh",
      [
        "api",
        // --paginate, and it is load-bearing. GitHub returns issue comments
        // OLDEST FIRST, so a single un-paginated page of 100 is the oldest 100
        // comments in the window — on a ledger busier than that, every newer
        // comment is invisible. Measured on this repository: 100 comments in
        // the 48-hour window, the panel frozen at the 100th oldest, and both
        // the assignments AND the "recent" list (which parses nothing at all)
        // stuck at the same moment. That symmetry is what rules the parser out
        // as the cause: a regex bug cannot freeze a list that never calls it.
        "--paginate",
        "repos/" +
          slug +
          "/issues/" +
          options.issue +
          "/comments?since=" +
          since +
          "&per_page=100",
      ],
      { timeoutMs: 20_000 },
    ),
    store.runner(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        slug,
        "--state",
        "open",
        "--json",
        "number,title,isDraft,headRefName,updatedAt,statusCheckRollup",
        "--limit",
        "30",
      ],
      { timeoutMs: 20_000 },
    ),
  ]);
  if (!commentsRes.ok && !prsRes.ok) {
    return {
      available: false,
      enabled: true,
      at: now,
      reason:
        "gh unavailable or offline: " +
        redactAndClip(
          (commentsRes.stderr || prsRes.stderr || "no output").trim(),
          120,
        ),
    };
  }
  let comments = [];
  let prs = [];
  try {
    if (commentsRes.ok) comments = JSON.parse(commentsRes.stdout || "[]");
  } catch {
    comments = [];
  }
  try {
    if (prsRes.ok) prs = JSON.parse(prsRes.stdout || "[]");
  } catch {
    prs = [];
  }
  const data = assembleFleet({
    now,
    slug,
    issue: options.issue,
    comments,
    prs,
  });
  if (!commentsRes.ok) data.partial = "ledger comments unavailable";
  else if (!prsRes.ok) data.partial = "PR list unavailable";
  return data;
}

/**
 * Stale-while-revalidate. Returns immediately with the freshest data held;
 * when the TTL has lapsed a background refresh is started, and the NEXT
 * snapshot serves its result. A snapshot build never waits on GitHub.
 */
export function refreshFleet(store, options) {
  if (!options.enabled) {
    return {
      enabled: false,
      available: false,
      reason: "disabled (--no-github)",
    };
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
    reason: "first fleet refresh in progress",
  };
}
