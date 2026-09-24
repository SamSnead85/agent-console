#!/usr/bin/env node

/*
 * The public-safety check: nothing goes into this public repository that is
 * not meant for the public.
 *
 *   node scripts/public-safety/check.mjs                 every tracked file
 *   node scripts/public-safety/check.mjs --range A..B    also every commit in
 *        the range: its author, committer, message, co-authors, and every line
 *        it added (history is published too, even when a later commit or a
 *        squash merge removes the line)
 *   node scripts/public-safety/check.mjs --text-env PR_TITLE,PR_BODY
 *        also the named environment variables (a pull request's title and
 *        body become the squash commit's message)
 *   --require-denylist   fail when the private denylist is not configured
 *
 * It checks: absolute home paths, private email addresses, machine network
 * names, credential shapes (rules.js); names on the private denylist
 * (denylist.js); and metadata in images (images.js). It prints where, and
 * which rule, never the matched text. Exit status 1 means a finding.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RULES, scanText, isPublicIdentityEmail, mask } from "./rules.js";
import { loadDenylist, scanDenylist } from "./denylist.js";
import { inspect, formatOf, IMAGE_EXTENSIONS } from "./images.js";

// The repository being checked is the one the command runs in.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });

function parseArgs(argv) {
  const out = { range: null, textEnv: [], requireDenylist: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--range") out.range = argv[++i];
    else if (a === "--text-env") out.textEnv = String(argv[++i] || "").split(",").filter(Boolean);
    else if (a === "--require-denylist") out.requireDenylist = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else out.files.push(a);
  }
  return out;
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** Every finding for one file's current contents. */
export function checkFile(rel, buf, denylist) {
  const findings = [];
  if (IMAGE_EXTENSIONS.test(rel) || formatOf(buf)) {
    const { format, findings: meta } = inspect(buf);
    if (!format) findings.push({ rule: "image-format", why: "only PNG, JPEG, GIF and WebP images, so their metadata can be checked", line: 0, column: 0, masked: "" });
    for (const m of meta) findings.push({ rule: "image-metadata", why: `${m.kind}: strip it with node scripts/public-safety/strip-images.mjs`, line: 0, column: 0, masked: "" });
    return findings;
  }
  if (isBinary(buf)) return findings;
  const text = buf.toString("utf8");
  findings.push(...scanText(text));
  if (denylist) findings.push(...scanDenylist(text, denylist.entries));
  if (/\.svg$/iu.test(rel) && /<metadata[\s>]|sodipodi:docname|inkscape:export-/u.test(text)) {
    findings.push({ rule: "image-metadata", why: "SVG editor metadata (<metadata>, sodipodi:docname, inkscape:export-*): remove it", line: 0, column: 0, masked: "" });
  }
  return findings;
}

/** Commit identities, messages and added lines in a range. */
function checkRange(range, denylist) {
  const out = [];
  const commits = git("rev-list", "--no-merges", range).split("\n").filter(Boolean);
  for (const sha of commits) {
    const short = sha.slice(0, 10);
    const [an, ae, cn, ce] = git("show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", sha).trim().split("\0");
    for (const [who, email] of [["author", ae], ["committer", ce]]) {
      if (!isPublicIdentityEmail(email)) out.push({ where: `commit ${short} ${who}`, rule: "commit-identity", why: "commit with a no-reply address (git config user.email <id>+<login>@users.noreply.github.com)", masked: mask(email) });
    }
    const message = git("show", "-s", "--format=%B", sha);
    for (const m of message.matchAll(/^co-authored-by:.*<([^>]+)>/gimu)) {
      if (!isPublicIdentityEmail(m[1])) out.push({ where: `commit ${short} co-author`, rule: "commit-identity", why: "a co-author trailer with a private address; GitHub repeats it in the squash commit", masked: mask(m[1]) });
    }
    const ident = `${an}\n${cn}\n${message}`;
    for (const f of [...scanText(ident, RULES.filter((r) => r.id !== "email")), ...(denylist ? scanDenylist(ident, denylist.entries) : [])]) {
      out.push({ where: `commit ${short} message`, ...f });
    }
    // Added lines, per file. Binary files are checked by their final contents.
    let file = null;
    const patch = git("show", "--format=", "--unified=0", "--no-color", "--no-ext-diff", sha);
    for (const line of patch.split("\n")) {
      if (line.startsWith("+++ ")) { file = line.slice(4).replace(/^b\//u, ""); continue; }
      if (!line.startsWith("+") || file === null) continue;
      const added = line.slice(1);
      for (const f of [...scanText(added), ...(denylist ? scanDenylist(added, denylist.entries) : [])]) out.push({ where: `commit ${short} ${file}`, ...f, line: undefined });
    }
    for (const entry of git("show", "--format=", "--name-only", "--diff-filter=AM", sha).split("\n").filter(Boolean)) {
      if (!IMAGE_EXTENSIONS.test(entry)) continue;
      const buf = execFileSync("git", ["-C", root, "show", `${sha}:${entry}`], { maxBuffer: 1 << 30 });
      for (const f of checkFile(entry, buf, null)) out.push({ where: `commit ${short} ${entry}`, ...f });
    }
  }
  return { commits: commits.length, findings: out };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const denylist = loadDenylist();
  if (!denylist && args.requireDenylist) {
    process.stderr.write("public-safety: the private denylist is not configured (set the PUBLIC_SAFETY_DENYLIST secret)\n");
    process.exit(1);
  }
  const files = args.files.length ? args.files : git("ls-files", "-z").split("\0").filter(Boolean);
  const report = [];
  let scanned = 0;
  for (const rel of files) {
    const abs = path.join(root, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; } // deleted in the working tree
    scanned += 1;
    for (const f of checkFile(rel, buf, denylist)) report.push({ where: f.line ? `${rel}:${f.line}:${f.column}` : rel, ...f });
  }
  let commits = 0;
  if (args.range) {
    const r = checkRange(args.range, denylist);
    commits = r.commits;
    report.push(...r.findings);
  }
  for (const name of args.textEnv) {
    const text = process.env[name] || "";
    for (const f of [...scanText(text), ...(denylist ? scanDenylist(text, denylist.entries) : [])]) report.push({ where: `${name}:${f.line}:${f.column}`, ...f });
  }
  const seen = new Set();
  const unique = report.filter((f) => { const k = `${f.where}|${f.rule}|${f.masked}`; if (seen.has(k)) return false; seen.add(k); return true; });
  for (const f of unique) process.stdout.write(`${f.where}  [${f.rule}] ${f.why}${f.masked ? `  (${f.masked})` : ""}\n`);
  const summary = `public-safety: ${scanned} files${args.range ? `, ${commits} commits` : ""}${args.textEnv.length ? `, ${args.textEnv.length} texts` : ""}; denylist ${denylist ? `${denylist.entries.length} entries from ${denylist.source}` : "not configured"}; ${unique.length} finding${unique.length === 1 ? "" : "s"}\n`;
  process.stdout.write(summary);
  process.exitCode = unique.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
