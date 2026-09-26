/**
 * One writer per physical hub state directory, independent of its listen ports.
 * Publish a fully written owner record with an atomic hard link, so a crash
 * cannot leave a half-written lock that another process mistakes for stale.
 * Only ESRCH on this host proves an owner is gone; age never does.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK = "hub.lock";
const RECOVERY = ".hub-lock-recovery";
const NONCE = /^[0-9a-f]{32}$/u;

function blocked(reason) {
  return Object.assign(new Error("The hub state directory is already in use, or its owner cannot be verified. "
    + reason + " Stop its other console before starting another, or choose a different --state-dir."), { code: "ELOCKED" });
}

function readOwner(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 2048) throw blocked("The lock is not a valid owner record.");
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    if (owner.v !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1
      || typeof owner.host !== "string" || !NONCE.test(owner.nonce)) throw blocked("The lock is not a valid owner record.");
    return owner;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOCKED") throw error;
    throw blocked("The lock could not be read safely.");
  }
}

function ownerIsGone(owner) {
  if (owner.host !== os.hostname()) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

/** Null is the in-memory demo; no directory or lock is created for it. */
export function acquireStateLock(dir) {
  if (!dir) return { dir: null, release() {} };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const canonical = fs.realpathSync(dir);
  const lockFile = path.join(canonical, LOCK);
  const recoveryDir = path.join(canonical, RECOVERY);
  const owner = { v: 1, pid: process.pid, host: os.hostname(), nonce: crypto.randomBytes(16).toString("hex") };
  const candidate = path.join(canonical, ".hub-lock-owner-" + owner.nonce);

  function claim(file, depth = 0) {
    if (depth > 16) throw blocked("Recovery needs an operator to inspect the ownership records.");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { fs.linkSync(candidate, file); return; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const previous = readOwner(file);
      if (!previous) continue;
      if (!ownerIsGone(previous)) throw blocked("Another process still owns it.");

      // One immutable recovery claim per dead owner prevents two contenders
      // from unlinking each other's new, live lock. Keep these small records:
      // deleting one would let a delayed contender reuse an old claim. A
      // crashed recovery process is recovered by the same protocol recursively.
      fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
      claim(path.join(recoveryDir, previous.nonce), depth + 1);
      const current = readOwner(file);
      if (current && current.nonce === previous.nonce) fs.unlinkSync(file);
      // Someone can win the newly vacant name before us; only an exclusive
      // link can acquire it. Never overwrite or rename a new owner's lock.
    }
    throw blocked("Ownership changed while this console was starting; try again.");
  }

  const fd = fs.openSync(candidate, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(owner) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    claim(lockFile);
  } finally { fs.unlinkSync(candidate); }

  let released = false;
  return {
    dir: canonical,
    release() {
      if (released) return;
      const current = readOwner(lockFile);
      if (current && current.nonce === owner.nonce) fs.unlinkSync(lockFile);
      released = true;
    },
  };
}

/** Who holds a state directory's lock: `{ pid, host }`, or null when nobody does or it cannot be read. */
export function stateLockOwner(dir) {
  if (!dir) return null;
  try {
    const owner = readOwner(path.join(fs.realpathSync(dir), LOCK));
    return owner ? { pid: owner.pid, host: owner.host } : null;
  } catch { return null; }
}
