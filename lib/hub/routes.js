/**
 * The hub's two HTTP surfaces.
 *
 *   The console      127.0.0.1 only, its own port. Pages, the console's data,
 *                    making join links and removing machines. Every API call
 *                    needs the sign-in cookie (lib/hub/admin.js), a loopback
 *                    connection with a loopback Host, and no proxy headers.
 *
 *   Reporting        the --listen address, a second port. Only: the join page
 *                    and its assets (plain HTTP, so a browser opens it without
 *                    a certificate warning; it carries no secret), and over TLS
 *                    with the hub's pinned certificate, the join exchange and
 *                    token-checked ingestion. Nothing of the console is here.
 *
 * Join attempts are counted before they are read, per address and in total;
 * ingestion is rate-limited per machine and capped per machine per day.
 * Callers from outside private networks are refused unless --allow-public.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { validateRecords, freshnessFor, backlogFor, isPrivateHost } from "../collector/transport.js";
import { buildConsole } from "./aggregate.js";
import { cleanLabel } from "./registry.js";
import { projectsPayload, PERIODS } from "./projects.js";
import { readBody, requestPath, query, sendJson, sendText, serveFile, headers } from "./http.js";
import { releasePage, releaseUrl } from "../invocation.js";

export const INGEST_PER_MINUTE = 600;
export const JOIN_PER_ADDRESS = 10;
export const JOIN_TOTAL = 60;
const JOIN_WINDOW_MS = 10 * 60_000;

/* The join page and what it loads: exact paths, nothing else. */
const JOIN_ASSETS = new Map([
  ["/join", "join.html"], ["/join.js", "join.js"], ["/join.css", "join.css"], ["/house.css", "house.css"],
  ["/brand/mark.svg", "brand/mark.svg"], ["/favicon.svg", "favicon.svg"],
]);
const FONT = /^\/fonts\/([a-z0-9-]+\.woff2)$/u;
const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "via"];

export function isLoopbackAddress(address) {
  const a = String(address || "").replace(/^::ffff:/u, "");
  return a === "::1" || /^127\./u.test(a);
}

/** Loopback or a private network (RFC 1918, CGNAT such as Tailscale, link-local, IPv6 ULA). */
export function isPrivateAddress(address) {
  const a = String(address || "").replace(/^::ffff:/u, "");
  return isLoopbackAddress(a) || isPrivateHost(a);
}

/** Loopback connection AND loopback Host (the Host pin is what stops DNS rebinding). */
export function isLocalRequest(req) {
  const host = String(req.headers.host || "");
  const name = host.replace(/:\d+$/u, "").replace(/^\[|\]$/gu, "");
  const hostOk = name === "localhost" || name === "127.0.0.1" || name === "::1";
  return hostOk && isLoopbackAddress(req.socket && req.socket.remoteAddress);
}

/** A request relayed by a proxy says so; the console refuses it whatever else it carries. */
export function viaProxy(req) {
  return PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
}

/** Fixed-window counters, per key. take() counts first and answers the wait in seconds (0 = allowed). */
export function createLimiter({ limit, windowMs }) {
  const hits = new Map();
  return {
    take(key, now = Date.now()) {
      let entry = hits.get(key);
      if (!entry || now - entry.start >= windowMs) { entry = { start: now, count: 0 }; hits.set(key, entry); }
      entry.count += 1;
      if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
      return entry.count <= limit ? 0 : Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
    },
  };
}

/** The addresses another machine could use to reach the reporting port. */
export function hubAddresses(listen, port) {
  const loopbackOnly = isLoopbackAddress(listen) || listen === "localhost";
  if (loopbackOnly) return { network: false, urls: [`http://127.0.0.1:${port}`] };
  if (listen !== "0.0.0.0" && listen !== "::") return { network: true, urls: [`http://${listen.includes(":") ? `[${listen}]` : listen}:${port}`] };
  const urls = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      // Wired and wireless first, virtual bridges last.
      const weight = /^(en|eth|wl)/u.test(name) ? 0 : /^(utun|tailscale|wg)/u.test(name) ? 1 : 2;
      urls.push({ weight, url: `http://${entry.address}:${port}` });
    }
  }
  urls.sort((a, b) => a.weight - b.weight);
  return { network: true, urls: urls.map((u) => u.url).concat(urls.length ? [] : [`http://127.0.0.1:${port}`]) };
}

