import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REGISTRY_EXPIRE_MS,
  REGISTRY_STALE_MS,
  createRegistry,
  normalizeRegistration,
  readRegistry,
  registerSession,
  safeId,
} from "../lib/ingest.js";
import { SECRETS } from "./helpers.js";

const NOW = 1_788_000_000_000;

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ingest-"));
}

test("an id is sanitized to a flat filename that cannot climb out", () => {
  assert.equal(safeId("kimi-vscode-1"), "kimi-vscode-1");
  assert.equal(safeId("../../etc/passwd"), "......etc.passwd");
  assert.equal(safeId("a/b\\c"), "a.b.c");
  // A name with nothing addressable in it is refused rather than turned into a
  // directory reference.
  assert.equal(safeId("///"), "");
  assert.equal(safeId(".."), "");
  assert.equal(safeId(""), "");
  assert.equal(safeId("x".repeat(200)).length, 64);
});

test("a traversal id writes inside the registry and nowhere else", () => {
  const dir = scratch();
  const registry = createRegistry({ dir });
  const result = registerSession(registry, { id: "../../etc/passwd" }, NOW);
  assert.equal(result.ok, true);
  assert.equal(
    path.dirname(path.resolve(result.file)),
    path.resolve(registry.dir),
    "a registration escaped the registry directory: " + result.file,
  );
  assert.ok(!fs.existsSync("/etc/passwd.json"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a registration without a usable id is refused, not silently dropped", () => {
  const dir = scratch();
  const registry = createRegistry({ dir });
  assert.match(
    registerSession(registry, { id: "///" }, NOW).reason,
    /id is required/u,
  );
  assert.match(registerSession(registry, {}, NOW).reason, /id is required/u);
  assert.match(
    registerSession(registry, "not an object", NOW).reason,
    /JSON object/u,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A registration is foreign text, exactly like a transcript line, and it is
 * masked on the way IN — before it is written to disk — rather than only on the
 * way out. A credential sitting in the registry file would survive this process
 * and reach whatever reads the directory next.
 */
test("a credential in a declaration is masked before it is stored", () => {
  const dir = scratch();
  const registry = createRegistry({ dir });
  const result = registerSession(
    registry,
    {
      id: "leaky",
      note: "using OPENAI_API_KEY=" + SECRETS.openai + " for the run",
      name: "token " + SECRETS.githubClassic,
    },
    NOW,
  );
  assert.equal(result.ok, true);
  const onDisk = fs.readFileSync(result.file, "utf8");
  assert.ok(
    !onDisk.includes(SECRETS.openai),
    "an API key was written to the registry file",
  );
  assert.ok(
    !onDisk.includes(SECRETS.githubClassic),
    "a GitHub token was written to the registry file",
  );
  assert.match(onDisk, /redacted/u, "nothing marked the masking");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("token and agent counts are coerced, never trusted", () => {
  const { record } = normalizeRegistration(
    {
      id: "x",
      tokens: { in: "120000", out: -5, cr: 1.9, cw: "oops" },
      agents: { live: "2", total: null },
    },
    NOW,
  );
  assert.deepEqual(record.tokens, {
    in: 120000,
    out: 0,
    cr: 1,
    cw: 0,
    cw1h: 0,
    think: 0,
  });
  assert.deepEqual(record.agents, { live: 2, total: 0 });
});

test("an unknown state is dropped rather than rendered as one", () => {
  assert.equal(
    normalizeRegistration({ id: "x", state: "BUSY" }, NOW).record.state,
    null,
  );
  assert.equal(
    normalizeRegistration({ id: "x", state: "live" }, NOW).record.state,
    "LIVE",
  );
});

test("a round trip through the drop file survives a restart", () => {
  const dir = scratch();
  const registry = createRegistry({ dir });
  registerSession(
    registry,
    {
      id: "kimi",
      sessionId: "abc",
      vendor: "kimi",
      machine: "studio",
      tokens: { in: 100, out: 50, cr: 10, cw: 5 },
    },
    NOW,
  );
  // A fresh registry object is exactly what a restarted server has.
  const reread = readRegistry(createRegistry({ dir }), NOW);
  assert.equal(reread.sessions.length, 1);
  assert.equal(reread.sessions[0].id, "kimi");
  assert.equal(reread.sessions[0].sessionId, "abc");
  assert.equal(reread.sessions[0].total, 165);
  assert.equal(reread.sessions[0].stale, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The drop file is a public interface, so a file written by hand gets exactly
 * the checks an HTTP body gets. It must also be impossible for one bad file to
 * blank the roster.
 */
test("a hand-written drop file is validated, and a bad one is counted not fatal", () => {
  const dir = scratch();
  const registry = createRegistry({ dir });
  fs.mkdirSync(registry.dir, { recursive: true });
  fs.writeFileSync(
    path.join(registry.dir, "good.json"),
    JSON.stringify({ id: "good" }),
  );
  fs.writeFileSync(path.join(registry.dir, "torn.json"), "{ not json");
  fs.writeFileSync(
    path.join(registry.dir, "noid.json"),
    JSON.stringify({ vendor: "x" }),
  );
  const out = readRegistry(registry, NOW);
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].id, "good");
  assert.equal(out.badFiles, 2);
  assert.equal(out.error, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A session that crashed cannot retract its own claim to be live, so age is the
 * only honest check on a declaration.
 */
test("a declaration goes stale on age and is dropped once expired", () => {
  const dir = scratch();
  const registry = createRegistry({ dir });
  const result = registerSession(registry, { id: "old" }, NOW);
  assert.equal(result.ok, true);

  const fresh = readRegistry(registry, NOW + 60_000);
  assert.equal(fresh.sessions[0].stale, false);

  const stale = readRegistry(registry, NOW + REGISTRY_STALE_MS + 1000);
  assert.equal(stale.sessions[0].stale, true);
  assert.ok(stale.sessions[0].ageMs > REGISTRY_STALE_MS);

  const gone = readRegistry(registry, NOW + REGISTRY_EXPIRE_MS + 1000);
  assert.equal(
    gone.sessions.length,
    0,
    "an abandoned registration haunted the roster",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The writer's own timestamp is a claim. The file's mtime is an observation.
 * A record claiming to be from the future must not read as permanently fresh.
 */
test("a declaration cannot claim to be newer than the file it lives in", () => {
  const dir = scratch();
  const registry = createRegistry({ dir });
  registerSession(registry, { id: "liar" }, NOW);
  const file = path.join(registry.dir, "liar.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.at = Date.now() + 3600_000;
  fs.writeFileSync(file, JSON.stringify(record));
  const out = readRegistry(registry, Date.now());
  assert.ok(
    out.sessions[0].at <= Date.now() + 1000,
    "a record dated in the future was accepted at face value",
  );
});

test("a missing registry directory is absent, not an error", () => {
  const registry = createRegistry({
    dir: path.join(os.tmpdir(), "fleet-nope-" + Date.now()),
  });
  const out = readRegistry(registry, NOW);
  assert.deepEqual(out.sessions, []);
  assert.equal(out.error, null);
});
