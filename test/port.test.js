/**
 * "Port 6787 is already in use" was the first wall a novice hit. The console
 * now tells apart its own copy already running (point at it) from another
 * program holding the port (move to the next free one and say so), and never
 * moves a port the person chose.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { choosePort, portFree } from "../lib/hub/port.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-console.mjs");

async function holdPort(t, handler = null) {
  const server = handler ? http.createServer(handler) : net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return server.address().port;
}

// events.once(server, "listening") also rejects on "error", so racing it
// against once("error") does not handle an occupied neighboring port.
function listenPort(server, port) {
  return new Promise((resolve, reject) => {
    const clean = () => { server.removeListener("listening", listening); server.removeListener("error", error); };
    const listening = () => { clean(); resolve(true); };
    const error = (err) => { clean(); if (err.code === "EADDRINUSE") resolve(false); else reject(err); };
    server.once("listening", listening);
    server.once("error", error);
    server.listen(port, "127.0.0.1");
  });
}
const closeServer = (server) => new Promise((resolve, reject) => {
  if (!server.listening) { resolve(); return; }
  server.close((err) => err ? reject(err) : resolve());
});

async function holdNeighboringPorts(t, hello, beforeNeighbor = null) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // Drain the deliberately unresponsive holder so an aborted HTTP probe's
    // FIN is consumed and close() can finish on every supported platform.
    const held = net.createServer((socket) => socket.resume()), moved = http.createServer(hello);
    try {
      assert.equal(await listenPort(held, 0), true);
      const port = held.address().port;
      if (port === 65_535) continue;
      await beforeNeighbor?.(port, attempt);
      if (!(await listenPort(moved, port + 1))) continue;
      t.after(async () => { await closeServer(moved); await closeServer(held); });
      return port;
    } finally {
      // Keep successful reservations until the assertions finish. Retry only
      // the expected address collision; all other errors fail the test.
      if (!moved.listening) await closeServer(held);
    }
  }
  assert.fail("could not reserve neighboring loopback ports after 20 attempts");
}

test("neighboring-port setup retries a real address collision and still reserves both ports", async (t) => {
  const blockers = [];
  t.after(async () => { for (const server of blockers) await closeServer(server); });
  let attempts = 0;
  const port = await holdNeighboringPorts(t, (_req, res) => res.end(), async (candidate, attempt) => {
    attempts += 1;
    if (attempt > 0) return;
    const blocker = net.createServer();
    blockers.push(blocker);
    // Either we reserve it or another process already did: the first
    // neighboring listen is guaranteed to encounter EADDRINUSE.
    await listenPort(blocker, candidate + 1);
  });
  assert.ok(attempts >= 2, "the colliding pair was retried, not skipped");
  assert.equal(await portFree(port, "127.0.0.1"), false);
  assert.equal(await portFree(port + 1, "127.0.0.1"), false);
});

test("port 0 means any free port, and a held port is seen as held", async (t) => {
  const port = await holdPort(t);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await portFree(port, "127.0.0.1"), false);
  const answer = await choosePort({ port: 0, host: "127.0.0.1" });
  assert.deepEqual(answer, { action: "listen", port: 0 });
});

test("another program on the default port: the console moves to the next free port", async (t) => {
  const port = await holdPort(t);
  const answer = await choosePort({ port, host: "127.0.0.1", explicit: false });
  assert.equal(answer.action, "listen");
  assert.ok(answer.port > port);
  assert.equal(answer.movedFrom, port);
});

test("a port the person chose is never moved: they are told it is busy", async (t) => {
  const port = await holdPort(t);
  assert.equal((await choosePort({ port, host: "127.0.0.1", explicit: true })).action, "busy");
});

test("Agent Console already running there: point at it instead of starting a second copy", async (t) => {
  const port = await holdPort(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ product: "Agent Console", version: "0.2.1", demo: false, retentionDays: 8 }));
  });
  const answer = await choosePort({ port, host: "127.0.0.1", explicit: false, demo: false });
  assert.equal(answer.action, "already-running");
  assert.equal(answer.port, port);
  // A demo does not stand in for the real console (or the other way round).
  const other = await choosePort({ port, host: "127.0.0.1", explicit: false, demo: true });
  assert.equal(other.action, "listen");
  assert.notEqual(other.port, port);
});

test("the CLI refuses a busy port the person chose, and says so", async (t) => {
  const port = await holdPort(t);
  const child = spawn(process.execPath, [BIN, "--demo", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGTERM"));
  let err = "";
  child.stderr.on("data", (c) => { err += c; });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(err, new RegExp(`Port ${port} is already in use by another program`, "u"));
});

test("started again after it moved off a busy port, the console finds itself instead of starting a second copy", async (t) => {
  // Another program holds the default port; this console moved one port on.
  const hello = (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ product: "Agent Console", version: "0.3.0", demo: false, retentionDays: 8 }));
  };
  const held = await holdNeighboringPorts(t, hello);
  const ours = await choosePort({ port: held, host: "127.0.0.1", explicit: false, demo: false, mine: async (p) => p === held + 1 });
  assert.deepEqual([ours.action, ours.port], ["already-running", held + 1]);
  // A console that cannot prove it is this one (another --state-dir) is passed over.
  const theirs = await choosePort({ port: held, host: "127.0.0.1", explicit: false, demo: false, mine: async () => false });
  assert.equal(theirs.action, "listen");
  assert.ok(theirs.port > held + 1);
});
