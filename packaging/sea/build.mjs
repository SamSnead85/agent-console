#!/usr/bin/env node
/*
 * Build the standalone executable for the machine this runs on: Node.js with
 * the release package inside it, as one file. CI runs it once per platform
 * (.github/workflows/binaries.yml); it also works on a maintainer's machine.
 *
 *   npm ci --prefix packaging/sea          (postject, pinned by the lockfile)
 *   node packaging/sea/build.mjs [--out dist/sea]
 *
 * The Node.js that runs this script is the one that goes into the executable.
 * The package is exactly what `npm pack` would publish, file for file, each
 * with its SHA-256 (main.cjs checks them at every start). Writes, under --out:
 *
 *   dist/agent-console-<platform>-<arch>[.exe]    the executable
 *   dist/agent-console-<platform>-<arch>.tar.gz   it again, with its licences (not on Windows)
 *   labels/<file>.label                           what the release page says beside each file
 *
 * macOS: signed with a Developer ID (hardened runtime, secure timestamp,
 * identifier ai.lockedinlabs.agent-console) and notarized when
 * MACOS_SIGN_IDENTITY is set, with APPLE_NOTARY_KEY_PATH, APPLE_NOTARY_KEY_ID
 * and APPLE_NOTARY_ISSUER (CI) or APPLE_NOTARY_KEYCHAIN_PROFILE (a maintainer's
 * Mac); it is labelled signed only after Apple's ticket names its CDHash and
 * Gatekeeper accepts a quarantined copy. Otherwise it gets the ad-hoc signature
 * Apple silicon needs to run anything and is labelled unsigned, unless
 * AGENT_CONSOLE_REQUIRE_SIGNING=1 (a release), which makes that a failure.
 * Windows: Node's own signature is removed, since injecting the package breaks
 * it, and the file is labelled unsigned (there is no Authenticode certificate).
 * Linux has no signing scheme. Never a fake signature anywhere.
 */

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
// The macOS code signature's identifier: the same for every macOS build, never the file name.
const MAC_IDENTIFIER = "ai.lockedinlabs.agent-console";
const PLATFORM_NAMES = {
  "darwin-arm64": "macOS, Apple silicon",
  "darwin-x64": "macOS, Intel",
  "linux-x64": "Linux, x64",
  "linux-arm64": "Linux, arm64",
  "win32-x64": "Windows, x64",
};

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const OUT = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join(ROOT, "dist", "sea"));
const target = `${process.platform}-${process.arch}`;
if (!PLATFORM_NAMES[target]) fail(`there is no standalone executable for ${target}`);

