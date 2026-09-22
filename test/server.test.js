import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import {
  scratchHome,
  removeTree,
  writeJsonl,
  assistantLine,
  SECRETS,
} from "./helpers.js";

const fsRemove = (target) => rmSync(target, { recursive: true, force: true });

const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "server.js",
);
const INTENT_HEADERS = Object.freeze({ "X-Agent-Console": "1" });

function apiFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...INTENT_HEADERS, ...(init.headers || {}) },
  });
}

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

function start(home, port, extraEnv, args) {
  const child = spawn(process.execPath, [SERVER, ...(args || [])], {
    env: {
      ...process.env,
      FLEET_HOME: home,
      FLEET_PORT: String(port),
      // Server tests are hermetic: both hosted-forge checks and coordination
      // ledger refresh are disabled unless a test opts into them explicitly.
      FLEET_NO_GITHUB: "1",
      FLEET_NO_MUSTER: "1",
      ...(extraEnv || {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return {
    child,
    ready: new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (output.includes("ready:")) {
          clearInterval(timer);
          resolve(output);
        }
      }, 50);
      child.on("exit", (code) => {
        clearInterval(timer);
        reject(new Error("server exited with " + code + ": " + output));
      });
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error("server never became ready: " + output));
      }, 30_000).unref();
    }),
  };
}

/** A scratch home whose transcript deliberately contains a credential. */
function plantedHome(name) {
  const home = scratchHome(name);
  // An orchestrator-written progress file, served through the same payload.
  const dataDir = path.join(home, ".sprintloop-fleet-dashboard");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, "progress.json"),
    JSON.stringify({
      percent: 64,
      summary: "planted progress line",
      remaining: ["one thing", "another"],
      updatedAt: new Date().toISOString(),
    }),
  );
  const at = Date.now();
  writeJsonl(
    path.join(home, ".claude", "projects", "-tmp-planted", "sess.jsonl"),
    [
      assistantLine({
        id: "msg_1",
        at,
        in: 10,
        out: 20,
        cr: 1000,
        cw: 100,
        cwd: "/tmp/planted",
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: {
              command:
                "export OPENAI_API_KEY=" +
                SECRETS.openai +
                " && psql postgresql://ops:" +
                SECRETS.password +
                "@db:5432/app",
            },
          },
        ],
      }),
      assistantLine({
        id: "msg_1",
        at,
        in: 10,
        out: 37,
        cr: 1000,
        cw: 100,
        cwd: "/tmp/planted",
      }),
    ],
  );
  return home;
}

