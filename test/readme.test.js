/**
 * The README is the first thing a newcomer follows, so the parts that were
 * found wanting in a cold install are held here: the full LockedIn Labs lockup
 * at the top in both themes, the literal folder to go into after unzipping, and
 * what the .tgz on the release page is.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
const README = read("README.md");

test("the README opens with the full lockup, in a light and a dark version, then the product name", () => {
  const head = README.slice(0, README.indexOf("<h1"));
  assert.match(head, /<picture>\s*<source media="\(prefers-color-scheme: dark\)" srcset="docs\/brand\/lockup-on-dark\.svg">\s*<img src="docs\/brand\/lockup-on-light\.svg" alt="LockedIn Labs"/u);
  assert.match(README, /<h1 align="center">Agent Console<\/h1>/u);
  const mark = read("public/brand/mark.svg");
  const markShapes = [...mark.matchAll(/ d="([^"]+)"/gu)].map((m) => m[1]);
  for (const [variant, ink] of [["light", "#0B1220"], ["dark", "#EEF2F8"]]) {
    const svg = read(`docs/brand/lockup-on-${variant}.svg`);
    // Outlined: GitHub renders it without the font, and nothing is fetched.
    assert.doesNotMatch(svg, /<text|<style|href=|url\(/u, variant + " lockup depends on something outside itself");
    assert.match(svg, /aria-label="LockedIn Labs"/u);
    // The real mark, not a redrawing of it.
    for (const d of markShapes) assert.ok(svg.includes(`d="${d}"`), `${variant} lockup is missing a path of the mark`);
    assert.ok(svg.includes(`fill="${ink}"`), `${variant} lockup does not use the console's ink for its ground`);
    assert.ok(svg.includes('fill="#0B5CFF"'), `${variant} lockup lost the cobalt`);
    // Two runs of letters: LOCKEDIN in ink, LABS in the quieter colour, as the header draws them.
    assert.equal((svg.match(/<path fill="#[0-9A-F]{6}" d="M3\d\./gu) || []).length, 1, "LOCKEDIN starts beside the mark");
  }
});

test("Start here names the folder to go into, and says what the release's .tgz is", () => {
  assert.match(README, /agent-console-main/u);
  assert.match(README, /cd ~\/Downloads\/agent-console-main/u);
  assert.match(README, /cd \$HOME\\Downloads\\agent-console-main/u);
  assert.match(README, /lockedinlabs-agent-console-<version>\.tgz/u);
  assert.match(README, /You don't\s+need to download or open it/u);
});

test("the README's install line runs this version: every release link names package.json's version", () => {
  const { version } = JSON.parse(read("package.json"));
  const links = [...README.matchAll(/releases\/download\/v([0-9][^/\s]*)\/lockedinlabs-agent-console-([0-9][^\s"`)]*)\.tgz/gu)];
  assert.ok(links.length > 0, "the README has no install line");
  for (const [link, tag, file] of links) {
    assert.equal(tag, version, `${link} is not this version (${version})`);
    assert.equal(file, version, `${link} is not this version (${version})`);
  }
});

test("a README install line whose release file is missing fails, except for the release event and a fresh version bump", async () => {
  const { missingRelease, BUMP_GRACE_MS } = await import("../scripts/readme-install.mjs");
  const now = Date.parse("2026-09-25T12:00:00Z");
  assert.equal(missingRelease({ event: "schedule", now }).skip, false);
  assert.equal(missingRelease({ event: "workflow_dispatch", now }).skip, false);
  assert.equal(missingRelease({ event: "push", bumpedAt: now - 2 * BUMP_GRACE_MS, now }).skip, false, "a version bumped long ago");
  assert.equal(missingRelease({ event: "push", bumpedAt: null, now }).skip, false);
  assert.equal(missingRelease({ event: "push", bumpedAt: now - 3600_000, now }).skip, true);
  assert.equal(missingRelease({ event: "release", now }).skip, true);
});
