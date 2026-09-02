import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createClaudeStore, scanClaude, buildSessions } from "../lib/claude.js";
import { dayKeyOf } from "../lib/snapshot.js";
import { sumTokens } from "../lib/prices.js";
import {
  scratchHome,
  removeTree,
  writeJsonl,
  assistantLine,
} from "./helpers.js";

/**
 * Claude Code writes ONE API response as several assistant lines — one per
 * content block, plus streaming snapshots — and every one of them repeats that
 * response's usage. A captured validation corpus produced a 1.84x overcount
 * before duplicates were collapsed. These fixtures repeat message ids on
 * purpose.
 */

function scan(home, at) {
  const store = createClaudeStore({
    root: path.join(home, ".claude", "projects"),
    sessionsDir: path.join(home, ".claude", "sessions"),
    windowMs: 36 * 3600 * 1000,
  });
  scanClaude(store, at, dayKeyOf);
  return {
    store,
    sessions: buildSessions(store, at, dayKeyOf(at), new Map()),
  };
}

test("repeated message ids are counted once, at the high-water mark", () => {
  const home = scratchHome("dedup");
  const at = Date.now();
  const file = path.join(
    home,
    ".claude",
    "projects",
    "-tmp-project",
    "session-a.jsonl",
  );
  writeJsonl(file, [
    // One response, written across four lines. The usage grows as the response
    // streams; only the final figure is the truth.
    assistantLine({ id: "msg_A", at, in: 10, out: 5, cr: 1000, cw: 100 }),
    assistantLine({ id: "msg_A", at, in: 10, out: 20, cr: 1000, cw: 100 }),
    assistantLine({ id: "msg_A", at, in: 10, out: 37, cr: 1000, cw: 100 }),
    assistantLine({ id: "msg_A", at, in: 10, out: 37, cr: 1000, cw: 100 }),
    // A second, genuinely different response.
    assistantLine({ id: "msg_B", at, in: 7, out: 3, cr: 500, cw: 50 }),
  ]);

  const { sessions } = scan(home, at);
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.deepEqual(
    { in: s.tokens.in, out: s.tokens.out, cr: s.tokens.cr, cw: s.tokens.cw },
    { in: 17, out: 40, cr: 1500, cw: 150 },
    "duplicate lines were summed instead of collapsed",
  );
  assert.equal(sumTokens(s.tokens), 1707);
  assert.equal(s.responses, 2, "distinct responses miscounted");
  assert.equal(s.usageLines, 5, "usage lines miscounted");

  // The naive figure, for contrast: this is what summing every line produces.
  const naive =
    10 +
    5 +
    1000 +
    100 +
    (10 + 20 + 1000 + 100) +
    (10 + 37 + 1000 + 100) +
    (10 + 37 + 1000 + 100) +
    (7 + 3 + 500 + 50);
  assert.equal(naive, 5099);
  assert.ok(
    naive > sumTokens(s.tokens) * 2.9,
    "the fixture must actually overcount",
  );
  removeTree(home);
});

test("de-duplication survives ids interleaved far apart", () => {
  // The regression corpus puts one message id hundreds of usage records apart,
  // disproving any assumption that its lines are adjacent.
  const home = scratchHome("dedup-interleave");
  const at = Date.now();
  const records = [];
  records.push(
    assistantLine({ id: "msg_long", at, in: 100, out: 0, cr: 0, cw: 0 }),
  );
  for (let i = 0; i < 600; i += 1) {
    records.push(
      assistantLine({ id: "msg_f" + i, at, in: 1, out: 0, cr: 0, cw: 0 }),
    );
  }
  records.push(
    assistantLine({ id: "msg_long", at, in: 100, out: 40, cr: 0, cw: 0 }),
  );

  const file = path.join(
    home,
    ".claude",
    "projects",
    "-tmp-project",
    "session-b.jsonl",
  );
  writeJsonl(file, records);
  const { sessions, store } = scan(home, at);
  const s = sessions[0];
  assert.equal(s.tokens.in, 700, "the long-lived id was double counted");
  assert.equal(s.tokens.out, 40);
  assert.equal(s.responses, 601);
  assert.ok(store.dedupSpanMax >= 601, "the observed span was not reported");
  removeTree(home);
});