test("the whole surface behaves, and no credential reaches the browser", async (t) => {
  const home = plantedHome("server");
  const port = await freePort();
  const server = start(home, port);
  t.after(() => {
    server.child.kill("SIGKILL");
    removeTree(home);
  });
  await server.ready;
  const base = "http://127.0.0.1:" + port;

  await t.test(
    "the page and its assets are served with a locked-down policy",
    async () => {
      const page = await fetch(base + "/");
      assert.equal(page.status, 200);
      const csp = page.headers.get("content-security-policy");
      assert.match(csp, /default-src 'self'/u);
      assert.match(
        csp,
        /connect-src 'self'/u,
        "the page could reach another origin",
      );
      assert.match(csp, /script-src 'self'/u);
      assert.ok(
        !/https?:\/\//u.test(csp),
        "an external origin is allowed by the policy: " + csp,
      );
      const html = await page.text();
      // Nothing is LOADED from another origin: no script, stylesheet, image or
      // font. Plain links out (the firm's site, the source) are not loads.
      assert.ok(
        !/<(?:script|img|link|iframe)\b[^>]*(?:src|href)="https?:\/\//u.test(html),
        "the page loads something from an external origin",
      );
      assert.ok(!/url\(\s*["']?https?:/u.test(html), "the page styles from an external origin");
      for (const asset of [
        "/house.css",
        "/console.css",
        "/console.js",
        "/theme.js",
        "/fonts/ibm-plex-sans-latin-400-normal.woff2",
        "/fonts/LICENSE-OFL.txt",
        "/favicon.svg",
        "/manifest.webmanifest",
        "/icon-192.png",
      ]) {
        assert.equal(
          (await fetch(base + asset)).status,
          200,
          asset + " is missing",
        );
      }
      const css = await (await fetch(base + "/house.css")).text();
      assert.ok(!/url\(\s*["']?https?:/u.test(css), "a stylesheet reaches another origin");
      const client = await (await fetch(base + "/console.js")).text();
      assert.ok(
        (client.match(/headers: HEADERS/gu) || []).length >= 1 && /\.\.\.HEADERS/u.test(client),
        "every console request must carry explicit Console request intent",
      );
      assert.match(
        client,
        /D\.now \+ \(performance\.now\(\) - receivedAt\)/u,
        "relative times must use the served clock, not the browser's",
      );
    },
  );

  await t.test(
    "the API reports the scan and masks the planted credential",
    async () => {
      const response = await apiFetch(base + "/api");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      const body = await response.text();
      assert.ok(
        !body.includes(SECRETS.openai),
        "an API key reached the browser",
      );
      assert.ok(
        !body.includes(SECRETS.password),
        "a database password reached the browser",
      );
      const data = JSON.parse(body);
      assert.ok(data.redaction.count >= 2, "nothing was reported as redacted");
      assert.equal(data.rows.length, 1);
      // De-duplication is visible end to end: two lines, one response.
      assert.equal(data.instrument.usageLines, 2);
      assert.equal(data.instrument.responses, 1);
      assert.equal(data.rows[0].total, 10 + 37 + 1000 + 100);
      assert.match(data.meta.network, /coordination read-only/u);
      assert.match(data.meta.network, /refresh disabled/u);
      // With GitHub reads disabled the fleet panel must say so, not error.
      assert.equal(data.fleet.enabled, false);
      // The instrument always states the table's verified horizon.
      assert.equal(typeof data.instrument.priceTableExpiry, "string");
      assert.equal(typeof data.instrument.priceTableExpired, "boolean");
      // The orchestrator's progress file reaches the page as written.
      assert.equal(data.progress.available, true);
      assert.equal(data.progress.percent, 64);
      assert.equal(data.progress.stale, false);
    },
  );

  await t.test(
    "period-scoped history is served, agrees with the day view, and is validated",
    async () => {
      const response = await apiFetch(base + "/api/history?period=24h");
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(
        !text.includes(SECRETS.openai) && !text.includes(SECRETS.password),
        "a credential reached the history payload",
      );
      const history = JSON.parse(text);
      assert.equal(history.period.id, "24h");
      assert.equal(
        history.totals.total,
        10 + 37 + 1000 + 100,
        "the 24h history must hold the planted spend, de-duplicated by id",
      );
      assert.ok(history.series.length > 0, "the chart series is empty");
      assert.ok(history.bySession.length > 0);
      assert.equal(history.byModel[0].model, "claude-opus-5");
      assert.ok(history.code, "period code stats are missing");
      assert.ok(
        Number.isInteger(history.code.totals.prsMerged),
        "merged-PR count must be a number",
      );

      const lifecycle = await apiFetch(base + "/api/history?period=all");
      assert.equal((await lifecycle.json()).period.id, "all");

      const bogus = await apiFetch(base + "/api/history?period=fortnight");
      assert.equal(bogus.status, 400, "an unknown period must be refused");
    },
  );

  await t.test(
    "a foreign Host header is refused, closing DNS rebinding",
    async () => {
      // fetch() will not let a caller choose the Host header, so this one goes
      // through the raw client — which is also what an attacker would use.
      const status = await new Promise((resolve, reject) => {
        const request = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/api",
            headers: { Host: "attacker.example" },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on("error", reject);
        request.end();
      });
      assert.equal(
        status,
        421,
        "a rebound DNS name would have reached the API",
      );
    },
  );

  await t.test(
    "every API request requires the console intent header",
    async () => {
      for (const url of ["/api", "/api/history?period=24h"]) {
        const response = await fetch(base + url);
        assert.equal(response.status, 403, url);
        assert.match((await response.json()).reason, /X-Agent-Console/u);
      }
      const legacy = await fetch(base + "/api", {
        headers: { "X-Fleet-Request": "1" },
      });
      assert.equal(legacy.status, 403, "the retired header remained accepted");

      // The header the console shipped under its previous name still works.
      // Renaming a product must not silently break an embedder mid-upgrade.
      const previousName = await fetch(base + "/api", {
        headers: { "X-Muster-Console": "1" },
      });
      assert.equal(previousName.status, 200);

      // A preflight is ANSWERED — that is ordinary HTTP — but with no
      // embedding configured it carries no permission, so the browser stops
      // there. The status is not the property under test; the absence of an
      // allow-origin header is.
      const preflight = await fetch(base + "/api", {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "X-Agent-Console",
        },
      });
      assert.equal(preflight.headers.get("access-control-allow-origin"), null);

      // And an ordinary cross-origin GET gets no permission either, even
      // when it carries a valid intent header.
      const crossOrigin = await fetch(base + "/api", {
        headers: {
          "X-Agent-Console": "1",
          Origin: "https://attacker.example",
        },
      });
      assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);

      const ackWithoutIntent = await fetch(base + "/api/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "all" }),
      });
      assert.equal(ackWithoutIntent.status, 403);

      const ack = await apiFetch(base + "/api/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "all" }),
      });
      assert.equal(ack.status, 200);
      assert.equal((await ack.json()).ok, true);
    },
  );

  await t.test(
    "process termination and HTTP session ingest are not public routes",
    async () => {
      for (const url of [
        "/api/kill/prepare",
        "/api/kill/confirm",
        "/api/session",
      ]) {
        const response = await apiFetch(base + url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pid: process.pid, id: "unreachable" }),
        });
        assert.equal(response.status, 404, url + " is still exposed");
        assert.equal((await response.json()).reason, "no such endpoint");
      }
    },
  );

  await t.test(
    "static serving cannot be walked out of the public directory",
    async () => {
      for (const attempt of [
        "/../server.js",
        "/..%2fserver.js",
        "/%2e%2e/lib/prices.js",
      ]) {
        const response = await fetch(base + attempt);
        assert.ok(
          response.status >= 400,
          attempt + " returned " + response.status,
        );
        const text = await response.text();
        assert.ok(!text.includes("PRICE TABLE"), attempt + " leaked source");
      }
    },
  );

  await t.test("nothing but loopback can reach it", async () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) {
      t.diagnostic(
        "no non-loopback IPv4 interface on this machine; skipping the LAN probe",
      );
      return;
    }
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const socket = net.connect(
            { host: lan.address, port, timeout: 2000 },
            () => {
              socket.destroy();
              resolve();
            },
          );
          socket.on("error", reject);
          socket.on("timeout", () => {
            socket.destroy();
            reject(new Error("timeout"));
          });
        }),
      "the server accepted a connection on a routable address",
    );
  });

  await t.test(
    "the process holds no outbound connection after a full scan",
    () => {
      let sockets = "";
      try {
        // -a is load-bearing: without it lsof ORs the selectors and reports every
        // TCP socket on the machine, which would make this assertion meaningless.
        sockets = execFileSync(
          "/usr/sbin/lsof",
          ["-nP", "-a", "-p", String(server.child.pid), "-iTCP"],
          { encoding: "utf8" },
        );
      } catch {
        t.diagnostic("lsof unavailable; skipping the socket census");
        return;
      }
      for (const line of sockets.split("\n").slice(1).filter(Boolean)) {
        const name = line.split(/\s+/u).slice(8).join(" ");
        assert.ok(
          /^(127\.0\.0\.1|\[::1\]|localhost)/u.test(name),
          "a non-loopback socket is open: " + name,
        );
      }
    },
  );
});

