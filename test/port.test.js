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
