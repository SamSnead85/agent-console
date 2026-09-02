import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createClaudeStore, scanClaude, buildSessions } from "../lib/claude.js";
import { createCodexStore, scanCodex, buildThreads } from "../lib/codex.js";
import { dayKeyOf } from "../lib/day.js";
import { scratchHome, removeTree, assistantLine } from "./helpers.js";

/**
 * A transcript's last line can have no terminating newline. lib/jsonl.js emits
 * that line once the file has gone quiet, which is the only way it is ever
 * counted.
 *
 * The caller made that branch unreachable. The per-file skip was
 *
 *     mtime unchanged && size === offset && offset > 0  ->  continue
 *
 * and "quiet" is exactly when mtime and size stop changing — so after the first
 * full read the flush could only ever fire on a file that was ALREADY idle when
 * the dashboard started. The same bytes on disk therefore produced two
 * different day totals depending on when the process happened to start, which
 * on the fixture below is 1,000 tokens against 778,777.
 */

function noonToday() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

function claudeTotal(home, now, at) {
  const store = createClaudeStore({
    root: path.join(home, ".claude", "projects"),
    sessionsDir: path.join(home, ".claude", "sessions"),
    windowMs: 36 * 3600 * 1000,
  });
  const sessions = () => buildSessions(store, now, dayKeyOf(at), new Map());
  return { store, sessions };
}

function writeUnterminated(file, records, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The final line deliberately has NO trailing newline: a transcript whose
  // writer was interrupted, or is mid-write, looks exactly like this.
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"));
  // The flush is a function of (now - mtime), so both are pinned rather than
  // left to whatever the wall clock says while the suite runs.
  const seconds = mtimeMs / 1000;
  fs.utimesSync(file, seconds, seconds);
}

test("the same bytes give the same day total whenever the scan starts", () => {
  const at = noonToday();
  const build = (name) => {
    const home = scratchHome(name);
    writeUnterminated(
      path.join(home, ".claude", "projects", "-tmp-flush", "s.jsonl"),
      [
        assistantLine({ id: "msg_E1", at, in: 1000 }),
        assistantLine({ id: "msg_E2", at, in: 777_777 }),
      ],
      at,
    );
    return home;
  };

  // (a) The dashboard was already running when the file went quiet.
  const running = build("flush-running");
  const a = claudeTotal(running, at, at);
  scanClaude(a.store, at + 3_000, dayKeyOf);
  const early = a.sessions()[0].total;
  scanClaude(a.store, at + 60_000, dayKeyOf);
  const late = a.sessions()[0].total;

  // (b) A fresh process reading the identical bytes, already idle.
  const cold = build("flush-cold");
  const b = claudeTotal(cold, at + 60_000, at);
  scanClaude(b.store, at + 60_000, dayKeyOf);
  const fresh = b.sessions()[0].total;

  assert.equal(early, 1000, "the un-terminated line must not be counted early");
  assert.equal(
    late,
    fresh,
    "the day total depends on when the process started: " +
      late +
      " vs " +
      fresh,
  );
  assert.equal(late, 1000 + 777_777);

  removeTree(running);
  removeTree(cold);
});

test("a flushed line is absorbed, not added twice, on the polls that follow", () => {
  const at = noonToday();
  const home = scratchHome("flush-repeat");
  writeUnterminated(
    path.join(home, ".claude", "projects", "-tmp-flush2", "s.jsonl"),
    [assistantLine({ id: "msg_R", at, in: 500 })],
    at,
  );
  const { store, sessions } = claudeTotal(home, at, at);
  for (const t of [at + 60_000, at + 70_000, at + 80_000]) {
    scanClaude(store, t, dayKeyOf);
  }
  assert.equal(
    sessions()[0].total,
    500,
    "the flushed line was counted more than once",
  );
  removeTree(home);
});

test("the codex scanner has the same guard, and the same determinism", () => {
  const at = noonToday();
  const line = (total) =>
    JSON.stringify({
      timestamp: new Date(at).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: total,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: total,
          },
          last_token_usage: { total_tokens: total },
        },
      },
    });

  const build = (name) => {
    const home = scratchHome(name);
    const dir = path.join(home, ".codex", "sessions", "2026", "08", "30");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "rollout-2026-08-30T12-00-00-thread-a.jsonl");
    fs.writeFileSync(file, line(10) + "\n" + line(999_999));
    fs.utimesSync(file, at / 1000, at / 1000);
    return home;
  };

  const running = build("codex-flush-running");
  const storeA = createCodexStore({
    root: path.join(running, ".codex", "sessions"),
    windowMs: 36 * 3600 * 1000,
  });
  scanCodex(storeA, at + 3_000);
  scanCodex(storeA, at + 60_000);
  const late = buildThreads(storeA, at + 60_000)[0].tokens.total;

  const cold = build("codex-flush-cold");
  const storeB = createCodexStore({
    root: path.join(cold, ".codex", "sessions"),
    windowMs: 36 * 3600 * 1000,
  });
  scanCodex(storeB, at + 60_000);
  const fresh = buildThreads(storeB, at + 60_000)[0].tokens.total;

  assert.equal(late, fresh, late + " vs " + fresh);
  assert.equal(late, 999_999);

  removeTree(running);
  removeTree(cold);
});
