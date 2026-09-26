"use strict";
/*
 * The first thing a standalone Agent Console executable runs.
 *
 * The executable is Node.js with the release package inside it. This script
 * puts that package, file for file, in a folder of the user's cache named for
 * its version and contents, checks every file against the SHA-256 recorded
 * when the executable was built, and starts it exactly as
 * `node bin/agent-console.mjs` would. Nothing is fetched: everything it writes
 * came out of this file, and a folder that no longer matches is unpacked again.
 * Other versions' folders stay in place: a running older executable may
 * still need their files and does not necessarily leave a process marker.
 *
 * Built by packaging/sea/build.mjs; see docs/executables.md.
 */

const sea = require("node:sea");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const manifest = JSON.parse(sea.getAsset("manifest.json", "utf8"));

/** Where unpacked copies live: the platform's per-user cache, or AGENT_CONSOLE_CACHE_DIR. */
function cacheRoot(env) {
  if (env.AGENT_CONSOLE_CACHE_DIR) return path.resolve(env.AGENT_CONSOLE_CACHE_DIR);
  const home = os.homedir();
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "agent-console", "Cache");
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "agent-console");
  const xdg = env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.join(home, ".cache");
  return path.join(xdg, "agent-console");
}

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function safeRelative(file) {
  if (path.isAbsolute(file) || file.split(/[\\/]/u).some((part) => part === ".." || part === "")) {
    throw new Error("the package inside this executable names an unsafe path");
  }
  return file;
}

/** True when every file in the folder is exactly the one this executable carries. */
function intact(dir) {
  try {
    return manifest.files.every((f) => sha256(fs.readFileSync(path.join(dir, safeRelative(f.path)))) === f.sha256);
  } catch {
    return false;
  }
}

function unpack(root, dir) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(root, ".unpacking-"));
  try {
    for (const f of manifest.files) {
      const bytes = Buffer.from(sea.getAsset("app/" + f.path));
      if (sha256(bytes) !== f.sha256) throw new Error(`${f.path} inside this executable does not match its recorded SHA-256`);
      const to = path.join(staging, safeRelative(f.path));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, bytes, { mode: 0o644 });
    }
    try {
      fs.renameSync(staging, dir);
    } catch (error) {
      // Another copy starting at the same moment got there first: use its folder if it is whole.
      if (intact(dir)) return;
      // A folder left damaged or half-written: set it aside, take its place, then clear it away.
      const aside = `${dir}.damaged-${process.pid}-${Date.now()}`;
      fs.renameSync(dir, aside);
      fs.renameSync(staging, dir);
      try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* already renamed into place */ }
  }
}

const root = cacheRoot(process.env);
const dir = path.join(root, `${manifest.version}-${manifest.digest.slice(0, 16)}`);
try {
  if (!intact(dir)) unpack(root, dir);
} catch (error) {
  process.stderr.write(
    `\n  Agent Console could not unpack itself into ${root}:\n  ${error.message}\n` +
      "  Set AGENT_CONSOLE_CACHE_DIR to a folder you can write to, and run it again.\n\n",
  );
  process.exit(1);
}
const entry = path.join(dir, manifest.entry);
process.argv[1] = entry;
import(pathToFileURL(entry).href).catch((error) => {
  process.stderr.write(String((error && error.stack) || error) + "\n");
  process.exit(1);
});