test("the history endpoint scopes to a project and explains every term it shows", async (t) => {
  const home = plantedHome("server-scope");
  const port = await freePort();
  const server = start(home, port, { FLEET_NO_MUSTER: "1" });
  t.after(() => {
    server.child.kill("SIGKILL");
    removeTree(home);
  });
  await server.ready;
  const base = "http://127.0.0.1:" + port;

  const all = await (await apiFetch(base + "/api/history?period=24h")).json();
  assert.equal(all.scope, null);
  assert.ok(all.projects.available);
  assert.ok(
    all.projects.count >= 1,
    "the planted project is not in the ledger",
  );
  assert.ok(all.attribution, "no attribution was assembled");
  assert.ok(Array.isArray(all.attribution.authors));
  assert.ok(all.progress, "no progress trend accompanied the history");

  const slug = all.projects.projects[0].slug;
  const scoped = await (
    await apiFetch(
      base + "/api/history?period=24h&project=" + encodeURIComponent(slug),
    )
  ).json();
  assert.equal(scoped.scope.slug, slug);
  assert.ok(
    scoped.totals.total > 0,
    "scoping to the only project emptied the totals",
  );
  assert.equal(
    scoped.totals.total,
    all.totals.total,
    "scoping to the only project changed the total",
  );
  // The selector must still see every project, or the scope cannot be left.
  assert.equal(scoped.projects.count, all.projects.count);
  assert.ok(scoped.projects.projects.some((p) => p.selected));

  // An unknown project reads empty rather than erroring: a project can honestly
  // have no activity in a period, and 400ing would break the period switch.
  const empty = await apiFetch(
    base + "/api/history?period=hour&project=no-such-thing",
  );
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).totals.total, 0);

  // The period label no longer claims to be one project's lifetime.
  const lifetime = await (
    await apiFetch(base + "/api/history?period=all")
  ).json();
  assert.equal(lifetime.period.label, "everything recorded");
  assert.match(lifetime.coverage.scopeNote, /every project on this machine/u);
});

