#!/usr/bin/env node

/*
 * The parts of docs/PRINCIPLES.md a machine can check on a pull request:
 *
 *   - a user-visible change (lib/, public/, bin/, server.js) comes with a
 *     CHANGELOG.md line, or the description ticks "No user-visible change";
 *   - an interface change (public/) comes with a new screenshot under docs/,
 *     or the description ticks "The screenshots still match", so someone has
 *     looked.
 *
 * Reads BASE and HEAD (commits) and PR_BODY from the environment.
 */

import { execFileSync } from "node:child_process";

const { BASE, HEAD, PR_BODY = "" } = process.env;
if (!/^[0-9a-f]{40}$/u.test(BASE || "") || !/^[0-9a-f]{40}$/u.test(HEAD || "")) {
  process.stderr.write("pr-checks: BASE and HEAD must be commit ids\n");
  process.exit(2);
}
const changed = execFileSync("git", ["diff", "--name-only", `${BASE}...${HEAD}`], { encoding: "utf8" }).split("\n").filter(Boolean);
const ticked = (label) => new RegExp(`\\[[xX]\\]\\s*${label}`, "u").test(PR_BODY);

const problems = [];
const userVisible = changed.filter((f) => /^(lib\/|public\/|bin\/|server\.js$)/u.test(f));
if (userVisible.length && !changed.includes("CHANGELOG.md") && !ticked("No user-visible change")) {
  problems.push(`This changes ${userVisible.length} file(s) people run (${userVisible.slice(0, 3).join(", ")}${userVisible.length > 3 ? ", …" : ""}) `
    + "but not CHANGELOG.md. Add a plain-language line under Unreleased, or tick \"No user-visible change\" in the description.");
}
const ui = changed.filter((f) => /^public\/.*\.(js|css|html)$/u.test(f));
const shots = changed.filter((f) => /^docs\/.*\.(png|jpe?g|gif|webp|mp4)$/u.test(f));
if (ui.length && !shots.length && !ticked("The screenshots still match")) {
  problems.push(`This changes the interface (${ui.slice(0, 3).join(", ")}${ui.length > 3 ? ", …" : ""}) but no screenshot under docs/. `
    + "Retake the affected screenshots from --demo, or look at them and tick \"The screenshots still match\" in the description.");
}
for (const p of problems) process.stdout.write(`::error::${p}\n`);
process.stdout.write(`pr-checks: ${changed.length} files changed; ${problems.length ? problems.length + " to fix" : "fine"}\n`);
process.exitCode = problems.length ? 1 : 0;
