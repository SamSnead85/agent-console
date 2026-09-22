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
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { packageFiles, packageTarball } from "../lib/hub/package.js";
import { parseJoinTarget, projectLabel } from "../lib/reporter.js";
import { runOnce } from "../lib/collector/collector.js";
import { readConfig } from "../lib/config.js";
import { hubAddresses, isLocalRequest, isPublicPath } from "../lib/hub/routes.js";
import { claudeSession } from "./fixtures/transcripts.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function untar(buffer) {
  const files = new Map();
  for (let at = 0; at + 512 <= buffer.length;) {
    const header = buffer.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/su, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/su, "").trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(sum, Number.parseInt(header.subarray(148, 156).toString("ascii"), 8), "header checksum for " + name);
    files.set(prefix ? prefix + "/" + name : name, buffer.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test("the hub hands out exactly the package: everything a reporter needs, nothing private", () => {
  const files = untar(zlib.gunzipSync(packageTarball(ROOT)));
  for (const needed of ["package/package.json", "package/bin/agent-console.mjs", "package/lib/reporter.js", "package/lib/collector/collector.js", "package/lib/collector/prices.json", "package/LICENSE"]) {
    assert.ok(files.has(needed), needed + " is missing from the tarball");
  }
  for (const name of files.keys()) {
    assert.match(name, /^package\//u);
    assert.doesNotMatch(name, /(^|\/)(test|\.git|node_modules)\/|\.png$/u, name + " should not be handed out");
  }
  assert.deepEqual(JSON.parse(files.get("package/package.json")), JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")));
  assert.equal(packageFiles(ROOT).length, files.size);
});

test("a join link is read however it arrives", () => {
  const want = { hub: "http://192.168.1.20:6787", code: "K7Q2-9XMA" };
  assert.deepEqual(parseJoinTarget("http://192.168.1.20:6787/join#K7Q2-9XMA"), want);
  assert.deepEqual(parseJoinTarget("http://192.168.1.20:6787/join#k7q29xma"), want);
  assert.deepEqual(parseJoinTarget("http://192.168.1.20:6787", "K7Q2-9XMA"), want);
  assert.deepEqual(parseJoinTarget("192.168.1.20:6787", "k7q2 9xma"), want);
  assert.deepEqual(parseJoinTarget("http://192.168.1.20:6787/join?code=K7Q2-9XMA"), want);
  assert.throws(() => parseJoinTarget("http://192.168.1.20:6787/join"), /missing or mistyped/u);
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
  for (const p of ["/join", "/api/join", "/api/ingest", "/agent-console-0.2.0.tgz", "/fonts/x.woff2"]) assert.equal(isPublicPath(p), true, p);
  for (const p of ["/", "/api/console", "/api/invitations", "/api", "/console.js", "/agent-console-evil.tgz"]) assert.equal(isPublicPath(p), false, p);
});
