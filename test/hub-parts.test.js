/**
 * The smaller pieces of the hub: the package it hands out, how a join link is
 * read, the one opt-in label, the collector's retention window and in-process
 * delivery, and the --listen option.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseJoinTarget, projectLabel } from "../lib/reporter.js";
import { runOnce } from "../lib/collector/collector.js";
import { readConfig } from "../lib/config.js";
import { hubAddresses, isLocalRequest } from "../lib/hub/routes.js";
import { claudeSession } from "./fixtures/transcripts.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every copy of the package carries its licences", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const needed of ["THIRD_PARTY_NOTICES.md", "SECURITY.md", "CHANGELOG.md", "public/"]) {
    assert.ok(manifest.files.includes(needed), "npm pack would leave out " + needed);
  }
  const ofl = fs.readFileSync(path.join(ROOT, "public", "fonts", "LICENSE-OFL.txt"), "utf8");
  assert.match(ofl, /IBM Plex Sans: Copyright 2019 IBM Corp\./u);
  assert.match(ofl, /IBM Plex Mono: Copyright 2017 IBM Corp\./u);
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/u);
});

test("the README's one-command install names this version's release", () => {
  // Bumping the version fails here until the README's link is bumped with it.
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const links = [...readme.matchAll(/releases\/download\/v([^/\s]+)\/lockedinlabs-agent-console-([^\s]+?)\.tgz/gu)];
  assert.ok(links.length > 0, "the README has no one-command install");
  for (const [, tag, file] of links) assert.deepEqual([tag, file], [version, version]);
});

test("--version prints the package version and starts nothing", () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const flag of ["--version", "-v"]) {
    const run = spawnSync(process.execPath, [path.join(ROOT, "bin", "agent-console.mjs"), flag], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "agent-console " + version + "\n");
  }
});

test("a join link carries the code and the certificate to pin; a typed code needs the fingerprint", () => {
  const code = "A".repeat(21) + "b";
  const fp = "Z".repeat(42) + "9";
  const want = { hub: "https://192.168.1.20:6788", code, fingerprint: fp };
  assert.deepEqual(parseJoinTarget(`http://192.168.1.20:6788/join#${code}.${fp}`), want);
  assert.deepEqual(parseJoinTarget("192.168.1.20:6788", "k7q2 9xma", fp), { ...want, code: "K7Q2-9XMA" });
  assert.equal(parseJoinTarget(`http://[fd00::20]:6788/join#${code}.${fp}`).hub, "https://[fd00::20]:6788");
  assert.throws(() => parseJoinTarget("http://192.168.1.20:6788/join"), /missing or mistyped/u);
  assert.throws(() => parseJoinTarget(`http://192.168.1.20:6788/join#${code}`), /no certificate fingerprint/u, "a link without the pin is refused");
  assert.throws(() => parseJoinTarget("192.168.1.20:6788", "K7Q2-9XMA"), /no certificate fingerprint/u);
  assert.throws(() => parseJoinTarget(), /Paste the join link/u);
});

test("the opt-in label is a folder's name, reduced; never a path", () => {
  assert.equal(projectLabel("/home/dev/mobile-app"), "mobile-app");
  assert.equal(projectLabel("C:\\work\\Atlas API\\"), "atlas-api");
  assert.equal(projectLabel("/srv/123-svc"), "p-123-svc");
  assert.equal(projectLabel("/"), null);
  for (const input of ["/home/someone/private/thing", "/a/b/c/dd"]) assert.doesNotMatch(String(projectLabel(input)), /\//u);
});

test("the collector reads only the retention window, and a delivered spool is emptied", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collector-window-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "state");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "enrollment.json"), JSON.stringify({ v: 1, organizationId: "org_test",
    device: { id: "dev_test", label: "Test" }, orgSalt: Buffer.alloc(32, 9).toString("base64url") }), { mode: 0o600 });
  const logs = path.join(root, "logs");
  fs.mkdirSync(logs);
  const now = Date.now();
  // an old transcript, untouched for ten days, and a fresh one
  const old = path.join(logs, "old.jsonl");
  fs.writeFileSync(old, claudeSession({ sessionId: "old-session", cwd: "/tmp/old", start: now - 10 * 86_400_000, turns: 2 }));
  fs.utimesSync(old, new Date(now - 10 * 86_400_000), new Date(now - 10 * 86_400_000));
  fs.writeFileSync(path.join(logs, "new.jsonl"), claudeSession({ sessionId: "new-session", cwd: "/tmp/new", start: now - 5 * 60_000, turns: 3 }));

  const delivered = [];
  const labels = [];
  const options = {
    directory, roots: [{ tool: "claude-code", directory: logs }], compact: true, watch: true,
    sinceMs: now - 8 * 86_400_000,
    onLocalLabel: (x) => labels.push(x),
    deliver: async (device, records, freshness) => {
      delivered.push(...records);
      assert.equal(freshness.mode, "live");
      return { accepted: records.length, duplicate: 0, expired: 0, rejected: [] };
    },
  };
  const result = await runOnce(options);
  assert.equal(result.coverage.filesSkipped, 1, "the old transcript was not opened");
  assert.equal(delivered.length, 3);
  assert.ok(delivered.every((r) => !JSON.stringify(r).includes("/tmp/new")), "a hook's view of the path reached a record");
  assert.ok(labels.some((l) => l.cwd === "/tmp/new"), "the hub's own machine can name its lanes");
  assert.equal(fs.statSync(path.join(directory, "records-v2.ndjson")).size, 0, "the delivered spool was emptied");
  const again = await runOnce(options);
  assert.equal(again.emitted, 0, "nothing is delivered twice after compaction");
});

test("--listen takes an address, and the console never answers a foreign host", () => {
  assert.equal(readConfig([], {}).listen, "127.0.0.1");
  assert.equal(readConfig(["--listen", "0.0.0.0"], {}).listen, "0.0.0.0");
  assert.deepEqual(readConfig(["--listen", "0.0.0.0"], {}).listenErrors, []);
  assert.equal(readConfig(["--listen", "my-laptop"], {}).listenErrors.length, 1);
  assert.equal(readConfig(["--retention-days", "400"], {}).retentionDays, 90);
  assert.equal(readConfig(["--demo"], {}).stateDir, null, "demo keeps nothing on disk");
  assert.equal(readConfig(["--no-local"], {}).local, false);
  assert.deepEqual(hubAddresses("127.0.0.1", 6787), { network: false, urls: ["http://127.0.0.1:6787"] });
  assert.equal(hubAddresses("192.168.1.20", 6787).urls[0], "http://192.168.1.20:6787");
  const req = (host, remote) => ({ headers: { host }, socket: { remoteAddress: remote } });
  assert.equal(isLocalRequest(req("127.0.0.1:6787", "127.0.0.1")), true);
  assert.equal(isLocalRequest(req("localhost:6787", "::1")), true);
  assert.equal(isLocalRequest(req("192.168.1.20:6787", "127.0.0.1")), false, "a rebinding page");
  assert.equal(isLocalRequest(req("127.0.0.1:6787", "192.168.1.30")), false, "another machine");
});
