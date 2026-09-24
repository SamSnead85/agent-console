#!/usr/bin/env node

/*
 * Which commits a CI run should check, printed as `range=<git revision range>`
 * for $GITHUB_OUTPUT. A pull request: base..head. A push: before..after, or,
 * for a new branch or a force-push whose old head is gone, everything the
 * branch has that main does not.
 */

import { execFileSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/u;
const { EVENT, BASE, HEAD, BEFORE, AFTER } = process.env;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const exists = (sha) => { try { git("cat-file", "-e", `${sha}^{commit}`); return true; } catch { return false; } };

function range() {
  if (EVENT === "pull_request") {
    if (!SHA.test(BASE || "") || !SHA.test(HEAD || "")) throw new Error("pull request without base and head commits");
    return `${BASE}..${HEAD}`;
  }
  if (!SHA.test(AFTER || "")) throw new Error("push without a commit");
  if (SHA.test(BEFORE || "") && !/^0+$/u.test(BEFORE) && exists(BEFORE)) return `${BEFORE}..${AFTER}`;
  try {
    const base = git("merge-base", "origin/main", AFTER);
    if (base && base !== AFTER) return `${base}..${AFTER}`;
  } catch { /* no main to compare with */ }
  return AFTER;   // the whole history
}

process.stdout.write(`range=${range()}\n`);
