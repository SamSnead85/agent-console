/**
 * The console's layout says what it shows and hides nothing that matters —
 * the six defects a read-only review found on the canon pass, each pinned
 * here so it cannot come back:
 *
 * 1. Team and Projects: the period control sits with the figures it drives;
 *    the hour chart is captioned as the hour and carries no control.
 * 2. The spend spectrum's bar names sit in their own column, never sharing a
 *    class with the header's `.top`.
 * 3. On a phone the lanes' footer sits outside the sideways scroller, the
 *    spend legend wraps, and the figures that cost money come first.
 * 4. No numeric is cut: the model split's names are not clipped, and the
 *    Projects Est. column carries its unit once, in the header.
 * 5. An Attention row is a door (lane or alert list) with keyboard access;
 *    the pointer is drawn only where there is a door.
 * 6. Projects fills its frame: the canvas takes the height and the sessions
 *    behind the projects take what the table leaves.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL("../public/" + file, import.meta.url), "utf8");
const HTML = read("index.html");
const CSS = read("console.css");
const JS = read("console.js");

/** The text of the first `@media (...)` block whose query contains `q`. */
function media(q) {
  const at = CSS.indexOf("@media (" + q);
  assert.ok(at !== -1, "no @media block for " + q);
  let depth = 0, i = CSS.indexOf("{", at);
  for (; i < CSS.length; i += 1) { if (CSS[i] === "{") depth += 1; else if (CSS[i] === "}" && --depth === 0) break; }
  return CSS.slice(at, i + 1);
}
/** The markup between two ids, in document order. */
const between = (fromId, toId) => { const a = HTML.indexOf(`id="${fromId}"`), b = HTML.indexOf(`id="${toId}"`); assert.ok(a !== -1 && b !== -1 && a < b, `${fromId} before ${toId}`); return HTML.slice(a, b); };

