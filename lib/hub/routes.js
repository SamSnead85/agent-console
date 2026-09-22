/**
 * The hub's HTTP surface, and the one security decision that shapes it:
 *
 *   The console, its data and every administrative act answer ONLY to this
 *   machine — a loopback connection carrying a loopback Host header. That is
 *   true even when the hub listens on the network.
 *
 *   Listening on the network (an explicit --listen flag, with a warning) opens
 *   exactly four things to other machines: the join page, the package tarball
 *   the join command installs, the join exchange (which needs a live
 *   single-use code), and ingestion (which needs a device's bearer token).
 *   Nobody on the network can read the console, list machines or mint codes.
 *
 * Failed join attempts and every ingest are rate-limited per address.
 */

import os from "node:os";
import { validateRecords, freshnessFor } from "../collector/transport.js";
import { buildConsole } from "./aggregate.js";
import { cleanLabel } from "./registry.js";
import { packageTarball } from "./package.js";

export const PUBLIC_PATHS = new Set(["/join", "/join.html", "/join.js", "/join.css", "/house.css", "/brand/mark.svg", "/favicon.svg", "/api/join", "/api/join/info", "/api/ingest"]);
/* The package is served under its version as well, because npx caches a
   tarball by URL: a teammate who joined an older hub would otherwise keep
   running the old reporter after the hub was upgraded. */
export const TARBALL = /^\/agent-console(?:-\d+\.\d+\.\d+)?\.tgz$/u;
export const isPublicPath = (url) => PUBLIC_PATHS.has(url) || url.startsWith("/fonts/") || TARBALL.test(url);

function isLoopbackAddress(address) {
  const a = String(address || "");
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1" || a.startsWith("127.");
}

/** Loopback connection AND loopback Host (the Host pin is what stops DNS rebinding). */
export function isLocalRequest(req) {
  const host = String(req.headers.host || "");
  const name = host.replace(/:\d+$/u, "").replace(/^\[|\]$/gu, "");
  const hostOk = name === "localhost" || name === "127.0.0.1" || name === "::1";
  return hostOk && isLoopbackAddress(req.socket && req.socket.remoteAddress);
}

/** Fixed-window counters, per key. */
function createLimiter({ limit, windowMs }) {
  const hits = new Map();
  return {
    take(key, now = Date.now()) {
      let entry = hits.get(key);
      if (!entry || now - entry.start >= windowMs) { entry = { start: now, count: 0 }; hits.set(key, entry); }
      entry.count += 1;
      if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
      return entry.count <= limit ? 0 : Math.ceil((entry.start + windowMs - now) / 1000);
    },
    peek(key, now = Date.now()) {
      const entry = hits.get(key);
      return entry && now - entry.start < windowMs && entry.count >= limit;
    },
  };
}

/** The addresses another machine could use to reach this hub. */
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

/**
 * @returns {(req, res, url, helpers) => boolean} true when the request was handled
 */
