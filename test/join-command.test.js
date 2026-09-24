/**
 * The command a teammate pastes into a terminal to join (0.2.2 security fix).
 *
 * The join page used to check only the first two dot-separated parts of its
 * #fragment and then put the whole of location.href, in double quotes, into
 * that command, so shell syntax after the fingerprint, in a query string or in
 * a host name went along with it. These tests run the real public/join.js
 * against real URLs and hold every way a link can carry something: the
 * fragment must be exactly a code and a fingerprint, the link is rebuilt from
 * checked parts, and it reaches the command single-quoted, as one literal
 * argument in every shell there is to try it in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { joinCommand, releaseUrl, SAFE_JOIN_LINK } from "../lib/invocation.js";
import { parseJoinTarget } from "../lib/reporter.js";

const SOURCE = fs.readFileSync(new URL("../public/join.js", import.meta.url), "utf8");
const VERSION = "0.2.2";
const PREFIX = `npx --yes ${releaseUrl(VERSION)} join `;
const CODE = "AAAAAAAAAAAAAAAAAAAAAA";
const PRINT = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** Runs the join page at `href` and presses Copy; what it would put on the clipboard. */
async function joinPage(href, { version = VERSION } = {}) {
  const url = new URL(href);
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) {
      elements.set(id, { id, textContent: "", hidden: true, disabled: false, href: "", value: "", listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; }, select() {} });
    }
    return elements.get(id);
  };
  let clipboard = null;
  const sandbox = {
    document: { getElementById: $, querySelectorAll: () => [], execCommand: () => false },
    location: { href: url.href, hash: url.hash, origin: url.origin, pathname: url.pathname, host: url.host },
    fetch: async () => ({ json: async () => ({ product: "Agent Console", version, demo: false }) }),
    navigator: { clipboard: { writeText: async (text) => { clipboard = text; } } },
  };
  vm.runInNewContext(SOURCE, sandbox);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await $("copyBtn").listeners.click();
  return { command: clipboard, shown: $("cmd").textContent, disabled: $("copyBtn").disabled, refused: !$("noCode").hidden };
}

/** Shells on this machine to paste a command into. */
function shells() {
  const found = [];
  for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash"]) if (fs.existsSync(shell)) found.push(shell);
  return found;
}

