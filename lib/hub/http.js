/**
 * The small HTTP toolkit both listeners share: response headers, JSON with
 * redaction, bounded request bodies, and static files served by exact,
 * normalised path from the package's public directory.
 */

import fs from "node:fs";
import path from "node:path";
import { redactDeep } from "../redact.js";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/* Everything is same-origin: no script, style, font or image from anywhere else.
   Inline style attributes carry bar widths; they cannot load anything, because
   images and fonts are still limited to 'self'. */
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");

export function headers(type, extra = {}) {
  return {
    "content-type": type,
    "cache-control": "no-store",
    "content-security-policy": CSP,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    ...extra,
  };
}

/**
 * Every JSON answer passes redaction first, so a credential-shaped string
 * from anywhere upstream is masked before a browser sees it. The two answers
 * that are credentials by design — a join code to this machine's own browser,
 * a device token to the machine that spent a code — opt out by name.
 */
export function sendJson(res, status, body, { redact = true, extra = {} } = {}) {
  let text;
  if (!redact) {
    text = JSON.stringify(body);
  } else {
    const { value, count, kinds } = redactDeep(body);
    if (value && typeof value === "object") value.redaction = { count, kinds };
    text = JSON.stringify(value);
  }
  res.writeHead(status, headers("application/json; charset=utf-8", extra));
  res.end(text);
}

export function sendText(res, status, text, extra = {}) {
  res.writeHead(status, headers("text/plain; charset=utf-8", extra));
  res.end(text + "\n");
}

/** A JSON body of at most `limit` bytes, or a rejection. */
export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * The request's path, decoded once and refused unless it is already in its
 * simplest form. "/fonts/../console.js", "/%2e%2e/", "//x" and backslashes are
 * refused here, before any routing decision looks at them.
 */
export function requestPath(req) {
  // The raw request target, not a URL-normalised one: normalising would turn
  // "/fonts/../console.js" into "/console.js" silently instead of refusing it.
  let pathname;
  try {
    pathname = decodeURIComponent(String(req.url || "/").split(/[?#]/u)[0]);
  } catch {
    return null;
  }
  if (!/^\/[A-Za-z0-9._\/-]*$/u.test(pathname)) return null;
  if (pathname.includes("//") || pathname.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return pathname;
}

export function query(req) {
  try { return new URL(String(req.url || "/"), "http://localhost").searchParams; } catch { return new URLSearchParams(); }
}

/**
 * Serves one file from `root` by a path already checked by requestPath. A
 * symbolic link is refused, so nothing outside the package is ever served.
 */
export function serveFile(req, res, root, rel, extra = {}) {
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) { sendText(res, 404, "not found"); return; }
  fs.lstat(target, (error, stat) => {
    if (error || !stat.isFile()) { sendText(res, 404, "not found"); return; }
    fs.readFile(target, (readError, data) => {
      if (readError) { sendText(res, 404, "not found"); return; }
      const head = headers(TYPES[path.extname(target)] || "application/octet-stream", extra);
      if (path.basename(target) === "sw.js") head["service-worker-allowed"] = "/";
      res.writeHead(200, head);
      res.end(req.method === "HEAD" ? undefined : data);
    });
  });
}
