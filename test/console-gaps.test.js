/**
 * The verified gaps of the ui-next round, each held by the screen's own source
 * or by the page's own renderer run with plain helpers:
 *
 * - the lanes pane is never left standing empty: cold lanes fill it, the card
 *   hugs its rows when the day leaves room (and this machine's Projects fold
 *   opens in that room), and a pane with no lane at all is the hatched void;
 * - Team's alert head is the hub's own day counter, saying how many are kept;
 * - Projects' live and subagent counts come from the per-project rollup;
 * - a floor is named once per pane, and only by what made it a floor;
 * - the burn rate's money shares the tokens' unit;
 * - a person's or project's door carries the presenting token in the DOM;
 * - a sheet's opener is found again inside its own container;
 * - the "24 h" group label has a row of its own; the strip's clock has a plate;
 * - the context history is a stepped area; a measured zero prints 0; a period
 *   without kept sessions says so once per pane; an inspector row's long name
 *   gives way in its own cell; a Copy with nothing to copy is not the accent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";

// A Windows checkout has CRLF endings; the functions are sliced out of the source by their LF-delimited ends.
const read = (file) => fs.readFileSync(new URL("../public/" + file, import.meta.url), "utf8").replace(/\r\n/gu, "\n");
const JS = read("console.js");
const CSS = read("console.css");
const JOIN_CSS = read("join.css");
const CONSOLE = JSON.parse(fs.readFileSync(new URL("../fixtures/console-v0.4.json", import.meta.url), "utf8"));

/** One of the page's own functions, run with plain helpers. */
function fn(name, helpers = {}) {
  const start = JS.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `console.js no longer defines ${name}`);
  const end = JS.indexOf("\n  }\n", start);
  const ctx = { plural: (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`, esc: (s) => String(s ?? ""), ...helpers };
  vm.createContext(ctx);
  vm.runInContext(JS.slice(start, end + 4) + `\nthis.${name} = ${name};`, ctx);
  return ctx[name];
}
const text = (html) => html.replace(/<[^>]+>/gu, "");

test("G06: the lanes card hugs its rows when the day leaves the pane room, fills the room with cold lanes otherwise, and draws a void sized to the pane when there is no lane", () => {
  assert.match(CSS, /#consoleCanvas \.lanes\.hug \{ flex: 0 0 auto; min-height: 0; \}/u);
  assert.match(JS, /const whole = visible\.length \+ \(cold\.length \? cold\.length \+ 1 : 0\);/u);
  assert.match(JS, /const hugWanted = room > 0 && whole > 0 && whole < room;/u);
  // nothing in the last hour (U3): the day's most recent sessions are drawn, idle, rather than an empty hatch
  assert.match(JS, /const fill = hugWanted \? cold : room > visible\.length \+ 1 \? cold\.slice\(0, room - visible\.length - 1\) : !visible\.length \? cold\.slice\(0, room > 0 \? Math\.max\(1, room - 1\) : 8\) : \[\];/u);
  // the card hugs its rows whenever the day leaves the pane room (J4-12): the folds that fit take what they can, the rest is the tray
  // as on Projects and Team — never a hatched tile standing in for rows
  assert.match(JS, /const hug = hugWanted;/u);
  assert.match(JS, /box\.closest\("\.lanes"\)\.classList\.toggle\("hug", hug\);/u);
  assert.doesNotMatch(JS, /laneVoid|lanevoid/u, "no void tile stands in for rows");
  assert.doesNotMatch(CSS, /\.lanevoid \{/u);
  // the room is read from the canvas, never from the card that follows its rows
  assert.match(JS, /const room = canvas\.clientHeight - parseFloat\(cs\.paddingTop\) - parseFloat\(cs\.paddingBottom\)/u);
  // the cold fill sits under a hairline that names it, and the void is the pane
  assert.match(JS, /laneSep\.className = "lanesep"/u);
  assert.match(CSS, /\.lanes \.empty\.voidfill \{ flex: 1 1 auto;/u);
  assert.match(JS, /<div class="empty voidfill"><b>\$\{esc\(head\)\}<\/b>\$\{why \? `<span>\$\{esc\(why\)\}<\/span>` : ""\}/u);
  assert.match(JS, /<span>Nothing is estimated in its place\.<\/span><\/div>`;/u);
  // the room under a hugging card is taken by the folds with rows whose rendered height fits it (R3-02, J4-12) — the Cold fold among
  // them, the tallest that fits first, then the next that fits what is left — measured, never a fixed row count; the reader's own
  // choice, once made, is kept
  assert.match(JS, /const AUTO_FOLDS = \["foldCold", "foldProjects", "foldEffort", "foldShipped"\];/u);
  assert.match(JS, /if \(id === "foldCold"\) return coldRows\.size > 0;/u);
  assert.match(JS, /const sized = AUTO_FOLDS\.filter\(foldHasRows\)\.map\(\(id\) => \{ const d = \$\(id\); d\.open = true; const h = d\.offsetHeight; d\.open = false; return \[id, h\]; \}\)\.sort\(\(a, b\) => b\[1\] - a\[1\]\);/u);
  assert.match(JS, /for \(const \[id, h\] of sized\) if \(h <= left \+ 4\) \{ \$\(id\)\.open = true; foldAuto\.add\(id\); opened \+= h; left -= h; \}/u);
  assert.match(JS, /if \(!hugWanted\) \{ if \(foldAuto\.size && !foldTouched\) \{ for \(const id of foldAuto\) \{ const d = \$\(id\); if \(d\.open\) d\.open = false; \} foldAuto\.clear\(\); \} return openPx\(\); \}/u);
  assert.match(JS, /if \(ev\.target\.closest\("summary"\)\) foldTouched = true;/u);
  // rows are placed by position, never re-appended (R3-01), so the row the keyboard is on keeps its focus through every poll
  assert.match(JS, /if \(want !== node\) box\.insertBefore\(node, want\);/u);
  assert.match(JS, /if \(active\.isConnected && box\.contains\(active\) && !document\.querySelector\("dialog\[open\]"\)\) active\.focus\(\{ preventScroll: true \}\);/u);
  assert.doesNotMatch(JS, /box\.appendChild\(row\);\s*\/\/ moves it into sorted position/u);
});

