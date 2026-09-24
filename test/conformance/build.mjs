#!/usr/bin/env node
/**
 * Builds the token-accounting conformance suite (docs/accounting.md §11).
 *
 *   node test/conformance/build.mjs          # rewrite logs/, manifest.json, expected.json, collector-records.json
 *   node test/conformance/build.mjs --check  # exit 1 if anything on disk differs from what this would write
 *
 * THE EXPECTED TOTALS ARE NOT COUNTED BY ANY COUNTER. Every token event below is
 * declared once, as ground truth — who, which machine, which session, which
 * model, when, and its exact usage by class — and then written out as the
 * transcript lines the tools really produce for it: streamed over several
 * lines, re-written, copied into a resumed file, synced to a second machine,
 * replayed into a forked Codex child, dated across a window edge. expected.json
 * is the sum of the declared events, so an implementation that passes has
 * recovered the truth from the mess, not agreed with another implementation.
 *
 * collector-records.json is different: it is what THIS package's collector
 * sends for each delivery, captured so a receiver in another repository can
 * pin the exact collector-shaped input and check its own accounting against
 * the same expected.json. test/conformance.test.js fails if the collector
 * drifts from it.
 *
 * Everything here is synthetic. The prompts, file names and branch names are
 * canaries: if one of them appears in any record, the privacy promise broke.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
export const SUITE_VERSION = "1.0.0";

// ---- the organisation, its window, its machines and people --------------------

const ORG_SALT = Buffer.alloc(32, 0x2a).toString("base64url");
const ORGANIZATION_ID = "org_conformance0001";
const W0 = "2026-09-20T00:00:00.000Z";
const W1 = "2026-09-21T00:00:00.000Z";
const HALF = "2026-09-20T12:00:00.000Z";
const TEAM = "Platform team";
const PERSON_A = "Person A";
const PERSON_B = "Person B";

const DEVICES = {
  "personA-studio": { id: "dev_personA-studio01", label: "Studio (person A)", person: PERSON_A },
  "personA-laptop": { id: "dev_personA-laptop01", label: "Laptop (person A)", person: PERSON_A },
  "sharedbox-userB": { id: "dev_sharedbox-userB1", label: "Shared build box, account B", person: PERSON_B },
  "sharedbox-build": { id: "dev_sharedbox-build1", label: "Shared build box, build account", person: null },
  "personA-studio-rejoined": { id: "dev_personA-studio02", label: "Studio (person A), joined again", person: PERSON_A },
};

// Deliveries run in this order. `state` names the collector state directory:
// a new name is a machine that lost its cursor (or joined again) and re-reads
// everything it can see.
const DELIVERIES = [
  { step: 1, device: "personA-studio", state: "studio", roots: ["personA-studio"], why: "first report from the studio" },
  { step: 2, device: "personA-laptop", state: "laptop", roots: ["personA-laptop"], why: "the laptop, which holds a synced copy of a studio session" },
  { step: 3, device: "personA-studio", state: "studio-cursor-lost", roots: ["personA-studio"], why: "the studio lost its cursor and re-reports everything" },
  { step: 4, device: "sharedbox-userB", state: "userB", roots: ["sharedbox-userB"], why: "person B's account on the shared build box" },
  { step: 5, device: "sharedbox-build", state: "build", roots: ["sharedbox-build"], why: "the shared build account, enrolled to nobody" },
  { step: 6, device: "personA-studio-rejoined", state: "studio-rejoined", roots: ["personA-studio", "personA-studio-later"], why: "the studio joined again under a new device id and re-reads its history, plus new work" },
  { step: 7, device: "personA-laptop", state: "laptop", roots: ["personA-laptop"], why: "the laptop reports again with its cursor intact: nothing new" },
];

// ---- ground truth: every token event, once ------------------------------------

const S = {
  S1: "c0000001-0000-4000-8000-000000000001",
  S2: "c0000002-0000-4000-8000-000000000002",
  S12: "c0000012-0000-4000-8000-000000000012",
  S4: "c0000004-0000-4000-8000-000000000004",
  S5: "c0000005-0000-4000-8000-000000000005",
  S6: "c0000006-0000-4000-8000-000000000006",
  S8: "c0000008-0000-4000-8000-000000000008",
  S9: "c0000009-0000-4000-8000-000000000009",
  X3: "d0000003-0000-4000-8000-000000000003",
  X33: "d0000033-0000-4000-8000-000000000033",
  X7: "d0000007-0000-4000-8000-000000000007",
};

/** Session labels as the spec names them: tool, session id, and agent id for a Claude subagent. */
const SESSIONS = {
  [`claude-code:${S.S1}`]: { parent: null, device: "personA-studio", rule: "orchestrator: streaming, a re-written line, an API error and its retry, compaction" },
  [`claude-code:${S.S1}:agent:a1`]: { parent: `claude-code:${S.S1}`, device: "personA-studio", rule: "subagent sidechain" },
  [`claude-code:${S.S1}:agent:a2`]: { parent: `claude-code:${S.S1}`, device: "personA-studio", rule: "subagent sidechain, one-hour cache writes" },
  [`claude-code:${S.S2}`]: { parent: null, device: "personA-studio", rule: "a session later resumed into a new file" },
  [`claude-code:${S.S12}`]: { parent: null, device: "personA-studio", rule: "the resumed conversation: copied history plus new work" },
  [`codex:${S.X3}`]: { parent: null, device: "personA-studio", rule: "cumulative counters: repeat, model switch, restart" },
  [`codex:${S.X33}`]: { parent: `codex:${S.X3}`, device: "personA-studio", rule: "forked child: inherited history replayed before its boundary" },
  [`claude-code:${S.S4}`]: { parent: null, device: "personA-laptop", rule: "second machine; a timestamp written with an offset" },
  [`claude-code:${S.S5}`]: { parent: null, device: "personA-laptop", rule: "window edges: before, straddling the start, exactly at the end" },
  [`claude-code:${S.S6}`]: { parent: null, device: "sharedbox-userB", rule: "unknown cache-write lifetime" },
  [`codex:${S.X7}`]: { parent: null, device: "sharedbox-userB", rule: "an event without an ordinal" },
  [`claude-code:${S.S8}`]: { parent: null, device: "sharedbox-build", rule: "shared account enrolled to nobody" },
  [`claude-code:${S.S9}`]: { parent: null, device: "personA-studio-rejoined", rule: "new work after joining again" },
};

