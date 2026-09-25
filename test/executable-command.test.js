/*
 * A standalone executable prints commands that name itself: by its bare name
 * when PATH finds this very file first, otherwise by a path each shell runs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executableCommand, invocation } from "../lib/invocation.js";

const posix = (files, pathEnv, links = {}) => ({
  env: { PATH: pathEnv },
  platform: "linux",
  exists: (f) => files.includes(f),
  realpath: (f) => links[f] ?? f,
});

test("an executable that PATH finds first is run by its name", () => {
  const exe = "/home/dev/.local/bin/agent-console";
  assert.equal(executableCommand(exe, posix([exe], "/usr/bin:/home/dev/.local/bin")), "agent-console");
});

test("a Homebrew symlink on PATH that resolves to this file counts as this file", () => {
  const exe = "/opt/homebrew/Cellar/agent-console/0.3.0/bin/agent-console";
  const link = "/opt/homebrew/bin/agent-console";
  assert.equal(executableCommand(exe, posix([link], "/opt/homebrew/bin", { [link]: exe })), "agent-console");
});

test("another copy earlier on PATH means the full path is printed", () => {
  const exe = "/home/dev/Downloads/agent-console";
  const other = "/usr/local/bin/agent-console";
  assert.equal(executableCommand(exe, posix([other, exe], "/usr/local/bin:/home/dev/Downloads")), exe);
});

test("a path with spaces is quoted on macOS and Linux", () => {
  const exe = "/Users/dev/My Tools/agent-console-darwin-arm64";
  assert.equal(executableCommand(exe, posix([], "/usr/bin")), `"${exe}"`);
});

test("on Windows the name drops .exe, and a quoted path gets PowerShell's call operator", () => {
  const dir = "C:\\Users\\dev\\AppData\\Local\\Programs\\AgentConsole";
  const exe = dir + "\\agent-console.exe";
  const win = (files) => ({ env: { PATH: `C:\\Windows;${dir}` }, platform: "win32", exists: (f) => files.includes(f), realpath: (f) => f });
  assert.equal(executableCommand(exe, win([exe])), "agent-console");
  assert.equal(executableCommand(exe, win([])), exe);
  const spaced = "C:\\Users\\dev\\My Tools\\agent-console-win32-x64.exe";
  assert.equal(executableCommand(spaced, win([])), `& "${spaced}"`);
});

test("run under node, nothing changes", () => {
  assert.match(invocation("0.2.2", "/tmp/agent-console/bin/agent-console.mjs", null), /^node ".+agent-console\.mjs"$/u);
  assert.match(invocation("0.2.2", "/tmp/_npx/abc/node_modules/x/bin/agent-console.mjs", null), /^npx --yes https:/u);
});
