/**
 * The hub's TLS identity: a self-signed certificate, and its fingerprint.
 *
 * Reporting travels over TLS. There is no certificate authority on a private
 * network, so the hub makes its own certificate on first start and puts the
 * certificate's SHA-256 fingerprint in every join link. The reporter accepts
 * exactly that certificate and no other (it pins it), so a device token and
 * the usage metadata are never readable or replaceable on the way, even on a
 * shared network.
 *
 * Node can parse certificates but not make them, so this writes the few DER
 * structures of an X.509 v3 certificate itself: an ECDSA P-256 key, a random
 * serial, the same name as issuer and subject, and a ten-year validity.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const sequence = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const integer = (bytes) => tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const utf8 = (text) => tlv(0x0c, Buffer.from(text, "utf8"));
const bitString = (bytes) => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]));
const explicit = (n, body) => tlv(0xa0 + n, body);

function oid(dotted) {
  const parts = dotted.split(".").map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(date) {
  const digits = date.toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(digits.slice(2) + "Z")) : tlv(0x18, Buffer.from(digits + "Z"));
}

/** A new self-signed certificate and its private key, both PEM. */
export function selfSignedCertificate({ commonName = "Agent Console hub", days = 3650, now = new Date() } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const algorithm = sequence(oid("1.2.840.10045.4.3.2"));          // ecdsa-with-SHA256
  const name = sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const validity = sequence(time(new Date(now.getTime() - 5 * 60_000)), time(new Date(now.getTime() + days * 86_400_000)));
  const tbs = sequence(explicit(0, integer(Buffer.from([2]))), integer(serial), algorithm, name, validity, name,
    publicKey.export({ type: "spki", format: "der" }));
  const der = sequence(tbs, algorithm, bitString(crypto.sign("sha256", tbs, privateKey)));
  const cert = "-----BEGIN CERTIFICATE-----\n" + der.toString("base64").match(/.{1,64}/gu).join("\n") + "\n-----END CERTIFICATE-----\n";
  return { cert, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

/** SHA-256 of the certificate's DER bytes, base64url: 43 characters, fit for a link. */
export function fingerprintOf(certificate) {
  const raw = Buffer.isBuffer(certificate) ? certificate
    : certificate && certificate.raw ? certificate.raw
    : new crypto.X509Certificate(certificate).raw;
  return crypto.createHash("sha256").update(raw).digest("base64url");
}

export const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The hub's certificate, made once and kept in the state directory (mode 600)
 * so the fingerprint in links already sent keeps working across restarts. A
 * demo, which has no state directory, gets a fresh one each start.
 */
export function hubCertificate(dir) {
  if (!dir) {
    const made = selfSignedCertificate();
    return { ...made, fingerprint: fingerprintOf(made.cert) };
  }
  const certFile = path.join(dir, "tls-cert.pem");
  const keyFile = path.join(dir, "tls-key.pem");
  try {
    const cert = fs.readFileSync(certFile, "utf8");
    const key = fs.readFileSync(keyFile, "utf8");
    const x509 = new crypto.X509Certificate(cert);
    if (x509.checkPrivateKey(crypto.createPrivateKey(key)) && Date.parse(x509.validTo) > Date.now() + 86_400_000) {
      return { cert, key, fingerprint: fingerprintOf(x509) };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("The hub's TLS certificate could not be read: " + error.message);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const made = selfSignedCertificate();
  fs.writeFileSync(keyFile, made.key, { mode: 0o600 });
  fs.writeFileSync(certFile, made.cert, { mode: 0o600 });
  return { ...made, fingerprint: fingerprintOf(made.cert) };
}