test("every term the page can point at is defined in the payload", async (t) => {
  const home = plantedHome("server-glossary");
  const port = await freePort();
  const server = start(home, port, { FLEET_NO_MUSTER: "1" });
  t.after(() => {
    server.child.kill("SIGKILL");
    removeTree(home);
  });
  await server.ready;

  const snapshot = await (
    await apiFetch("http://127.0.0.1:" + port + "/api")
  ).json();
  assert.ok(snapshot.glossary, "the payload carries no glossary");
  const defined = new Set(snapshot.glossary.entries.map((e) => e.id));

  // The embeddable panel still points at glossary terms; each must be defined.
  const panel = await (
    await fetch("http://127.0.0.1:" + port + "/panel.js")
  ).text();
  for (const m of panel.matchAll(/data-term=\\?"([A-Za-z0-9-]+)\\?"/gu)) {
    assert.ok(
      defined.has(m[1]),
      'panel.js points at "' + m[1] + '" and nothing defines it',
    );
  }

  // The banner's state must be one the glossary explains.
  assert.ok(
    defined.has(snapshot.master.word) || snapshot.master.word === "IDLE",
    "the banner showed " + snapshot.master.word + " with no definition",
  );
  assert.ok(snapshot.stall, "the payload carries no stall verdict");
  assert.equal(typeof snapshot.stall.stalled, "boolean");
});

test("an empty machine renders a zeroed instrument, not an error", async (t) => {
  const home = scratchHome("server-empty");
  // A machine that has never run Codex has no ~/.codex at all. That is "out of
  // service", which the UI hatches — a different thing from a zero.
  fsRemove(path.join(home, ".codex"));
  const port = await freePort();
  const server = start(home, port);
  t.after(() => {
    server.child.kill("SIGKILL");
    removeTree(home);
  });
  await server.ready;
  const data = await (
    await apiFetch("http://127.0.0.1:" + port + "/api")
  ).json();
  assert.equal(data.rows.length, 0);
  assert.equal(data.header.total, 0);
  assert.equal(data.header.costTotal, 0);
  assert.equal(data.master.word, "IDLE");
  assert.equal(
    data.progress.available,
    false,
    "no progress file must mean no widget — never a fabricated figure",
  );
  assert.equal(
    data.codex.available,
    false,
    "a missing ~/.codex must read as out of service",
  );
  assert.equal(
    data.burn.minutes.length,
    60,
    "the burn band must keep its full grid when idle",
  );
});

/**
 * The two credential shapes that reached the live HTTP surface in the clear.
 *
 * Both are asserted against the RESPONSE BODY STRING, not against a field, so a
 * value that survives anywhere in the payload fails the test. `rows[].last` is
 * the roster's `doing` column — the widest, most-read cell on the page — and
 * the browser only styles a mark the server already applied, so nothing
 * downstream can save it.
 */
test("a bare PASSWORD= and a truncated connection string are both masked", async (t) => {
  const home = scratchHome("server-bare");
  const at = Date.now();
  const bash = (command) => ({
    type: "tool_use",
    name: "Bash",
    input: { command },
  });
  // Positioned so the "@" the connection-string rule is anchored on falls just
  // past the 140-character cut that lib/claude.js applies to this string.
  const tail = "psql postgresql://ops:" + SECRETS.password;
  const filler = "cd /srv/deploy && " + "x".repeat(140 - 18 - tail.length);

  writeJsonl(path.join(home, ".claude", "projects", "-tmp-bare", "s.jsonl"), [
    assistantLine({
      id: "msg_bare",
      at,
      in: 10,
      out: 20,
      cwd: "/tmp/bare",
      content: [bash("export PASSWORD=" + SECRETS.password + " && deploy.sh")],
    }),
    assistantLine({
      id: "msg_cut",
      at: at + 1,
      in: 10,
      out: 20,
      cwd: "/tmp/bare",
      content: [bash(filler + tail + "@db.internal:5432/app -c 'select 1'")],
    }),
  ]);

  const port = await freePort();
  const server = start(home, port);
  t.after(() => {
    server.child.kill("SIGKILL");
    removeTree(home);
  });
  await server.ready;

  const body = await (
    await apiFetch("http://127.0.0.1:" + port + "/api")
  ).text();
  assert.ok(
    !body.includes(SECRETS.password),
    "a plaintext password reached the browser in the served payload",
  );
  const data = JSON.parse(body);
  assert.ok(
    data.redaction.count > 0,
    "the operator was told nothing was redacted while a secret was on screen",
  );
  assert.match(
    data.rows[0].last,
    /‹redacted \d+›/u,
    "the doing column carries no mask: " + data.rows[0].last,
  );
});
