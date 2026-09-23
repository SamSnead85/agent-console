/**
 * Who may use the console: the person at this machine, signed in.
 *
 * The console listens on 127.0.0.1 only, but "the request came from this
 * machine" is not enough on its own: a reverse proxy or any local program can
 * relay a request. So every console API call also needs a sign-in cookie.
 *
 *   secret   32 random bytes in admin.key in the state directory (mode 600),
 *            made on first start. Only a process running as this user can
 *            read it.
 *   ticket   a single-use sign-in link, /login?ticket=…, good for a few
 *            minutes. `--open` opens one; the start banner prints one. Using
 *            it sets the cookie and forgets the ticket.
 *   cookie   HttpOnly and SameSite=Strict, so page scripts cannot read it and
 *            other sites cannot send it. Its value is derived from the secret,
 *            so it survives restarts and a new secret signs everyone out.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const COOKIE = "agent_console_session";
const TICKET_TTL_MS = 15 * 60_000;
const MAX_TICKETS = 20;

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

/** The secret a running console uses, read by a second start as the same user. */
export function readAdminSecret(dir) {
  try {
    const value = Buffer.from(fs.readFileSync(path.join(dir, "admin.key"), "utf8").trim(), "base64url");
    return value.length === 32 ? value.toString("base64url") : null;
  } catch {
    return null;
  }
}

function equal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieValue(header) {
  for (const part of String(header || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

export function createAdmin({ dir = null, now = () => Date.now() } = {}) {
  const secret = readSecret(dir);
  const session = crypto.createHmac("sha256", secret).update("console-session").digest("base64url");
  const tickets = new Map();

  return {
    /** A single-use sign-in ticket. */
    ticket(ttlMs = TICKET_TTL_MS) {
      const t = now();
      for (const [key, expires] of tickets) if (expires <= t) tickets.delete(key);
      while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
      const ticket = crypto.randomBytes(24).toString("base64url");
      tickets.set(ticket, t + ttlMs);
      return ticket;
    },
    /** Spends a ticket; true once, then never again. */
    redeem(ticket) {
      if (typeof ticket !== "string") return false;
      const expires = tickets.get(ticket);
      tickets.delete(ticket);
      return typeof expires === "number" && expires > now();
    },
    /** The Set-Cookie value that signs this browser in. */
    setCookie: `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
    signedIn(req) {
      const value = cookieValue(req.headers && req.headers.cookie);
      return value !== null && equal(value, session);
    },
    /** For a second start of the console, proving it runs as the same user. */
    secretMatches(value) {
      return typeof value === "string" && equal(value, secret.toString("base64url"));
    },
  };
}
