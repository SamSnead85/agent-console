import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { BIND_ADDRESS, DEFAULT_PORT, help, readConfig } from "../lib/config.js";
import { help as reporterHelp } from "../lib/reporter.js";
import { invocation, releaseUrl } from "../lib/invocation.js";

test("a boolean switch never swallows the argument that follows it", () => {
  const config = readConfig(["--demo", "--port", "7404"], {});
  assert.equal(config.demo, true);
  assert.equal(config.port, 7404);
});

test("value-taking options take their value, in both spellings", () => {
  const config = readConfig(["--port", "7404", "--poll-ms", "2000", "--retention-days=3"], {});
  assert.equal(config.port, 7404);
  assert.equal(config.pollMs, 2000);
  assert.equal(config.retentionDays, 3);
});

test("the console is on 127.0.0.1; reporting sits on the next port unless told otherwise", () => {
  assert.equal(BIND_ADDRESS, "127.0.0.1");
  const plain = readConfig([], {});
  assert.equal(plain.port, DEFAULT_PORT);
  assert.equal(plain.reportPort, DEFAULT_PORT + 1);
  assert.equal(plain.listen, "127.0.0.1");
  assert.equal(plain.allowPublic, false);
  assert.equal(readConfig(["--port", "7000"], {}).reportPort, 7001);
  assert.equal(readConfig(["--report-port", "7100"], {}).reportPort, 7100);
  assert.deepEqual(readConfig(["--listen", "not-an-address"], {}).listenErrors.length, 1);
});

test("a join link lives at most an hour", () => {
  assert.equal(readConfig(["--invite-minutes", "1440"], {}).inviteMinutes, 60);
  assert.equal(readConfig(["--invite-minutes", "15"], {}).inviteMinutes, 15);
});

test("custom transcript roots are respected, and demo reads no home at all", () => {
  const roots = ["--claude-root", "/tmp/claude-source", "--codex-root", "/tmp/codex-source"];
  assert.equal(readConfig(roots, {}).claudeRoot, "/tmp/claude-source");
  assert.equal(readConfig(roots, {}).codexRoot, "/tmp/codex-source");
  const demo = readConfig(["--demo", ...roots], {});
  assert.equal(demo.home, null);
  assert.equal(demo.claudeRoot, null);
  assert.equal(demo.stateDir, null);
});

test("every printed command runs this copy: never a bare name npx could resolve elsewhere", () => {
  const fromNpx = invocation("0.2.1", "/home/dev/.npm/_npx/abc123/node_modules/@lockedinlabs/agent-console/bin/agent-console.mjs");
  assert.equal(fromNpx, `npx --yes ${releaseUrl("0.2.1")}`);
  assert.match(releaseUrl("0.2.1"), /^https:\/\/github\.com\/SamSnead85\/agent-console\/releases\/download\/v0\.2\.1\/lockedinlabs-agent-console-0\.2\.1\.tgz$/u);
  const fromDownload = invocation("0.2.1", "/home/dev/agent-console-main/bin/agent-console.mjs");
  assert.equal(fromDownload, `node "${path.resolve("/home/dev/agent-console-main/bin/agent-console.mjs")}"`);
  for (const text of [help(fromDownload), reporterHelp(fromDownload), help(fromNpx), reporterHelp(fromNpx)]) {
    assert.doesNotMatch(text, /npx\s+(--yes\s+)?agent-console\b/u);
    assert.doesNotMatch(text, /^\s*agent-console\s/mu, "a bare command line");
  }
});
