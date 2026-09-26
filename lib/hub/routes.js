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
 * Join attempts are counted before they are read, per address (an IPv6
 * address by its /64) and in total; an address over its own limit is refused
 * without being counted in the total, so one device cannot use up everyone's
 * joins. Ingestion is rate-limited per machine and capped per machine per day.
 * Callers from outside private networks are refused unless --allow-public;
 * carrier-grade NAT (100.64.0.0/10) counts as private only with --allow-cgnat.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { validateRecords, freshnessFor, backlogFor, coverageFor, extrasFor, isPrivateHost } from "../collector/transport.js";
import { ALERT_WINDOW_MS } from "./alerts.js";
import { buildConsole } from "./aggregate.js";
import { cleanLabel, LINK_CODE_PATTERN } from "./registry.js";
import { projectsPayload, PERIODS } from "./projects.js";
import { readBody, requestPath, query, sendJson, sendText, serveFile, headers } from "./http.js";
import { joinCommand, releasePage, releaseUrl, verifiedRun } from "../invocation.js";
import { formatInteropMetrics } from '../analysis/index.js';
import { TOKEN_DEFINITION } from '../analysis/interop.js';
import { readInteropBody } from '../interop/ingest.js';

export const INGEST_PER_MINUTE = 600;
export const JOIN_PER_ADDRESS = 10;
export const JOIN_TOTAL = 60;
const JOIN_WINDOW_MS = 10 * 60_000;

/* The join page and what it loads: exact paths, nothing else. */
const JOIN_ASSETS = new Map([
  ["/join", "join.html"], ["/join.js", "join.js"], ["/join.css", "join.css"], ["/house.css", "house.css"], ["/theme.js", "theme.js"],
  ["/brand/mark.svg", "brand/mark.svg"], ["/brand/substrate.jpg", "brand/substrate.jpg"], ["/favicon.svg", "favicon.svg"],
]);
const FONT = /^\/fonts\/([a-z0-9-]+\.woff2)$/u;
const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "via"];

export function isLoopbackAddress(address) {
  const a = String(address || "").replace(/^::ffff:/u, "");
  return a === "::1" || /^127\./u.test(a);
}

/**
 * Loopback or a private network (RFC 1918, link-local, IPv6 ULA). Carrier-grade
 * NAT, 100.64.0.0/10, only with { cgnat: true }: Tailscale uses it, but so do
 * internet providers, whose other customers share the range.
 */
export function isPrivateAddress(address, { cgnat = false } = {}) {
  const a = String(address || "").replace(/^::ffff:/u, "");
  return isLoopbackAddress(a) || isPrivateHost(a, { cgnat });
}

