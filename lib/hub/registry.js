/**
 * The hub's registry: who may report to it, and how they got in.
 *
 * Three kinds of record, all kept in the hub's private state directory:
 *
 *   identity     one organization id and one 32-byte salt, made on first run.
 *                Every enrolled machine hashes session and project identifiers
 *                with this same salt, which is what lets the hub recognise a
 *                transcript copied between two machines as ONE event.
 *   devices      each machine that reports: a label, the person it belongs to,
 *                when and how it joined, when it last made contact, and a
 *                SHA-256 verifier of its bearer token — never the token.
 *   invitations  single-use join codes. A code is eight characters, expires
 *                (thirty minutes by default), is stored only as a verifier,
 *                and is spent the moment a machine redeems it. The long-lived
 *                device token is issued in exchange and goes straight to that
 *                machine; nobody ever sees it on a screen.
 *
 * Nothing in here is a network service. server.js decides who may call what.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const TOKEN_PATTERN = /^acd_[A-Za-z0-9_-]{43}$/u;
/* Crockford-style: no 0/O, 1/I/L or U, so a code read aloud or retyped from a
   phone survives. 30 symbols, 8 of them: about 39 bits, and every guess is
   rate-limited per address and the code dies after one use or 30 minutes. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_PATTERN = /^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/u;
export const DEFAULT_INVITE_TTL_MS = 30 * 60 * 1000;
const MAX_INVITATIONS_KEPT = 60;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** A person's or a machine's name: short, printable, trimmed. */
export function cleanLabel(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  const label = value.replace(/\s+/gu, " ").trim();
  if (!label || label.length > 40 || /[\u0000-\u001f\u007f<>]/u.test(label)) return fallback;
  return label;
}

/** Accepts "k7q2 9xma", "K7Q2-9XMA", "k7q29xma"; returns the canonical form or null. */
export function normalizeCode(value) {
  if (typeof value !== "string") return null;
  const compact = value.toUpperCase().replace(/[\s-]/gu, "");
  if (compact.length !== 8) return null;
  const code = compact.slice(0, 4) + "-" + compact.slice(4);
  return CODE_PATTERN.test(code) ? code : null;
}

function randomCode() {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    // Rejection-free: 256 % 30 leaves a bias of under 1%, too small to help a
    // guesser who is rate-limited to ten tries per ten minutes.
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i === 3) out += "-";
  }
  return out;
}

const newId = (prefix) => prefix + crypto.randomBytes(12).toString("base64url");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error("The hub's state at " + file + " could not be read: " + error.message);
  }
}

function writePrivate(file, value) {
  const temporary = file + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* not every filesystem keeps modes */ }
}

/** What a device looks like outside this module: no verifier, ever. */
function publicDevice(device) {
  const { tokenHash, ...rest } = device;
  return { ...rest, hasToken: Boolean(tokenHash) };
}

function publicInvitation(invitation, now) {
  const { codeHash, ...rest } = invitation;
  let state = "open";
  if (invitation.usedAt) state = "joined";
  else if (invitation.cancelledAt) state = "cancelled";
  else if (invitation.expiresAt <= now) state = "expired";
  return { ...rest, state };
}

/**
 * @param {object} options
 * @param {string|null} options.dir   private state directory; null keeps everything in memory (demo)
 * @param {() => number} [options.now]
 */
