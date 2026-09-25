/**
 * HTTPS to a hub whose certificate is known in advance.
 *
 * A hub signs its own certificate, and every join link carries that
 * certificate's SHA-256 fingerprint. `probeCertificate` fetches the hub's
 * certificate once, at join, and refuses it unless it has exactly that
 * fingerprint. From then on `pinnedFetch` trusts only that certificate: the TLS
 * layer checks the chain against it, and the fingerprint is checked again on
 * every connection. A different certificate, however it is signed, ends the
 * connection before a byte of the request is sent.
 *
 * `pinnedFetch` answers the small part of the fetch API the transport uses:
 * method, headers, body, signal; status, headers.get(), json().
 */

import crypto from "node:crypto";
import https from "node:https";
import tls from "node:tls";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export function fingerprint(raw) {
  return crypto.createHash("sha256").update(raw).digest("base64url");
}

function target(url) {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("A pinned connection is HTTPS only.");
  return { host: u.hostname.replace(/^\[|\]$/gu, ""), port: Number(u.port || 443), path: u.pathname + u.search };
}

/** The hub's certificate (PEM), if and only if its fingerprint is the expected one. */
export function probeCertificate(url, expected, { timeoutMs = 10_000 } = {}) {
  const { host, port } = target(url);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerX509Certificate();
      socket.end();
      if (!cert || fingerprint(cert.raw) !== expected) {
        reject(Object.assign(new Error("certificate mismatch"), { code: "certificate_mismatch" }));
        return;
      }
      resolve(cert.toString());
    });
    socket.on("timeout", () => socket.destroy(Object.assign(new Error("timed out"), { code: "unreachable" })));
    socket.on("error", (error) => reject(error.code === "certificate_mismatch" ? error : Object.assign(new Error("unreachable"), { code: "unreachable" })));
  });
}

/** True for the errors Node's TLS gives a certificate it does not trust. */
export function isCertificateError(error) {
  const code = String(error && error.code || "");
  return code === "certificate_mismatch" || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/u.test(code);
}

/** A fetch that only ever talks to the pinned certificate. */
export function pinnedFetch({ certificate, fingerprint: expected }) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    let spec;
    try { spec = target(url); } catch (error) { reject(error); return; }
    const request = https.request({
      ...spec,
      method: init.method || "GET",
      headers: init.headers || {},
      ca: certificate,
      agent: false,
      checkServerIdentity: (_host, cert) => (cert && cert.raw && fingerprint(cert.raw) === expected
        ? undefined
        : Object.assign(new Error("certificate mismatch"), { code: "certificate_mismatch" })),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { request.destroy(new Error("response too large")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          headers: { get: (name) => { const v = response.headers[String(name).toLowerCase()]; return Array.isArray(v) ? v.join(", ") : v ?? null; } },
          json: async () => JSON.parse(text),
          text: async () => text,
        });
      });
      response.on("error", reject);
    });
    // A certificate other than the pinned one fails the TLS check before a
    // byte is sent. Said as what it is, so "its certificate changed" is not
    // reported as "cannot reach".
    request.on("error", (error) => reject(isCertificateError(error)
      ? Object.assign(new Error("certificate mismatch"), { code: "certificate_mismatch" }) : error));
    if (init.signal) {
      if (init.signal.aborted) { request.destroy(new Error("aborted")); return; }
      init.signal.addEventListener("abort", () => request.destroy(new Error("aborted")), { once: true });
    }
    if (init.body) request.write(init.body);
    request.end();
  });
}
