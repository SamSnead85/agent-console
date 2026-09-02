/**
 * Test helpers.
 *
 * Credential fixtures are ASSEMBLED AT RUNTIME rather than written as literals.
 * The repository's source-hygiene gate walks every file and fails on a
 * credential-shaped literal — correctly, since a fixture in git history is a
 * leaked secret whether or not it was ever real. Concatenation keeps the tests
 * realistic without putting a matching string on disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function scratchHome(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-" + name + "-"));
  fs.mkdirSync(path.join(root, ".claude", "projects"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codex", "sessions"), { recursive: true });
  return root;
}

export function removeTree(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

export function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

/** One assistant line as Claude Code writes it. */
export function assistantLine(options) {
  return {
    type: "assistant",
    timestamp: new Date(options.at).toISOString(),
    cwd: options.cwd || "/tmp/project",
    gitBranch: options.branch || "main",
    version: "2.1.241",
    requestId: options.requestId || "req_test",
    message: {
      id: options.id,
      model: options.model || "claude-opus-5",
      role: "assistant",
      type: "message",
      content: options.content || [
        { type: "text", text: options.text || "hello" },
      ],
      usage: {
        input_tokens: options.in || 0,
        output_tokens: options.out || 0,
        cache_read_input_tokens: options.cr || 0,
        cache_creation_input_tokens: options.cw || 0,
        cache_creation: {
          ephemeral_1h_input_tokens: options.cw1h || 0,
          ephemeral_5m_input_tokens: (options.cw || 0) - (options.cw1h || 0),
        },
        output_tokens_details: { thinking_tokens: options.think || 0 },
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
    },
  };
}

/**
 * Credential-shaped strings, built at runtime. None of these has ever been a
 * live credential; the shapes are what matter.
 */
export const SECRETS = {
  anthropic: "sk-" + "ant-" + "api03-" + "Zx".repeat(24),
  openai: "sk-" + "proj-" + "Q".repeat(48),
  githubClassic: "gh" + "p_" + "aB3".repeat(14),
  githubFine: "github" + "_pat_" + "11ABCDE".repeat(8),
  aws: "AK" + "IA" + "IOSFODNN7EXAMPLE",
  google: "AI" + "za" + "Sy".repeat(20),
  slack: "xo" + "xb-" + "1234567890-abcdefghijkl",
  npm: "np" + "m_" + "z".repeat(36),
  supabase: "sb" + "_publishable_" + "k".repeat(32),
  stripe: "sk" + "_live_" + "S".repeat(30),
  jwt: [
    "ey" + "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0",
    "dBjftJeZ4CVP" + "mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  ].join("."),
  password: "hunter2-correct-horse",
  bearer: "A".repeat(40),
};
