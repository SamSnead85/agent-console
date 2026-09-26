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

test("Team's and Projects' period control sits with the figures it drives, and their activity waves follow it", () => {
  for (const [cap, seg] of [["tCap", "periodSeg"], ["pCap", "projSeg"]]) {
    const figurePane = between(cap, seg);
    assert.doesNotMatch(figurePane, /class="col flow"/u, `${seg} is not in the figure pane`);
    assert.match(HTML, new RegExp(`<div class="cap"><span id="${cap}">Tokens</span>\\s*<span class="seg" id="${seg}"`, "u"), `${seg} sits in the figure's caption`);
  }
  // the activity chart is captioned for the period, from the hub's own per-machine and per-project series (H04), never "kept for the hour only"
  assert.match(HTML, /<div class="cap"><span id="tFlowTitle">Activity · last 24 hours<\/span> <em class="by">by machine<\/em>/u);
  assert.match(HTML, /<div class="cap"><span id="pFlowTitle">Activity · last 24 hours<\/span> <em class="by">by project<\/em>/u);
  assert.match(JS, /\$\("tFlowTitle"\)\.textContent = "Activity · " \+ PERIOD_TEXT\[period\]\[0\]/u);
  assert.match(JS, /\$\("pFlowTitle"\)\.textContent = "Activity · " \+ PERIOD_TEXT\[period\]\[0\]/u);
  assert.match(JS, /series: s\.byDevice/u);
  assert.match(JS, /p\.series\[period\]\.byProject/u);
  assert.doesNotMatch(JS, /kept for the (last )?hour only/u);
  assert.doesNotMatch(JS, /function drawStacked\(/u, "the blocky stacked bars are gone; the series are waves");
  const teamFlow = between("tFlowWrap", "tLegend"), projFlow = between("pFlowWrap", "pLegend");
  for (const flow of [teamFlow, projFlow]) assert.doesNotMatch(flow, /class="seg"/u);
  // the axis under each wave states the window and the step in words, and the left end names the period
  assert.match(JS, /\$\("tFlowCap"\)\.innerHTML = .*stepText\(drawn\.frame\.step\)\} steps/u);
  assert.match(JS, /\$\("pFlowCap"\)\.innerHTML = .*stepText\(drawn\.frame\.step\)\} steps/u);
  assert.match(JS, /\$\("tAxLeft"\)\.textContent = PERIOD_TEXT\[period\]\[2\]/u);
  assert.match(JS, /\$\("pAxLeft"\)\.textContent = PERIOD_TEXT\[period\]\[2\]/u);
  // the caption names the figure; the period words move to hover, where the pressed button already says them
  assert.match(JS, /\$\("tCap"\)\.title = "Tokens · " \+ PERIOD_TEXT\[period\]\[0\]/u);
  assert.match(JS, /\$\("pCap"\)\.title = `Tokens · \$\{PERIOD_TEXT\[period\]\[0\]\} · this machine/u);
  assert.doesNotMatch(JS, /\$\("[tp]Cap"\)\.textContent/u);
});

test("the spend spectrum names its bars in a column of their own", () => {
  assert.match(HTML, /<div class="slabs" aria-hidden="true"><span class="slab cost">cost<\/span><span class="slab tok">tokens<\/span><\/div>/u);
  assert.doesNotMatch(HTML, /class="slab (top|bot)"/u, "a label class the header's .top rule would size");
  assert.match(CSS, /\.specwrap \{[^}]*display: grid; grid-template-columns: auto minmax\(0, 1fr\)/u);
  assert.match(CSS, /\.slab \{ display: block; height: calc\(22px \* var\(--k\)\)/u);
  assert.doesNotMatch(CSS, /\.slab \{[^}]*position: absolute/u);
  assert.doesNotMatch(CSS, /\.specwrap \{[^}]*padding-left/u);
  // 22px bars carry the class and its dollars inside any segment wide enough; the ink follows the ramp's end
  assert.match(JS, /TOP = \[2, 24\], BOT = \[36, 58\];/u);
  assert.match(JS, /wdt >= W \* 0\.12 \? `<text class="\$\{inkFor\(k\)\}"/u);
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
  // the legend flows as whole items: each item on one line, never a word cut or a share alone on the next line
  assert.match(CSS, /\.speclegend \{[^}]*display: flex;[^}]*flex-wrap: wrap;/u);
  assert.match(CSS, /\.speclegend span \{[^}]*white-space: nowrap;/u);
  assert.doesNotMatch(CSS, /\.speclegend span \{[^}]*overflow: hidden/u);
  assert.doesNotMatch(CSS, /\.speclegend \{[^}]*grid-template-columns/u, "a grid would cut an item at its column's edge");
  // state, the name (its branch under it), five minutes and when it last spoke come first; the estimate and the day follow under the thumb; Last is shown
  const order = (cls) => Number(phone.match(new RegExp(`\\.lane \\.${cls} \\{ order: (\\d); \\}`, "u"))?.[1]);
  assert.ok(order("st") < order("pr") && order("pr") < order("fm") && order("fm") < order("la") && order("la") < order("usd"), "state · name · 5 min · last · then the estimate");
  assert.match(phone, /\.lhead \.c-la, \.lane \.la \{ display: block; \}/u);
  assert.doesNotMatch(phone, /\.lane \.la \{ display: none/u);
  for (const cls of ["c-st", "c-fm", "c-usd", "c-la", "c-pr", "c-md", "c-sp", "c-tot"]) assert.match(HTML, new RegExp(`<span class="(r )?${cls}"`, "u"), cls + " named in the header");
  assert.match(JS, /row\.closest\('\.lanebody, \.fold'\)\.scrollLeft = 0/u);
  // the right edge fades while there is more to the right, so a cut column reads as "more"
  assert.match(phone, /\.lanebody\.fademore \{[^}]*mask-image: linear-gradient\(90deg/u);
  assert.match(JS, /watchScroll\(row\.closest\("\.lanebody"\), "x"\)|watchScroll\(body, "x"\)/u);
});

