/**
 * The session registry — how a session this console cannot scan gets on screen.
 *
 * Local scanners cover Claude Code and Codex records. A persisted registry can
 * represent other vendors or machines without misclassifying declarations as
 * locally measured activity.
 *
 * ONE mechanism, two doors into it. A registration is a small JSON file in
 * <history-dir>/sessions/<id>.json. The HTTP endpoint writes that file; an
 * agent with no HTTP client writes it directly. Both are read the same way,
 * both survive a restart of this server, and neither can reach anything outside
 * that directory: the id is sanitized to a flat filename and joined to a fixed
 * root, so "../../etc/passwd" becomes a file called "......etc.passwd".
 *
 * A registration is DECLARED, never measured, and the roster says so beside it.
 * It goes stale after REGISTRY_STALE_MS without an update — a session that
 * crashed cannot retract its own claim to be live — and is dropped entirely
 * after REGISTRY_EXPIRE_MS so an abandoned file does not haunt the roster.
 */

import fs from "node:fs";
import path from "node:path";
import { redactAndClip } from "./redact.js";
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  writePrivateAtomic,
} from "./private-state.js";

export const REGISTRY_DIR = "sessions";
/** Past this without an update, a registration is shown but marked stale. */
export const REGISTRY_STALE_MS = 10 * 60_000;
/** Past this, the file is ignored entirely and swept on the next write. */
export const REGISTRY_EXPIRE_MS = 24 * 3600_000;
/** Refuse a registry that has grown past this; something is writing a loop. */
export const REGISTRY_MAX = 200;

const TEXT_MAX = 120;
const NOTE_MAX = 200;
const ID_MAX = 64;

const STATES = new Set([
  "LIVE",
  "WARM",
  "IDLE",
  "COLD",
  "STALL",
  "RUN",
  "DEAD",
]);

export function createRegistry(config) {
  const dir = config && config.dir;
  return {
    dir: dir ? path.join(dir, REGISTRY_DIR) : null,
    lastError: null,
    writes: 0,
  };
}

/**
 * A flat, safe filename for an arbitrary id.
 *
 * Every character outside the safe set becomes a dot, so no separator and no
 * "." segment survives to climb out of the registry directory. The result is
 * also the identity the roster joins on, so it is returned rather than hidden.
 */
export function safeId(value) {
  const raw = String(value === undefined || value === null ? "" : value);
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/gu, ".").slice(0, ID_MAX);
  // A name of dots alone is still a directory reference on some platforms.
  return /[A-Za-z0-9]/u.test(cleaned) ? cleaned : "";
}

function text(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().split("\n")[0];
  if (!trimmed) return null;
  // Masked first, cut second: cutting first can remove the anchor a redaction
  // rule needs and serve the secret. See lib/redact.js.
  return redactAndClip(trimmed, max || TEXT_MAX);
}

function count(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Validate and normalize one declaration.
 * Returns { ok: true, record } or { ok: false, reason }.
 */
export function normalizeRegistration(body, now) {
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "body must be a JSON object" };
  }
  const id = safeId(body.id);
  if (!id) {
    return {
      ok: false,
      reason:
        "id is required and must contain at least one letter or digit (A-Z a-z 0-9 . _ -)",
    };
  }
  const state =
    typeof body.state === "string" && STATES.has(body.state.toUpperCase())
      ? body.state.toUpperCase()
      : null;
  const t = body.tokens && typeof body.tokens === "object" ? body.tokens : {};
  const tokens = {
    in: count(t.in),
    out: count(t.out),
    cr: count(t.cr),
    cw: count(t.cw),
    cw1h: 0,
    think: 0,
  };
  const a = body.agents && typeof body.agents === "object" ? body.agents : {};
  const record = {
    v: 1,
    id,
    // The identity a scanned row can be joined on. Supplying it is what stops a
    // session being counted twice; leaving it out is not an error.
    sessionId: text(body.sessionId, ID_MAX),
    name: text(body.name),
    vendor: text(body.vendor) || "other",
    model: text(body.model),
    machine: text(body.machine),
    project: text(body.project),
    branch: text(body.branch),
    author: text(body.author),
    note: text(body.note, NOTE_MAX),
    state,
    tokens,
    agents: { live: count(a.live), total: count(a.total) },
    at: now,
  };
  return { ok: true, record };
}

