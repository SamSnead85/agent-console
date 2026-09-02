import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createReadState, readNewLines } from "../lib/jsonl.js";

function tempFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-jsonl-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return { dir, file };
}

test("a half-written trailing line is left for the next pass", () => {
  const { dir, file } = tempFile("t.jsonl", '{"a":1}\n{"b":2}\n{"c":');
  const state = createReadState(file);
  const seen = [];
  readNewLines(state, (line) => seen.push(line), Date.now());
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}'], "a partial line was consumed");

  fs.appendFileSync(file, '3}\n{"d":4}\n');
  const more = [];
  readNewLines(state, (line) => more.push(line), Date.now());
  assert.deepEqual(
    more,
    ['{"c":3}', '{"d":4}'],
    "the completed line was not reassembled",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a multi-byte character split across the read boundary is not corrupted", () => {
  // Reproduce a captured boundary defect: the final byte of an EN DASH landing
  // across a 4 MiB read boundary must not become replacement characters.
  const dashLine = '{"t":"' + "M12–M15 ".repeat(2000) + '"}';
  const lines = [];
  for (let i = 0; i < 900; i += 1) lines.push(dashLine);
  const contents = lines.join("\n") + "\n";
  assert.ok(
    Buffer.byteLength(contents) > 4 * 1024 * 1024,
    "fixture must exceed one read buffer",
  );
  const { dir, file } = tempFile("wide.jsonl", contents);
  const state = createReadState(file);
  let bad = 0;
  let count = 0;
  readNewLines(
    state,
    (line) => {
      count += 1;
      if (line.includes("�")) bad += 1;
      JSON.parse(line);
    },
    Date.now(),
  );
  assert.equal(count, 900);
  assert.equal(bad, 0, bad + " lines were corrupted at a read boundary");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a truncated or replaced file restarts cleanly", () => {
  const { dir, file } = tempFile("t.jsonl", '{"a":1}\n{"b":2}\n');
  const state = createReadState(file);
  readNewLines(state, () => {}, Date.now());
  assert.ok(state.offset > 0);

  fs.writeFileSync(file, '{"z":9}\n');
  const seen = [];
  readNewLines(state, (line) => seen.push(line), Date.now());
  assert.deepEqual(
    seen,
    ['{"z":9}'],
    "the reader did not reset after truncation",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an un-terminated final line is emitted once the file goes quiet", () => {
  const { dir, file } = tempFile("t.jsonl", '{"a":1}\n{"b":2}');
  const state = createReadState(file);
  const now = Date.now();

  const fresh = [];
  readNewLines(state, (line) => fresh.push(line), now);
  assert.deepEqual(
    fresh,
    ['{"a":1}'],
    "the tail was emitted while the file was still hot",
  );

  const idle = [];
  readNewLines(state, (line) => idle.push(line), now + 60_000);
  assert.deepEqual(
    idle,
    ['{"b":2}'],
    "the stranded final line was never emitted",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a file that does not exist is not fatal", () => {
  const state = createReadState("/definitely/not/here.jsonl");
  assert.equal(
    readNewLines(state, () => assert.fail("should not emit"), Date.now()),
    false,
  );
});

test("blank lines are skipped rather than counted as records", () => {
  const { dir, file } = tempFile("t.jsonl", '{"a":1}\n\n\n{"b":2}\n');
  const state = createReadState(file);
  const seen = [];
  readNewLines(state, (line) => seen.push(line), Date.now());
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}']);
  fs.rmSync(dir, { recursive: true, force: true });
});