test("no numeric is cut and no unit is said twice", () => {
  assert.doesNotMatch(CSS, /table\.grid \.models \{[^}]*max-width/u);
  assert.doesNotMatch(CSS, /table\.grid \.models \.names \{[^}]*text-overflow: ellipsis/u);
  // the Projects table's estimate column: the header carries the one label for the estimate, the cell the figure, "+" when it is a floor
  assert.match(HTML, /<th scope="col" class="r" title="List-price estimate, not an invoice">Est\. \$<\/th>/u);
  const cell = JS.match(/data-l="est\." data-internal data-src="projects\.usd"[^>]*>\$\{x\.usd === null \? "unpriced" : money\(x\.usd\)\}\$\{projCost\(x\)\.status === "partial" \? "\+" : ""\}<\/td>/u);
  assert.ok(cell, "the Est. cell is the figure alone, marked + when partial");
  // one label for the estimate everywhere: "Est. $" in table heads, "est. $" in pane heads, "est." only as a suffix on a figure
  assert.doesNotMatch(HTML, /<th[^>]*>Est\. cost<\/th>/u);
  assert.doesNotMatch(HTML, /<span>est\.<\/span>/u, "a pane head says est. without its unit");
});

test("every Attention row is a door, by pointer and by keyboard; the pointer is drawn only where there is a door", () => {
  // the row's hover carries the whole of it — kind, lane, cause, time — and says which door it is
  assert.match(JS, /<div class="arow\$\{cls\}" \$\{lane \? `data-lane="\$\{esc\(lane\.key\)\}"` : "data-alerts"\} tabindex="0" role="button" title="\$\{esc\(ALERT_LABEL\[a\.kind\] \|\| "Alert"\)\}[^\n]*\$\{lane \? "open the lane" : "open the alert list"\}"/u);
  // a lane the canvas does not carry still opens: the alert list carries it
  assert.match(JS, /if \(!focusLane\(go\.dataset\.lane\) && go\.classList\.contains\("arow"\)\) openAlerts\(go\);/u);
  assert.match(JS, /\[role='button'\]\[data-lane\], \[role='button'\]\[data-alerts\], \[role='button'\]\[data-inspect\]/u);
  assert.match(CSS, /\.arow\[role="button"\] \{ cursor: pointer; \}/u);
  assert.doesNotMatch(CSS, /\.arow \{[^}]*cursor: pointer/u);
});

