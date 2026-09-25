/*
 * A standalone executable prints commands that name itself: by its bare name
 * when PATH finds this very file first, otherwise by a path each shell runs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { executableCommand, invocation, releaseAsset, shellArgument, verifiedRun } from "../lib/invocation.js";
import { carriedOptions } from "../lib/reporter.js";

const posixShell = { skip: process.platform === "win32" ? "sh is not on Windows" : false };
// Each name carries something a shell would act on inside double quotes or bare.
const HOSTILE = [
  "tools$(touch PROOF)", "tools`touch PROOF`", "it's here", 'say "hi"', "My Tools",
  "a;touch PROOF", "a&touch PROOF", "a|touch PROOF", "a<b", "a>PROOF", "a\\b", "$HOME",
];

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

test("run under node, the local entry is a literal argument and npx remains verified", () => {
  assert.match(invocation("0.2.2", "/tmp/agent-console/bin/agent-console.mjs", {}, null), /^node '.+agent-console\.mjs'$/u);
  assert.equal(invocation("0.2.2", "/tmp/_npx/abc/node_modules/x/bin/agent-console.mjs", {}, null), verifiedRun("0.2.2"));
});

test("Node restart commands preserve the entry and carried paths without shell substitution", posixShell, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-node-command-"));
  try {
    for (const [i, name] of HOSTILE.entries()) {
      const entry = path.join(root, String(i), name, "fixture.cjs");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
      const stateDir = path.join(root, name, "state");
      const command = [invocation("0.3.0", entry, {}, null), "report", ...carriedOptions(new Map([["state-dir", stateDir]]))].join(" ");
      const result = spawnSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, `${command}\n${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), ["report", "--state-dir", stateDir]);
      assert.equal(fs.existsSync(path.join(root, "PROOF")), false, command);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("carried paths use PowerShell literal quoting, including typographic quotes", () => {
  for (const name of ["it's here", "it’s here", "‘x‚‛", "tools$(whoami)", "tools`whoami`", "My Tools"]) {
    const dir = path.resolve(name);
    const args = carriedOptions(new Map([["state-dir", dir]]), undefined, "win32");
    assert.deepEqual(args, ["--state-dir", "'" + dir.replace(/['‘’‚‛]/gu, "$&$&") + "'"]);
  }
});

const pwsh = process.platform === "win32" ? "pwsh.exe" : "pwsh";
const hasPowerShell = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { stdio: "ignore" }).status === 0;
test("PowerShell runs the printed Node command and retained package with literal paths", { skip: process.platform !== "win32" && !hasPowerShell && "PowerShell is not installed here" }, () => {
  assert.ok(hasPowerShell, "Windows CI must execute the native PowerShell regression");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-powershell-command-"));
  try {
    for (const name of ["it's here", "it’s here", "‘x‚‛", "tools$(Get-Date)", "tools`Get-Date`", "My Tools", "tools”;Write-Output PROOF;#"]) {
      const entry = path.join(root, name, "fixture.cjs");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
      const stateDir = path.join(root, name, "state");
      const prefix = process.platform === "win32" ? invocation("0.3.0", entry, {}, null) : `node ${shellArgument(entry, "win32")}`;
      const command = [prefix, "report", ...carriedOptions(new Map([["state-dir", stateDir]]), undefined, "win32")].join(" ");
      const result = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, `${command}\n${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), ["report", "--state-dir", stateDir]);
    }
    // Parse npx's actual printed package argument with a synthetic Node receiver;
    // never fetch or install a package to exercise this quoting boundary.
    const kept = path.join(root, "tools”;Write-Output PROOF;#", releaseAsset("0.3.0"));
    const command = invocation("0.3.0", path.join(root, "_npx", "entry.mjs"), { AGENT_CONSOLE_PACKAGE: kept }, null);
    assert.ok(command.startsWith("npx --yes "));
    const receiver = path.join(root, "receiver.cjs");
    fs.writeFileSync(receiver, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const parsed = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", `node ${shellArgument(receiver, "win32")} ${command.slice("npx --yes ".length)}`], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.deepEqual(JSON.parse(parsed.stdout), [`file:${kept}`]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an executable names itself even when the environment carries a kept package", () => {
  const env = { PATH: "/usr/bin", AGENT_CONSOLE_PACKAGE: "/home/dev/.agent-console/releases/lockedinlabs-agent-console-0.2.2.tgz" };
  assert.equal(invocation("0.2.2", "/tmp/_npx/abc/node_modules/x/bin/agent-console.mjs", env, "/opt/tools/agent-console"), "/opt/tools/agent-console");
});

/* ── Printed commands are literal: nothing in a file name is run by the shell ── */

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