/** Write one declaration into the registry directory. */
export function registerSession(registry, body, now) {
  if (!registry.dir) {
    return { ok: false, reason: "no data directory is configured" };
  }
  const normalized = normalizeRegistration(body, now);
  if (!normalized.ok) return normalized;
  const record = normalized.record;
  try {
    ensurePrivateDirectory(registry.dir);
    const existing = fs.readdirSync(registry.dir).filter(isRecordFile);
    const file = path.join(registry.dir, record.id + ".json");
    if (existing.length >= REGISTRY_MAX && !fs.existsSync(file)) {
      return {
        ok: false,
        reason:
          "registry is full (" +
          REGISTRY_MAX +
          " sessions); remove stale files from " +
          registry.dir,
      };
    }
    // Written whole then renamed, so a reader never sees half a record.
    writePrivateAtomic(file, JSON.stringify(record) + "\n");
    registry.writes += 1;
    registry.lastError = null;
    sweep(registry, now);
    return { ok: true, record, file };
  } catch (error) {
    registry.lastError = String(error && error.message);
    return { ok: false, reason: registry.lastError };
  }
}

function isRecordFile(name) {
  return name.endsWith(".json") && !name.endsWith(".tmp");
}

/** Delete registrations older than REGISTRY_EXPIRE_MS. Best effort. */
function sweep(registry, now) {
  try {
    for (const name of fs.readdirSync(registry.dir)) {
      if (!isRecordFile(name) && !name.endsWith(".tmp")) continue;
      const full = path.join(registry.dir, name);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > REGISTRY_EXPIRE_MS)
        fs.rmSync(full, { force: true });
    }
  } catch {
    /* sweeping is housekeeping; failing it must never fail a registration */
  }
}

/**
 * Every live registration, normalized and aged.
 *
 * A malformed file is skipped and counted, never fatal — an agent writing the
 * drop file directly will get it wrong at least once, and one bad file must not
 * blank the roster.
 */
export function readRegistry(registry, now) {
  const out = { sessions: [], badFiles: 0, dir: registry.dir, error: null };
  if (!registry.dir) {
    out.error = "no data directory is configured";
    return out;
  }
  let names;
  try {
    names = fs.readdirSync(registry.dir);
  } catch (error) {
    if (error && error.code !== "ENOENT") out.error = String(error.message);
    return out;
  }
  for (const name of names) {
    if (!isRecordFile(name)) continue;
    let record;
    let mtime = 0;
    try {
      const full = path.join(registry.dir, name);
      hardenPrivateFile(full);
      mtime = fs.statSync(full).mtimeMs;
      record = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      out.badFiles += 1;
      continue;
    }
    // A hand-written drop file is re-validated exactly like an HTTP body: the
    // file is a public interface, so it gets the public interface's checks.
    const normalized = normalizeRegistration(record, mtime);
    if (!normalized.ok) {
      out.badFiles += 1;
      continue;
    }
    const value = normalized.record;
    // The record's own `at` is what the writer claimed; the file's mtime is what
    // this machine observed. The older of the two is the honest age.
    const claimed = Number(record.at);
    const at = Number.isFinite(claimed) ? Math.min(claimed, mtime) : mtime;
    const ageMs = Math.max(0, now - at);
    if (ageMs > REGISTRY_EXPIRE_MS) continue;
    value.at = at;
    value.ageMs = ageMs;
    value.stale = ageMs > REGISTRY_STALE_MS;
    value.total =
      value.tokens.in + value.tokens.out + value.tokens.cr + value.tokens.cw;
    out.sessions.push(value);
  }
  out.sessions.sort((a, b) => b.at - a.at);
  return out;
}