export function createRegistry({ dir = null, now = () => Date.now() } = {}) {
  if (dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
  const identityFile = dir ? path.join(dir, "hub.json") : null;
  const devicesFile = dir ? path.join(dir, "devices.json") : null;

  let identity = identityFile ? readJson(identityFile, null) : null;
  if (!identity) {
    identity = {
      v: 1,
      organizationId: newId("org_"),
      orgSalt: crypto.randomBytes(32).toString("base64url"),
      createdAt: new Date(now()).toISOString(),
    };
    if (identityFile) writePrivate(identityFile, identity);
  }
  if (identity.v !== 1 || Buffer.from(identity.orgSalt, "base64url").length !== 32) {
    throw new Error("The hub identity file is not one this version understands. It was left untouched.");
  }

  const state = (devicesFile ? readJson(devicesFile, null) : null) || { v: 1, devices: [], invitations: [] };
  const devices = new Map(state.devices.map((d) => [d.id, d]));
  const byToken = new Map();
  for (const d of devices.values()) if (d.tokenHash && !d.revokedAt) byToken.set(d.tokenHash, d.id);
  let invitations = state.invitations || [];

  let saveTimer = null;
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!devicesFile) return;
    writePrivate(devicesFile, { v: 1, devices: [...devices.values()], invitations });
  }
  /* Contact times change every few seconds per machine; writing the file each
     time would be a disk write per report. Joins and revocations save at once. */
  function saveSoon() {
    if (!devicesFile || saveTimer) return;
    saveTimer = setTimeout(saveNow, 15_000);
    saveTimer.unref?.();
  }

  function pruneInvitations() {
    if (invitations.length > MAX_INVITATIONS_KEPT) {
      invitations = invitations
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, MAX_INVITATIONS_KEPT);
    }
  }

  function addDevice({ label, person, local = false, via }) {
    const device = {
      id: newId("dev_"),
      label: cleanLabel(label, "Machine " + (devices.size + 1)),
      person: cleanLabel(person, null),
      local,
      joinedVia: via,
      createdAt: new Date(now()).toISOString(),
      revokedAt: null,
      tokenHash: null,
      lastContactAt: null,
      lastObservedAt: null,
      mode: null,
    };
    devices.set(device.id, device);
    return device;
  }

  return {
    get organizationId() { return identity.organizationId; },
    get orgSalt() { return identity.orgSalt; },

    /** The hub's own machine: one device, created the first time it is asked for. */
    localDevice({ label, person } = {}) {
      let device = [...devices.values()].find((d) => d.local);
      if (!device) {
        device = addDevice({ label: label || "This machine", person: person || "You", local: true, via: "local" });
        saveNow();
      } else {
        const nextLabel = cleanLabel(label, null);
        const nextPerson = cleanLabel(person, null);
        let changed = false;
        if (nextLabel && nextLabel !== device.label) { device.label = nextLabel; changed = true; }
        if (nextPerson && nextPerson !== device.person) { device.person = nextPerson; changed = true; }
        if (changed) saveNow();
      }
      return publicDevice(device);
    },

    /** Demo only: a device with a fixed id and no credential. */
    addSynthetic({ id, label, person, local = false, createdAt }) {
      const device = {
        id, label, person, local, joinedVia: local ? "local" : "link",
        createdAt, revokedAt: null, tokenHash: null,
        lastContactAt: null, lastObservedAt: null, mode: "live",
      };
      devices.set(id, device);
      return publicDevice(device);
    },

    get(id) {
      const device = devices.get(id);
      return device ? publicDevice(device) : null;
    },

    list() {
      return [...devices.values()].map(publicDevice);
    },

    invitations() {
      const t = now();
      return invitations.map((i) => publicInvitation(i, t))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    /** Issues a join code. The code is returned here and nowhere else. */
    invite({ person, machine, ttlMs = DEFAULT_INVITE_TTL_MS, demo = false } = {}) {
      const code = randomCode();
      const created = now();
      const invitation = {
        id: newId("inv_"),
        person: cleanLabel(person, null),
        machine: cleanLabel(machine, null),
        createdAt: new Date(created).toISOString(),
        expiresAt: created + Math.max(60_000, Math.min(ttlMs, 7 * 24 * 3600 * 1000)),
        codeHash: sha256(code),
        usedAt: null,
        deviceId: null,
        cancelledAt: null,
        demo,
      };
      invitations.push(invitation);
      pruneInvitations();
      saveNow();
      return { invitation: publicInvitation(invitation, created), code };
    },

    cancelInvitation(id) {
      const invitation = invitations.find((i) => i.id === id);
      if (!invitation || invitation.usedAt || invitation.cancelledAt) return false;
      invitation.cancelledAt = new Date(now()).toISOString();
      saveNow();
      return true;
    },

    /**
     * Spends a join code. Returns the new device and its bearer token, or
     * throws an error carrying an HTTP status and a reason a person can act on.
     * The reasons are deliberately few: an unknown code and a used one read
     * the same, so the answer does not tell a guesser which codes exist.
     */
    redeem(rawCode, { name } = {}) {
      const code = normalizeCode(rawCode);
      const refuse = (status, reason) => Object.assign(new Error(reason), { status });
      if (!code) throw refuse(400, "That is not a join code. It looks like K7Q2-9XMA.");
      const hash = sha256(code);
      const invitation = invitations.find((i) =>
        crypto.timingSafeEqual(Buffer.from(i.codeHash, "hex"), Buffer.from(hash, "hex")));
      const t = now();
      if (!invitation || invitation.usedAt || invitation.cancelledAt) {
        throw refuse(404, "This join code is not valid. It may have been used already — ask for a new link.");
      }
      if (invitation.expiresAt <= t) throw refuse(410, "This join code has expired. Ask for a new link.");
      if (invitation.demo) throw refuse(403, "This console is a demonstration and does not accept machines.");
      const token = "acd_" + crypto.randomBytes(32).toString("base64url");
      const device = addDevice({
        label: cleanLabel(name, null) || invitation.machine,
        person: invitation.person,
        via: "link",
      });
      device.tokenHash = sha256(token);
      device.invitationId = invitation.id;
      byToken.set(device.tokenHash, device.id);
      invitation.usedAt = new Date(t).toISOString();
      invitation.deviceId = device.id;
      saveNow();
      return { device: publicDevice(device), token };
    },

    /** The device a bearer token belongs to, or null for unknown or revoked. */
    authenticate(token) {
      if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
      const id = byToken.get(sha256(token));
      const device = id ? devices.get(id) : null;
      return device && !device.revokedAt ? publicDevice(device) : null;
    },

    revoke(id) {
      const device = devices.get(id);
      if (!device || device.local || device.revokedAt) return false;
      device.revokedAt = new Date(now()).toISOString();
      if (device.tokenHash) byToken.delete(device.tokenHash);
      device.tokenHash = null;
      saveNow();
      return true;
    },

    /** Records a report's arrival. Contact is the hub's clock, never the machine's. */
    touch(id, { freshness, backlog, at = now() } = {}) {
      const device = devices.get(id);
      if (!device) return;
      device.lastContactAt = at;
      // A machine sending a large first upload says how far it has got. Until
      // it has sent everything, the console must not call it complete.
      if (backlog) device.backlog = backlog.delivered < backlog.total ? { delivered: backlog.delivered, total: backlog.total } : null;
      if (freshness && (freshness.mode === "live" || freshness.mode === "periodic")) device.mode = freshness.mode;
      if (freshness && typeof freshness.lastObservedAt === "string") {
        const observed = Date.parse(freshness.lastObservedAt);
        if (Number.isFinite(observed) && (!device.lastObservedAt || observed > device.lastObservedAt)) {
          device.lastObservedAt = observed;
        }
      }
      saveSoon();
    },

    flush: saveNow,
  };
}
