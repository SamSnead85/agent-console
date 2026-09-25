/*
 * A standalone executable prints commands that name itself: by its bare name
 * when PATH finds this very file first, otherwise by a path each shell runs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executableCommand, invocation, verifiedRun } from "../lib/invocation.js";

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
  assert.equal(executableCommand(exe, posix([], "/usr/bin")), `'${exe}'`);
});

test("on Windows the name drops .exe, and a quoted path gets PowerShell's call operator", () => {
  const dir = "C:\\Users\\dev\\AppData\\Local\\Programs\\AgentConsole";
  const exe = dir + "\\agent-console.exe";
  const win = (files) => ({ env: { PATH: `C:\\Windows;${dir}` }, platform: "win32", exists: (f) => files.includes(f), realpath: (f) => f });
  assert.equal(executableCommand(exe, win([exe])), "agent-console");
  assert.equal(executableCommand(exe, win([])), exe);
  const spaced = "C:\\Users\\dev\\My Tools\\agent-console-win32-x64.exe";
  assert.equal(executableCommand(spaced, win([])), `& '${spaced}'`);
});

test("run under node, nothing changes", () => {
  assert.match(invocation("0.2.2", "/tmp/agent-console/bin/agent-console.mjs", {}, null), /^node ".+agent-console\.mjs"$/u);
  assert.equal(invocation("0.2.2", "/tmp/_npx/abc/node_modules/x/bin/agent-console.mjs", {}, null), verifiedRun("0.2.2"));
});

test("an executable names itself even when the environment carries a kept package", () => {
  const env = { PATH: "/usr/bin", AGENT_CONSOLE_PACKAGE: "/home/dev/.agent-console/releases/lockedinlabs-agent-console-0.2.2.tgz" };
  assert.equal(invocation("0.2.2", "/tmp/_npx/abc/node_modules/x/bin/agent-console.mjs", env, "/opt/tools/agent-console"), "/opt/tools/agent-console");
});

/* ── Printed commands are literal: nothing in a file name is run by the shell ── */

// Each name carries something a shell would act on inside double quotes or bare.
const HOSTILE = [
  "tools$(touch PROOF)", "tools`touch PROOF`", "it's here", 'say "hi"', "My Tools",
  "a;touch PROOF", "a&touch PROOF", "a|touch PROOF", "a<b", "a>PROOF", "a\\b", "$HOME",
];

test("a full path is single-quoted for sh, with ' written as '\\''", () => {
  for (const dir of HOSTILE) {
    const exe = `/home/dev/${dir}/agent-console`;
    assert.equal(executableCommand(exe, posix([], "/usr/bin")), "'" + exe.replace(/'/gu, "'\\''") + "'", dir);
  }
});

test("a name that PATH finds is single-quoted for sh when it is not a plain word", () => {
  for (const name of ["agent-console$(touch PROOF)", "agent-console`id`", "agent console", "agent-console;id", "it's"]) {
    const exe = `/home/dev/.local/bin/${name}`;
    assert.equal(executableCommand(exe, posix([exe], "/home/dev/.local/bin")), "'" + name.replace(/'/gu, "'\\''") + "'", name);
  }
});

test("PowerShell gets a single-quoted literal behind &, with ' (and its typographic forms) doubled", () => {
  const win = (files, dir) => ({ env: { PATH: dir }, platform: "win32", exists: (f) => files.includes(f), realpath: (f) => f });
  for (const dir of HOSTILE.filter((d) => d !== "a\\b").concat(["it’s", "‘x‚‛"])) {
    const exe = `C:\\Users\\dev\\${dir}\\agent-console.exe`;
    assert.equal(executableCommand(exe, win([], "C:\\Windows")), "& '" + exe.replace(/['‘’‚‛]/gu, "$&$&") + "'", dir);
  }
  const odd = "C:\\Tools\\agent-console$(calc).exe";
  assert.equal(executableCommand(odd, win([odd], "C:\\Tools")), "& 'agent-console$(calc)'");
});

const posixShell = { skip: process.platform === "win32" ? "sh is not on Windows" : false };

test("sh runs the printed command as this very file, with its options, and runs nothing else", posixShell, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-invocation-"));
  try {
    const cases = [];
    for (const dir of HOSTILE) {
      const exe = path.join(root, "d" + cases.length, dir, "agent-console");
      cases.push({ exe, onPath: false });
    }
    // The PATH-basename case: an odd file name on PATH, found first.
    cases.push({ exe: path.join(root, "bin", "agent-console$(touch PROOF)"), onPath: true });
    for (const { exe, onPath } of cases) {
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, '#!/bin/sh\nprintf "fixture ran:%s\\n" "$*"\n', { mode: 0o755 });
      const PATH = onPath ? `${path.dirname(exe)}:/usr/bin:/bin` : "/usr/bin:/bin";
      const command = executableCommand(exe, { env: { PATH } }) + " report --once";
      const result = spawnSync("/bin/sh", ["-c", command], { cwd: root, env: { PATH }, encoding: "utf8" });
      assert.equal(result.status, 0, `${command}\n${result.stderr}`);
      assert.equal(result.stdout, "fixture ran:report --once\n", command);
      assert.equal(fs.existsSync(path.join(root, "PROOF")), false, `the shell ran part of ${command}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