// u(fresh, output, cacheRead, cacheWrite5m, cacheWrite1h, cacheWriteUnknownTtl)
const u = (fresh, output, cacheRead, w5 = 0, w1 = 0, wUnknown = 0) => ({ fresh, output, cacheRead, cacheWrite5m: w5, cacheWrite1h: w1, cacheWriteUnknownTtl: wUnknown });
const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5", FABLE = "claude-fable-5-1", HAIKU = "claude-haiku-4-5-20251001", SOL = "gpt-5.6-sol", GPT55 = "gpt-5.5";

/** Each event: its session, model, the instant its API response began, and its true usage. */
const EVENTS = [
  { id: "E01", session: `claude-code:${S.S1}`, model: OPUS, at: "2026-09-20T09:00:05.000Z", usage: u(12, 340, 0, 20000, 4000) },
  { id: "E02", session: `claude-code:${S.S1}`, model: OPUS, at: "2026-09-20T09:00:50.000Z", usage: u(3, 410, 24000, 500, 0), note: "streamed over three lines across a minute boundary" },
  { id: "E03", session: `claude-code:${S.S1}`, model: OPUS, at: "2026-09-20T09:02:10.000Z", usage: u(5, 90, 24500, 300, 0), note: "its line is written twice with the same uuid" },
  { id: "E04", session: `claude-code:${S.S1}`, model: OPUS, at: "2026-09-20T09:03:20.000Z", usage: u(4, 60, 24800, 200, 0), note: "the retry that succeeded after a synthetic API-error line" },
  { id: "E05", session: `claude-code:${S.S1}`, model: OPUS, at: "2026-09-20T09:10:30.000Z", usage: u(9, 800, 0, 6000, 2000), note: "first response after compaction" },
  { id: "E06", session: `claude-code:${S.S1}:agent:a1`, model: SONNET, at: "2026-09-20T09:05:00.000Z", usage: u(2, 150, 0, 3000, 0) },
  { id: "E07", session: `claude-code:${S.S1}:agent:a1`, model: SONNET, at: "2026-09-20T09:05:40.000Z", usage: u(1, 260, 3000, 100, 0), note: "streamed over two lines" },
  { id: "E08", session: `claude-code:${S.S1}:agent:a2`, model: OPUS, at: "2026-09-20T09:06:00.000Z", usage: u(6, 500, 0, 0, 7000) },
  { id: "E09", session: `claude-code:${S.S2}`, model: OPUS, at: "2026-09-20T11:00:00.000Z", usage: u(10, 200, 1000, 1500, 0) },
  { id: "E10", session: `claude-code:${S.S2}`, model: OPUS, at: "2026-09-20T11:01:00.000Z", usage: u(2, 150, 2500, 400, 0), note: "streamed over two lines; both copied into the resumed file" },
  { id: "E11", session: `claude-code:${S.S12}`, model: OPUS, at: "2026-09-20T13:00:00.000Z", usage: u(7, 330, 2900, 800, 0) },
  { id: "E12", session: `codex:${S.X3}`, model: SOL, at: "2026-09-20T14:00:20.000Z", usage: u(800, 50, 0, 0, 0, 200) },
  { id: "E13", session: `codex:${S.X3}`, model: SOL, at: "2026-09-20T14:02:00.000Z", usage: u(400, 80, 1000, 0, 0, 100), note: "after a repeated, unchanged cumulative total" },
  { id: "E14", session: `codex:${S.X3}`, model: GPT55, at: "2026-09-20T14:04:00.000Z", usage: u(100, 60, 700), note: "after turn_context switched the model" },
  { id: "E15", session: `codex:${S.X3}`, model: GPT55, at: "2026-09-20T14:30:00.000Z", usage: u(200, 40, 400), note: "the counter restarted from zero" },
  { id: "E16", session: `codex:${S.X3}`, model: GPT55, at: "2026-09-20T14:31:00.000Z", usage: u(300, 60, 500) },
  { id: "E17", session: `codex:${S.X33}`, model: SOL, at: "2026-09-20T14:10:20.000Z", usage: u(600, 70, 0, 0, 0, 300), note: "the child's first own request; its counter starts below the inherited one" },
  { id: "E18", session: `codex:${S.X33}`, model: SOL, at: "2026-09-20T14:11:00.000Z", usage: u(300, 80, 800, 0, 0, 100) },
  { id: "E19", session: `claude-code:${S.S4}`, model: FABLE, at: "2026-09-20T16:00:00.000Z", usage: u(20, 700, 0, 10000, 0), note: "timestamp written as 12:00 at -04:00" },
  { id: "E20", session: `claude-code:${S.S4}`, model: FABLE, at: "2026-09-20T16:02:00.000Z", usage: u(3, 90, 10000, 50, 0) },
  { id: "E21", session: `claude-code:${S.S5}`, model: OPUS, at: "2026-09-19T22:00:00.000Z", usage: u(4, 40, 0, 1000, 0), note: "before the window" },
  { id: "E22", session: `claude-code:${S.S5}`, model: OPUS, at: "2026-09-19T23:59:30.000Z", usage: u(5, 250, 1000, 200, 0), note: "begins before the window, its last line lands inside: wholly before" },
  { id: "E23", session: `claude-code:${S.S5}`, model: OPUS, at: "2026-09-21T00:00:00.000Z", usage: u(6, 60, 1200), note: "exactly at the window end: outside (half-open)" },
  { id: "E24", session: `claude-code:${S.S5}`, model: OPUS, at: "2026-09-20T03:30:00.000Z", usage: u(7, 77, 1300, 70, 0), note: "inside the UTC day, on the previous New York day" },
  { id: "E25", session: `claude-code:${S.S6}`, model: SONNET, at: "2026-09-20T18:00:00.000Z", usage: u(11, 210, 0, 0, 0, 900), note: "cache write reported without its lifetime split" },
  { id: "E26", session: `claude-code:${S.S6}`, model: SONNET, at: "2026-09-20T18:01:00.000Z", usage: u(2, 40, 900, 30, 0) },
  { id: "E27", session: `codex:${S.X7}`, model: SOL, at: "2026-09-20T18:30:00.000Z", usage: u(400, 20, 0, 0, 0, 100) },
  { id: "E28", session: `codex:${S.X7}`, model: SOL, at: "2026-09-20T18:31:00.000Z", usage: u(250, 40, 450), note: "token_count without an ordinal" },
  { id: "E29", session: `claude-code:${S.S8}`, model: HAIKU, at: "2026-09-20T20:00:00.000Z", usage: u(30, 400, 0, 2000, 0) },
  { id: "E30", session: `claude-code:${S.S8}`, model: HAIKU, at: "2026-09-20T20:00:40.000Z", usage: u(1, 20, 2000, 0, 0) },
  { id: "E31", session: `claude-code:${S.S9}`, model: OPUS, at: "2026-09-20T22:00:00.000Z", usage: u(8, 180, 0, 900, 100) },
];