function powershell() {
  const names = process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    for (const name of names) if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

test("a well-formed link: the command carries exactly that link, single-quoted, and nothing else", async () => {
  const link = `http://192.168.1.20:6788/join#${CODE}.${PRINT}`;
  const page = await joinPage(link);
  assert.equal(page.refused, false);
  assert.equal(page.command, `${PREFIX}'${link}'`);
  assert.equal(page.shown, `${PREFIX}'${link}'`.replace(CODE, "••••••••"), "the code is masked on screen");
  // Written the way the console writes it, too.
  assert.equal(joinCommand(VERSION, link), page.command);
  for (const ipv6 of [`http://[fd12::1]:6788/join#${CODE}.${PRINT}`, `https://192.168.1.20:6788/join#${CODE}.${PRINT}`]) {
    assert.equal((await joinPage(ipv6)).command, `${PREFIX}'${ipv6}'`);
  }
});

test("S1: shell syntax anywhere in the link never reaches the command", async () => {
  const hostile = [
    // The review's link: a genuine console, and a third part after the fingerprint.
    "http://192.168.1.20:6788/join#" + CODE + "." + PRINT + ".$(touch${IFS}/tmp/pwned)",
    "http://192.168.1.20:6788/join#" + CODE + "." + PRINT + "\";touch /tmp/pwned;\"",
    "http://192.168.1.20:6788/join#" + CODE + "." + PRINT + "'$(touch /tmp/pwned)'",
    "http://192.168.1.20:6788/join#" + CODE + "." + PRINT + "`touch /tmp/pwned`",
    "http://192.168.1.20:6788/join#" + CODE + "." + PRINT + "%24(touch%20/tmp/pwned)",
    "http://192.168.1.20:6788/join#$(id)" + CODE.slice(5) + "." + PRINT,
    // Shell syntax in the host name: browsers accept it there.
    "http://a$(touch${IFS}x)b.example:6788/join#" + CODE + "." + PRINT,
    "http://a'b.example:6788/join#" + CODE + "." + PRINT,
    "http://a;b&c.example:6788/join#" + CODE + "." + PRINT,
    // Only /join is a join page.
    "http://192.168.1.20:6788/other#" + CODE + "." + PRINT,
  ];
  for (const href of hostile) {
    const page = await joinPage(href);
    assert.equal(page.command, null, "a command was offered for " + href);
    assert.equal(page.disabled, true, href);
    assert.equal(page.refused, true, href);
    assert.throws(() => joinCommand(VERSION, new URL(href).href), /unexpected characters/u, href);
  }
});

test("S1: a query string or user info in the link is dropped; the command is rebuilt from checked parts", async () => {
  const clean = `http://192.168.1.20:6788/join#${CODE}.${PRINT}`;
  for (const href of [
    `http://192.168.1.20:6788/join?x=$(touch${"${IFS}"}/tmp/pwned)#${CODE}.${PRINT}`,
    `http://someone:secret@192.168.1.20:6788/join#${CODE}.${PRINT}`,
  ]) {
    assert.equal((await joinPage(href)).command, `${PREFIX}'${clean}'`, href);
  }
});

test("S1: a version from the console that is not a plain version number gives no command", async () => {
  const page = await joinPage(`http://192.168.1.20:6788/join#${CODE}.${PRINT}`, { version: "0.2.2/../../evil" });
  assert.equal(page.command, null);
});

test("S1: pasted into a shell, the command's link is one literal argument", { skip: shells().length === 0 && "no POSIX shell here" }, async () => {
  for (const link of [`http://192.168.1.20:6788/join#${CODE}.${PRINT}`, `http://[fd12::1]:6788/join#${CODE}.${PRINT}`]) {
    const { command } = await joinPage(link);
    const rest = command.slice(PREFIX.length);
    for (const shell of shells()) {
      const run = spawnSync(shell, ["-c", `printf '%s\\n' ${rest}`], { encoding: "utf8" });
      assert.equal(run.status, 0, shell + ": " + run.stderr);
      assert.equal(run.stdout, link + "\n", shell);
    }
  }
});

test("S1: pasted into PowerShell, the command's link is one literal argument", { skip: !powershell() && "PowerShell is not installed here" }, async () => {
  const link = `http://192.168.1.20:6788/join#${CODE}.${PRINT}`;
  const { command } = await joinPage(link);
  const run = spawnSync(powershell(), ["-NoProfile", "-NonInteractive", "-Command", `Write-Output ${command.slice(PREFIX.length)}`], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), link);
});

test("the reporter reads a link with the quotes cmd.exe passes through, and the console's commands are single-quoted", () => {
  const link = `http://192.168.1.20:6788/join#${CODE}.${PRINT}`;
  const plain = parseJoinTarget(link);
  assert.deepEqual(plain, { hub: "https://192.168.1.20:6788", code: CODE, fingerprint: PRINT });
  assert.deepEqual(parseJoinTarget(`'${link}'`), plain);
  assert.deepEqual(parseJoinTarget(`"${link}"`), plain);
  assert.equal(SAFE_JOIN_LINK.test(link), true);
  assert.equal(SAFE_JOIN_LINK.test(link + "'"), false);
  const routes = fs.readFileSync(new URL("../lib/hub/routes.js", import.meta.url), "utf8");
  assert.match(routes, /command: joinCommand\(version, link\)/u);
  assert.doesNotMatch(SOURCE.replace(/\/\*[\s\S]*?\*\//gu, ""), /location\.href/u, "the join page must not put location.href into anything");
});
