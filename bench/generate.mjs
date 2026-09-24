#!/usr/bin/env node

/*
 * Synthetic, realistic Claude Code and Codex history for benchmarks.
 *
 *   node bench/generate.mjs --out <dir> [--lines 1000000] [--sessions 240]
 *        [--days 30] [--homes 1] [--seed 1] [--now <ISO time>]
 *
 * Writes <dir>/home-<n>/.claude/projects/... and .codex/sessions/... the way
 * the tools lay them out. The shapes are the tools' own: a Claude response
 * streamed over several assistant lines that share a message id and grow in
 * usage, sidechain subagent files, large tool results; Codex rollouts with
 * cumulative token counts and forked subagent threads. Every file's mtime is
 * its last line's time, as on a real disk, so retention windows skip old
 * files the way they would for a real user.
 *
 * Deterministic: the same arguments write the same bytes. Nothing in it is
 * anyone's data; the text is filler and the folders are role names.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
  const o = { out: null, lines: 1_000_000, sessions: 240, days: 30, homes: 1, seed: 1, now: Date.now(), bytesPerLine: 1800 };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === "--out") { o.out = v; i++; }
    else if (k === "--lines") { o.lines = Number(v); i++; }
    else if (k === "--sessions") { o.sessions = Number(v); i++; }
    else if (k === "--days") { o.days = Number(v); i++; }
    else if (k === "--homes") { o.homes = Number(v); i++; }
    else if (k === "--seed") { o.seed = Number(v); i++; }
    else if (k === "--now") { o.now = Date.parse(v); i++; }
    else if (k === "--bytes-per-line") { o.bytesPerLine = Number(v); i++; }
    else throw new Error(`unknown option ${k}`);
  }
  if (!o.out) throw new Error("--out <dir> is required");
  return o;
}

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTS = ["api-server", "web-app", "mobile-app", "data-pipeline", "infra", "design-system", "billing", "search", "auth-service", "docs-site", "ml-training", "cli-tools"];
const CLAUDE_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1"];
const CODEX_MODELS = ["gpt-5.6-sol", "gpt-6-astra"];
const MINUTE = 60_000;

export function generate(options) {
  const rand = prng(options.seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  // Filler text: printable, incompressible enough that JSON parsing does real work.
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:_-(){}[]=+*/";
  let filler = "";
  for (let i = 0; i < 1 << 17; i++) filler += alphabet[Math.floor(rand() * alphabet.length)];
  const text = (n) => { const at = Math.floor(rand() * (filler.length - n - 1)); return filler.slice(at, at + Math.max(1, n)); };
  // Heavy-tailed sizes: most tool output is a few KB, some is tens of KB.
  const outputSize = () => Math.min(60_000, Math.floor(options.bytesPerLine * 0.9 * Math.exp((rand() + rand() + rand() - 1.5) * 1.6)));
  let uuidN = 0;
  const uuid = (prefix) => { uuidN += 1; const h = (uuidN * 2654435761 >>> 0).toString(16).padStart(8, "0"); return `${prefix}${h}-${String(uuidN).padStart(4, "0").slice(-4)}-4000-8000-${String(uuidN).padStart(12, "0")}`; };
  const iso = (ms) => new Date(ms).toISOString();

  const start = options.now - options.days * 86_400_000;
  // Session sizes: a few long sessions carry most lines, as in real use.
  const weights = Array.from({ length: options.sessions }, () => Math.exp(rand() * 3.2));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const stats = { files: 0, lines: 0, bytes: 0, sessions: 0, subagents: 0, homes: options.homes };

  for (let h = 0; h < options.homes; h++) {
    const home = path.join(options.out, `home-${h + 1}`);
    for (let s = 0; s < options.sessions; s++) {
      const budget = Math.max(12, Math.round((options.lines / options.homes) * weights[s] / weightSum));
      // Sessions spread over the window, a little denser towards now.
      const t0 = start + Math.floor(Math.pow(rand(), 0.8) * options.days * 86_400_000);
      const project = pick(PROJECTS);
      const cwd = `/home/dev/work/${project}`;
      const claude = rand() < 0.62;
      stats.sessions += 1;
      if (claude) writeClaude(home, { cwd, project, t0, budget });
      else writeCodex(home, { cwd, t0, budget });
    }
  }
  return stats;

  function put(file, lines, lastAt) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = lines.join("\n") + "\n";
    fs.writeFileSync(file, body);
    const when = new Date(Math.min(lastAt, options.now));
    fs.utimesSync(file, when, when);
    stats.files += 1; stats.lines += lines.length; stats.bytes += Buffer.byteLength(body);
  }

  function claudeLines({ sessionId, cwd, t0, budget, agentId = null, model }) {
    const lines = [];
    let t = t0, parent = null;
    const base = (extra) => ({ parentUuid: parent, isSidechain: Boolean(agentId), ...(agentId ? { agentId } : {}), userType: "external", cwd, sessionId, version: "2.1.0", gitBranch: "main", ...extra });
    const push = (obj) => { lines.push(JSON.stringify(obj)); parent = obj.uuid ?? parent; };
    push(base({ type: "user", uuid: uuid("u"), timestamp: iso(t), message: { role: "user", content: text(between(80, 900)) } }));
    let cacheRead = between(8_000, 30_000);
    while (lines.length < budget) {
      // One API response, streamed over 1-4 lines with the same message id.
      t += between(2, 40) * 1000;
      const messageId = `msg_${uuid("")}`, requestId = `req_${uuid("")}`;
      const parts = between(1, 4);
      const input = between(3, 400), write = rand() < 0.3 ? between(500, 12_000) : between(0, 400);
      cacheRead = Math.min(900_000, cacheRead + between(200, 6_000));
      let out = 0;
      for (let p = 0; p < parts && lines.length < budget; p++) {
        out += between(20, 900);
        const block = p === 0 && rand() < 0.5 ? { type: "thinking", thinking: text(between(200, 2_000)) }
          : p === parts - 1 ? { type: "tool_use", id: `toolu_${uuid("")}`, name: pick(["Bash", "Edit", "Read", "Grep"]), input: { command: text(between(20, 300)) } }
            : { type: "text", text: text(between(100, 1_500)) };
        push(base({ type: "assistant", uuid: uuid("a"), requestId, timestamp: iso(t + p * between(200, 4_000)), message: {
          id: messageId, type: "message", role: "assistant", model, content: [block], stop_reason: p === parts - 1 ? "tool_use" : null,
          usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: cacheRead, output_tokens: out,
            cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 }, service_tier: "standard" } } }));
      }
      if (lines.length >= budget) break;
      t += between(1, 20) * 1000;
      const size = outputSize();
      push(base({ type: "user", uuid: uuid("r"), timestamp: iso(t), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: text(size) }] },
        toolUseResult: { stdout: text(Math.min(size, 4_000)), stderr: "", interrupted: false } }));
      if (rand() < 0.04 && lines.length < budget) {
        t += between(30, 600) * 1000;
        push(base({ type: "user", uuid: uuid("u"), timestamp: iso(t), message: { role: "user", content: text(between(80, 900)) } }));
      }
    }
    return { lines, lastAt: t };
  }

  function writeClaude(home, { cwd, t0, budget }) {
    const sessionId = uuid("c");
    const model = pick(CLAUDE_MODELS);
    const dir = path.join(home, ".claude", "projects", cwd.replace(/[\\/]/gu, "-"));
    const agents = rand() < 0.55 ? between(1, 4) : 0;
    const mainBudget = agents ? Math.ceil(budget * 0.6) : budget;
    const main = claudeLines({ sessionId, cwd, t0, budget: mainBudget, model });
    put(path.join(dir, `${sessionId}.jsonl`), main.lines, main.lastAt);
    for (let a = 0; a < agents; a++) {
      const agentId = uuid("g").slice(0, 17);
      const sub = claudeLines({ sessionId, cwd, t0: t0 + between(1, 30) * MINUTE, budget: Math.max(8, Math.floor((budget - mainBudget) / agents)), agentId, model: pick(CLAUDE_MODELS) });
      put(path.join(dir, sessionId, "subagents", `agent-${agentId}.jsonl`), sub.lines, sub.lastAt);
      stats.subagents += 1;
    }
  }

  function codexLines({ id, cwd, t0, budget, model, parent = null }) {
    const lines = [];
    let t = t0;
    const push = (obj) => lines.push(JSON.stringify(obj));
    const source = parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } : "cli";
    push({ timestamp: iso(t), type: "session_meta", payload: { id, timestamp: iso(t), cwd, originator: "codex_cli_rs", cli_version: "0.99.0", source, instructions: text(between(500, 3_000)), git: { branch: "main", commit_hash: "0".repeat(40) } } });
    push({ timestamp: iso(t), type: "turn_context", payload: { cwd, model, approval_policy: "on-request", sandbox_policy: { mode: "workspace-write" } } });
    const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    while (lines.length < budget) {
      t += between(3, 60) * 1000;
      push({ timestamp: iso(t), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: text(between(50, 600)) }] } });
      const calls = between(1, 5);
      for (let c = 0; c < calls && lines.length < budget; c++) {
        t += between(1, 15) * 1000;
        push({ timestamp: iso(t), type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: text(between(100, 800)) }] } });
        push({ timestamp: iso(t), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", text(between(20, 200))] }), call_id: `call_${uuid("")}` } });
        push({ timestamp: iso(t), type: "response_item", payload: { type: "function_call_output", call_id: "call_x", output: text(outputSize()) } });
        const last = { input_tokens: between(4_000, 60_000), output_tokens: between(50, 3_000), reasoning_output_tokens: between(0, 1_500) };
        last.cached_input_tokens = Math.floor(last.input_tokens * (0.6 + rand() * 0.35));
        last.cache_write_input_tokens = 0;
        last.total_tokens = last.input_tokens + last.output_tokens;
        for (const k of Object.keys(total)) total[k] += last[k];
        push({ timestamp: iso(t), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { ...total }, last_token_usage: last, model_context_window: 272_000 } } });
      }
      push({ timestamp: iso(t), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: text(between(100, 1_200)) }] } });
    }
    return { lines, lastAt: t };
  }

  function codexFile(home, id, t0) {
    const d = new Date(t0);
    const dir = path.join(home, ".codex", "sessions", String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
    return path.join(dir, `rollout-${iso(t0).slice(0, 19).replace(/:/gu, "-")}-${id}.jsonl`);
  }

  function writeCodex(home, { cwd, t0, budget }) {
    const id = uuid("d");
    const model = pick(CODEX_MODELS);
    const children = rand() < 0.35 ? between(1, 3) : 0;
    const mainBudget = children ? Math.ceil(budget * 0.7) : budget;
    const main = codexLines({ id, cwd, t0, budget: mainBudget, model });
    put(codexFile(home, id, t0), main.lines, main.lastAt);
    for (let c = 0; c < children; c++) {
      const childId = uuid("e");
      const ct0 = t0 + between(1, 20) * MINUTE;
      const child = codexLines({ id: childId, cwd, t0: ct0, budget: Math.max(8, Math.floor((budget - mainBudget) / children)), model, parent: id });
      put(codexFile(home, childId, ct0), child.lines, child.lastAt);
      stats.subagents += 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const t = Date.now();
  const stats = generate(options);
  process.stdout.write(JSON.stringify({ ...stats, seconds: (Date.now() - t) / 1000 }) + "\n");
}
