import test from "node:test";
import assert from "node:assert/strict";

import {
  authorizeKill,
  classify,
  fingerprint,
  listAgents,
  parsePs,
} from "../lib/procs.js";

/**
 * A captured `ps -Ao pid=,ppid=,lstart=,etime=,pcpu=,rss=,command=` snapshot
 * from this machine, trimmed. It contains every case the guard has to get
 * right: two real agents, the disclaimer wrapper that repeats a real agent's
 * argv, a Chromium helper child, the Codex desktop app-server, the code-mode
 * host, a sandbox wrapper, and the dashboard's own process tree.
 */
const CLAUDE =
  "/Users/me/Library/Application Support/Claude/claude-code/2.1.241/claude.app/Contents/MacOS/claude";
const PS = [
  "    1     0 Thu Aug 27 09:00:00 2026     08-00:00:00   0.0   9000 /sbin/launchd",
  " 1032   876 Mon Aug 24 21:57:58 2026     05-23:03:35   1.4 1675728 /Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
  " 3153  1032 Mon Aug 24 22:03:30 2026     05-22:58:03   0.0  32352 /Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host",
  " 6415 81036 Fri Aug 28 20:12:54 2026     02-00:48:39   0.0    688 /Applications/Claude.app/Contents/Helpers/disclaimer -- " +
    CLAUDE +
    " --output-format stream-json",
  " 6416  6415 Fri Aug 28 20:12:54 2026     02-00:48:39   0.9 293248 " +
    CLAUDE +
    " --output-format stream-json --verbose --model claude-opus-5",
  " 6710  6415 Fri Aug 28 20:13:37 2026     02-00:47:56   3.5 868928 " +
    CLAUDE +
    " --output-format stream-json --verbose --model claude-fable-5",
  " 7788  6710 Sat Aug 30 21:00:00 2026        00:05:00   0.1  40000 /Applications/Claude.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper --type=renderer",
  " 8000  1032 Sat Aug 30 20:00:00 2026        01:00:00   0.0  20000 /Users/me/.codex/bin/codex sandbox exec -- /bin/sh -c build",
  " 9100  6416 Sat Aug 30 21:10:00 2026        00:01:00   0.0  30000 /usr/local/bin/node server.js",
].join("\n");

const SELF = 9100; // the dashboard, a child of agent 6416 in this fixture

function rowFor(pid) {
  return parsePs(PS).find((r) => r.pid === pid);
}

test("only the real agent binaries are identified as agents", () => {
  const agents = listAgents(PS, SELF);
  const byPid = new Map(agents.map((a) => [a.pid, a]));
  assert.equal(byPid.get(6416).role, "agent");
  assert.equal(byPid.get(6710).role, "agent");
  assert.equal(
    byPid.get(1032).role,
    "host",
    "the Codex app-server is not a worker",
  );
  assert.equal(
    byPid.has(6415),
    false,
    "the disclaimer wrapper must not appear",
  );
  assert.equal(
    byPid.has(7788),
    false,
    "a Chromium helper child must not appear",
  );
  assert.equal(byPid.has(3153), false, "the code-mode host must not appear");
  assert.equal(byPid.has(8000), false, "the sandbox wrapper must not appear");
  assert.equal(byPid.has(1), false, "launchd must not appear");
});

test("host processes and the dashboard's own ancestors are never offered", () => {
  const agents = listAgents(PS, SELF);
  const byPid = new Map(agents.map((a) => [a.pid, a]));
  assert.equal(byPid.get(1032).killable, false);
  assert.equal(
    byPid.get(6416).killable,
    false,
    "an ancestor of this process must not be terminable",
  );
  assert.equal(
    byPid.get(6710).killable,
    true,
    "an unrelated agent should be terminable",
  );
});

test("a positively identified agent with a matching fingerprint is authorized", () => {
  const expected = fingerprint(rowFor(6710));
  const verdict = authorizeKill(PS, 6710, expected, SELF);
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.target.pid, 6710);
  assert.equal(verdict.target.vendor, "claude");
});

test("a pid that is not running is refused", () => {
  const verdict = authorizeKill(PS, 424242, "whatever", SELF);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "NOT_FOUND");
});

test("a pid that is not an agent is refused", () => {
  const verdict = authorizeKill(PS, 1, fingerprint(rowFor(1)), SELF);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "NOT_AN_AGENT");
});

test("vendor host infrastructure is refused even though it matches an agent binary", () => {
  const verdict = authorizeKill(PS, 1032, fingerprint(rowFor(1032)), SELF);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "HOST");
});

test("the dashboard refuses to kill itself or its own ancestors", () => {
  for (const pid of [SELF, 6416]) {
    const verdict = authorizeKill(PS, pid, fingerprint(rowFor(pid)), SELF);
    assert.equal(verdict.ok, false, "pid " + pid + " was authorized");
    assert.ok(
      verdict.code === "SELF" || verdict.code === "NOT_AN_AGENT",
      "unexpected code for pid " + pid + ": " + verdict.code,
    );
  }
  assert.equal(
    authorizeKill(PS, 6416, fingerprint(rowFor(6416)), SELF).code,
    "SELF",
  );
});