test("Team's and Projects' period control sits with the figures it drives, and the hour chart says it is the hour", () => {
  for (const [cap, seg, flowCap] of [["tCap", "periodSeg", "tFlowCap"], ["pCap", "projSeg", "pFlowCap"]]) {
    const figurePane = between(cap, seg);
    assert.doesNotMatch(figurePane, /class="col flow"/u, `${seg} is not in the figure pane`);
    assert.match(HTML, new RegExp(`<div class="cap"><span id="${cap}">Tokens</span>\\s*<span class="seg" id="${seg}"`, "u"), `${seg} sits in the figure's caption`);
  }
  assert.match(HTML, /<div class="cap">Activity · last hour <em class="by">by machine<\/em>/u);
  assert.match(HTML, /<div class="cap">Activity · last hour <em class="by">by project<\/em>/u);
  assert.doesNotMatch(HTML, /Activity · 1H/u, "the hour chart is not captioned as a period the control could move");
  const teamFlow = between("tFlowWrap", "tLegend"), projFlow = between("pFlowWrap", "pLegend");
  for (const flow of [teamFlow, projFlow]) assert.doesNotMatch(flow, /class="seg"/u);
  // the axis under each hour chart states the window's resolution in words
  assert.match(JS, /\$\("tFlowCap"\)\.innerHTML = .*3-min steps/u);
  assert.match(JS, /\$\("pFlowCap"\)\.innerHTML = .*3-min steps/u);
  // the caption names the figure; the period words move to hover, where the pressed button already says them
  assert.match(JS, /\$\("tCap"\)\.title = "Tokens · " \+ PERIOD_TEXT\[period\]\[0\]/u);
  assert.match(JS, /\$\("pCap"\)\.title = `Tokens · \$\{PERIOD_TEXT\[period\]\[0\]\} · this machine/u);
  assert.doesNotMatch(JS, /\$\("[tp]Cap"\)\.textContent/u);
});

test("the spend spectrum names its bars in a column of their own", () => {
  assert.match(HTML, /<div class="slabs" aria-hidden="true"><span class="slab cost">cost<\/span><span class="slab tok">tokens<\/span><\/div>/u);
  assert.doesNotMatch(HTML, /class="slab (top|bot)"/u, "a label class the header's .top rule would size");
  assert.match(CSS, /\.specwrap \{[^}]*display: grid; grid-template-columns: auto minmax\(0, 1fr\)/u);
  assert.match(CSS, /\.slab \{ display: block; height: calc\(21px \* var\(--k\)\)/u);
  assert.doesNotMatch(CSS, /\.slab \{[^}]*position: absolute/u);
  assert.doesNotMatch(CSS, /\.specwrap \{[^}]*padding-left/u);
});

test("on a phone the lanes' footer stays in frame, the spend legend wraps, and the figures that cost money come first", () => {
  // the footer is a sibling of the scroller, not inside it
  const console_ = between("cLanes", "lFoot");
  assert.match(console_, /<\/div><\/div>\s*<div class="lfoot" $/u, "the lanes body closes before the footer");
  assert.match(HTML, /<div class="lanebody"><div class="lhead"/u);
  assert.equal((HTML.match(/<div class="lanebody">/gu) || []).length, 2, "Console and Projects lanes both scroll in a body");
  const phone = media("max-width: 760px");
  assert.match(phone, /\.lanebody \{ overflow-x: auto;/u);
  assert.doesNotMatch(phone, /\.lanes:not\(\.tbl\) \{ overflow-x: auto; \}/u);
  assert.doesNotMatch(phone, /\.lfoot \{[^}]*min-width: 640px/u);
  assert.match(phone, /\.lfoot span\.end \{ flex-basis: 100%;/u);
  // the legend wraps instead of cutting a word
  assert.match(CSS, /\.speclegend span \{[^}]*flex-wrap: wrap;[^}]*white-space: normal;/u);
  assert.doesNotMatch(CSS, /\.speclegend span \{[^}]*overflow: hidden/u);
  assert.match(phone, /\.speclegend \{ grid-template-columns: 1fr; \}/u);
  // state, five minutes, the estimate and when it last spoke come before the name; Last is shown
  const order = (cls) => Number(phone.match(new RegExp(`\\.lane \\.${cls} \\{ order: (\\d); \\}`, "u"))?.[1]);
  assert.ok(order("st") < order("fm") && order("fm") < order("usd") && order("usd") < order("la") && order("la") < order("pr"), "state · 5 min · est. · last · then the name");
  assert.match(phone, /\.lhead \.c-la, \.lane \.la \{ display: block; \}/u);
  assert.doesNotMatch(phone, /\.lane \.la \{ display: none/u);
  for (const cls of ["c-st", "c-fm", "c-usd", "c-la", "c-pr", "c-md", "c-sp", "c-tot"]) assert.match(HTML, new RegExp(`<span class="(r )?${cls}"`, "u"), cls + " named in the header");
  assert.match(JS, /row\.closest\('\.lanebody, \.fold'\)\.scrollLeft = 0/u);
});

test("no numeric is cut and no unit is said twice", () => {
  assert.doesNotMatch(CSS, /table\.grid \.models \{[^}]*max-width/u);
  assert.doesNotMatch(CSS, /table\.grid \.models \.names \{[^}]*text-overflow: ellipsis/u);
  // the Projects table's Est. column: the header carries the unit, the cell the figure
  assert.match(HTML, /<th scope="col" class="r" title="List-price estimate, not an invoice">Est\.<\/th>/u);
  const cell = JS.match(/data-l="est\." data-internal data-src="projects\.usd"[^>]*>\$\{x\.usd === null \? "unpriced" : money\(x\.usd\)\}<\/td>/u);
  assert.ok(cell, "the Est. cell is the figure alone");
});

test("every Attention row is a door, by pointer and by keyboard; the pointer is drawn only where there is a door", () => {
  assert.match(JS, /<div class="arow" \$\{lane \? `data-lane="\$\{esc\(lane\.key\)\}"` : "data-alerts"\} tabindex="0" role="button" title="\$\{lane \? "Open the lane" : "Open the alert list"\}">/u);
  // a lane the canvas does not carry still opens: the alert list carries it
  assert.match(JS, /if \(!focusLane\(go\.dataset\.lane\) && go\.classList\.contains\("arow"\)\) openAlerts\(\);/u);
  assert.match(JS, /\[role='button'\]\[data-lane\], \[role='button'\]\[data-alerts\], \[role='button'\]\[data-inspect\]/u);
  assert.match(CSS, /\.arow\[role="button"\] \{ cursor: pointer; \}/u);
  assert.doesNotMatch(CSS, /\.arow \{[^}]*cursor: pointer/u);
});

test("Projects fills its frame at desk width", () => {
  const desk = media("min-width: 901px");
  assert.match(desk, /#projCanvas \{ flex: 1 1 auto; \}/u);
  assert.match(desk, /#projCanvas \.lanes:last-child \{ flex: 1 1 auto; \}/u);
  assert.match(desk, /\.canvas \{ flex: 0 1 auto; min-height: 0; overflow-y: auto;/u, "the canvas still scrolls by itself when its rows need more than the frame has");
});

/* The bounded pass after the six: three residual groups the final captures still showed. */
test("Effort's figures are never cut: a line wraps its figures whole under the label", () => {
  assert.match(CSS, /\.effort > div \{ display: flex; flex-wrap: wrap;/u);
  assert.doesNotMatch(CSS, /\.effort > div \{[^}]*(overflow: hidden|white-space: nowrap)/u, "a cut line hides a figure");
  assert.match(CSS, /\.effort \.ev \{ display: flex; flex-wrap: wrap;[^}]*min-width: 0;/u);
  assert.match(CSS, /\.effort \.eg \{ display: inline-flex;[^}]*white-space: nowrap;/u, "a figure and its unit stay together");
  // both lines: label, then the figures as two groups joined by the separator
  assert.match(JS, /<span class="el">every machine<\/span><span class="ev"><span class="eg"><b data-src="windows\.tokens\.total">[^<]*<\/b><em>tokens<\/em><\/span> · <span class="eg"><b data-internal data-src="windows\.cost\.usd">/u);
  assert.match(JS, /<span class="el">this machine<\/span><span class="ev"><span class="eg"><b data-src="projects\.tokens">[^<]*<\/b><em>tokens<\/em><\/span> · <span class="eg"><b data-src="projects\.totals\.commits">[^<]*<\/b><em>commits<\/em><\/span><\/span>/u);
});

test("a row that opens an inspector is a 24px target, and the type keeps its size (WCAG 2.5.8)", () => {
  // the minimum is an absolute 24 CSS px, so it is not scaled by --k
  assert.match(CSS, /\.xrow\.door \{[^}]*min-height: 24px; margin-top: 0;/u);
  assert.match(CSS, /\.mrow\.door \{ min-height: 24px; margin-top: 0; cursor: pointer; \}/u);
  assert.doesNotMatch(CSS, /\.xrow \.xn \{[^}]*font: 500 calc\(1[3-9]/u, "the row's text did not grow to fill the target");
  // every inspector-opening row still carries the door class the rule sizes
  assert.match(JS, /<div class="xrow door \$\{d\.status\}" title=/u);
  assert.match(JS, /<div class="xrow msgs door" data-inspect="person:/u);
  assert.equal((JS.match(/<div class="mrow door" data-inspect="project:/gu) || []).length, 2, "share and spend rows");
});

test("on a phone the hour axis caption, the person's machine status and the lane's DEMO stamp are shown whole", () => {
  const phone = media("max-width: 760px");
  // the axis: its ends stay at the plot's edges, the caption takes the next line whole
  assert.match(HTML, /<div class="bx wrapcap"><span>60 min ago<\/span><span id="tFlowCap">/u);
  assert.match(HTML, /<div class="bx wrapcap"><span>60 min ago<\/span><span id="pFlowCap">/u);
  assert.match(phone, /\.bx\.wrapcap \{ flex-wrap: wrap;/u);
  assert.match(phone, /\.bx\.wrapcap span:nth-child\(2\) \{ order: 3; flex: 1 1 100%; white-space: normal; overflow: visible;/u);
  // the person's machine row: name and figures on one line, the status whole on the next
  assert.match(JS, /<div class="irow mach" data-inspect="machine:\$\{esc\(d\.id\)\}" tabindex="0" role="button"/u);
  assert.match(phone, /\.inspect \.irow\.mach \{ grid-template-columns: minmax\(0, 1fr\) 64px 60px;/u);
  assert.match(phone, /\.inspect \.irow\.mach > b \{ grid-area: 1 \/ 1; \}/u);
  assert.match(phone, /\.inspect \.irow\.mach \.status \{ grid-row: 2; grid-column: 1 \/ -1; \}/u);
  // the state column holds the dot, the longest word the console says and the stamp at every width: 124px
  // (SILENT · DEMO needs 113, REMOVED · DEMO 121, RECONNECTING alone 107), never the 104, 96 or 92 that cut the stamp to DEM
  assert.match(phone, /\.lhead, \.lane \{[^}]*grid-template-columns: 124px 64px 64px 60px/u);
  assert.equal((CSS.match(/grid-template-columns: calc\(124px \* var\(--k\)\) minmax\(calc\(1[3-9]\dpx \* var\(--k\)\)/gu) || []).length, 4, "desk, narrow, folded and wide lane grids");
  assert.doesNotMatch(CSS, /grid-template-columns: calc\((96|104)px \* var\(--k\)\) minmax\(calc\(1[3-9]\dpx/u);
  assert.doesNotMatch(phone, /grid-template-columns: (92|96|104)px 64px 64px (52|60)px/u);
});

/* The 124px state column made the desk grid's minimum 1356px, wider than the frame at 1366 (1314px): the header said L for
   LAST and the Last values were hidden, and at 1241 the Machine column too. Between 1241 and 1439 the lane grid is held at
   what each column's widest header or value needs, with nothing folded or cut. */
test("between 1241 and 1439 every lane column fits the frame, header and value, with nothing hidden", () => {
  const narrow = media("min-width: 1241px) and (max-width: 1439px");
  assert.doesNotMatch(narrow, /display: none/u, "no lane column is hidden at this width");
  const rule = narrow.match(/\.lhead, \.lane \{ gap: (\d+)px; grid-template-columns: ([^}]*); \}/u);
  assert.ok(rule, "one lane grid rule, gap first");
  const gap = Number(rule[1]);
  // every track's minimum in px: a fixed calc(Npx * var(--k)) or the minimum of a minmax(calc(Npx * var(--k)), fr)
  const mins = [...rule[2].matchAll(/(?:minmax\()?calc\((\d+)px \* var\(--k\)\)/gu)].map((m) => Number(m[1]));
  assert.equal(mins.length, 14, "fourteen lane columns: state, project, model, activity, 5 min, in, out, total, est., agents, context, doing, machine, last");
  // the state column still holds SILENT · DEMO (113) and REMOVED · DEMO (121); the last column holds a clock time (11:50 AM, 58)
  assert.equal(mins[0], 124);
  assert.ok(mins[13] >= 60, "Last holds a clock time");
  // the widest header or value each column carries, measured in the demo at 1440 (Plex Sans 12px caps for headers, Plex Mono 12px for values)
  const need = { st: 124, pr: 123, md: 97, sp: 93, fm: 41, in: 29, out: 29, tot: 39, usd: 51, ag: 51, cx: 59, do: 116, dv: 76, la: 58 };
  Object.values(need).forEach((n, i) => assert.ok(mins[i] >= n, `column ${i} (${Object.keys(need)[i]}) is ${mins[i]}px for content that needs ${n}px`));
  // the whole minimum fits the frame at 1241: 1241 − 2 × 24px shell − 2 × 2px canvas = 1189px for the row, less its own 20px + 16px padding
  const minimum = mins.reduce((a, b) => a + b, 0) + 13 * gap + 36;
  assert.ok(minimum <= 1189, `the lane grid's minimum is ${minimum}px, more than the 1189px the frame has at 1241`);
  // the desk grid (1440 and up) keeps its own tracks, and its minimum fits 1440's 1388px
  const desk = CSS.match(/\n\.lhead, \.lane \{ display: grid;[^}]*grid-template-columns: ([^}]*); \}/u);
  assert.ok(desk, "the desk lane grid");
  const deskMins = [...desk[1].matchAll(/(?:minmax\()?calc\((\d+)px \* var\(--k\)\)/gu)].map((m) => Number(m[1]));
  assert.equal(deskMins.length, 14);
  assert.ok(deskMins.reduce((a, b) => a + b, 0) + 13 * 12 + 36 <= 1388, "the desk grid fits the frame at 1440");
  assert.ok(deskMins[13] >= 60, "the desk Last column holds a clock time");
  // a silent lane's Last is the clock time alone — the state column already says SILENT — so it fits its 60px cell everywhere; the sentence stays on hover
  assert.match(JS, /l\.state === "silent" \|\| l\.state === "revoked" \? hhmm\(l\.device\.lastContactAt \|\| l\.lastAt\)/u);
  assert.doesNotMatch(JS, /la\.textContent = [^;]*`since \$\{hhmm/u, "the word since does not fit the Last cell");
  assert.match(JS, /la\.title = l\.state === "silent" \|\| l\.state === "revoked" \? "The machine's last report · silent since " \+ hhmm/u);
});