// ---- transcript rendering -----------------------------------------------------

const CANARY = {
  prompt: "CANARY-PROMPT-conformance-5c1e",
  reply: "CANARY-REPLY-conformance-88d0",
  file: "canary_conformance_file.ts",
  project: "/work/canary-secret-project-dir",
  laptopProject: "/Users/persona/work/canary-secret-project-dir",
  branch: "canary-private-branch-conformance",
  summary: "CANARY-COMPACT-SUMMARY-conformance-7a2f",
};
export const CANARIES = Object.values(CANARY);

const byId = Object.fromEntries(EVENTS.map((e) => [e.id, e]));
const plus = (iso, seconds) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
let uuidCounter = 0;
const lineUuid = () => `aaaa${String(++uuidCounter).padStart(4, "0")}-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;

function claudeUsage(x, output = x.output) {
  const usage = { input_tokens: x.fresh, cache_creation_input_tokens: x.cacheWrite5m + x.cacheWrite1h + x.cacheWriteUnknownTtl,
    cache_read_input_tokens: x.cacheRead, output_tokens: output, service_tier: "standard" };
  if (x.cacheWriteUnknownTtl === 0) usage.cache_creation = { ephemeral_5m_input_tokens: x.cacheWrite5m, ephemeral_1h_input_tokens: x.cacheWrite1h };
  return usage;
}

function claudeBase(sessionId, cwd, { agentId = null } = {}) {
  return { isSidechain: agentId !== null, userType: "external", cwd, sessionId, version: "2.1.0", gitBranch: CANARY.branch, ...(agentId ? { agentId } : {}) };
}

function userLine(base, at, content) {
  return { parentUuid: null, ...base, type: "user", message: { role: "user", content }, uuid: lineUuid(), timestamp: at };
}

/**
 * The lines Claude Code writes for one API response: one per content block,
 * each carrying the response's usage as it stood when the block was written.
 * `outputs` is the output count on each line; the last is the final count.
 */
function assistantLines(base, event, { outputs = [event.usage.output], stepSeconds = 15, timestamp = null } = {}) {
  const blocks = ["thinking", "text", "tool_use"];
  const messageId = `msg_conf_${event.id.toLowerCase()}`;
  return outputs.map((output, index) => {
    const block = blocks[index % blocks.length];
    const content = block === "thinking" ? [{ type: "thinking", thinking: CANARY.reply, signature: "c2lnbmF0dXJl" }]
      : block === "text" ? [{ type: "text", text: CANARY.reply }]
      : [{ type: "tool_use", id: `toolu_conf_${event.id}_${index}`, name: "Edit", input: { file_path: path.join(base.cwd, "src", CANARY.file), new_string: CANARY.reply } }];
    return {
      parentUuid: null, ...base, type: "assistant", uuid: lineUuid(), requestId: `req_conf_${event.id.toLowerCase()}`,
      timestamp: index === 0 && timestamp ? timestamp : plus(event.at, index * stepSeconds),
      message: { id: messageId, type: "message", role: "assistant", model: event.model, content, stop_reason: index === outputs.length - 1 ? "tool_use" : null,
        usage: claudeUsage(event.usage, output) },
    };
  });
}

function syntheticErrorLine(base, at) {
  return { parentUuid: null, ...base, type: "assistant", uuid: lineUuid(), timestamp: at, isApiErrorMessage: true,
    message: { id: "msg_conf_synthetic_error", type: "message", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error: overloaded" }], stop_reason: "stop_sequence",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
}

const jsonl = (lines) => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

function codexTotals(cumulative) {
  const [input, cached, write, output] = cumulative;
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: Math.floor(output / 4), total_tokens: input + output };
}
function tokenCount(at, ordinal, cumulative, last) {
  return { timestamp: at, type: "event_msg", ...(ordinal === null ? {} : { ordinal }),
    payload: { type: "token_count", info: { total_token_usage: codexTotals(cumulative), last_token_usage: codexTotals(last), model_context_window: 400000 },
      rate_limits: { primary: { used_percent: 12.5, window_minutes: 300 } } } };
}
function codexMeta(at, id, model, extra = {}) {
  return { timestamp: at, type: "session_meta", payload: { id, timestamp: at, cwd: CANARY.project, originator: "codex_cli_rs", cli_version: "0.99.0",
    instructions: CANARY.prompt, model_provider: "openai", model, git: { branch: CANARY.branch, commit_hash: "0".repeat(40), repository_url: "git@example.invalid:canary-secret-project-dir.git" }, ...extra } };
}
const turnContext = (at, model) => ({ timestamp: at, type: "turn_context", payload: { cwd: CANARY.project, model, approval_policy: "on-request", sandbox_policy: { mode: "workspace-write" } } });
const codexReply = (at) => ({ timestamp: at, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: CANARY.reply }] } });

/** Codex cumulative vector [input incl. cached and writes, cached, write, output] for a Codex event. */
const cumulativeOf = (x) => [x.fresh + x.cacheRead + x.cacheWriteUnknownTtl, x.cacheRead, x.cacheWriteUnknownTtl, x.output];
const addVec = (a, b) => a.map((v, i) => v + b[i]);

function buildLogs() {
  const files = new Map();
  const put = (rel, text) => files.set(rel, text);
  const slug = (cwd) => cwd.replace(/[\\/]/g, "-");

  // --- studio: orchestrator S1 with two subagents -------------------------------
  const s1 = claudeBase(S.S1, CANARY.project);
  const e03 = assistantLines(s1, byId.E03);
  const s1Lines = [
    userLine(s1, "2026-09-20T09:00:00.000Z", CANARY.prompt),
    ...assistantLines(s1, byId.E01),
    userLine(s1, "2026-09-20T09:00:30.000Z", [{ type: "tool_result", tool_use_id: "toolu_conf_E01_0", content: CANARY.reply }]),
    ...assistantLines(s1, byId.E02, { outputs: [7, 120, 410], stepSeconds: 15 }),
    ...e03,
    e03[0], // the same line written again, uuid and all
    syntheticErrorLine(s1, "2026-09-20T09:03:00.000Z"),
    ...assistantLines(s1, byId.E04),
    { parentUuid: null, ...s1, type: "system", subtype: "compact_boundary", content: "Conversation compacted", uuid: lineUuid(), timestamp: "2026-09-20T09:10:00.000Z", compactMetadata: { trigger: "auto", preTokens: 25000 } },
    { parentUuid: null, ...s1, type: "user", isCompactSummary: true, message: { role: "user", content: CANARY.summary }, uuid: lineUuid(), timestamp: "2026-09-20T09:10:01.000Z" },
    ...assistantLines(s1, byId.E05),
  ];
  const studioProject = `personA-studio/claude/projects/${slug(CANARY.project)}`;
  put(`${studioProject}/${S.S1}.jsonl`, jsonl(s1Lines));
  const a1 = claudeBase(S.S1, CANARY.project, { agentId: "a1" });
  put(`${studioProject}/${S.S1}/subagents/agent-a1.jsonl`, jsonl([
    userLine(a1, "2026-09-20T09:04:55.000Z", CANARY.prompt),
    ...assistantLines(a1, byId.E06),
    ...assistantLines(a1, byId.E07, { outputs: [30, 260], stepSeconds: 10 }),
  ]));
  const a2 = claudeBase(S.S1, CANARY.project, { agentId: "a2" });
  put(`${studioProject}/${S.S1}/subagents/agent-a2.jsonl`, jsonl([userLine(a2, "2026-09-20T09:05:55.000Z", CANARY.prompt), ...assistantLines(a2, byId.E08)]));

  // --- studio: S2, then resumed into a new file that copies its history ----------
  const s2 = claudeBase(S.S2, CANARY.project);
  const s2Lines = [userLine(s2, "2026-09-20T10:59:50.000Z", CANARY.prompt), ...assistantLines(s2, byId.E09), ...assistantLines(s2, byId.E10, { outputs: [50, 150], stepSeconds: 20 })];
  put(`${studioProject}/${S.S2}.jsonl`, jsonl(s2Lines));
  const s12 = claudeBase(S.S12, CANARY.project);
  put(`${studioProject}/${S.S12}.jsonl`, jsonl([...s2Lines, userLine(s12, "2026-09-20T12:59:50.000Z", CANARY.prompt), ...assistantLines(s12, byId.E11)]));

  // --- studio: Codex thread X3 and its forked child X33 ------------------------------
  // X3 cumulative: E12, repeat, E13, model switch, E14, restart (E15), E16.
  const c12 = cumulativeOf(byId.E12.usage);
  const c13 = addVec(c12, cumulativeOf(byId.E13.usage));
  const c14 = addVec(c13, cumulativeOf(byId.E14.usage));
  const c15 = cumulativeOf(byId.E15.usage); // restarted from zero
  const c16 = addVec(c15, cumulativeOf(byId.E16.usage));
  const x3Lines = [
    codexMeta("2026-09-20T14:00:00.000Z", S.X3, SOL, { source: "cli" }),
    turnContext("2026-09-20T14:00:01.000Z", SOL),
    codexReply("2026-09-20T14:00:19.000Z"),
    tokenCount(byId.E12.at, 1, c12, c12),
    tokenCount("2026-09-20T14:01:00.000Z", 2, c12, c12), // unchanged cumulative: no event
    tokenCount(byId.E13.at, 3, c13, cumulativeOf(byId.E13.usage)),
    turnContext("2026-09-20T14:03:00.000Z", GPT55),
    tokenCount(byId.E14.at, 4, c14, cumulativeOf(byId.E14.usage)),
    tokenCount(byId.E15.at, 5, c15, c15),
    tokenCount(byId.E16.at, 6, c16, cumulativeOf(byId.E16.usage)),
  ];
  put(`personA-studio/codex/sessions/2026/09/20/rollout-2026-09-20T14-00-00-${S.X3}.jsonl`, jsonl(x3Lines));
  // The child replays the parent's history (ordinals 1 and 3, re-dated at fork
  // time) before subagent_history_start_ordinal, then counts from zero.
  const c17 = cumulativeOf(byId.E17.usage);
  const c18 = addVec(c17, cumulativeOf(byId.E18.usage));
  put(`personA-studio/codex/sessions/2026/09/20/rollout-2026-09-20T14-10-00-${S.X33}.jsonl`, jsonl([
    codexMeta("2026-09-20T14:10:00.000Z", S.X33, SOL, { forked_from_id: S.X3, subagent_history_start_ordinal: 4,
      source: { subagent: { thread_spawn: { parent_thread_id: S.X3, depth: 1 } } } }),
    codexMeta("2026-09-20T14:10:00.000Z", S.X3, SOL, { source: "cli" }),
    turnContext("2026-09-20T14:10:00.000Z", SOL),
    tokenCount("2026-09-20T14:10:00.000Z", 1, c12, c12),
    tokenCount("2026-09-20T14:10:00.000Z", 3, c13, cumulativeOf(byId.E13.usage)),
    turnContext("2026-09-20T14:10:01.000Z", SOL),
    codexReply("2026-09-20T14:10:19.000Z"),
    tokenCount(byId.E17.at, 4, c17, c17),
    tokenCount(byId.E18.at, 5, c18, cumulativeOf(byId.E18.usage)),
  ]));

  // --- studio, later: new work after the machine joined again --------------------
  const s9 = claudeBase(S.S9, CANARY.project);
  put(`personA-studio-later/claude/projects/${slug(CANARY.project)}/${S.S9}.jsonl`, jsonl([userLine(s9, "2026-09-20T21:59:50.000Z", CANARY.prompt), ...assistantLines(s9, byId.E31)]));

  // --- laptop: S4 (offset timestamp), S5 (window edges), and a synced copy of S1 --
  const laptopProject = `personA-laptop/claude/projects/${slug(CANARY.laptopProject)}`;
  const s4 = claudeBase(S.S4, CANARY.laptopProject);
  put(`${laptopProject}/${S.S4}.jsonl`, jsonl([
    userLine(s4, "2026-09-20T15:59:50.000Z", CANARY.prompt),
    ...assistantLines(s4, byId.E19, { timestamp: "2026-09-20T12:00:00.000-04:00" }),
    ...assistantLines(s4, byId.E20),
  ]));
  const s5 = claudeBase(S.S5, CANARY.laptopProject);
  put(`${laptopProject}/${S.S5}.jsonl`, jsonl([
    userLine(s5, "2026-09-19T21:59:50.000Z", CANARY.prompt),
    ...assistantLines(s5, byId.E21),
    ...assistantLines(s5, byId.E22, { outputs: [3, 250], stepSeconds: 50 }), // 23:59:30 then 00:00:20
    ...assistantLines(s5, byId.E24),
    ...assistantLines(s5, byId.E23),
  ]));
  put(`personA-laptop/claude/projects/${slug(CANARY.project)}/${S.S1}.jsonl`, jsonl(s1Lines));

  // --- shared build box: person B's account -------------------------------------
  const userBProject = `sharedbox-userB/claude/projects/${slug(CANARY.project)}`;
  const s6 = claudeBase(S.S6, CANARY.project);
  put(`${userBProject}/${S.S6}.jsonl`, jsonl([userLine(s6, "2026-09-20T17:59:50.000Z", CANARY.prompt), ...assistantLines(s6, byId.E25), ...assistantLines(s6, byId.E26)]));
  const c27 = cumulativeOf(byId.E27.usage);
  const c28 = addVec(c27, cumulativeOf(byId.E28.usage));
  put(`sharedbox-userB/codex/sessions/2026/09/20/rollout-2026-09-20T18-29-00-${S.X7}.jsonl`, jsonl([
    codexMeta("2026-09-20T18:29:00.000Z", S.X7, SOL, { source: "cli" }),
    turnContext("2026-09-20T18:29:01.000Z", SOL),
    tokenCount(byId.E27.at, 1, c27, c27),
    tokenCount(byId.E28.at, null, c28, cumulativeOf(byId.E28.usage)),
  ]));

  // --- shared build box: the build account, enrolled to nobody --------------------
  const s8 = claudeBase(S.S8, "/srv/ci/canary-secret-project-dir");
  put(`sharedbox-build/claude/projects/${slug("/srv/ci/canary-secret-project-dir")}/${S.S8}.jsonl`, jsonl([
    userLine(s8, "2026-09-20T19:59:50.000Z", CANARY.prompt), ...assistantLines(s8, byId.E29), ...assistantLines(s8, byId.E30),
  ]));
  return files;
}

// ---- expected totals from ground truth ------------------------------------------

const hmac = (value) => createHmac("sha256", Buffer.from(ORG_SALT, "base64url")).update(value).digest("hex");
const sessionHash = (label) => hmac(`session|${label}`);

/** USD for one event at the pinned price table, in exact units of 1e-8 USD (rates have at most 2 decimals). */
function priceUnits(event, rows) {
  const row = rows.find((r) => r.model === event.model);
  if (!row || row.status !== "verified") return null;
  const r = row.usdPerMillion, x = event.usage;
  const cents = (rate) => { // cents per million tokens; the table's rates have at most two decimals
    const value = Math.round(rate * 100);
    if (Math.abs(rate * 100 - value) > 1e-9) throw new Error(`rate ${rate} has more than two decimals`);
    return value;
  };
  const parts = [[x.fresh, r.fresh], [x.output, r.output], [x.cacheRead, r.cacheRead]];
  if (x.cacheWrite5m || x.cacheWrite1h) parts.push([x.cacheWrite5m, r.cacheWrite5m], [x.cacheWrite1h, r.cacheWrite1h]);
  if (x.cacheWriteUnknownTtl) parts.push([x.cacheWriteUnknownTtl, r.cacheWrite]);
  let units = 0;
  for (const [tokens, rate] of parts) {
    if (!tokens) continue;
    if (typeof rate !== "number") return null;
    units += tokens * cents(rate); // cents per million × tokens = 1e-8 USD
  }
  return units;
}

function emptyTotals() {
  return { total: 0, fresh: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknownTtl: 0, messages: 0, usdUnits: 0 };
}
function addEvent(t, e, units) {
  const x = e.usage, write = x.cacheWrite5m + x.cacheWrite1h + x.cacheWriteUnknownTtl;
  t.fresh += x.fresh; t.output += x.output; t.cacheRead += x.cacheRead; t.cacheWrite += write;
  t.cacheWrite5m += x.cacheWrite5m; t.cacheWrite1h += x.cacheWrite1h; t.cacheWriteUnknownTtl += x.cacheWriteUnknownTtl;
  t.total += x.fresh + x.output + x.cacheRead + write; t.messages += 1; t.usdUnits += units;
}
function finish(t) {
  const { usdUnits, ...rest } = t;
  return { ...rest, usd: Number((usdUnits / 1e8).toFixed(8)), usdExact: `${Math.trunc(usdUnits / 1e8)}.${String(usdUnits % 1e8).padStart(8, "0")}` };
}
const group = (events, keyOf, rows) => {
  const out = {};
  for (const e of events) addEvent(out[keyOf(e)] ??= emptyTotals(), e, priceUnits(e, rows));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, finish(v)]));
};

function calendarDay(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function buildExpected(prices) {
  const rows = prices.rows;
  for (const e of EVENTS) if (priceUnits(e, rows) === null) throw new Error(`fixture model ${e.model} has no verified rate for its classes`);
  const minuteOf = (e) => Math.floor(Date.parse(e.at) / 60_000) * 60_000;
  const inWindow = (e, from, to) => minuteOf(e) >= Date.parse(from) && minuteOf(e) < Date.parse(to);
  const personOfSession = (label) => DEVICES[SESSIONS[label].device].person ?? "Unassigned";
  const deviceOfSession = (label) => DEVICES[SESSIONS[label].device].id;
  const rootOf = (label) => { let l = label; while (SESSIONS[l].parent) l = SESSIONS[l].parent; return l; };
  const window = EVENTS.filter((e) => inWindow(e, W0, W1));
  const sessions = {};
  for (const [label, s] of Object.entries(SESSIONS)) {
    sessions[label] = { hash: sessionHash(label), parent: s.parent, parentHash: s.parent ? sessionHash(s.parent) : null, root: rootOf(label),
      tool: label.startsWith("codex:") ? "codex" : "claude-code", device: deviceOfSession(label), person: personOfSession(label), exercises: s.rule };
  }
  const windowBlock = (from, to) => {
    const events = EVENTS.filter((e) => inWindow(e, from, to));
    return {
      from, to,
      events: events.map((e) => e.id),
      team: group(events, () => TEAM, rows)[TEAM] ?? finish(emptyTotals()),
      people: group(events, (e) => personOfSession(e.session), rows),
      devices: group(events, (e) => deviceOfSession(e.session), rows),
      models: group(events, (e) => e.model, rows),
      sessions: group(events, (e) => e.session, rows),
      sessionTrees: group(events, (e) => rootOf(e.session), rows),
    };
  };
  const days = {};
  for (const timeZone of ["UTC", "America/New_York"]) days[timeZone] = group(EVENTS, (e) => calendarDay(minuteOf(e), timeZone), rows);
  return {
    suite: SUITE_VERSION,
    spec: "docs/accounting.md",
    units: "tokens; usd is a standard API-list-price estimate from the pinned price table, never an invoice",
    priceTable: { file: "lib/collector/prices.json", basis: prices.basis, inventoryCheckedOn: prices.inventoryCheckedOn,
      rows: Object.fromEntries([...new Set(EVENTS.map((e) => e.model))].sort().map((m) => [m, rows.find((r) => r.model === m).usdPerMillion])) },
    team: TEAM,
    window: windowBlock(W0, W1),
    windows: [windowBlock(W0, HALF), windowBlock(HALF, W1)],
    days,
    sessions,
    events: EVENTS.map((e) => ({ id: e.id, session: e.session, model: e.model, at: e.at, minute: new Date(minuteOf(e)).toISOString(), inWindow: window.includes(e), usage: e.usage, ...(e.note ? { note: e.note } : {}) })),
    invariants: [
      "team == sum(people) == sum(devices) == sum(models) == sum(sessions) == sum(sessionTrees)",
      "windows[0] + windows[1] == window",
      "total == fresh + output + cacheRead + cacheWrite; cacheWrite == cacheWrite5m + cacheWrite1h + cacheWriteUnknownTtl",
      "every delivery after the first copy of an event adds nothing",
    ],
  };
}

function buildManifest() {
  return {
    suite: SUITE_VERSION,
    spec: "docs/accounting.md",
    organization: { id: ORGANIZATION_ID, orgSalt: ORG_SALT, note: "Synthetic. Record ids are HMAC-SHA256(orgSalt, `${tool}|${sessionId}|${messageId}`); session hashes HMAC-SHA256(orgSalt, `session|${label}`)." },
    window: { from: W0, to: W1, timeZone: "UTC", halfOpen: true },
    team: TEAM,
    devices: DEVICES,
    deliveries: DELIVERIES.map((d) => ({ ...d, roots: d.roots.map((r) => `logs/${r}`) })),
    canaries: CANARIES,
  };
}

/** Runs this package's collector for each delivery and returns what it sent. */
export async function collectDeliveries({ fixtureRoot = HERE, manifest = buildManifest(), scratch = null } = {}) {
  const { runOnce } = await import(path.join(REPO, "lib", "collector", "collector.js"));
  const base = scratch ?? fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-conformance-"));
  const states = new Map();
  const deliveries = [];
  try {
    for (const delivery of manifest.deliveries) {
      const device = manifest.devices[delivery.device];
      let directory = states.get(delivery.state);
      if (!directory) {
        directory = path.join(base, delivery.state);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(directory, "enrollment.json"), JSON.stringify({ v: 1, orgSalt: manifest.organization.orgSalt,
          organizationId: manifest.organization.id, device: { id: device.id, label: device.label } }), { mode: 0o600 });
        states.set(delivery.state, directory);
      }
      const roots = [];
      for (const root of delivery.roots) {
        const claude = path.join(fixtureRoot, root, "claude", "projects");
        const codex = path.join(fixtureRoot, root, "codex", "sessions");
        if (fs.existsSync(claude)) roots.push({ tool: "claude-code", directory: claude });
        if (fs.existsSync(codex)) roots.push({ tool: "codex", directory: codex });
      }
      let sent = [];
      await runOnce({ directory, roots, sinkName: "conformance", now: new Date(W1),
        deliver: async (_device, records) => { sent = records.map((r) => JSON.parse(JSON.stringify(r))); return { accepted: sent.length, duplicate: 0, rejected: [] }; } });
      deliveries.push({ step: delivery.step, device: delivery.device, deviceId: device.id, records: sent });
    }
  } finally {
    if (!scratch) fs.rmSync(base, { recursive: true, force: true });
  }
  return deliveries;
}

function writeAll(target, files) {
  for (const [rel, text] of files) {
    const file = path.join(target, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

export async function build({ check = false } = {}) {
  const prices = JSON.parse(fs.readFileSync(path.join(REPO, "lib", "collector", "prices.json"), "utf8"));
  const logs = buildLogs();
  const manifest = buildManifest();
  const expected = buildExpected(prices);
  const out = new Map();
  for (const [rel, text] of logs) out.set(path.join("logs", rel), text);
  out.set("manifest.json", JSON.stringify(manifest, null, 1) + "\n");
  out.set("expected.json", JSON.stringify(expected, null, 1) + "\n");
  // The collector reads the logs from disk, so stage them first.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-conformance-logs-"));
  try {
    writeAll(stage, out);
    const deliveries = await collectDeliveries({ fixtureRoot: stage, manifest });
    out.set("collector-records.json", JSON.stringify({ suite: SUITE_VERSION, collector: "@lockedinlabs/agent-console lib/collector",
      note: "Exactly what the collector sent at each delivery step, in order. A receiver replays these to check its own accounting against expected.json.",
      deliveries }, null, 1) + "\n");
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  const drift = [];
  for (const [rel, text] of out) {
    const file = path.join(HERE, rel);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (current !== text) drift.push(rel);
  }
  if (check) return drift;
  writeAll(HERE, out);
  return drift;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const drift = await build({ check });
  if (check && drift.length) { console.error("conformance fixtures differ from the builder:\n  " + drift.join("\n  ")); process.exitCode = 1; }
  else console.log(check ? "conformance fixtures are current" : `wrote ${drift.length} changed file(s)`);
}
