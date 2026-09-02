import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  appendPrivateFile,
  writePrivateAtomic,
} from "../lib/private-state.js";

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "muster-console-state-"));
}

test("console persistence creates private directories and files", (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "state", "history.jsonl");

  appendPrivateFile(file, "one\n");
  appendPrivateFile(file, "two\n");
  assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo\n");

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, PRIVATE_DIRECTORY_MODE);
    assert.equal(fs.statSync(file).mode & 0o777, PRIVATE_FILE_MODE);
  }

  writePrivateAtomic(file, "replacement\n");
  assert.equal(fs.readFileSync(file, "utf8"), "replacement\n");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, PRIVATE_FILE_MODE);
  }
});

test("console persistence refuses a symlinked state file", {
  skip: process.platform === "win32",
}, (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target.txt");
  const file = path.join(root, "state", "history.jsonl");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(target, "untouched\n");
  fs.symlinkSync(target, file);

  assert.throws(() => appendPrivateFile(file, "bad\n"), /not a regular file/);
  assert.equal(fs.readFileSync(target, "utf8"), "untouched\n");
});