test("Projects and Team end where their rows end at desk width: no card is stretched into an empty tile", () => {
  const desk = media("min-width: 1024px");
  assert.match(desk, /#projCanvas, #teamCanvas \{ flex: 0 1 auto; \}/u, "the canvas fits its rows and shrinks to scroll when they need more than the frame has");
  assert.match(desk, /#projCanvas \.lanes, #teamCanvas \.lanes \{ flex: none; \}/u, "a card ends at its last row; what is left under it is the tray");
  assert.doesNotMatch(desk, /\.lanes:last-child \{ flex: 1 1 auto; \}/u, "a stretched last card is an empty tile under its rows");
  assert.match(desk, /\.canvas \{ flex: 0 1 auto; min-height: 0; overflow-y: auto;/u, "the canvas still scrolls by itself when its rows need more than the frame has");
  // the Console canvas alone takes the frame's height: the lanes get it, and the first band is one height under any reading
  assert.match(desk, /#consoleCanvas \{ flex: 1 1 auto; \}/u);
  assert.match(desk, /#band \{ height: calc\(260px \* var\(--k\)\); \}/u);
  assert.match(desk, /#band \.classes \.note \{ display: none; \}/u, "a partial estimate's notes go to hover, never into the frame's height");
});

test("a short frame keeps eight lane rows: the compact tier folds the second band to one row and every caption to one line", () => {
  const compact = media("min-width: 1024px) and ((max-width: 1280px) or (max-height: 820px)");
  assert.match(compact, /#band \{ height: calc\(240px \* var\(--k\)\); \}/u);
  assert.match(compact, /\.console\.two \{ height: calc\(68px \* var\(--k\)\); \}/u);
  assert.match(compact, /\.cap \.long, \.cap \.by, \.mhead \.long \{ display: none; \} \.cap \.short, \.mhead \.short \{ display: inline; \}/u);
  assert.match(compact, /\.lfoot span\.end \{ display: none; \}/u);
  // the strip is 76px with the name in the display sans, and the status bar is one 28px line
  assert.match(CSS, /\.conhead \{[^}]*height: calc\(76px \* var\(--k\)\)/u);
  assert.match(CSS, /\.conhead h1 \{ margin: 0; font: 300 calc\(22px \* var\(--k\)\)\/1 var\(--sans\); letter-spacing: -\.02em;/u);
  assert.match(CSS, /\.foot \{ margin: 0; min-height: calc\(28px \* var\(--k\)\); padding: calc\(2px \* var\(--k\)\) 0; display: flex; flex-wrap: nowrap; white-space: nowrap; overflow: hidden;/u, "the status bar is one line; its mono provenance gives way with an ellipsis");
  assert.match(media("max-width: 760px"), /\.foot \{ flex-wrap: wrap; white-space: normal; overflow: visible; \}/u, "the phone wraps it again");
  // captions carry their short form in the markup, so the tier can choose without a second string in the script
  assert.match(HTML, /Burn · <span class="long">last 60 min<\/span><span class="short">60 min<\/span>/u);
  assert.match(HTML, /<span class="long">Spend spectrum<\/span><span class="short">Spectrum<\/span>/u);
  assert.match(HTML, /<span class="c-pr" title="Project \/ branch"><span class="long">Project \/ branch<\/span><span class="short">Project<\/span><\/span>/u);
});
const desk_ = () => media("min-width: 1024px");

/* The bounded pass after the six: three residual groups the final captures still showed. */
test("Effort's figures are never cut: a line wraps its figures whole under the label", () => {
  assert.match(CSS, /\.effort > div \{ display: flex; flex-wrap: wrap;/u);
  assert.doesNotMatch(CSS, /\.effort > div \{[^}]*(overflow: hidden|white-space: nowrap)/u, "a cut line hides a figure");
  assert.match(CSS, /\.effort \.ev \{ display: flex; flex-wrap: wrap;[^}]*min-width: 0;/u);
  assert.match(CSS, /\.effort \.eg \{ display: inline-flex;[^}]*white-space: nowrap;/u, "a figure and its unit stay together");
  // both lines: label, then the figures as two groups joined by the separator; the fleet line reads from the same /api/projects answer (H08), at one clock
  assert.match(JS, /<span class="el">every machine<\/span><span class="ev"><span class="eg"><b data-src="\$\{fleet \? "fleet\.tokens" : "windows\.tokens\.total"\}">[^<]*<\/b><em>tokens/u);
  assert.match(JS, /<span class="el">this machine<\/span><span class="ev"><span class="eg"><b data-src="projects\.tokens">[^<]*<\/b><em>tokens<\/em><\/span> · <span class="eg"><b data-src="projects\.totals\.commits">[^<]*<\/b><em>\$\{t\.commits === 1 \? "commit" : "commits"\}<\/em><\/span><\/span>/u);
  assert.match(JS, /const fleetOf = \(p\) => \(p && p\.fleet && p\.fleet\[period\]/u);
  assert.match(JS, /const over = fleet && p\.tokens > w\.tokens\.total;/u, "a subset larger than its whole is clamped and marked");
});

test("a row that opens an inspector is a 24px target, and the type keeps its size (WCAG 2.5.8)", () => {
  // the minimum is an absolute 24 CSS px, so it is not scaled by --k
  assert.match(CSS, /\.xrow\.door \{[^}]*min-height: 24px; margin-top: 0;/u);
  assert.match(CSS, /\.mrow\.door \{ min-height: 24px; margin-top: 0; cursor: pointer; \}/u);
  assert.doesNotMatch(CSS, /\.xrow \.xn \{[^}]*font: 500 calc\(1[3-9]/u, "the row's text did not grow to fill the target");
  // every inspector-opening row still carries the door class the rule sizes
  assert.match(JS, /<div class="xrow door \$\{d\.status\}" title=/u);
  assert.match(JS, /<div class="xrow msgs door" data-inspect="person:/u);
  assert.equal((JS.match(/<div class="mrow door" data-inspect="project:/gu) || []).length, 3, "share, spend-per-commit and spend-per-merge rows");
});

test("on a phone the hour axis caption, the person's machine status and the lane's DEMO stamp are shown whole", () => {
  const phone = media("max-width: 760px");
  // the axis: its ends stay at the plot's edges, the caption takes the next line whole
  assert.match(HTML, /<div class="bx wrapcap"><span id="tAxLeft">24 hours ago<\/span><span id="tFlowCap">/u);
  assert.match(HTML, /<div class="bx wrapcap"><span id="pAxLeft">24 hours ago<\/span><span id="pFlowCap">/u);
  assert.match(phone, /\.bx\.wrapcap \{ flex-wrap: wrap;/u);
  assert.match(phone, /\.bx\.wrapcap span:nth-child\(2\) \{ order: 3; flex: 1 1 100%; white-space: normal; overflow: visible;/u);
  // the person's machine row: name and figures on one line, the status whole on the next
  assert.match(JS, /<div class="irow mach" data-inspect="machine:\$\{esc\(d\.id\)\}" tabindex="0" role="button"/u);
  assert.match(phone, /\.inspect \.irow\.mach \{ grid-template-columns: minmax\(0, 1fr\) 64px 60px;/u);
  assert.match(phone, /\.inspect \.irow\.mach > b \{ grid-area: 1 \/ 1; \}/u);
  assert.match(phone, /\.inspect \.irow\.mach \.status \{ grid-row: 2; grid-column: 1 \/ -1; \}/u);
  // the state column holds the dot, the longest word the console says and the stamp at every width: 124px
  // (SILENT · DEMO needs 113, REMOVED · DEMO 121, RECONNECTING alone 107), never the 104, 96 or 92 that cut the stamp to DEM
  assert.match(phone, /\.lhead, \.lane \{[^}]*grid-template-columns: 124px 120px 64px 60px/u);
  // the three on-screen columns end inside the scroller's 354px at 390: 16px left padding + State + the name (120px, branch on its second line) + 5 min + two gaps; Last follows under the thumb
  const phoneRule = phone.match(/\.lhead, \.lane \{[^}]*padding: 0 \d+px 0 (\d+)px; gap: (\d+)px; grid-template-columns: (\d+)px (\d+)px (\d+)px (\d+)px /u);
  assert.ok(phoneRule, "the phone lane grid: padding, gap, then the on-screen tracks");
  const [, padL, phoneGap, st, pr, fm, la] = phoneRule.map(Number);
  assert.ok(padL + st + pr + fm + 2 * phoneGap <= 354, `the on-screen three end at ${padL + st + pr + fm + 2 * phoneGap}px, past the 354px the scroller shows at 390`);
  assert.equal(pr, 120, "the name has 120px, its branch on a 12px second line");
  assert.match(phone, /\.lane \.pr \{ flex-direction: column;/u);
  assert.ok(la >= 60, "Last holds a clock time on a phone");
  assert.equal((CSS.match(/grid-template-columns: calc\(124px \* var\(--k\)\) minmax\(calc\(1[3-9]\dpx \* var\(--k\)\)/gu) || []).length, 5, "desk, narrow, narrow from 1280, folded and wide lane grids");
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
  // the widest header or value each column carries, measured in the demo at 1440 (Plex Sans 12px caps for headers, Plex Sans 12.5px tabular for values;
  // the project track is 160px so a name and its branch stay whole, paid for by the five-minute, uncached-input, output and total columns' slack)
  const need = { st: 124, pr: 160, md: 97, sp: 93, fm: 41, in: 29, out: 29, tot: 39, usd: 51, ag: 51, cx: 59, do: 116, dv: 76, la: 58 };
  Object.values(need).forEach((n, i) => assert.ok(mins[i] >= n, `column ${i} (${Object.keys(need)[i]}) is ${mins[i]}px for content that needs ${n}px`));
  // the whole minimum fits the frame at 1241: 1241 − 2 × 24px shell − 2 × 8px tray = 1177px for the row, less its own 20px + 16px padding
  const minimum = mins.reduce((a, b) => a + b, 0) + 13 * gap + 36;
  assert.ok(minimum <= 1177, `the lane grid's minimum is ${minimum}px, more than the 1177px the frame has at 1241`);
  // the project name stays whole in the project track's minimum: "project b1d604" is 101px in Plex Mono 12px, and the name's share of the cell must hold it
  const share = narrow.match(/\.lane \.pr b \{ max-width: (\d+)%; \}/u);
  assert.ok(share, "the name's share of the project cell at this width");
  assert.ok((mins[1] * Number(share[1])) / 100 >= 101, `the project name gets ${(mins[1] * Number(share[1])) / 100}px of a ${mins[1]}px track, less than the 101px "project b1d604" needs`);
  // the desk grid (1440 and up) keeps its own tracks, and its minimum fits 1440's 1376px (1440 − 48 shell − 16 tray)
  const desk = CSS.match(/\n\.lhead, \.lane \{ display: grid;[^}]*grid-template-columns: ([^}]*); \}/u);
  assert.ok(desk, "the desk lane grid");
  const deskMins = [...desk[1].matchAll(/(?:minmax\()?calc\((\d+)px \* var\(--k\)\)/gu)].map((m) => Number(m[1]));
  assert.equal(deskMins.length, 14);
  assert.ok(deskMins.reduce((a, b) => a + b, 0) + 13 * 12 + 36 <= 1376, "the desk grid fits the frame at 1440");
  // Doing has 20px more from 1280 up, so a short alert form ("▲ spike 14:40") and a tool with its pace fit whole
  const wider = media("min-width: 1280px) and (max-width: 1439px");
  assert.match(wider, /minmax\(calc\(136px \* var\(--k\)\), 1fr\)/u);
  assert.ok(deskMins[13] >= 60, "the desk Last column holds a clock time");
  // a silent lane's Last is the clock time alone — the state column already says SILENT — so it fits its 60px cell everywhere; the sentence stays on hover
  assert.match(JS, /l\.state === "silent" \|\| l\.state === "revoked" \? hhmm\(l\.device\.lastContactAt \|\| l\.lastAt\)/u);
  assert.doesNotMatch(JS, /la\.textContent = [^;]*`since \$\{hhmm/u, "the word since does not fit the Last cell");
  assert.match(JS, /la\.title = l\.state === "silent" \|\| l\.state === "revoked" \? "The machine's last report · silent since " \+ hhmm/u);
});
