/**
 * The public-safety check (scripts/public-safety/): what it catches, what it
 * lets through, and that it never repeats what it caught.
 *
 * Every string that the check must flag is assembled at runtime, like the
 * credential fixtures, so this file passes the same check it tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanText } from "../scripts/public-safety/rules.js";
import { parseDenylist, scanDenylist } from "../scripts/public-safety/denylist.js";
import { inspect, strip } from "../scripts/public-safety/images.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = path.join(ROOT, "scripts", "public-safety", "check.mjs");
const rulesHit = (text) => scanText(text).map((f) => f.rule);

// Pieces, joined only at runtime.
const U = "/Us" + "ers/";
const H = "/ho" + "me/";
const ACCOUNT = "jq" + "rivera";
const PRIVATE_EMAIL = "jq.rivera" + "@" + "gmail" + ".com";
const MACHINE = "JQs-Mac" + "Book-Pro" + ".local";

test("absolute home paths name an account; placeholders and ~ do not", () => {
  assert.deepEqual(rulesHit(`cwd: ${U}${ACCOUNT}/work/app`), ["home-path"]);
  assert.deepEqual(rulesHit(`${H}${ACCOUNT}/.claude/projects`), ["home-path"]);
  assert.deepEqual(rulesHit("C:" + "\\\\Users\\\\" + ACCOUNT + "\\\\app"), ["home-path"]);
  assert.deepEqual(rulesHit(`/tmp/claude-503/-Users-${ACCOUNT}-app/scratch`), ["home-path"]);
  for (const ok of [`${U}me/app`, `${H}dev/app`, `${U}persona/work`, "~/.claude/projects", `${U}<you>/x`, `"${U}"`, `${H}runner/work`, `-Users-me-app`]) {
    assert.deepEqual(rulesHit(ok), [], ok);
  }
});

test("only documentation and no-reply email addresses pass", () => {
  assert.deepEqual(rulesHit(`contact ${PRIVATE_EMAIL}`), ["email"]);
  for (const ok of ["t@example.invalid", "a@example.com", "noreply@github.com", "143340072+someone@users.noreply.github.com",
    "noreply@anthropic.com", "icon@2x.png", "security@lockedinlabs.ai", "npx @lockedinlabs/agent-console"]) {
    assert.deepEqual(rulesHit(ok), [], ok);
  }
});

test("a machine's own network name is caught; code that reads like one is not", () => {
  assert.deepEqual(rulesHit(`host ${MACHINE}`), ["hostname"]);
  assert.deepEqual(rulesHit("build-box" + ".lan:6788"), ["hostname"]);
  assert.deepEqual(rulesHit("laptop" + ".tail1a2b3c" + ".ts.net"), ["hostname"]);
  for (const ok of ["if (d.local) return;", "postgres://db.internal:5432/app", "studio.local", "device.local = true"]) {
    assert.deepEqual(rulesHit(ok), [], ok);
  }
});

test("credential shapes are caught, except AWS's published example key", () => {
  const shapes = ["sk-" + "ant-api03-" + "Zx".repeat(24), "gh" + "p_" + "aB3".repeat(14), "AK" + "IA" + "Q".repeat(16), "nf" + "p_" + "k".repeat(36)];
  for (const s of shapes) assert.deepEqual(rulesHit(`token=${s}`), ["credential"], s.slice(0, 6));
  assert.deepEqual(rulesHit("AK" + "IA" + "IOSFODNN7EXAMPLE"), []);
});

test("an inline allowance works for a rule, never for a credential", () => {
  assert.deepEqual(rulesHit(`${U}${ACCOUNT}/x // public-safety: allow home-path`), []);
  assert.deepEqual(rulesHit("gh" + "p_" + "aB3".repeat(14) + " // public-safety: allow credential"), ["credential"]);
});

test("the private denylist matches whole words or a regex, and reports an entry number, not the text", () => {
  const entries = parseDenylist(["# comment", "", "Acme Widgets", "/proj-?x\\d+/i"].join("\n"));
  const text = "we shipped for acme widgets and acme_widgets, not acmewidgets; see PROJX12";
  const found = scanDenylist(text, entries);
  assert.deepEqual(found.map((f) => f.rule), ["denylist #3", "denylist #3", "denylist #4"]);
  assert.ok(found.every((f) => f.masked === "(not shown)"));
  assert.throws(() => parseDenylist("/(unclosed/"), /entry 1 is not a valid pattern/u);
});

// --- images ------------------------------------------------------------------

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}
function png(extra = []) {
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
  const idat = Buffer.from("78da636000000002000148afa46b", "hex");
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

test("PNG text, EXIF, time and profile chunks are metadata; strip removes exactly them", () => {
  const dirty = png([chunk("tEXt", Buffer.from("Comment\0" + U + ACCOUNT + "/shot.png", "latin1")), chunk("eXIf", Buffer.from("MM\0*")),
    chunk("iCCP", Buffer.from("Display\0\0x", "latin1")), chunk("tIME", Buffer.alloc(7))]);
  assert.deepEqual(inspect(dirty).findings.map((f) => f.kind), ["PNG tEXt chunk", "PNG eXIf chunk", "PNG iCCP chunk", "PNG tIME chunk"]);
  const clean = strip(dirty);
  assert.deepEqual(inspect(clean).findings, []);
  assert.ok(!clean.toString("latin1").includes(ACCOUNT));
  // The pixels are the same bytes, and a lost profile is replaced by sRGB.
  const idat = (b) => b.subarray(b.indexOf("IDAT") - 4);
  assert.ok(idat(clean).equals(idat(png())));
  assert.ok(clean.includes(Buffer.from("sRGB")));
  assert.ok(strip(png()).equals(png()), "a clean image is left as it was");
});

test("JPEG EXIF, XMP and comments are metadata; JFIF is not", () => {
  const seg = (marker, data) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(data.length + 2) >> 8, (data.length + 2) & 255]), data]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    seg(0xe1, Buffer.from("Exif\0\0" + ACCOUNT, "latin1")), seg(0xfe, Buffer.from("made on " + MACHINE)),
    Buffer.from([0xff, 0xda, 0, 2]), Buffer.from([1, 2, 3]), Buffer.from([0xff, 0xd9])]);
  assert.deepEqual(inspect(jpeg).findings.map((f) => f.kind), ["JPEG APP1 segment", "JPEG comment"]);
  const clean = strip(jpeg);
  assert.deepEqual(inspect(clean).findings, []);
  assert.ok(clean.includes(Buffer.from("JFIF")) && !clean.toString("latin1").includes(ACCOUNT));
});

test("every image in the repository carries no metadata", () => {
  const files = execFileSync("git", ["-C", ROOT, "ls-files", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp"], { encoding: "utf8" }).split("\n").filter(Boolean);
  assert.ok(files.length > 0);
  for (const file of files) assert.deepEqual(inspect(fs.readFileSync(path.join(ROOT, file))).findings, [], file);
});

// --- the command -------------------------------------------------------------

function scratchRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-public-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Maintainer", GIT_AUTHOR_EMAIL: "1+maintainer@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Maintainer", GIT_COMMITTER_EMAIL: "1+maintainer@users.noreply.github.com" } });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git("add", "."); git("commit", "-q", "-m", "start");
  return { dir, git };
}
const runCheck = (cwd, args = [], env = {}) => spawnSync(process.execPath, [CHECK, ...args], { cwd, encoding: "utf8",
  env: { ...process.env, PUBLIC_SAFETY_DENYLIST: "", PUBLIC_SAFETY_DENYLIST_FILE: "", ...env } });

test("the command reports where and which rule, and never the text it found", (t) => {
  const { dir, git } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "notes.md"), `path ${U}${ACCOUNT}/app\nmail ${PRIVATE_EMAIL}\nhost ${MACHINE}\nclient Acme Widgets\n`);
  git("add", ".");
  const plain = runCheck(dir);
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /notes\.md:1:\d+ {2}\[home-path\]/u);
  assert.match(plain.stdout, /notes\.md:2:\d+ {2}\[email\]/u);
  assert.match(plain.stdout, /notes\.md:3:\d+ {2}\[hostname\]/u);
  const withList = runCheck(dir, [], { PUBLIC_SAFETY_DENYLIST: "# private\nAcme Widgets\n" });
  assert.match(withList.stdout, /notes\.md:4:\d+ {2}\[denylist #2\]/u);
  for (const out of [plain.stdout + plain.stderr, withList.stdout + withList.stderr]) {
    for (const secret of [ACCOUNT, PRIVATE_EMAIL, MACHINE, "Acme"]) assert.ok(!out.includes(secret), `the output repeated ${secret.slice(0, 3)}…`);
  }
  assert.equal(runCheck(dir, ["--require-denylist"]).status, 1, "a required denylist that is missing fails");
});

test("a commit range is checked for identities, co-authors and every line it ever added", (t) => {
  const { dir, git } = scratchRepo(t);
  const base = git("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(dir, "a.md"), `see ${U}${ACCOUNT}/app\n`);
  git("add", "."); git("commit", "-q", "-m", "add");
  fs.writeFileSync(path.join(dir, "a.md"), "see ~/app\n");
  git("add", "."); git("commit", "-q", "-m", "fix\n\nCo-authored-by: Someone <" + PRIVATE_EMAIL + ">");
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "from a laptop"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: ACCOUNT + "@" + MACHINE, GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: ACCOUNT + "@" + MACHINE } });
  assert.equal(runCheck(dir).status, 0, "the final tree is clean");
  const range = runCheck(dir, ["--range", `${base}..HEAD`]);
  assert.equal(range.status, 1);
  assert.match(range.stdout, /commit [0-9a-f]{10} a\.md {2}\[home-path\]/u, "a line removed later is still in the history");
  assert.match(range.stdout, /co-author {2}\[commit-identity\]/u);
  assert.match(range.stdout, /author {2}\[commit-identity\]/u);
  assert.ok(!range.stdout.includes(ACCOUNT) && !range.stdout.includes(PRIVATE_EMAIL));
});

test("a pull request's title and body are checked too", (t) => {
  const { dir } = scratchRepo(t);
  const r = runCheck(dir, ["--text-env", "PR_TITLE,PR_BODY"], { PR_TITLE: "Fix counting", PR_BODY: `Checked on ${MACHINE}` });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PR_BODY:1:\d+ {2}\[hostname\]/u);
});

test("this repository, as committed, passes the public checks", () => {
  const r = spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PUBLIC_SAFETY_DENYLIST: "", PUBLIC_SAFETY_DENYLIST_FILE: "" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