test("a recycled pid is refused: same number, different process", () => {
  const expected = fingerprint(rowFor(6710));
  // Same pid, but the process started later and is running something else —
  // exactly what a pid recycled between the poll and the confirmation looks like.
  const recycled = PS.replace(
    " 6710  6415 Fri Aug 28 20:13:37 2026     02-00:47:56   3.5 868928 " +
      CLAUDE +
      " --output-format stream-json --verbose --model claude-fable-5",
    " 6710  6415 Sat Aug 30 21:20:00 2026        00:00:10   0.1  10000 " +
      CLAUDE +
      " --output-format stream-json --verbose --model claude-haiku-4-5",
  );
  const verdict = authorizeKill(recycled, 6710, expected, SELF);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "CHANGED");
});

test("a missing or wrong fingerprint is refused — the guard never guesses", () => {
  assert.equal(authorizeKill(PS, 6710, null, SELF).code, "CHANGED");
  assert.equal(authorizeKill(PS, 6710, "", SELF).code, "CHANGED");
  assert.equal(authorizeKill(PS, 6710, "0".repeat(32), SELF).code, "CHANGED");
});

test("an empty or unreadable ps output authorizes nothing", () => {
  assert.equal(
    authorizeKill("", 6710, fingerprint(rowFor(6710)), SELF).code,
    "NOT_FOUND",
  );
  assert.equal(listAgents("", SELF).length, 0);
});

test("the fingerprint changes when the command line changes", () => {
  const a = rowFor(6710);
  const b = { ...a, cmd: a.cmd + " --extra" };
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test("classify is conservative about anything it does not recognise", () => {
  assert.equal(classify({ cmd: "/usr/bin/python3 train.py --claude" }), null);
  assert.equal(classify({ cmd: "grep claude codex" }), null);
  assert.equal(classify({ cmd: "/bin/zsh -c 'claude --help'" }), null);
});

/**
 * The three negatives above are all BARE-NAME lookalikes, and every one of them
 * passes for a reason unrelated to what the guard has to get right. The real
 * failure is an agent's full executable PATH sitting in an argument position:
 * matching was `pattern.test(row.cmd)` over the entire `ps` line, so a process
 * that merely mentioned the path was identified as an agent — and the live
 * server did prepare, confirm, and SIGTERM one.
 */
test("an agent path in an ARGUMENT does not make a process an agent", () => {
  const decoy =
    "/Users/me/.hermes/node/bin/node -e setInterval(()=>{},1e9) /Users/me/.codex/bin/codex";
  assert.equal(
    classify({ cmd: decoy }),
    null,
    "a plain node process was identified as a Codex agent",
  );

  // The realistic one: the supervisor shell, a DIFFERENT process from the agent
  // it launched. Killing it orphans the agent, so the operator believes they
  // stopped a burning session and have not.
  const wrapper =
    "/bin/sh -c /usr/local/bin/codex exec --model gpt-5 --cd /repo; echo done";
  assert.equal(classify({ cmd: wrapper }), null, "a wrapper shell was offered");

  // And an argument that is a path without any flag before it.
  assert.equal(
    classify({ cmd: "/usr/bin/node runner.js /opt/tools/bin/codex" }),
    null,
  );
});

test("a real agent is not hidden or frozen by the words in its own prompt", () => {
  // Both of these were taken from a live `ps` row and varied only in the
  // trailing prompt. The first was dropped from the roster entirely; the second
  // was labelled vendor infrastructure and made permanently unkillable.
  const withType =
    CLAUDE +
    ' --output-format stream-json -p "switch package.json to --type=module"';
  assert.deepEqual(classify({ cmd: withType }), {
    vendor: "claude",
    role: "agent",
  });

  const withHostWord =
    CLAUDE +
    ' --output-format stream-json -p "restart the app-server before tests"';
  assert.deepEqual(classify({ cmd: withHostWord }), {
    vendor: "claude",
    role: "agent",
  });
});

test("an executable path containing a space is still argv[0]", () => {
  // "…/Library/Application Support/Claude/…" — whitespace-splitting argv[0]
  // would truncate this at "Application" and identify nothing.
  assert.deepEqual(
    classify({ cmd: CLAUDE + " --output-format stream-json --verbose" }),
    { vendor: "claude", role: "agent" },
  );
});

test("the guard refuses to signal a process it did not positively identify", () => {
  const decoyPs =
    " 4101     1 Sat Aug 30 21:00:00 2026        00:05:00   0.1  40000 " +
    "/Users/me/.hermes/node/bin/node -e setInterval(()=>{},1e9) /Users/me/.codex/bin/codex";
  const rows = parsePs(decoyPs);
  assert.equal(rows.length, 1, "the fixture did not parse");
  assert.equal(listAgents(decoyPs, SELF).length, 0, "the decoy was listed");
  const verdict = authorizeKill(decoyPs, 4101, fingerprint(rows[0]), SELF);
  assert.equal(verdict.ok, false, "the decoy was authorized for SIGTERM");
  assert.equal(verdict.code, "NOT_AN_AGENT");
});

test("a credential in an argument is masked before the command is served", () => {
  // procs[].cmd is rendered in the processes drawer. It used to be cut to 160
  // characters and only then walked by redaction, so a connection string whose
  // "@host" fell past the cut lost the anchor its rule needs and the whole
  // password was served.
  const secret = "hunter2-" + "correct-horse";
  const long =
    CLAUDE +
    " --resume " +
    "y".repeat(96) +
    " postgresql://ops:" +
    secret +
    "@db.internal:5432/app";
  const line =
    " 4102     1 Sat Aug 30 21:00:00 2026        00:05:00   0.1  40000 " + long;
  const [agent] = listAgents(line, SELF);
  assert.ok(agent, "the agent row is missing");
  assert.ok(
    !agent.cmd.includes(secret),
    "a password reached the served command string: " + agent.cmd,
  );
});