test("a line re-read after an idle flush does not double count", () => {
  // The reader emits an un-terminated final line once the file goes quiet, and
  // emits it again as part of the real line if the file later grows. That is
  // only safe because dedup absorbs it; assert that it does.
  const home = scratchHome("dedup-reread");
  const at = Date.now();
  const file = path.join(
    home,
    ".claude",
    "projects",
    "-tmp-project",
    "session-c.jsonl",
  );
  writeJsonl(file, [
    assistantLine({ id: "msg_X", at, in: 5, out: 5, cr: 0, cw: 0 }),
  ]);

  const store = createClaudeStore({
    root: path.join(home, ".claude", "projects"),
    sessionsDir: path.join(home, ".claude", "sessions"),
    windowMs: 36 * 3600 * 1000,
  });
  scanClaude(store, at, dayKeyOf);
  // Force a re-read of the same bytes from the top.
  for (const s of store.files.values()) {
    s.offset = 0;
    s.leftover = "";
  }
  scanClaude(store, at + 1000, dayKeyOf);
  const sessions = buildSessions(store, at + 1000, dayKeyOf(at), new Map());
  assert.equal(
    sumTokens(sessions[0].tokens),
    10,
    "a re-read line was counted twice",
  );
  removeTree(home);
});

test("synthetic model lines carry usage but are not real spend", () => {
  const home = scratchHome("dedup-synth");
  const at = Date.now();
  const file = path.join(
    home,
    ".claude",
    "projects",
    "-tmp-project",
    "session-d.jsonl",
  );
  const synthetic = assistantLine({ id: "msg_S", at, in: 999, out: 999 });
  synthetic.message.model = "<synthetic>";
  writeJsonl(file, [
    synthetic,
    assistantLine({ id: "msg_R", at, in: 1, out: 1 }),
  ]);
  const { sessions } = scan(home, at);
  assert.equal(sumTokens(sessions[0].tokens), 2, "a synthetic line was priced");
  removeTree(home);
});

test("server-tool counts are de-duplicated with the tokens they ride on", () => {
  // web_search_requests / web_fetch_requests sit in the same `usage` object and
  // are repeated on every line of a response exactly as the token counts are.
  // Accumulating them per physical line multiplied them by the duplication
  // factor and rendered the product straight to the screen as
  // "server tools 12 search / 4 fetch" for three searches.
  const home = scratchHome("servertools");
  const at = Date.now();
  const line = (out) => {
    const record = assistantLine({ id: "msg_A", at, in: 100, out, cr: 50_000 });
    record.message.usage.server_tool_use = {
      web_search_requests: 3,
      web_fetch_requests: 1,
    };
    return record;
  };
  writeJsonl(path.join(home, ".claude", "projects", "-tmp-st", "s.jsonl"), [
    line(10),
    line(60),
    line(110),
    line(120),
  ]);

  const { sessions } = scan(home, at);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].usageLines, 4);
  assert.equal(sessions[0].responses, 1);
  assert.deepEqual(
    sessions[0].serverTools,
    { search: 3, fetch: 1 },
    "server-tool counts were multiplied by the duplication factor",
  );
  removeTree(home);
});

test("a growing server-tool count within one response is taken at its high-water mark", () => {
  const home = scratchHome("servertools-grow");
  const at = Date.now();
  const line = (searches) => {
    const record = assistantLine({ id: "msg_A", at, in: 100, out: 10 });
    record.message.usage.server_tool_use = {
      web_search_requests: searches,
      web_fetch_requests: 0,
    };
    return record;
  };
  writeJsonl(path.join(home, ".claude", "projects", "-tmp-st2", "s.jsonl"), [
    line(1),
    line(2),
    line(5),
  ]);
  const { sessions } = scan(home, at);
  assert.equal(sessions[0].serverTools.search, 5);
  removeTree(home);
});
