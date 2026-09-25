/**
 * Who may use the console: the person at this machine, signed in.
 *
 * The console listens on 127.0.0.1 only, but "the request came from this
 * machine" is not enough on its own: a reverse proxy or any local program can
 * relay a request. So every console API call also needs a sign-in cookie.
 *
 *   key      32 random bytes in admin.key in the state directory (mode 600),
 *            made on first start. Only a process running as this user can
 *            read it. It never leaves this machine's files: nothing sends it.
 *   ticket   a single-use sign-in link, /login?ticket=…, good for a few
 *            minutes. `--open` opens one; the start banner prints one. Using
 *            it starts a session and forgets the ticket.
 *   session  a random id per browser, in an HttpOnly, SameSite=Strict cookie
 *            that lasts 30 days. The console keeps only a verifier of it, an
 *            HMAC under the key, in sessions.json (mode 600), so it survives a
 *            restart, and a new key ends every session. Sign out ends one.
 *            The cookie's name is derived from the key too: consoles with
 *            different state directories on one computer each keep their own,
 *            because a browser sends a 127.0.0.1 cookie to every port.
 *
 * telemetry separate read/ingest HMAC bearer credentials for --interop.
 *           `metrics-token --scope read|ingest` prints one, and --rotate
 *           revokes that scope without changing browser sessions. The raw
 *           console key and wrong-scope credentials are never accepted.
 *
 * A second start of the console, running as the same user, asks the running
 * one for a ticket without sending the key: the running console issues a
 * single-use nonce, the second start answers with an HMAC of it under the key
 * and the port it connected to, and the console answers with an HMAC of its
 * own, which the second start checks before it prints or opens anything. So a
 * program that took the port first learns nothing, and gets nothing opened.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkScope, interopGeneration } from "./interop-credentials.js";

const TICKET_TTL_MS = 15 * 60_000;
const MAX_TICKETS = 20;
const NONCE_TTL_MS = 60_000;
const MAX_NONCES = 20;
export const SESSION_TTL_MS = 30 * 86_400_000;
const MAX_SESSIONS = 50;
const TOKEN = /^[A-Za-z0-9_-]{32}$/u;
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/u;
const VERIFIER = /^[0-9a-f]{64}$/u;

function readSecret(dir) {
  if (!dir) return crypto.randomBytes(32);
  const file = path.join(dir, "admin.key");
  try {
    const value = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64url");
    if (value.length === 32) return value;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("The console's sign-in key could not be read: " + error.message);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret.toString("base64url") + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not every filesystem keeps modes */ }
  return secret;
}

/** The key a running console uses, read by a second start as the same user; null if there is none. */
export function readAdminKey(dir) {
  try {
    const value = Buffer.from(fs.readFileSync(path.join(dir, "admin.key"), "utf8").trim(), "base64url");
    return value.length === 32 ? value : null;
  } catch {
    return null;
  }
}

function mac(key, ...parts) {
  return crypto.createHmac("sha256", key).update(parts.join("\n")).digest("base64url");
}

export const SCRAPE_TOKEN_LABEL = "agent-console/metrics/v1";

/** A scope-specific telemetry bearer token, derived from the console's key. */
export function scrapeToken(key, scope = "read", generation = "") {
  checkScope(scope);
  const label = scope === "read" ? SCRAPE_TOKEN_LABEL : "agent-console/ingest/v1";
  return crypto.createHmac("sha256", key).update(label + (generation ? "\n" + generation : "")).digest("base64url");
}

/** What a second start sends: proof it can read the key, bound to the port it reached and the console's nonce. */
export function ticketRequestProof(key, { port, nonce, client }) {
  return mac(key, "agent-console ticket request v1", String(port), nonce, client);
}

/** What the running console sends back with the ticket: proof it holds the same key. */
export function ticketAnswerProof(key, { port, nonce, client, ticket }) {
  return mac(key, "agent-console ticket answer v1", String(port), nonce, client, ticket);
}

function equal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function writePrivate(file, value) {
  const temporary = file + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* not every filesystem keeps modes */ }
}

