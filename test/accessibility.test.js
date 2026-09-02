import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const HTML = fs.readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const CSS = fs.readFileSync(
  new URL("../public/app.css", import.meta.url),
  "utf8",
);
const MANIFEST = JSON.parse(
  fs.readFileSync(
    new URL(
      "../public/manifest.webmanifest",
      import.meta.url,
    ),
    "utf8",
  ),
);

function cssColor(name) {
  const match = CSS.match(
    new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})\\s*;", "u"),
  );
  assert.ok(match, "missing CSS color variable --" + name);
  return match[1];
}

function luminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../gu)
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((value) =>
      value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4,
    );
  return (
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  );
}

function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("the Console exposes a semantic page and session table", () => {
  assert.match(HTML, /<html lang="en">/u);
  assert.match(HTML, /<main id="app">/u);
  assert.match(HTML, /<h1 class="visually-hidden">Agent Console<\/h1>/u);
  assert.match(HTML, /id="roster"[^>]*role="region"[^>]*aria-label="Sessions"/u);
  assert.match(HTML, /<caption class="visually-hidden">/u);
  assert.match(HTML, /id="latched"[^>]*aria-live="polite"/u);
  assert.match(HTML, /id="psbar"[\s\S]*role="progressbar"/u);
});

test("keyboard, reduced-motion and target-size contracts stay visible in CSS", () => {
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(CSS, /#filter:focus[\s\S]*outline:\s*1px solid var\(--sig\)/u);
  assert.match(CSS, /#roster:focus-visible[\s\S]*outline:/u);
  assert.match(CSS, /#glossarykey[\s\S]*width:\s*24px;[\s\S]*height:\s*24px;/u);
  assert.match(
    CSS,
    /#period,[\s\S]*#project,[\s\S]*#filter,[\s\S]*min-height:\s*24px;/u,
  );
  assert.notEqual(MANIFEST.orientation, "landscape");
});

test("text states meet WCAG AA contrast on both Console grounds", () => {
  const grounds = [cssColor("void"), cssColor("slate")];
  for (const name of ["bone", "mute", "sig", "st-live", "st-idle", "st-warn", "st-dead"]) {
    for (const ground of grounds) {
      assert.ok(
        contrast(cssColor(name), ground) >= 4.5,
        `--${name} fails 4.5:1 against ${ground}`,
      );
    }
  }

  // The darkest token-class fill conveys quantitative area, so it must meet
  // the 3:1 non-text contrast floor against the raised instrument ground.
  assert.ok(contrast(cssColor("m-cr"), cssColor("slate")) >= 3);
});