test("G01: the Team head prints the day's alert count from the hub's counter and says how many are kept when the list is shorter", () => {
  // without the hub's counter the figure is today's own list (J4-03): an alert from before today is never in it
  assert.match(JS, /const count = today \? today\.count : dayList\.length;/u);
  assert.match(JS, /const kept = today \? today\.kept : dayList\.length;/u);
  assert.match(JS, /\$\{plural\(count, "alert"\)\} today\$\{kept < count \? ` · \$\{kept\} kept` : ""\}/u);
  assert.ok(Number.isInteger(CONSOLE.alertsToday.count) && Number.isInteger(CONSOLE.alertsToday.kept), "the fixture carries the day counter");
  assert.ok(CONSOLE.alertsToday.count >= CONSOLE.alertsToday.kept);
});

test("R2-M1: Projects counts live and subagents from the hub's per-project rollup, never from the rows drawn", () => {
  assert.match(JS, /const live = lt && lt\.every\(\(t\) => Number\.isFinite\(t\.live\)\) \? lt\.reduce\(\(a, t\) => a \+ t\.live, 0\)/u);
  assert.match(JS, /const subagents = lt && lt\.every\(\(t\) => Number\.isFinite\(t\.subagents\)\) \? lt\.reduce\(\(a, t\) => a \+ t\.subagents, 0\)/u);
  assert.match(JS, /Counted over every session on this machine in the last 24 hours, not only the rows drawn/u);
  assert.ok(Object.values(CONSOLE.laneTotals.byLocalProject).every((p) => Number.isInteger(p.subagents)), "the fixture's per-project rollup carries subagents");
});

