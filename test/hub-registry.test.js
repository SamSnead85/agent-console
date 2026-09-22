import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRegistry, normalizeCode, CODE_PATTERN, TOKEN_PATTERN, cleanLabel } from "../lib/hub/registry.js";

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the hub makes one identity, keeps it private, and reloads the same one", (t) => {
  const dir = scratch(t);
  const a = createRegistry({ dir });
  assert.equal(Buffer.from(a.orgSalt, "base64url").length, 32);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "hub.json")).mode & 0o777, 0o600);  // Windows has no POSIX modes
  if (process.platform !== "win32") assert.equal(fs.statSync(dir).mode & 0o777, 0o700);  // Windows has no POSIX modes
  const b = createRegistry({ dir });
  assert.equal(b.orgSalt, a.orgSalt);
  assert.equal(b.organizationId, a.organizationId);
});

test("a join code works exactly once, and only the device token comes back", (t) => {
  const dir = scratch(t);
  const registry = createRegistry({ dir });
  const { invitation, code } = registry.invite({ person: "Platform engineer", machine: "Laptop" });
  assert.match(code, CODE_PATTERN);
  assert.equal(invitation.state, "open");
  assert.equal("codeHash" in invitation, false, "the verifier leaves the registry");

  const { device, token } = registry.redeem(code.toLowerCase().replace("-", " "));
  assert.match(token, TOKEN_PATTERN);
  assert.equal(device.label, "Laptop");
  assert.equal(device.person, "Platform engineer");
  assert.equal(device.joinedVia, "link");
  assert.equal("tokenHash" in device, false, "the verifier leaves the registry");

  assert.throws(() => registry.redeem(code), (e) => e.status === 404);
  assert.equal(registry.invitations()[0].state, "joined");
  assert.equal(registry.invitations()[0].deviceId, device.id);

  // what is on disk: verifiers only, never the code or the token
  const disk = fs.readFileSync(path.join(dir, "devices.json"), "utf8");
  assert.ok(!disk.includes(token), "the device token was written to disk");
  assert.ok(!disk.includes(code), "the join code was written to disk");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "devices.json")).mode & 0o777, 0o600);  // Windows has no POSIX modes

  assert.equal(registry.authenticate(token).id, device.id);
  assert.equal(registry.authenticate(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")), null);
  assert.equal(registry.authenticate("not-a-token"), null);
});

test("expired, cancelled, malformed and demonstration codes are refused with reasons a person can act on", (t) => {
  let now = Date.UTC(2026, 8, 22, 12);
  const registry = createRegistry({ dir: scratch(t), now: () => now });
  const expiring = registry.invite({ ttlMs: 5 * 60_000 });
  now += 6 * 60_000;
  assert.throws(() => registry.redeem(expiring.code), (e) => e.status === 410 && /expired/u.test(e.message));
  const cancelled = registry.invite({});
  assert.equal(registry.cancelInvitation(cancelled.invitation.id), true);
  assert.throws(() => registry.redeem(cancelled.code), (e) => e.status === 404);
  assert.throws(() => registry.redeem("not a code"), (e) => e.status === 400);
  assert.throws(() => registry.redeem(""), (e) => e.status === 400);
  const demo = registry.invite({ demo: true });
  assert.throws(() => registry.redeem(demo.code), (e) => e.status === 403);
  assert.equal(registry.list().length, 0, "no refused code made a device");
});

test("a removed machine is refused at once; the hub's own machine cannot be removed", (t) => {
  const registry = createRegistry({ dir: scratch(t) });
  const local = registry.localDevice({ label: "Studio", person: "You" });
  assert.equal(local.local, true);
  assert.equal(registry.localDevice().id, local.id, "one local device, not one per start");
  const { code } = registry.invite({ person: "You", machine: "Laptop" });
  const { device, token } = registry.redeem(code);
  assert.equal(registry.revoke(device.id), true);
  assert.equal(registry.authenticate(token), null);
  assert.ok(registry.get(device.id).revokedAt);
  assert.equal(registry.revoke(device.id), false);
  assert.equal(registry.revoke(local.id), false);
});

test("contact time is the hub's clock; the reported mode is kept", (t) => {
  let now = 1_000_000;
  const registry = createRegistry({ dir: null, now: () => now });
  const { code } = registry.invite({});
  const { device } = registry.redeem(code, { name: "Build box" });
  assert.equal(device.label, "Build box", "the joining machine may name itself");
  registry.touch(device.id, { freshness: { mode: "periodic", lastObservedAt: "2026-09-22T12:00:00.000Z", lastSyncedAt: null }, at: now });
  const seen = registry.get(device.id);
  assert.equal(seen.lastContactAt, now);
  assert.equal(seen.mode, "periodic");
  assert.equal(seen.lastObservedAt, Date.parse("2026-09-22T12:00:00.000Z"));
});

test("codes and labels are normalised, and a label cannot carry markup or control characters", () => {
  assert.equal(normalizeCode("k7q2 9xma"), "K7Q2-9XMA");
  assert.equal(normalizeCode("K7Q29XMA"), "K7Q2-9XMA");
  assert.equal(normalizeCode("K7Q2-9XMO"), null, "O is not in the alphabet");
  assert.equal(normalizeCode("K7Q2-9XM"), null);
  assert.equal(cleanLabel("  Design   laptop "), "Design laptop");
  assert.equal(cleanLabel("<script>", "x"), "x");
  assert.equal(cleanLabel("a\u0007b", "x"), "x");
  assert.equal(cleanLabel("x".repeat(41), "x"), "x");
});
