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
  for (const id of ["addDialog", "inspectDialog", "alertPanel"]) {
    assert.match(HTML, new RegExp(`<dialog class="sheet dock" id="${id}" aria-labelledby="[^"]+"`, "u"), id + " is not a docked sheet");
  }
  // one door, one content: a lane's context lives in its inspector, and the context button opens the inspector at that section
  assert.doesNotMatch(HTML, /id="contextDialog"/u, "a second sheet repeats the inspector's context block");
  assert.match(JS, /function showContext\(lane, from = null\) \{\s*openInspect\("lane", lane\.key, from\);/u);
  assert.match(HTML + JS, /id="inspectContext"/u);
  // the address opens one thing beside the canvas: whatever it does not name closes first
  assert.match(JS, /for \(const d of document\.querySelectorAll\("dialog\[open\]"\)\) d\.close\(\);/u);
  // Remove confirms inside the machine's inspector, never in a modal that blanks the frame.
  assert.doesNotMatch(HTML, /id="revokeDialog"/u);
  assert.match(JS, /data-revoke-go=/u);
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
  // One frame stamp on the strip every view shares, then one per generated row and figure — never both on one pane, never neither.
  const strip = HTML.slice(HTML.indexOf('id="strip"'), HTML.indexOf('id="view-console"'));
  assert.match(strip, /<span class="stamp demo-only"[^>]*>DEMO<\/span>/u, "the strip has no DEMO stamp");
  for (const rows of [/peopleTable[\s\S]*?\$\{demoStamp\(\)\}/u, /machineTable[\s\S]*?\$\{demoStamp\(\)\}/u, /projTable[\s\S]*?\$\{demoStamp\(\)\}/u, /class="stamp sm" title="Generated/u]) {
    assert.match(JS, rows, "a generated row is not stamped");
  }
  for (const view of ["view-console", "view-team", "view-projects"]) {
    const section = HTML.slice(HTML.indexOf(`id="${view}"`), HTML.indexOf("</main>"));
    assert.doesNotMatch(section.slice(0, section.indexOf("</section>")), /class="stamp demo-only"/u, view + " stamps its pane heads on top of its rows");
  }
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

test("each lane's buttons are named with their reading and their row", () => {
  assert.doesNotMatch(JS, /aria-label="Show agent tree"|aria-label="Session context details"/u, "every row's buttons share one name");
  // the row's name goes through pn(), so presenting swaps it for a stand-in in the label too
  assert.match(JS, /const projectName = pn\("project", l\.project\.name\);/u);
  assert.match(JS, /agButton\.setAttribute\("aria-label", [^\n]*l\.agents\.live[^\n]*projectName/u);
  assert.match(JS, /cx\.querySelector\("button"\)\.setAttribute\("aria-label"[\s\S]{0,200}Context \$\{fmt\(l\.context\.latest\)\}[\s\S]{0,120}projectName/u);
  // every lane row is a button named for its lane, and the keyboard lands on it
  assert.match(JS, /row\.setAttribute\("role", "button"\);/u);
  assert.match(JS, /row\.setAttribute\("aria-label", `\$\{projectName\}/u);
  assert.match(JS, /row\.focus\(\{ preventScroll: true \}\);/u);
});

test("the Machines panel names the chosen period, and the agent tree says when an outcome is unknown", () => {
  assert.doesNotMatch(JS, /share of the last 24 hours/u, "the Machines subtitle is fixed to 24 hours");
  assert.match(JS, /share of the \$\{PERIOD_TEXT\[period\]\[0\]\}/u);
  assert.match(JS, /outcome unknown · no result recorded/u);
  assert.match(JS, /on machines that left or were removed/u);
  assert.match(JS, /d\.leftAt \? "left" : "removed"/u);
});