export function createAdmin({ dir = null, now = () => Date.now() } = {}) {
  const secret = readSecret(dir);
  const scrape = scrapeToken(secret);
  const secretText = secret.toString("base64url");
  const cookieName = "agent_console_" + mac(secret, "agent-console cookie name v1").slice(0, 12);
  const verifierOf = (id) => crypto.createHmac("sha256", secret).update("agent-console session v1\n" + id).digest("hex");
  const sessionsFile = dir ? path.join(dir, "sessions.json") : null;
  const tickets = new Map();
  const nonces = new Map();
  const sessions = loadSessions();

  function loadSessions() {
    const kept = new Map();
    if (!sessionsFile) return kept;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(sessionsFile, "utf8")); } catch { return kept; }
    const t = now();
    for (const entry of Array.isArray(saved && saved.sessions) ? saved.sessions : []) {
      if (entry && VERIFIER.test(String(entry.verifier)) && Number.isFinite(entry.expiresAt) && entry.expiresAt > t) {
        kept.set(entry.verifier, { createdAt: Number(entry.createdAt) || t, expiresAt: Math.min(entry.expiresAt, t + SESSION_TTL_MS) });
      }
    }
    return kept;
  }

  function saveSessions() {
    if (!sessionsFile) return;
    try {
      writePrivate(sessionsFile, { v: 1, sessions: [...sessions].map(([verifier, s]) => ({ verifier, createdAt: s.createdAt, expiresAt: s.expiresAt })) });
    } catch { /* sessions still work until the console stops */ }
  }

  function prune(map, t) {
    for (const [key, value] of map) if ((typeof value === "number" ? value : value.expiresAt) <= t) map.delete(key);
  }

  function sessionOf(req) {
    const value = cookieValue(req.headers && req.headers.cookie, cookieName);
    if (value === null || !SESSION_ID.test(value)) return null;
    const verifier = verifierOf(value);
    const session = sessions.get(verifier);
    if (!session) return null;
    if (session.expiresAt <= now()) { sessions.delete(verifier); return null; }
    return verifier;
  }

  /** A single-use sign-in ticket. */
  function issueTicket(ttlMs = TICKET_TTL_MS) {
    const t = now();
    prune(tickets, t);
    while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
    const ticket = crypto.randomBytes(24).toString("base64url");
    tickets.set(ticket, t + ttlMs);
    return ticket;
  }

  return {
    cookieName,
    ticket: issueTicket,
    /** Spends a ticket; true once, then never again. */
    redeem(ticket) {
      if (typeof ticket !== "string") return false;
      const expires = tickets.get(ticket);
      tickets.delete(ticket);
      return typeof expires === "number" && expires > now();
    },

    /** Starts a session for one browser; the Set-Cookie value that carries it. */
    startSession() {
      const t = now();
      prune(sessions, t);
      while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      const id = crypto.randomBytes(32).toString("base64url");
      sessions.set(verifierOf(id), { createdAt: t, expiresAt: t + SESSION_TTL_MS });
      saveSessions();
      return `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
    },
    signedIn(req) {
      return sessionOf(req) !== null;
    },
    /** A bearer scrape token that matches, compared in constant time. The console's key itself never does. */
    scrapeAuthorized(req, scope = "read") {
      const found = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(String((req.headers && req.headers.authorization) || ""));
      if (!found || equal(found[1], secretText)) return false;
      try {
        return equal(found[1], scrapeToken(secret, scope, interopGeneration(dir, scope)));
      } catch { return false; } // Corrupt rotation state must never reactivate an old token.
    },
    /** Only a demonstration console, whose key lives in memory, prints its token at start. */
    demoScrapeToken() {
      return dir ? null : scrape;
    },
    /** Ends this browser's session, if it has one; the Set-Cookie value that clears it. */
    signOut(req) {
      const verifier = sessionOf(req);
      if (verifier) { sessions.delete(verifier); saveSessions(); }
      return `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
    },

    /** The first half of a second start's request for a ticket: a single-use nonce. */
    challenge() {
      const t = now();
      prune(nonces, t);
      while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value);
      const nonce = crypto.randomBytes(24).toString("base64url");
      nonces.set(nonce, t + NONCE_TTL_MS);
      return nonce;
    },
    /**
     * The second half: a ticket and the console's own proof, or null. The nonce
     * is spent whatever the outcome; `port` is the port the request arrived on.
     */
    answerChallenge({ nonce, client, proof } = {}, port) {
      if (typeof nonce !== "string" || typeof client !== "string" || typeof proof !== "string") return null;
      const expires = nonces.get(nonce);
      nonces.delete(nonce);
      if (typeof expires !== "number" || expires <= now() || !TOKEN.test(client)) return null;
      if (!equal(proof, ticketRequestProof(secret, { port, nonce, client }))) return null;
      const ticket = issueTicket();
      return { ticket, proof: ticketAnswerProof(secret, { port, nonce, client, ticket }) };
    },
  };
}

/**
 * A second start asks the console already running on `port` for a sign-in
 * link. The key is never sent: see the top of this file. Resolves to
 * { verified: true, url } when the console proved it holds the same key, and
 * { verified: false } for anything else (another program, an older console,
 * a console with another state directory).
 */
export async function requestSignIn({ port, key, fetchImpl = globalThis.fetch, timeoutMs = 3000 }) {
  const base = "http://127.0.0.1:" + port;
  const post = (p, body) => fetchImpl(base + p, {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
    headers: { "x-agent-console": "1", "content-type": "application/json" }, body: JSON.stringify(body || {}),
  });
  try {
    const first = await post("/api/ticket/challenge");
    if (!first.ok) return { verified: false };
    const { nonce } = await first.json();
    if (typeof nonce !== "string" || !TOKEN.test(nonce)) return { verified: false };
    const client = crypto.randomBytes(24).toString("base64url");
    const second = await post("/api/ticket", { nonce, client, proof: ticketRequestProof(key, { port, nonce, client }) });
    if (!second.ok) return { verified: false };
    const answer = await second.json();
    const ticket = answer && answer.ticket;
    if (typeof ticket !== "string" || !TOKEN.test(ticket)) return { verified: false };
    if (!equal(answer.proof, ticketAnswerProof(key, { port, nonce, client, ticket }))) return { verified: false };
    return { verified: true, url: base + "/login?ticket=" + ticket };
  } catch {
    return { verified: false };
  }
}