export function createHubRoutes({ config, registry, store, names, local, version, root }) {
  const joinLimiter = createLimiter({ limit: 10, windowMs: 10 * 60_000 });
  const ingestLimiter = createLimiter({ limit: 120, windowMs: 60_000 });
  const badTokenLimiter = createLimiter({ limit: 20, windowMs: 60_000 });
  let cached = null;

  function hubInfo(port) {
    const addresses = hubAddresses(config.listen, port);
    return {
      product: "Agent Console",
      version,
      demo: config.demo,
      listen: { address: config.listen, port, network: addresses.network },
      urls: addresses.urls,
      retentionDays: config.retentionDays,
      local: local ? {
        enabled: true,
        tools: local.status.roots,
        firstRunComplete: local.status.firstRunComplete,
        error: local.status.error ? "This machine's transcripts could not be read on the last pass." : null,
      } : { enabled: false },
    };
  }

  function consolePayload(port) {
    const now = Date.now();
    // Several tabs polling at once share one computation per half second.
    if (cached && now - cached.at < 500) return cached.value;
    const value = buildConsole({ store, registry, names, now, hub: hubInfo(port) });
    cached = { at: now, value };
    return value;
  }

  function joinCommands(base, code) {
    const link = `${base}/join#${code}`;
    return {
      link,
      npx: `npx --yes ${base}/agent-console-${version}.tgz join ${base} ${code}`,
      installed: `agent-console join ${base} ${code}`,
    };
  }

  return async function handle(req, res, url, { sendJson, readBody, send, port }) {
    const ip = String(req.socket && req.socket.remoteAddress);
    const local = isLocalRequest(req);

    // ---- public: the join exchange ---------------------------------------
    if (url === "/api/join/info" && req.method === "GET") {
      const info = hubInfo(port);
      sendJson(res, 200, { product: info.product, version: info.version, demo: info.demo, retentionDays: info.retentionDays });
      return true;
    }
    if (url === "/api/join" && req.method === "POST") {
      if (joinLimiter.peek(ip)) {
        res.setHeader?.("retry-after", "600");
        sendJson(res, 429, { ok: false, reason: "Too many join attempts from this address. Wait ten minutes, then use a fresh link." });
        return true;
      }
      let body;
      try { body = await readBody(req, 4 * 1024); } catch { sendJson(res, 400, { ok: false, reason: "The join request was not readable." }); return true; }
      try {
        if (config.demo) throw Object.assign(new Error("This console is a demonstration and does not accept machines."), { status: 403 });
        const { device, token } = registry.redeem(body && body.code, { name: body && typeof body.name === "string" ? body.name : null });
        cached = null;
        sendJson(res, 200, {
          ok: true,
          token,
          device: { id: device.id, label: device.label, person: device.person },
          organizationId: registry.organizationId,
          orgSalt: registry.orgSalt,
          retentionDays: config.retentionDays,
        }, { redact: false });
      } catch (error) {
        joinLimiter.take(ip);
        sendJson(res, error.status || 400, { ok: false, reason: String(error.message) });
      }
      return true;
    }

    // ---- public: ingestion (bearer token) --------------------------------
    if (url === "/api/ingest" && req.method === "POST") {
      if (badTokenLimiter.peek(ip)) { sendJson(res, 429, { ok: false, reason: "too many refused requests" }); return true; }
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = config.demo ? null : registry.authenticate(token);
      if (!device) {
        badTokenLimiter.take(ip);
        sendJson(res, 401, { ok: false, reason: "unknown or revoked device" });
        return true;
      }
      const wait = ingestLimiter.take(device.id);
      if (wait) {
        res.setHeader?.("retry-after", String(wait));
        sendJson(res, 429, { ok: false, reason: "reporting too often" });
        return true;
      }
      let envelope;
      try { envelope = await readBody(req, 4 * 1024 * 1024); } catch (error) {
        sendJson(res, /large/u.test(String(error.message)) ? 413 : 400, { ok: false, reason: "unreadable envelope" });
        return true;
      }
      try {
        if (!envelope || envelope.v !== 1 || !envelope.device || envelope.device.id !== device.id) throw new Error("device");
        if (!Array.isArray(envelope.records) || envelope.records.length > 500) throw new Error("records");
        // The same strict check the reporter applied before sending: exact keys,
        // salted hashes, minute timestamps, non-negative counts, fixed provenance.
        validateRecords(envelope.records, { id: device.id });
        const freshness = freshnessFor(envelope.freshness, envelope.records);
        const receipt = store.ingest(device.id, envelope.records);
        registry.touch(device.id, { freshness });
        cached = null;
        // A receipt is counts only, and the reporter checks its exact shape —
        // it must go back without the redaction note other answers carry.
        sendJson(res, 200, receipt, { redact: false });
      } catch {
        sendJson(res, 400, { ok: false, reason: "invalid envelope" });
      }
      return true;
    }

    if (TARBALL.test(url) && (req.method === "GET" || req.method === "HEAD")) {
      const asked = url.match(/-(\d+\.\d+\.\d+)\.tgz$/u);
      if (asked && asked[1] !== version) {
        sendJson(res, 404, { ok: false, reason: `This hub serves version ${version}, not ${asked[1]}.` });
        return true;
      }
      const body = packageTarball(root);
      send(res, 200, "application/gzip", req.method === "HEAD" ? Buffer.alloc(0) : body, { "content-length": String(body.length) });
      return true;
    }

    // ---- everything below answers only on this machine --------------------
    if (!url.startsWith("/api/console") && !url.startsWith("/api/invitations") && !url.startsWith("/api/devices")) return false;
    if (!local) {
      sendJson(res, 403, { ok: false, reason: "the console answers only on the machine it runs on" });
      return true;
    }
    if (req.headers["x-agent-console"] !== "1") {
      sendJson(res, 403, { ok: false, reason: "missing X-Agent-Console header" });
      return true;
    }

    if (url === "/api/console" && req.method === "GET") {
      sendJson(res, 200, consolePayload(port));
      return true;
    }

    if (url === "/api/invitations" && req.method === "POST") {
      let body;
      try { body = await readBody(req, 4 * 1024); } catch { sendJson(res, 400, { ok: false, reason: "unreadable request" }); return true; }
      const minutes = Math.max(5, Math.min(24 * 60, Number(body && body.minutes) || config.inviteMinutes));
      const { invitation, code } = registry.invite({
        person: cleanLabel(body && body.person, null),
        machine: cleanLabel(body && body.machine, null),
        ttlMs: minutes * 60_000,
        demo: config.demo,
      });
      cached = null;
      const info = hubInfo(port);
      const base = info.urls[0];
      // The code travels back to this machine's own browser, once. It is shown
      // masked there, copied on request, and is useless after one join or 30 minutes.
      sendJson(res, 200, {
        ok: true,
        invitation,
        code,
        base,
        network: info.listen.network,
        demo: config.demo,
        ...joinCommands(base, code),
      }, { redact: false });
      return true;
    }

    let match = url.match(/^\/api\/invitations\/(inv_[A-Za-z0-9_-]{16})\/cancel$/u);
    if (match && req.method === "POST") {
      const ok = registry.cancelInvitation(match[1]);
      cached = null;
      sendJson(res, ok ? 200 : 404, { ok });
      return true;
    }
    match = url.match(/^\/api\/devices\/(dev_[A-Za-z0-9_-]{1,40})\/revoke$/u);
    if (match && req.method === "POST") {
      const ok = registry.revoke(match[1]);
      cached = null;
      sendJson(res, ok ? 200 : 404, { ok });
      return true;
    }
    sendJson(res, 404, { ok: false, reason: "no such endpoint" });
    return true;
  };
}
