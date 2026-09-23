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
