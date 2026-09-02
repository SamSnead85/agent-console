/*
 * Embedding: letting another page on this machine read this console.
 *
 * The default posture is deliberately hostile to that. This server reads
 * private session transcripts, so it binds loopback, pins the Host header,
 * emits no CORS permission, and forbids being framed. Those four together are
 * what stop a page on the public internet from resolving its own hostname to
 * 127.0.0.1 and reading an operator's prompts out of their own browser.
 *
 * Embedding has to open exactly one door in that wall, and only when the
 * operator asks. So:
 *
 *  - it is off unless `--embed <origin>` names an origin;
 *  - `*` is refused, always. A wildcard here would re-open the hole the Host
 *    pin exists to close, and "allow any origin" is never what someone putting
 *    a panel in their own command center actually needs;
 *  - the response echoes the ONE origin that matched and sets `Vary: Origin`,
 *    so a cache can never hand an allowed origin's response to another one;
 *  - `null` is refused. It is what a sandboxed iframe and a `file://` page
 *    send, and it is not an identity;
 *  - an origin is matched by exact string. No suffix matching, no ports
 *    treated as interchangeable: `http://localhost:3000` does not admit
 *    `http://localhost:3001`, and it does not admit `https://localhost:3000`.
 *
 * The same list drives `frame-ancestors`, because a panel someone wants to
 * fetch from is usually a panel they also want to iframe, and maintaining two
 * lists is how the two drift apart.
 */

"use strict";

/** Parse `--embed` into a validated, deduplicated origin allowlist. */
export function parseEmbedOrigins(raw) {
  if (raw === undefined || raw === null || raw === "" || raw === false) {
    return { origins: [], errors: [] };
  }
  // `--embed` with no value parses as the string "true" upstream; that is a
  // flag someone meant to pass an origin to, not a request to allow nothing.
  if (raw === true || raw === "true") {
    return {
      origins: [],
      errors: [
        "--embed needs at least one origin, for example --embed http://localhost:3000",
      ],
    };
  }

  const seen = new Set();
  const origins = [];
  const errors = [];

  for (const piece of String(raw).split(",")) {
    const candidate = piece.trim();
    if (!candidate) continue;

    if (candidate === "*") {
      errors.push(
        '--embed does not accept "*": this server serves private session ' +
          "transcripts, so every origin allowed to read it must be named",
      );
      continue;
    }
    if (candidate.toLowerCase() === "null") {
      errors.push(
        '--embed does not accept "null": a sandboxed frame and a file:// page ' +
          "both send it, so it identifies nobody",
      );
      continue;
    }

    let url;
    try {
      url = new URL(candidate);
    } catch {
      errors.push(
        `--embed origin "${candidate}" is not a URL; expected a scheme and a ` +
          "host, for example http://localhost:3000",
      );
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      /* `new URL("localhost:3000")` does not throw: it parses as the scheme
         `localhost:` with a path of `3000`. Reporting that as "must use http
         or https, not localhost" is technically true and useless, because the
         operator's actual mistake is a missing scheme — which is the single
         likeliest thing to type here. */
      errors.push(
        candidate.includes("//")
          ? `--embed origin "${candidate}" must use http or https, not ` +
            url.protocol.replace(":", "")
          : `--embed origin "${candidate}" has no scheme; write it in full, ` +
            `for example "http://${candidate}"`,
      );
      continue;
    }
    // `new URL("http://a/b").origin` already drops the path, but a path in the
    // operator's input means they expect it to be honoured, and it will not be.
    // Saying so beats silently widening what they asked for.
    if (url.pathname !== "/" || url.search || url.hash) {
      errors.push(
        `--embed origin "${candidate}" carries a path, query or fragment; an ` +
          `origin is scheme, host and port only — use "${url.origin}"`,
      );
      continue;
    }

    if (seen.has(url.origin)) continue;
    seen.add(url.origin);
    origins.push(url.origin);
  }

  return { origins, errors };
}

/** True when `origin` is exactly one of the allowed origins. */
export function originAllowed(origins, origin) {
  if (!origin || typeof origin !== "string") return false;
  return origins.includes(origin);
}

/**
 * The Content-Security-Policy for a response.
 *
 * Everything except `frame-ancestors` is fixed: no CDN, no font host, no
 * beacon, and the browser enforces it. `frame-ancestors` is the one directive
 * embedding moves, and it moves to a named list rather than to `*`.
 */
export function contentSecurityPolicy(origins = []) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Inline style attributes are how bar widths are expressed; they open no
    // egress path, because a CSS url() for an image is still governed by
    // img-src and a font by font-src, both of which are 'self'.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    origins.length
      ? `frame-ancestors ${origins.join(" ")}`
      : "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * CORS headers for one request, or `{}` when the request earns none.
 *
 * Returning an empty object rather than a permissive default is the whole
 * point: a request from an origin nobody named gets no permission header at
 * all, and the browser refuses to hand the body to the page.
 */
export function corsHeaders(origins, origin) {
  // `Vary: Origin` is emitted even when the origin is refused. Without it a
  // shared cache can store the no-permission response and replay it to an
  // allowed origin, or — worse — the reverse.
  if (!origins.length) return {};
  if (!originAllowed(origins, origin)) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "X-Agent-Console, X-Muster-Console",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

/**
 * Whether a cross-origin resource policy still applies.
 *
 * `same-origin` is correct while nothing may embed this. Once an operator has
 * named an origin, that header would block the very fetch they authorized, so
 * it relaxes to `cross-origin` — the CORS allowlist above is what actually
 * decides who reads the body.
 */
export function crossOriginResourcePolicy(origins = []) {
  return origins.length ? "cross-origin" : "same-origin";
}