/** In 100.64.0.0/10. */
export function isCgnatAddress(address) {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(String(address || "").replace(/^::ffff:/u, ""));
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/**
 * What join attempts are counted against: an IPv4 address as it is; a global
 * IPv6 address by its /64, since one machine can hold any number of addresses
 * in its own /64. A unique-local (fc00::/7) or link-local (fe80::/10) /64 is
 * usually the whole office network, shared by everyone joining, so those
 * addresses count one by one.
 */
export function joinAddressKey(address) {
  const a = String(address || "").replace(/^::ffff:/u, "").toLowerCase().split("%")[0];
  if (!a.includes(":")) return a;
  const [head, tail] = a.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = (tail === undefined ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back])
    .map((g) => g.replace(/^0+(?=.)/u, ""));
  if (/^f[cd]/u.test(groups[0] || "") || /^fe[89ab]/u.test(groups[0] || "")) return groups.join(":");
  return groups.slice(0, 4).join(":") + "::/64";
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

export function createReportingHandler({ config, registry, store, fleet = null, version, publicDir, onChange = () => {}, onEvent = () => {} }) {
  const joinPerAddress = createLimiter({ limit: JOIN_PER_ADDRESS, windowMs: JOIN_WINDOW_MS });
  const joinTotal = createLimiter({ limit: JOIN_TOTAL, windowMs: JOIN_WINDOW_MS });
  const ingestLimiter = createLimiter({ limit: INGEST_PER_MINUTE, windowMs: 60_000 });
  const badTokenLimiter = createLimiter({ limit: 20, windowMs: 60_000 });

  return async function handle(req, res, { secure }) {
    const ip = String(req.socket && req.socket.remoteAddress);
    if (!config.allowPublic && !isPrivateAddress(ip, { cgnat: config.allowCgnat === true })) {
      sendText(res, 403, isCgnatAddress(ip)
        ? "This console accepts machines on private networks only. 100.64.0.0/10 (carrier-grade NAT, also used by Tailscale) counts as private only when the console is started with --allow-cgnat."
        : "This console accepts machines on private networks only.");
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

    if (url === "/api/join" || url === "/api/ingest" || url === "/api/leave") {
      if (req.method !== "POST") { sendJson(res, 405, { ok: false, reason: "method not allowed" }); return; }
      if (!secure) {
        sendJson(res, 426, { ok: false, reason: "This console takes joins and reports over TLS only. Use a join link from it and the matching version of Agent Console." });
        return;
      }
    }

    // ---- the join exchange: counted before the body is read ------------------
    if (url === "/api/join") {
      const tooMany = (wait) => sendJson(res, 429, { ok: false, reason: "Too many join attempts. Wait a few minutes, then use a fresh link." }, { extra: { "retry-after": String(wait) } });
      // Counted per address before the body is read.
      const own = joinPerAddress.take(joinAddressKey(ip));
      if (own) { tooMany(own); return; }
      let body;
      try { body = await readBody(req, 4 * 1024); } catch { sendJson(res, 400, { ok: false, reason: "The join request was not readable." }); return; }
      // The total guards the eight-character typed code against guessing
      // from many addresses. A link's 128-bit code cannot be guessed, so a
      // join by link is never held off by other addresses' attempts.
      if (!(body && typeof body.code === "string" && LINK_CODE_PATTERN.test(body.code))) {
        const all = joinTotal.take("*");
        if (all) { tooMany(all); return; }
      }
      try {
        if (config.demo) throw Object.assign(new Error("This console is a demonstration and does not accept machines."), { status: 403 });
        const { device, token, reattached, renamed } = registry.redeem(body && body.code, {
          name: body && typeof body.name === "string" ? body.name : null,
          previousToken: body && typeof body.previous === "string" ? body.previous : null,
        });
        onChange();
        onEvent({ event: reattached ? "rejoined" : "joined", device: { id: device.id, label: device.label, person: device.person } });
        sendJson(res, 200, {
          ok: true,
          token,
          device: { id: device.id, label: device.label, person: device.person },
          organizationId: registry.organizationId,
          orgSalt: registry.orgSalt,
          retentionDays: config.retentionDays,
          // Said back, so the reporter can tell its person: the same entry
          // as before, and any name the console could not use as asked.
          reattached,
          renamed,
        }, { redact: false });
      } catch (error) {
        sendJson(res, error.status || 400, { ok: false, reason: String(error.message) });
      }
      return;
    }

    // ---- leaving (bearer token): the machine asks to be taken off --------------
    if (url === "/api/leave") {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = config.demo ? null : registry.authenticate(token);
      if (!device) {
        const wait = badTokenLimiter.take(ip);
        sendJson(res, wait ? 429 : 401, { ok: false, reason: wait ? "too many refused requests" : "unknown or revoked device" },
          wait ? { extra: { "retry-after": String(wait) } } : {});
        return;
      }
      registry.leave(device.id);
      onChange();
      onEvent({ event: "left", device: { id: device.id, label: device.label, person: device.person } });
      sendJson(res, 200, { ok: true });
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
      let freshness, backlog, coverage, extras;
      try {
        if (!envelope || envelope.v !== 1 || !envelope.device || envelope.device.id !== device.id) throw new Error("device");
        if (!Array.isArray(envelope.records) || envelope.records.length > 500) throw new Error("records");
        // The same strict check the reporter applied before sending: exact keys,
        // salted hashes, minute timestamps, non-negative counts, fixed provenance.
        validateRecords(envelope.records, { id: device.id });
        freshness = freshnessFor(envelope.freshness, envelope.records);
        backlog = backlogFor(envelope.backlog);
        coverage = coverageFor(envelope.coverage);
        // What this run shares, and its opt-in alerts and tool activity: counts,
        // kinds, minutes and salted hashes only. An entry dated past the clock
        // rule is refused one by one in fleet.accept, not with the records.
        extras = extrasFor(envelope);
      } catch {
        sendJson(res, 400, { ok: false, reason: "invalid envelope" });
        return;
      }
      if (store.quotaLeft(device.id) < envelope.records.length) {
        sendJson(res, 429, { ok: false, reason: "this machine's daily allowance is used up" }, { extra: { "retry-after": String(secondsToUtcMidnight()) } });
        return;
      }
      const receipt = store.ingest(device.id, envelope.records);
      registry.touch(device.id, { freshness, backlog, coverage });
      fleet?.accept(device.id, extras);
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

/** The demo's optional-telemetry figures: generated, and stamped DEMO wherever they are shown. */
export function demoInterop(now) {
  return {
    otel: { available: true, tokens: { input: 23_000, output: 8_000, cacheRead: 41_000, cacheWrite: 2_000, total: 74_000 }, receivedAt: now,
      tokenDefinition: TOKEN_DEFINITION.otel, dedupedSamples: 3, cumulativeIgnored: 12 },
    kong: { available: true, tokens: { input: 32_000, output: 10_000, cacheRead: 6_000, cacheWrite: 1_000, total: 42_000 }, receivedAt: now, tokenDefinition: TOKEN_DEFINITION.kong },
    litellm: { available: true, tokens: { input: 30_000, output: 8_000, cacheRead: 5_000, cacheWrite: 500, total: 38_000 }, receivedAt: now, tokenDefinition: TOKEN_DEFINITION.litellm },
  };
}

/** This machine's alerts, then every joined machine's that shares them; each names its machine. */
export function allAlerts({ alerts = null, fleet = null, localId = null }, now) {
  return [...(alerts?.list() || []).map((a) => ({ ...a, deviceId: a.deviceId ?? localId })), ...(fleet?.alerts(now) || [])];
}

/**
 * One machine's coverage of a window starting at `from`:
 * `{ state, since, reason }`, state one of
 *   complete    shared for the whole window: nothing held is a known zero
 *   partial     shared only since `since`: what is held is a floor, and a lane with nothing held is unavailable
 *   off | undeclared | unknown   not shared, not said, or not heard since start: unavailable
 * and `reason` a fixed word the screen turns into a sentence (null when complete):
 *   console-restarted    kept in memory; before this console started at `since` they are not held
 *   sharing-started      the machine began sharing at `since`
 *   sharing-off          the machine's reporter says it does not share them (since `since`)
 *   reporter-undeclared  the machine's reporter is older and does not say whether it shares them
 *   not-heard            nothing from the machine's reporter since this console started at `since`
 */
export function coverageOf(declared, from, startedAt) {
  if (!declared) return { state: "unknown", since: startedAt ?? null, reason: "not-heard" };
  if (declared.state === "off") return { state: "off", since: declared.since ?? null, reason: "sharing-off" };
  if (declared.state !== "on") return { state: "undeclared", since: declared.since ?? null, reason: "reporter-undeclared" };
  if (Number.isFinite(declared.since) && declared.since > from) {
    return { state: "partial", since: declared.since, reason: declared.since === startedAt ? "console-restarted" : "sharing-started" };
  }
  return { state: "complete", since: declared.since ?? null, reason: null };
}

/** Where each machine's activity and alert watch come from: this machine's own reading, or its reporter's declared opt-in. */
export function consoleSignals({ alerts = null, fleet = null, activity = null }, now) {
  // This machine's own readings are kept in memory from the console's start too.
  const startedAt = fleet?.startedAt ?? null;
  // A machine that joined after this console started has sent this console
  // everything it ever read: its first envelope's "on" has no gap before it.
  const joinedSinceStart = (device) => startedAt !== null && Date.parse(device.createdAt) >= startedAt;
  const declared = (device, kind) => {
    if (!device.local) {
      const c = fleet?.coverage(device.id, kind) ?? null;
      return c && c.state === "on" && c.since === startedAt && joinedSinceStart(device) ? { state: "on", since: null } : c;
    }
    const on = kind === "activity" ? Boolean(activity) : Boolean(alerts);
    return { state: on ? "on" : "off", since: on ? startedAt : null };
  };
  const covered = (c) => c.state === "complete" || c.state === "partial";
  const activityCoverage = (device, from) => coverageOf(declared(device, "activity"), from, startedAt);
  const alertsCoverage = (device, from = now - ALERT_WINDOW_MS) => coverageOf(declared(device, "alerts"), from, startedAt);
  const book = (device) => (!covered(activityCoverage(device, now)) ? null : device.local ? activity : fleet?.bookFor(device.id) ?? null);
  return {
    startedAt,
    activityCoverage,
    alertsCoverage,
    activityShared: (device) => covered(activityCoverage(device, now)),
    activity: (hashes, device) => book(device)?.snapshot(hashes, now) ?? null,
    results: (hash, device) => book(device)?.results(hash, now) ?? null,
    alertsWatched: (device) => covered(alertsCoverage(device)),
    rejectedFuture: (device) => (device.local ? 0 : fleet?.rejectedFuture(device.id) ?? 0),
  };
}

export function createConsoleHandler({ config, registry, store, names, local, admin, version, publicDir, reporting, git = null, alerts = null, interop = null,
  fleet = null, activity = null, onSignInLink = null, networkCommand = null }) {
  let cached = null;
  let lastSignInPrint = 0;

  function hubInfo() {
    const addresses = hubAddresses(config.listen, reporting.port);
    return {
      product: "Agent Console",
      version,
      demo: config.demo,
      interop: config.interop,
      listen: { address: config.listen, port: reporting.port, network: addresses.network },
      consolePort: reporting.consolePort,
      urls: addresses.urls,
      // How to open this console to other machines, with the options it runs
      // with: shown on this machine's own screen, in Add a machine.
      networkCommand: addresses.network || config.demo ? null : networkCommand,
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
    const value = buildConsole({ store, registry, names, now, hub: hubInfo(), alerts: consoleAlerts(now), signals: signals(now) });
    value.interop = config.demo ? demoInterop(now) : interop?.snapshot(now) || null;
    cached = { at: now, value };
    return value;
  }

  const consoleAlerts = (now) => allAlerts({ alerts, fleet, localId: local?.status?.device?.id ?? null }, now);
  const signals = (now) => consoleSignals({ alerts, fleet, activity }, now);

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
      // Built here, on the owner's own computer: the command to send.
      command: joinCommand(version, link),
      typed: `${verifiedRun(version)} join ${base} ${code} --fingerprint ${reporting.fingerprint}`,
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

      const interopPath = url === '/metrics' || url === '/v1/metrics'
        || url === '/ingest/gateway/kong' || url === '/ingest/gateway/litellm';
      if (config.interop && interopPath) {
        // The scrape token: an HMAC of a fixed label under the console's key
        // (lib/hub/admin.js), shown by `agent-console metrics-token`. The key
        // itself is never accepted here, and a new key makes a new token.
        if (!admin.scrapeAuthorized(req, url === "/metrics" ? "read" : "ingest")) {
          res.writeHead(401, headers('text/plain; charset=utf-8', { 'www-authenticate': 'Bearer realm="agent-console-metrics"' }));
          res.end('scrape token required: send Authorization: Bearer <token>; the metrics-token command prints it\n');
          return;
        }
      }

      if (config.interop && url === '/metrics' && req.method === 'GET') {
        const view = consolePayload();
        res.writeHead(200, headers('text/plain; version=0.0.4; charset=utf-8'));
        const demo = config.demo ? '# DEMO: this console is a demonstration; every figure below is generated.\n'
          + '# HELP agent_console_demo 1 when every figure is generated by --demo.\n# TYPE agent_console_demo gauge\nagent_console_demo 1\n' : '';
        res.end(demo + formatInteropMetrics(view.day.tokens, view.interop || interop.snapshot()));
        return;
      }
      if (config.interop && !config.demo && interop && req.method === 'POST'
        && (url === '/v1/metrics' || url === '/ingest/gateway/kong' || url === '/ingest/gateway/litellm')) {
        if (req.headers['x-agent-console-interop'] !== '1' || req.headers.origin) {
          sendText(res, 403, 'local telemetry header required'); return;
        }
        const otlp = url === '/v1/metrics';
        const type = String(req.headers['content-type'] || '').split(';')[0].trim();
        if (type !== (otlp ? 'application/json' : 'text/plain')) { sendText(res, 415, 'unsupported telemetry format'); return; }
        try {
          const body = await readInteropBody(req);
          const accepted = otlp ? interop.acceptOtlp(JSON.parse(body))
            : interop.acceptGateway(url.split('/').at(-1), body);
          if (!accepted) { sendText(res, 422, 'no supported token metrics'); return; }
          cached = null;
          sendJson(res, 200, { accepted });
        } catch (error) { sendText(res, error?.message === 'too large' ? 413 : 400, 'invalid telemetry'); }
        return;
      }

      if (url === "/login" && req.method === "GET") {
        if (admin.redeem(query(req).get("ticket"))) {
          res.writeHead(303, headers("text/plain; charset=utf-8", { location: "/", "set-cookie": admin.startSession() }));
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

      if (url.startsWith("/api/")) {
        if (req.headers["x-agent-console"] !== "1") {
          sendJson(res, 403, { ok: false, reason: "missing X-Agent-Console header" });
          return;
        }
        // A second start of the console, running as the same user, proves it
        // can read the key without sending it, and gets a sign-in ticket to
        // open the browser with (lib/hub/admin.js). The proof names the port
        // the request arrived on, so it cannot be relayed from another port.
        if (url === "/api/ticket/challenge" && req.method === "POST") {
          sendJson(res, 200, { ok: true, nonce: admin.challenge() }, { redact: false });
          return;
        }
        if (url === "/api/ticket" && req.method === "POST") {
          let body;
          try { body = await readBody(req, 4 * 1024); } catch { sendJson(res, 400, { ok: false, reason: "unreadable request" }); return; }
          const answer = admin.answerChallenge(body, req.socket && req.socket.localPort);
          if (!answer) { sendJson(res, 403, { ok: false, reason: "not this console's key" }); return; }
          sendJson(res, 200, { ok: true, ...answer }, { redact: false });
          return;
        }
        // Signed out, a browser can ask the console to print a fresh sign-in
        // link in its OWN terminal window. Nothing comes back but "printed":
        // only whoever can read that window can use it. This is the way back
        // in for a demo console, which has no key a second start could prove.
        if (url === "/api/sign-in/print" && req.method === "POST") {
          const t = Date.now();
          if (!onSignInLink || t - lastSignInPrint < 3000) { sendJson(res, 429, { ok: false, reason: "A link was printed moments ago; look in the console's window." }); return; }
          lastSignInPrint = t;
          onSignInLink();
          sendJson(res, 200, { ok: true, printed: true });
          return;
        }
        if (url === "/api/signout" && req.method === "POST") {
          sendJson(res, 200, { ok: true }, { extra: { "set-cookie": admin.signOut(req) } });
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
      // the three views are one page: /team and /projects open the console on that view (the page reads its path once, then carries the view in its hash)
      serveFile(req, res, publicDir, url === "/" || url === "/team" || url === "/projects" ? "index.html" : url.slice(1));
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
      const asked = Number(body && body.minutes) || config.inviteMinutes;
      const minutes = Math.max(5, Math.min(60, Math.round(asked)));
      const { invitation, code, linkCode } = registry.invite({
        person: cleanLabel(body && body.person, null),
        machine: cleanLabel(body && body.machine, null),
        ttlMs: minutes * 60_000,
        demo: config.demo,
      });
      cached = null;
      // The codes travel back to this machine's own browser, once. They are
      // shown masked there, copied on request, and stop working after one join.
      // A duration the console had to change is said, not changed silently.
      const adjusted = minutes !== asked ? { minutes: { asked, used: minutes, reason: "a link lasts from 5 to 60 minutes" } } : null;
      sendJson(res, 200, { ...invitationAnswer(invitation, code, linkCode), adjusted }, { redact: false });
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
