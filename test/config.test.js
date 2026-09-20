import test from "node:test";
import assert from "node:assert/strict";

import {
  BIND_ADDRESS,
  DEFAULT_PORT,
  HELP,
  readConfig,
} from "../lib/config.js";

test("process termination and HTTP ingest can never be enabled", () => {
  const cases = [
    [[], {}],
    [["--allow-terminate"], {}],
    [["--no-kill=false", "--no-ingest=false"], {}],
    [[], { MUSTER_CONSOLE_ALLOW_TERMINATE: "1" }],
    [[], { MUSTER_CONSOLE_NO_INGEST: "0" }],
  ];
  for (const [argv, env] of cases) {
    const config = readConfig(argv, env);
    assert.equal(config.killEnabled, false, JSON.stringify({ argv, env }));
    assert.equal(config.ingestEnabled, false, JSON.stringify({ argv, env }));
  }
});

test("a boolean switch never swallows the argument that follows it", () => {
  const config = readConfig(["--no-github", "--port", "7404"], {});
  assert.equal(config.githubEnabled, false);
  assert.equal(config.port, 7404);
});

test("retired mutation flags and routes are not advertised", () => {
  assert.doesNotMatch(HELP, /allow-terminate|no-kill|no-ingest|api\/session/iu);
});

test("value-taking options still take their value", () => {
  const config = readConfig(
    ["--port", "7404", "--poll-ms", "2000", "--window-hours", "12"],
    {},
  );
  assert.equal(config.port, 7404);
  assert.equal(config.pollMs, 2000);
  assert.equal(config.windowMs, 12 * 3600 * 1000);
  assert.equal(readConfig(["--poll-ms=2500"], {}).pollMs, 2500);
});

test("the bind address is a constant with no override", () => {
  assert.equal(BIND_ADDRESS, "127.0.0.1");
  assert.equal(readConfig(["--bind", "0.0.0.0"], {}).bind, undefined);
  assert.equal(readConfig([], {}).port, DEFAULT_PORT);
});


test("coordination is opt-in and can always be disabled", () => {
  assert.equal(readConfig([], {}).musterEnabled, false);
  assert.equal(readConfig(["--muster"], {}).musterEnabled, true);
  assert.equal(readConfig([], { AGENT_CONSOLE_MUSTER: "1" }).musterEnabled, true);
  assert.equal(readConfig(["--muster", "--no-muster"], {}).musterEnabled, false);
  assert.equal(readConfig(["--demo", "--muster"], {}).musterEnabled, false);
});

test("custom transcript roots are respected and demo ignores them", () => {
  const roots = ["--claude-root", "/tmp/claude-source", "--codex-root", "/tmp/codex-source"];
  assert.equal(readConfig(roots, {}).claudeRoot, "/tmp/claude-source");
  assert.equal(readConfig(roots, {}).codexRoot, "/tmp/codex-source");
  assert.equal(readConfig([], {AGENT_CONSOLE_CLAUDE_ROOT: "/tmp/custom"}).claudeRoot, "/tmp/custom");
  assert.notEqual(readConfig(["--demo", ...roots], {}).claudeRoot, "/tmp/claude-source");
});
