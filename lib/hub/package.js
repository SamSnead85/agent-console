/**
 * The hub hands out its own copy of this package.
 *
 * A teammate who is sent a join link should not have to find a release page,
 * pick a version, or install git. The hub already has every file the reporter
 * needs — it is the same package — so it serves them as an npm-style tarball
 * at /agent-console.tgz, and the join command is `npx <that URL> join ...`.
 * The reporter is then exactly the hub's version, and the whole exchange stays
 * on the local network.
 *
 * Node has gzip but no tar, so this writes the (simple, fixed-width) ustar
 * format itself. Only the files npm itself would pack are included, under the
 * `package/` prefix npm expects. Nothing from a state directory, a transcript
 * or the environment can end up in here: the list is walked from the
 * package's own directory and filtered by package.json's `files`.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ALWAYS = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "PROVENANCE.md", "SECURITY.md"];
const SKIP = /(^|\/)(\.|node_modules\/)|\.(png|jpe?g|webp)$/u;   // screenshots are not needed to report

function header(name, size, mode, mtime) {
  const block = Buffer.alloc(512, 0);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 154);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  block.write(base, 0, 100, "utf8");
  block.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");      // uid
  block.write("0000000\0", 116, 8, "ascii");      // gid
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  block.write(Math.floor(mtime / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");       // checksum placeholder
  block.write("0", 156, 1, "ascii");              // regular file
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return block;
}

function walk(root, rel, out) {
  const full = path.join(root, rel);
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(full).sort()) walk(root, rel ? rel + "/" + entry : entry, out);
  } else if (stat.isFile() && !SKIP.test(rel)) {
    out.push(rel);
  }
}

/** The package's files as npm would pack them (minus images), relative to root. */
export function packageFiles(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const out = [];
  for (const entry of [...ALWAYS, ...(manifest.files || []).map((f) => f.replace(/\/$/u, ""))]) {
    if (fs.existsSync(path.join(root, entry))) walk(root, entry, out);
  }
  return [...new Set(out)].sort();
}

let cached = null;

/** A gzipped tarball of this package, built once per process. */
export function packageTarball(root) {
  if (cached) return cached;
  const blocks = [];
  const mtime = Date.UTC(2026, 8, 22);   // fixed, so the same files make the same bytes
  for (const rel of packageFiles(root)) {
    const data = fs.readFileSync(path.join(root, rel));
    const executable = rel.startsWith("bin/");
    blocks.push(header("package/" + rel, data.length, executable ? 0o755 : 0o644, mtime));
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  cached = zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
  return cached;
}
