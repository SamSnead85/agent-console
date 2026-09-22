/*
 * The embed boundary, exercised against a real listening server.
 *
 * lib/embed.js is unit-tested next door; this file exists because the unit
 * that decides is not the thing an attacker meets. A correct allowlist wired
 * into the wrong response, or attached to `/api` but not to `panel.js`, is a
 * hole that no test of the decision function can see.
 */

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "server.js",
);
const ALLOWED = "http://127.0.0.1:3111";
const INTENT = Object.freeze({ "X-Agent-Console": "1" });

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Start the server in demo mode: no operator data is read to test headers. */
async function start(extraArgs) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [SERVER, "--demo", "--port", String(port), "--json", ...extraArgs],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));

  const exited = new Promise((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  const ready = new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (out.includes('"ok":true')) {
        clearInterval(poll);
        resolve();
      } else if (child.exitCode !== null) {
        clearInterval(poll);
        reject(new Error(`server exited ${child.exitCode}: ${err}`));
      } else if (Date.now() - started > 20000) {
        clearInterval(poll);
        reject(new Error("server did not start: " + err));
      }
    }, 25);
  });

  // A test that only cares about the exit code never awaits `ready`, and an
  // un-awaited rejection fails the whole file. Marking it handled here keeps
  // it awaitable — a test that does await it still sees the rejection.
  ready.catch(() => {});

  return {
    port,
    base: `http://127.0.0.1:${port}`,
    ready,
    exited,
    stderr: () => err,
    stop: () => {
      child.kill("SIGTERM");
      return exited;
    },
  };
}

test("with no --embed, nothing earns a CORS permission", async () => {
  const server = await start([]);
  await server.ready;
  try {
    for (const origin of [ALLOWED, "https://attacker.example", undefined]) {
      const response = await fetch(server.base + "/api", {
        headers: { ...INTENT, ...(origin ? { Origin: origin } : {}) },
      });
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        null,
        String(origin),
      );
      assert.match(
        response.headers.get("content-security-policy"),
        /frame-ancestors 'none'/u,
      );
      assert.equal(
        response.headers.get("cross-origin-resource-policy"),
        "same-origin",
      );
    }
  } finally {
    await server.stop();
  }
});

test("--embed admits exactly the named origin, and nothing adjacent to it", async () => {
  const server = await start(["--embed", ALLOWED]);
  await server.ready;
  try {
    const allowed = await fetch(server.base + "/api", {
      headers: { ...INTENT, Origin: ALLOWED },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), ALLOWED);
    assert.equal(allowed.headers.get("vary"), "Origin");

    // Every one of these is a plausible near miss, and every one is refused.
    // A suffix match or a port-insensitive compare would pass at least one.
    for (const impostor of [
      "https://attacker.example",
      "http://127.0.0.1:3112",
      "https://127.0.0.1:3111",
      "http://127.0.0.1",
      "http://127.0.0.1:3111.attacker.example",
      "null",
    ]) {
      const response = await fetch(server.base + "/api", {
        headers: { ...INTENT, Origin: impostor },
      });
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        null,
        impostor,
      );
      // The refusal still varies on Origin, or a cache could hand this
      // response to the allowed origin — or the reverse.
      assert.equal(response.headers.get("vary"), "Origin", impostor);
    }
  } finally {
    await server.stop();
  }
});

test("the permission covers the panel script and the page, not only the API", async () => {
  const server = await start(["--embed", ALLOWED]);
  await server.ready;
  try {
    // An embedder loads panel.js cross-origin before it ever calls /api. A
    // policy attached to the API alone breaks at the first script tag.
    for (const asset of ["/panel.js", "/console.css", "/"]) {
      const response = await fetch(server.base + asset, {
        headers: { Origin: ALLOWED },
      });
      assert.equal(response.status, 200, asset);
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        ALLOWED,
        asset,
      );
      assert.equal(
        response.headers.get("cross-origin-resource-policy"),
        "cross-origin",
        asset,
      );
      assert.match(
        response.headers.get("content-security-policy"),
        new RegExp("frame-ancestors " + ALLOWED.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
        asset,
      );
    }

    const panel = await fetch(server.base + "/panel.js");
    assert.match(await panel.text(), /customElements\.define/u);
  } finally {
    await server.stop();
  }
});

test("a preflight is answered, and grants only what the allowlist says", async () => {
  const server = await start(["--embed", ALLOWED]);
  await server.ready;
  try {
    const granted = await fetch(server.base + "/api", {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-Agent-Console",
      },
    });
    assert.equal(granted.status, 204);
    assert.equal(granted.headers.get("access-control-allow-origin"), ALLOWED);
    assert.match(
      granted.headers.get("access-control-allow-headers"),
      /X-Agent-Console/u,
    );

    const refused = await fetch(server.base + "/api", {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-Agent-Console",
      },
    });
    assert.equal(refused.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.stop();
  }
});

test("a bad allowlist stops the server instead of quietly disabling embedding", async () => {
  // The failure this prevents: an operator passes --embed "*", the flag is
  // rejected, the server starts anyway with embedding off, and they spend an
  // afternoon debugging a panel that says "no answer".
  for (const bad of ["*", "localhost:3000", "null"]) {
    const server = await start(["--embed", bad]);
    const code = await server.exited;
    assert.equal(code, 2, bad);
    assert.match(server.stderr(), /--embed/u, bad);
  }
});

/**
 * Send a request with an arbitrary Host header.
 *
 * `fetch` cannot do this: Host is a forbidden header name, and the browser and
 * undici both silently drop it. Testing the Host pin through fetch therefore
 * tests nothing — it asserts that a header the client never sent was refused.
 * A raw socket is the only way to actually put the attacker's Host on the wire.
 */
function rawRequest(port, host, headers = []) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        ["GET /api HTTP/1.1", `Host: ${host}`, ...headers, "Connection: close", "", ""].join(
          "\r\n",
        ),
      );
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (raw += chunk));
    socket.on("error", reject);
    socket.on("end", () => resolve(raw));
  });
}

test("embedding never relaxes the loopback bind or the Host pin", async () => {
  const server = await start(["--embed", ALLOWED]);
  await server.ready;
  try {
    // The Host pin is what stops a public page resolving its own name to
    // 127.0.0.1 and reading this server out of the victim's browser. Naming
    // an origin must not buy a way past it.
    const attacked = await rawRequest(server.port, "console.attacker.example", [
      "X-Agent-Console: 1",
      `Origin: ${ALLOWED}`,
    ]);
    assert.match(attacked, /^HTTP\/1\.1 421/u);
    assert.doesNotMatch(attacked, /access-control-allow-origin/iu);

    // The same request with a loopback Host is served, so the assertion above
    // is about the Host and not about something else being broken.
    const ok = await rawRequest(server.port, `127.0.0.1:${server.port}`, [
      "X-Agent-Console: 1",
      `Origin: ${ALLOWED}`,
    ]);
    assert.match(ok, /^HTTP\/1\.1 200/u);
  } finally {
    await server.stop();
  }
});