const say = (line) => process.stdout.write(line + "\n");
function fail(message) {
  process.stderr.write(`build: ${message}\n`);
  process.exit(1);
}
function run(command, argv, options = {}) {
  return execFileSync(command, argv, { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"], ...options });
}
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/* ── what goes in: the published package, file for file, and Node's licence ── */

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find((c) => c && /npm-cli\.js$/u.test(c) && fs.existsSync(c));
  if (!found) fail("npm was not found beside this Node.js");
  return found;
}

function nodeLicence() {
  const dir = path.dirname(process.execPath);
  const found = [path.join(dir, "LICENSE"), path.join(dir, "..", "LICENSE")].find((f) => fs.existsSync(f));
  if (!found) fail("Node.js's LICENSE was not found beside it; the executable cannot ship without it");
  return fs.readFileSync(found);
}

// A real npm pack, unpacked: the executable carries exactly the published tarball's files.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-sea-"));
const packDir = path.join(work, "pack");
fs.mkdirSync(packDir);
const packed = JSON.parse(run(process.execPath, [npmCli(), "pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { cwd: ROOT }))[0];
run("tar", ["-xzf", packed.filename], { cwd: packDir });
const packRoot = path.join(packDir, "package");
const pkg = JSON.parse(fs.readFileSync(path.join(packRoot, "package.json"), "utf8"));
const entry = path.posix.normalize(String(pkg.bin?.["agent-console"] || "")).replace(/^\.\//u, "");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? walk(path.join(dir, d.name)) : [path.relative(packRoot, path.join(dir, d.name)).split(path.sep).join("/")]);
const packedFiles = walk(packRoot);
if (packedFiles.length !== packed.entryCount) fail(`unpacked ${packedFiles.length} files, npm packed ${packed.entryCount}`);

const files = packedFiles
  .map((p) => ({ path: p, bytes: fs.readFileSync(path.join(packRoot, ...p.split("/"))) }))
  .concat([{ path: "LICENSE.node", bytes: nodeLicence() }])
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
if (!files.some((f) => f.path === entry)) fail(`the package has no ${entry}`);
for (const f of files) f.sha256 = sha256(f.bytes);
const digestOf = (list) => sha256(list.map((f) => `${f.path}\0${f.sha256}\n`).join(""));
const digest = digestOf(files);
// The package alone, without this platform's Node.js licence: equal on every platform, and to the release tarball.
const packageDigest = digestOf(files.filter((f) => f.path !== "LICENSE.node"));

/* ── the blob, injected into a copy of this Node.js ── */

const manifestFile = path.join(work, "manifest.json");
fs.writeFileSync(manifestFile, JSON.stringify({
  name: pkg.name, version: pkg.version, node: process.version, entry, digest,
  files: files.map(({ path: p, sha256: s, bytes }) => ({ path: p, sha256: s, size: bytes.length })),
}));
const assets = { "manifest.json": manifestFile };
for (const f of files) {
  const staged = path.join(work, "app", ...f.path.split("/"));
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, f.bytes);
  assets["app/" + f.path] = staged;
}
const blob = path.join(work, "sea.blob");
const config = path.join(work, "sea-config.json");
fs.writeFileSync(config, JSON.stringify({
  main: path.join(HERE, "main.cjs"), output: blob, assets,
  disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
}));
run(process.execPath, ["--experimental-sea-config", config]);

const base = `agent-console-${target}`;
const exeName = process.platform === "win32" ? base + ".exe" : base;
const distDir = path.join(OUT, "dist");
const labelDir = path.join(OUT, "labels");
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(labelDir, { recursive: true });
const exe = path.join(distDir, exeName);
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);

if (process.platform === "darwin") run("codesign", ["--remove-signature", exe]);
if (process.platform === "win32") run(signtool(), ["remove", "/s", exe]);

const postject = path.join(HERE, "node_modules", "postject", "dist", "cli.js");
if (!fs.existsSync(postject)) fail("postject is not installed; run `npm ci --prefix packaging/sea` first");
run(process.execPath, [postject, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", FUSE,
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])]);

let signing = process.platform === "linux" ? "" : "unsigned";
if (process.platform === "darwin") signing = signMac(exe);

function signtool() {
  const kits = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  const versions = fs.existsSync(kits) ? fs.readdirSync(kits).filter((v) => /^10\./u.test(v)).sort().reverse() : [];
  for (const v of versions) {
    const candidate = path.join(kits, v, "x64", "signtool.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return fail("signtool.exe was not found; Node's broken signature must be removed, not shipped");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** notarytool's credentials: an App Store Connect API key (CI), or a stored keychain profile (a maintainer's Mac). */
function notaryCredentials() {
  const { APPLE_NOTARY_KEY_PATH: key, APPLE_NOTARY_KEY_ID: keyId, APPLE_NOTARY_ISSUER: issuer, APPLE_NOTARY_KEYCHAIN_PROFILE: profile } = process.env;
  if (key && keyId && issuer) return ["--key", key, "--key-id", keyId, "--issuer", issuer];
  if (profile) return ["--keychain-profile", profile];
  return fail("a Developer ID signature without notarization is still blocked by Gatekeeper; set APPLE_NOTARY_KEY_PATH, APPLE_NOTARY_KEY_ID and APPLE_NOTARY_ISSUER (or APPLE_NOTARY_KEYCHAIN_PROFILE)");
}

function signMac(file) {
  const identity = process.env.MACOS_SIGN_IDENTITY;
  if (!identity) {
    if (process.env.AGENT_CONSOLE_REQUIRE_SIGNING === "1") fail("this build must be signed and notarized, and MACOS_SIGN_IDENTITY is not set");
    run("codesign", ["--force", "--sign", "-", file]);
    return "unsigned";
  }
  const credentials = notaryCredentials();
  // Hardened runtime (notarization requires it), a secure timestamp, and only
  // the entitlements V8 needs to compile JavaScript (entitlements.plist).
  run("codesign", ["--force", "--sign", identity, "--identifier", MAC_IDENTIFIER, "--options", "runtime", "--timestamp",
    "--entitlements", path.join(HERE, "entitlements.plist"), file]);
  run("codesign", ["--verify", "--strict", "--verbose=2", file]);
  const info = codesignInfo(file);
  const cdhash = /^CDHash=([0-9a-f]{40})$/mu.exec(info)?.[1];
  if (!/^Authority=Developer ID Application: /mu.test(info)) fail("the signature is not a Developer ID Application signature");
  if (!/flags=0x10000\(runtime\)/u.test(info)) fail("the signature does not carry the hardened runtime");
  if (!/^Timestamp=/mu.test(info)) fail("the signature has no secure timestamp");
  if (!cdhash) fail("codesign printed no CDHash");

  // Notarize: a bare executable cannot carry a stapled ticket, so Gatekeeper
  // fetches it from Apple by the signature's CDHash. Check the ticket names this file.
  const zip = path.join(work, "notarize.zip");
  run("ditto", ["-c", "-k", "--keepParent", file, zip]);
  const result = JSON.parse(run("xcrun", ["notarytool", "submit", zip, ...credentials, "--wait", "--timeout", "30m", "--output-format", "json"]));
  if (result.status !== "Accepted") fail(`notarization ended ${result.status}; see notarytool log ${result.id}`);
  const log = JSON.parse(run("xcrun", ["notarytool", "log", result.id, ...credentials]));
  if (!(log.ticketContents || []).some((t) => t.cdhash === cdhash)) fail(`notarization ${result.id} holds no ticket for this file's CDHash ${cdhash}`);
  say(`notarized: ${result.id}, CDHash ${cdhash}`);

  // Then ask Gatekeeper, as a browser download would be asked: a quarantined
  // copy must be accepted as notarized. Apple publishes the ticket within minutes.
  const probe = path.join(work, "gatekeeper-probe");
  fs.copyFileSync(file, probe);
  run("xattr", ["-w", "com.apple.quarantine", `0081;${Math.floor(Date.now() / 1000).toString(16)};Safari;`, probe]);
  let verdict = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const assessed = spawnSync("spctl", ["--assess", "--type", "install", "-vv", probe], { encoding: "utf8" });
    verdict = (assessed.stdout + assessed.stderr).trim();
    if (assessed.status === 0 && /source=Notarized Developer ID/u.test(verdict)) break;
    verdict = "";
    sleep(15_000);
  }
  if (!verdict) fail("Gatekeeper did not accept the notarized executable within 10 minutes");
  say(`gatekeeper: ${verdict.replace(`${probe}: `, "").split("\n").slice(0, 2).join(" ")}`);
  return "signed and notarized";
}

function codesignInfo(file) {
  // codesign -d writes its report to stderr.
  const shown = spawnSync("codesign", ["-dvvv", file], { encoding: "utf8" });
  if (shown.status !== 0) fail(`codesign -d failed: ${shown.stderr}`);
  return shown.stdout + shown.stderr;
}

/* ── a .tar.gz beside it: the executable keeps its mode, and its licences travel with it ── */

function tarGz(entries, mtime) {
  const blocks = [];
  const octal = (value, width) => Buffer.from(value.toString(8).padStart(width - 1, "0") + "\0", "ascii");
  for (const { name, bytes, mode } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    octal(mode, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(bytes.length, 12).copy(header, 124);
    octal(mtime, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\u000000", 257, 8, "binary");
    let sum = 0;
    for (const byte of header) sum += byte;
    Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

function sourceTime() {
  if (/^\d+$/u.test(process.env.SOURCE_DATE_EPOCH || "")) return Number(process.env.SOURCE_DATE_EPOCH);
  try { return Number(run("git", ["log", "-1", "--format=%ct"], { cwd: ROOT }).trim()) || 0; } catch { return 0; }
}

const outputs = [exeName];
if (process.platform !== "win32") {
  const read = (name) => fs.readFileSync(path.join(packRoot, name));
  const archive = base + ".tar.gz";
  fs.writeFileSync(path.join(distDir, archive), tarGz([
    { name: "agent-console", bytes: fs.readFileSync(exe), mode: 0o755 },
    { name: "LICENSE", bytes: read("LICENSE"), mode: 0o644 },
    { name: "LICENSE.node", bytes: files.find((f) => f.path === "LICENSE.node").bytes, mode: 0o644 },
    { name: "THIRD_PARTY_NOTICES.md", bytes: read("THIRD_PARTY_NOTICES.md"), mode: 0o644 },
  ], sourceTime()));
  outputs.push(archive);
}

/* ── the release page shows a label instead of the bare file name: say what it is ── */

for (const name of outputs) {
  const kind = name.endsWith(".tar.gz") ? "archive" : "executable";
  const label = `${name} · ${PLATFORM_NAMES[target]} ${kind}${signing ? `, ${signing}` : ""}`;
  fs.writeFileSync(path.join(labelDir, name + ".label"), label + "\n");
}

fs.rmSync(work, { recursive: true, force: true });
for (const name of outputs) {
  const size = fs.statSync(path.join(distDir, name)).size;
  say(`${name}  ${(size / 1048576).toFixed(1)} MB  ${sha256(fs.readFileSync(path.join(distDir, name)))}`);
}
say(`${pkg.name} ${pkg.version} on Node.js ${process.version}, ${packedFiles.length} packed files, package digest ${packageDigest.slice(0, 16)}${signing ? ", " + signing : ""}`);