test("G11: one floor line per pane names only what made the figure a floor — never a zero count as a cause", () => {
  const floorLine = fn("floorLine");
  assert.equal(floorLine(null), "");
  assert.equal(floorLine({ status: "priced", unpricedMessages: 0 }), "");
  assert.equal(floorLine({ status: "partial", unpricedMessages: 0, unpricedModels: [] }), "", "a floor with no cause named is no line at all");
  assert.equal(text(floorLine({ status: "partial", unpricedMessages: 0, unpricedModels: [] }, { dropped: 3 })), "+ a floor · 3 messages not counted");
  assert.equal(text(floorLine({ status: "partial", unpricedMessages: 12, unpricedModels: ["x-1"] })), "+ a floor · 12 messages unpriced");
  assert.equal(text(floorLine({ status: "partial", unpricedMessages: 1, unpricedModels: ["x-1"] }, { dropped: 1 })), "+ a floor · 1 message unpriced · 1 message not counted");
  assert.equal(text(floorLine({ status: "partial", unpricedModels: ["x-1", "y-2"] })), "+ a floor · x-1, y-2 unpriced", "a hub without message counts names the models");
  assert.match(floorLine({ status: "partial", unpricedMessages: 2, unpricedModels: ["x-1"] }), /title="A figure marked \+ is a floor: 2 messages unpriced \(x-1: no verified list price\)/u);
  // the three panes that carry floors each append the one line
  assert.ok((JS.match(/floorLine\(/gu) || []).length >= 4, "the by-machine rows, the spend legend and the class legend each say it once");
  assert.match(JS, /\$\("axMid"\)\.innerHTML = byClass && floor \? floorLine\(w\.cost\) : "";/u);
});

test("G14: the burn rate's money is in the tokens' unit, one denominator per line", () => {
  assert.match(JS, /const per = perSecond \? "\/s" : "\/min";/u);
  assert.match(JS, /const usdRate = D\.burn\.usdPerMinute === null \? null : D\.burn\.usdPerMinute \* \(perSecond \? 1 \/ 60 : 1\);/u);
  assert.match(JS, /\/hour est\.` \) \+ " · ";|\/hour est\.`\) \+ " · ";/u, "the hour rate is on hover, not beside the figure");
});

test("G07: a person's or project's door carries the presenting token in its data-inspect, resolved on the way back", () => {
  assert.match(JS, /const doorId = \(kind, id\) => \(present \? idInUrl\(kind, id\) : String\(id\)\);/u);
  assert.match(JS, /openInspect\(kind, idFromUrl\(rest\.join\(":"\)\), door\);/u);
  assert.doesNotMatch(JS, /data-inspect="person:\$\{esc\(p\.person\)\}"/u, "a person door with the raw name");
  assert.doesNotMatch(JS, /data-inspect="project:\$\{esc\(key\)\}"/u, "a project door with the raw key");
  assert.match(JS, /for \(const el of document\.querySelectorAll\("\[data-t\]"\)\) delete el\.dataset\.t;/u, "a cached title survives into presenting");
});

test("G05: a sheet's opener is found again inside its own container; a lost row hands focus to its section's head, never the body", () => {
  assert.match(JS, /const SCOPES = "#cLanes, #pLanes, #coldLanes, #peopleTable, #machineTable, #projTable/u);
  assert.match(JS, /scope: scope \? "#" \+ scope\.id : null/u);
  assert.match(JS, /for \(const el of \(root \|\| document\)\.querySelectorAll\(ref\.sel\)\) if \(visible\(el\)\) return stop\(el\);/u);
  assert.match(JS, /const head = ref\.section && ref\.section\.querySelector\("\.thead h3, \.lanescroll, \.mhead, \.cap, summary"\);/u);
  // and the focus survives the next poll's repaint of the table it landed in: the successor of a disconnected door takes it
  assert.match(JS, /lastDoor = scope \? \{ el: a, key, scope, btn: a\.classList\.contains\("rowbtn"\) \} : null;/u);
  assert.match(JS, /if \(!lastDoor \|\| lastDoor\.el\.isConnected \|\| document\.activeElement !== document\.body \|\| !lastDoor\.scope\.isConnected \|\| document\.querySelector\("dialog\[open\]"\)\) return;/u);
  assert.match(JS, /\}\)\.observe\(document\.body, \{ childList: true, subtree: true \}\);/u);
});

test("G03/G04: the day group label has a row of its own inside the header, and the strip's clock, scan note and controls carry a plate", () => {
  assert.match(CSS, /\.lhead \{[^}]*overflow: visible;/u);
  assert.match(CSS, /\.lhead \.grp \{ position: absolute; top: 0; left: 0; right: 0; height: 14px;[^}]*font: 500 12px\/14px var\(--sans\);/u);
  assert.match(CSS, /\.lhead \.grp span \{ position: relative; top: 0; display: inline-block; height: 14px; line-height: 14px;/u);
  assert.match(CSS, /\.conhead \.clock, \.conhead \.scan, \.conhead \.ctrls \{ background: rgba\(7, 11, 19, \.86\);/u);
});

test("G10/G12/G15/G08/G13: a void mark per cell with its sentence once; a counted zero prints 0; a stepped context history; a long name gives way; a dead Copy is not the accent", () => {
  assert.match(JS, /const sessionsCell = \(n\) => \(n === null \|\| n === undefined \? na\("—", notKeptWhy\) : String\(n\)\);/u);
  assert.match(JS, /\$\("tHint"\)\.title = tally && !tally\.sessionsKept \? notKeptWhy : "";/u);
  assert.match(JS, /<svg class="cstep" viewBox="0 0 \$\{W\} \$\{H\}" preserveAspectRatio="none" role="img"/u);
  assert.match(JS, /<line class="flag"/u);
  assert.match(JS, /peak <b>\$\{fmt\(top\)\}<\/b>/u);
  assert.doesNotMatch(JS, /<div class="cbars"/u, "the context history is still a row of bars");
  assert.match(JS, /<i><\/i>\$\{live\}<\/span>`;/u, "the Live column prints its measured zero");
  // the name keeps its cell (R3-05): it is a fixed item whose track can still clamp it when it is alone and too long
  assert.match(CSS, /\.inspect \.irow b \{[^}]*flex: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/u);
  assert.match(CSS, /\.inspect \.irow > \* \{ min-width: 0; \}/u, "every inspector cell keeps to its track");
  assert.match(CSS, /\.inspect \.irow \.status > span \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/u);
  assert.match(JS, /<span class="md" title="\$\{esc\(l\.modelLabel\)\}">\$\{esc\(l\.modelLabel\)\}<\/span>/u, "a model that gives way carries its whole on hover");
  assert.match(JS, /<span class="status \$\{d\.status\}" title="\$\{esc\(statusText\(d, now\)\)\}"><i><\/i><span>\$\{esc\(statusText\(d, now\)\)\}<\/span><\/span>/u);
  assert.match(JOIN_CSS, /\.copyrow \.btn\.primary:disabled \{ background: var\(--tile2\); color: var\(--quiet\); box-shadow: var\(--inset\); opacity: 1;/u);
});
