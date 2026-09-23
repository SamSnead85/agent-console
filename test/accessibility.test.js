import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL("../public/" + file, import.meta.url), "utf8");
const HTML = read("index.html");
const JOIN = read("join.html");
const HOUSE = read("house.css");
const CSS = read("console.css");
const JS = read("console.js");
const MANIFEST = JSON.parse(read("manifest.webmanifest"));

/** The custom properties declared in the first block that follows `selector`. */
function tokens(selector) {
  const at = HOUSE.indexOf(selector);
  assert.ok(at !== -1, "no block for " + selector);
  const block = HOUSE.slice(at, HOUSE.indexOf("}", at));
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/gu)) out[m[1]] = m[2];
  return out;
}

function luminance(hex) {
  const [r, g, b] = hex.slice(1).match(/../gu)
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test("the console is a semantic page with named regions", () => {
  assert.match(HTML, /<html lang="en">/u);
  assert.match(HTML, /<main id="app">/u);
  assert.match(HTML, /<h1 id="h-console">Agent Console<\/h1>/u);
  assert.match(HTML, /<nav class="tabs" id="tabs" aria-label="Views">/u);
  assert.match(HTML, /id="cLanes"[^>]*tabindex="0"[^>]*role="region"[^>]*aria-label="[^"]+"/u);
  assert.match(HTML, /id="toast" role="status" aria-live="polite"/u);
  assert.match(HTML, /id="joinStatus" role="status" aria-live="polite"/u);
  for (const id of ["addDialog", "revokeDialog"]) {
    assert.match(HTML, new RegExp(`<dialog class="sheet[^"]*" id="${id}" aria-labelledby="[^"]+"`, "u"));
  }
  for (const table of ["peopleTable", "machineTable", "projTable"]) {
    assert.match(HTML, new RegExp(`id="${table}"[\\s\\S]*?<caption class="visually-hidden">`, "u"), table + " has no caption");
  }
});

test("a join link is a credential: masked, never revealable, cleared when the sheet closes", () => {
  assert.match(HTML, /<input id="linkField" type="password" readonly/u);
  assert.doesNotMatch(HTML + JS, /\.type\s*=\s*["']text["']|setAttribute\(\s*["']type["']/u, "something can reveal the link");
  assert.doesNotMatch(HTML, /(show|reveal)\s+(link|code|token)/iu);
  // the commands on screen carry their codes masked; Copy puts the real ones on the clipboard
  assert.match(JS, /j\.command\.replace\(secret, "••••••••"\)/u);
  assert.match(JS, /j\.typed\.replace\(j\.code, "••••-••••"\)/u);
  assert.match(JS, /addDialog\.addEventListener\("close", \(\) => clearSecret\(\)\)/u);
  assert.match(read("join.js"), /command\.replace\(code, "••••••••"\)/u);
});

test("every surface that can show generated figures carries the DEMO stamp", () => {
  for (const view of ["view-console", "view-team", "view-projects"]) {
    const start = HTML.indexOf(`id="${view}"`);
    const end = HTML.indexOf("</section>", HTML.indexOf("<h2", start));
    assert.match(HTML.slice(start, end + 400), /class="stamp demo-only"/u, view + " has no DEMO stamp");
  }
  assert.match(HTML, /<span class="stamp demo-only"[^>]*>DEMO<\/span>/u, "the top bar has no DEMO stamp");
  assert.match(JOIN, /class="stamp" id="demoStamp"/u);
  assert.match(CSS, /body\[data-demo="false"\] \.demo-only \{ display: none; \}/u);
});

test("motion honours prefers-reduced-motion and runs on one loop", () => {
  assert.match(HOUSE, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(JS, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/u);
  assert.equal((JS.match(/requestAnimationFrame\(/gu) || []).length, 2, "one loop, scheduled from one place and started from one place");
  assert.doesNotMatch(JS, /setInterval\(/u, "nothing moves on a shared interval");
  assert.match(JS, /textAcc >= 0\.125/u, "text redraws at most eight times a second");
});

test("keyboard: focus is visible everywhere and the lanes can be scrolled from the keyboard", () => {
  assert.match(HOUSE, /:focus-visible \{ outline: 2px solid var\(--lit\)/u);
  assert.match(CSS, /\.lanescroll:focus-visible/u);
  assert.notEqual(MANIFEST.orientation, "landscape");
  assert.equal(MANIFEST.name, "Agent Console · LockedIn Labs");
  assert.equal(MANIFEST.short_name, "Agent Console");
});

test("text meets WCAG AA contrast on every ground, in light and in dark", () => {
  for (const [name, selector] of [["light", ":root {"], ["dark", ':root[data-theme="dark"] {']]) {
    const t = tokens(selector);
    for (const ink of ["ink", "ink2", "quiet", "good", "stop", "warn", "lit"]) {
      for (const ground of ["void", "tile", "tile2", "band"]) {
        assert.ok(t[ink] && t[ground], `${name}: --${ink} or --${ground} missing`);
        assert.ok(contrast(t[ink], t[ground]) >= 4.5, `${name}: --${ink} ${t[ink]} fails 4.5:1 on --${ground} ${t[ground]}`);
      }
    }
    // the cobalt primary button carries white text
    assert.ok(contrast("#FFFFFF", t.cobalt) >= 4.5, `${name}: white on --cobalt fails 4.5:1`);
  }
});

test("the dark theme is declared twice, so the toggle and the system agree", () => {
  const system = tokens(':root:not([data-theme="light"]) {');
  const toggled = tokens(':root[data-theme="dark"] {');
  assert.deepEqual(system, toggled);
});
