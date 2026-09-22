/**
 * Real-shaped, entirely synthetic Claude Code and Codex transcripts.
 *
 * The shapes follow what the two tools write to disk — the same field names,
 * the same nesting, the same way usage is reported — and every place a real
 * transcript would hold something private holds a CANARY instead: the prompt,
 * the reply, tool input and output, file paths, file contents, the working
 * directory, the git branch, a credential-looking string. A test that finds
 * any canary in anything that left the machine has found a leak.
 */

import fs from "node:fs";
import path from "node:path";

// Credential-shaped canaries are assembled at runtime, so no secret scanner
// (or this repository's own) ever sees a credential-shaped literal on disk.
const KEY_CANARY = "sk-" + "ant-" + "CANARY".repeat(4) + "00";

export const CANARIES = [
  "CANARY-PROMPT-7f3a",
  "CANARY-REPLY-19bd",
  "CANARY-FILE-CONTENT-a41c",
  "CANARY-TOOL-OUTPUT-5e02",
  "canary-secret-project-dir",
  "canary-private-branch",
  "canary_file_name_e91.ts",
  KEY_CANARY,
  "CANARY-THINKING-66d0",
];

const iso = (ms) => new Date(ms).toISOString();

/** One Claude Code session: a user turn, then assistant turns with usage. */
export function claudeSession({ sessionId, cwd, branch = "canary-private-branch", model = "claude-sonnet-5", start, turns = 4, stepMs = 15_000, agentId = null, seed = 1 }) {
  const lines = [];
  let t = start;
  const common = (extra) => ({
    parentUuid: null,
    isSidechain: Boolean(agentId),
    ...(agentId ? { agentId } : {}),
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.0",
    gitBranch: branch,
    ...extra,
  });
  lines.push(common({
    type: "user",
    uuid: `${sessionId}-u0`,
    timestamp: iso(t),
    message: { role: "user", content: "CANARY-PROMPT-7f3a please edit " + path.join(cwd, "src", "canary_file_name_e91.ts") },
  }));
  for (let i = 0; i < turns; i += 1) {
    t += stepMs;
    const k = seed * 7 + i;
    lines.push(common({
      type: "assistant",
      uuid: `${sessionId}-a${i}`,
      requestId: `req_${sessionId}_${i}`,
      timestamp: iso(t),
      message: {
        id: `msg_${sessionId}_${i}`,
        type: "message",
        role: "assistant",
        model,
        content: [
          { type: "thinking", thinking: "CANARY-THINKING-66d0" },
          { type: "text", text: "CANARY-REPLY-19bd" },
          { type: "tool_use", id: `toolu_${i}`, name: "Edit", input: { file_path: path.join(cwd, "src", "canary_file_name_e91.ts"), new_string: "CANARY-FILE-CONTENT-a41c " + KEY_CANARY } },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 40 + (k % 13) * 11,
          cache_creation_input_tokens: 1200 + (k % 5) * 300,
          cache_read_input_tokens: 24_000 + (k % 9) * 2100,
          output_tokens: 300 + (k % 7) * 90,
          cache_creation: { ephemeral_5m_input_tokens: 1200 + (k % 5) * 300, ephemeral_1h_input_tokens: 0 },
          service_tier: "standard",
        },
      },
    }));
    t += 2000;
    lines.push(common({
      type: "user",
      uuid: `${sessionId}-r${i}`,
      timestamp: iso(t),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: "CANARY-TOOL-OUTPUT-5e02" }] },
      toolUseResult: { filePath: path.join(cwd, "src", "canary_file_name_e91.ts"), content: "CANARY-FILE-CONTENT-a41c" },
    }));
  }
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

/** One Codex rollout: session metadata, a turn context, and cumulative token counts. */
export function codexSession({ id, cwd, branch = "canary-private-branch", model = "gpt-5.6-sol", start, turns = 3, stepMs = 20_000 }) {
  const lines = [];
  let t = start;
  lines.push({ timestamp: iso(t), type: "session_meta", payload: { id, timestamp: iso(t), cwd, originator: "codex_cli_rs", cli_version: "0.99.0", instructions: "CANARY-PROMPT-7f3a", git: { branch, commit_hash: "0".repeat(40), repository_url: "git@example.invalid:canary-secret-project-dir.git" } } });
  lines.push({ timestamp: iso(t), type: "turn_context", payload: { cwd, model, approval_policy: "on-request", sandbox_policy: { mode: "workspace-write" } } });
  lines.push({ timestamp: iso(t), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "CANARY-PROMPT-7f3a" }] } });
  let input = 0, cached = 0, output = 0, reasoning = 0;
  for (let i = 0; i < turns; i += 1) {
    t += stepMs;
    lines.push({ timestamp: iso(t), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "CANARY-REPLY-19bd" }] } });
    lines.push({ timestamp: iso(t), type: "response_item", payload: { type: "function_call_output", call_id: `call_${i}`, output: "CANARY-TOOL-OUTPUT-5e02 CANARY-FILE-CONTENT-a41c" } });
    input += 9000 + i * 1500; cached += 7000 + i * 1400; output += 800 + i * 120; reasoning += 200;
    lines.push({ timestamp: iso(t), type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output },
      last_token_usage: { input_tokens: 9000, cached_input_tokens: 7000, output_tokens: 800, reasoning_output_tokens: 200, total_tokens: 9800 },
      model_context_window: 272000,
    } } });
  }
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

/**
 * Writes a home directory the way the tools lay it out:
 *   <home>/.claude/projects/<slug>/<session>.jsonl
 *   <home>/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl
 */
export function writeHome(home, { claude = [], codex = [] }) {
  for (const s of claude) {
    const slug = s.cwd.replace(/[\\/]/g, "-");
    const dir = path.join(home, ".claude", "projects", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, s.sessionId + ".jsonl"), claudeSession(s));
  }
  for (const s of codex) {
    const d = new Date(s.start);
    const dir = path.join(home, ".codex", "sessions", String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `rollout-${s.id}.jsonl`), codexSession(s));
  }
  return home;
}