function secondsToUtcMidnight(now = Date.now()) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((next.getTime() - now) / 1000));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function createReportingHandler({ config, registry, store, version, publicDir, onChange = () => {} }) {
  const joinPerAddress = createLimiter({ limit: JOIN_PER_ADDRESS, windowMs: JOIN_WINDOW_MS });
  const joinTotal = createLimiter({ limit: JOIN_TOTAL, windowMs: JOIN_WINDOW_MS });
  const ingestLimiter = createLimiter({ limit: INGEST_PER_MINUTE, windowMs: 60_000 });
  const badTokenLimiter = createLimiter({ limit: 20, windowMs: 60_000 });

  return async function handle(req, res, { secure }) {
    const ip = String(req.socket && req.socket.remoteAddress);
    if (!config.allowPublic && !isPrivateAddress(ip)) {
      sendText(res, 403, "This console accepts machines on private networks only.");
      return;
    }
    const url = requestPath(req);
    if (url === null) { sendText(res, 400, "bad path"); return; }

    if (url === "/api/join/info" && req.method === "GET") {
      sendJson(res, 200, { product: "Agent Console", version, demo: config.demo, retentionDays: config.retentionDays,
        release: { url: releaseUrl(version), page: releasePage(version) } });
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && (JOIN_ASSETS.has(url) || FONT.test(url))) {
      const rel = JOIN_ASSETS.get(url) || "fonts/" + FONT.exec(url)[1];
      serveFile(req, res, publicDir, rel);
      return;
    }

    if (url === "/api/join" || url === "/api/ingest") {
      if (req.method !== "POST") { sendJson(res, 405, { ok: false, reason: "method not allowed" }); return; }
      if (!secure) {
        sendJson(res, 426, { ok: false, reason: "This console takes joins and reports over TLS only. Use a join link from it and the matching version of Agent Console." });
        return;
      }
    }

    // ---- the join exchange: counted before the body is read ------------------
    if (url === "/api/join") {
      const wait = Math.max(joinPerAddress.take(ip), joinTotal.take("*"));
      if (wait) {
        sendJson(res, 429, { ok: false, reason: "Too many join attempts. Wait a few minutes, then use a fresh link." }, { extra: { "retry-after": String(wait) } });
        return;
      }
      let body;
      try { body = await readBody(req, 4 * 1024); } catch { sendJson(res, 400, { ok: false, reason: "The join request was not readable." }); return; }
      try {
        if (config.demo) throw Object.assign(new Error("This console is a demonstration and does not accept machines."), { status: 403 });
        const { device, token } = registry.redeem(body && body.code, { name: body && typeof body.name === "string" ? body.name : null });
        onChange();
        sendJson(res, 200, {
          ok: true,
          token,
          device: { id: device.id, label: device.label, person: device.person },
          organizationId: registry.organizationId,
          orgSalt: registry.orgSalt,
          retentionDays: config.retentionDays,
        }, { redact: false });
      } catch (error) {
        sendJson(res, error.status || 400, { ok: false, reason: String(error.message) });
      }
      return;
    }

    // ---- ingestion (bearer token) ----------------------------------------------
    if (url === "/api/ingest") {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = config.demo ? null : registry.authenticate(token);
      if (!device) {
        const wait = badTokenLimiter.take(ip);
        sendJson(res, wait ? 429 : 401, { ok: false, reason: wait ? "too many refused requests" : "unknown or revoked device" },
          wait ? { extra: { "retry-after": String(wait) } } : {});
        return;
      }
      const wait = ingestLimiter.take(device.id);
      if (wait) {
        sendJson(res, 429, { ok: false, reason: "reporting too often" }, { extra: { "retry-after": String(wait) } });
        return;
      }
      let envelope;
      try { envelope = await readBody(req, 4 * 1024 * 1024); } catch (error) {
        sendJson(res, /large/u.test(String(error.message)) ? 413 : 400, { ok: false, reason: "unreadable envelope" });
        return;
      }
      let freshness, backlog;
      try {
        if (!envelope || envelope.v !== 1 || !envelope.device || envelope.device.id !== device.id) throw new Error("device");
        if (!Array.isArray(envelope.records) || envelope.records.length > 500) throw new Error("records");
        // The same strict check the reporter applied before sending: exact keys,
        // salted hashes, minute timestamps, non-negative counts, fixed provenance.
        validateRecords(envelope.records, { id: device.id });
        freshness = freshnessFor(envelope.freshness, envelope.records);
        backlog = backlogFor(envelope.backlog);
      } catch {
        sendJson(res, 400, { ok: false, reason: "invalid envelope" });
        return;
      }
      if (store.quotaLeft(device.id) < envelope.records.length) {
        sendJson(res, 429, { ok: false, reason: "this machine's daily allowance is used up" }, { extra: { "retry-after": String(secondsToUtcMidnight()) } });
        return;
      }
      const receipt = store.ingest(device.id, envelope.records);
      registry.touch(device.id, { freshness, backlog });
      onChange();
      // A receipt is counts only, and the reporter checks its exact shape.
      sendJson(res, 200, receipt, { redact: false });
      return;
    }

    sendText(res, 404, "not found");
  };
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

export function createConsoleHandler({ config, registry, store, names, local, admin, version, publicDir, reporting, git = null, guard = null }) {
  let cached = null;

  function hubInfo() {
    const addresses = hubAddresses(config.listen, reporting.port);
    return {
      product: "Agent Console",
      version,
      demo: config.demo,
      listen: { address: config.listen, port: reporting.port, network: addresses.network },
      consolePort: reporting.consolePort,
      urls: addresses.urls,
      fingerprint: reporting.fingerprint,
      retentionDays: config.retentionDays,
      release: { url: releaseUrl(version), page: releasePage(version) },
      local: local ? {
        enabled: true,
        tools: local.status.roots,
        firstRunComplete: local.status.firstRunComplete,
        progress: local.status.firstRunComplete ? null : local.status.progress,
        error: local.status.error ? "This machine's transcripts could not be read on the last pass." : null,
      } : { enabled: false },
    };
  }

  function consolePayload() {
    const now = Date.now();
    // Several tabs polling at once share one computation per half second.
    if (cached && now - cached.at < 500) return cached.value;
    const value = buildConsole({ store, registry, names, now, hub: hubInfo() });
    value.guard = guard?.list() || { installed: false, decisions: [] };
    cached = { at: now, value };
    return value;
  }

  function invitationAnswer(invitation, code, linkCode) {
    const info = hubInfo();
    const base = info.urls[0];
    const link = `${base}/join#${linkCode}.${reporting.fingerprint}`;
    return {
      ok: true,
      invitation,
      code,
      link,
      base,
      fingerprint: reporting.fingerprint,
      network: info.listen.network,
      demo: config.demo,
      release: info.release,
      // The reporter comes from the GitHub release over HTTPS, never from this hub.
      command: `npx --yes ${releaseUrl(version)} join "${link}"`,
      typed: `npx --yes ${releaseUrl(version)} join ${base} ${code} --fingerprint ${reporting.fingerprint}`,
    };
  }

  return {
    invalidate() { cached = null; },
    async handle(req, res) {
      if (viaProxy(req) || !isLocalRequest(req)) {
        sendText(res, 421, "The console answers only on the computer it runs on, and never through a proxy.");
        return;
      }
      const url = requestPath(req);
      if (url === null) { sendText(res, 400, "bad path"); return; }

      if (url === "/login" && req.method === "GET") {
        if (admin.redeem(query(req).get("ticket"))) {
          res.writeHead(303, headers("text/plain; charset=utf-8", { location: "/", "set-cookie": admin.setCookie }));
          res.end("signed in\n");
        } else {
          res.writeHead(403, headers("text/html; charset=utf-8"));
          res.end("<!doctype html><meta charset=utf-8><title>Agent Console</title><p style=\"font:15px system-ui;margin:3em\">"
            + "This sign-in link has already been used or has expired. Start the console again with <code>--open</code>, "
            + "or use the newest link it printed.</p>\n");
        }
        return;
      }

      if (url === "/api/hello" && req.method === "GET") {
        sendJson(res, 200, { product: "Agent Console", version, demo: config.demo });
        return;
      }

      // A second start of the console, running as the same user, proves it by
      // the key file and gets a sign-in ticket to open the browser with.
      if (url === "/api/ticket" && req.method === "POST") {
        const header = String(req.headers.authorization || "");
        if (!admin.secretMatches(header.startsWith("Bearer ") ? header.slice(7) : "")) {
          sendJson(res, 403, { ok: false, reason: "not this console's key" });
          return;
        }
        sendJson(res, 200, { ok: true, ticket: admin.ticket() }, { redact: false });
        return;
      }

      if (url.startsWith("/api/")) {
        if (req.headers["x-agent-console"] !== "1") {
          sendJson(res, 403, { ok: false, reason: "missing X-Agent-Console header" });
          return;
        }
        if (!admin.signedIn(req)) {
          sendJson(res, 401, { ok: false, reason: "Sign in with the link the console printed when it started, or start it again with --open." });
          return;
        }
        await api(req, res, url);
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") { sendText(res, 405, "method not allowed"); return; }
      serveFile(req, res, publicDir, url === "/" ? "index.html" : url.slice(1));
    },
  };

  async function api(req, res, url) {
    if (url === "/api/console" && req.method === "GET") {
      sendJson(res, 200, consolePayload());
      return;
    }
    if (url === "/api/projects" && req.method === "GET") {
      const period = query(req).get("period") || "24h";
      if (!PERIODS[period]) { sendJson(res, 400, { ok: false, reason: "unknown period; use one of " + Object.keys(PERIODS).join(", ") }); return; }
      sendJson(res, 200, await projectsPayload({ store, registry, names, period, demo: config.demo, git }));
      return;
    }
    if (url === "/api/invitations" && req.method === "POST") {
      let body;
      try { body = await readBody(req, 4 * 1024); } catch { sendJson(res, 400, { ok: false, reason: "unreadable request" }); return; }
      const minutes = Math.max(5, Math.min(60, Number(body && body.minutes) || config.inviteMinutes));
      const { invitation, code, linkCode } = registry.invite({
        person: cleanLabel(body && body.person, null),
        machine: cleanLabel(body && body.machine, null),
        ttlMs: minutes * 60_000,
        demo: config.demo,
      });
      cached = null;
      // The codes travel back to this machine's own browser, once. They are
      // shown masked there, copied on request, and stop working after one join.
      sendJson(res, 200, invitationAnswer(invitation, code, linkCode), { redact: false });
      return;
    }
    let match = url.match(/^\/api\/invitations\/(inv_[A-Za-z0-9_-]{16})\/cancel$/u);
    if (match && req.method === "POST") {
      const ok = registry.cancelInvitation(match[1]);
      cached = null;
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }
    match = url.match(/^\/api\/devices\/(dev_[A-Za-z0-9_-]{1,40})\/revoke$/u);
    if (match && req.method === "POST") {
      const ok = registry.revoke(match[1]);
      cached = null;
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }
    sendJson(res, 404, { ok: false, reason: "no such endpoint" });
  }
}

/** Every file of the join page exists: checked at start, so a broken package fails loudly. */
export function joinAssetsPresent(publicDir) {
  return [...JOIN_ASSETS.values()].every((rel) => fs.existsSync(path.join(publicDir, rel)));
}
