/**
 * What the console draws for the v0.4 coverage fields, and three composition
 * bars the screen holds at 1440 (docs/COLLECTOR-CONTRACT.md, "What the console
 * shows for them"; the fixtures under fixtures/ carry every state):
 *
 * - a lane's tool activity is zero only under complete coverage; a floor,
 *   marked with the figure, under partial; a void with the reporter's own
 *   reason under partial-with-nothing-held, off, undeclared and unknown;
 * - a machine's row and inspector say what it shares and flag entries refused
 *   for being dated in the future;
 * - "no alert" is claimed only from alertsCoverage.since, everywhere the
 *   console says it, and the sixty-minute strip is hatched before then;
 * - every row's activity is the wave, never bars, with a dotted baseline for
 *   nothing; the spend legend flows as whole items; the Attention card's
 *   timeline has an axis row of its own;
 * - presenting aliases the address of an open inspector and the add-a-machine
 *   sheet's names.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL("../public/" + file, import.meta.url), "utf8");
const JS = read("console.js");
const CSS = read("console.css");
const HTML = read("index.html");
const CONSOLE = JSON.parse(fs.readFileSync(new URL("../fixtures/console-v0.4.json", import.meta.url), "utf8"));

test("the fixture carries every coverage state the screen must draw", () => {
  const states = new Set(CONSOLE.lanes.map((l) => l.activityCoverage.state));
  for (const s of ["complete", "partial", "off", "undeclared"]) assert.ok(states.has(s), `no lane under ${s} coverage`);
  assert.ok(CONSOLE.lanes.some((l) => l.activityCoverage.state === "partial" && l.activity), "a partial lane with counts held (a floor)");
  assert.ok(CONSOLE.lanes.some((l) => l.activityCoverage.state === "complete" && l.activity && Object.values(l.activity.calls).every((n) => n === 0)), "a complete lane with nothing called (a true zero)");
  assert.ok(CONSOLE.devices.every((d) => d.sharing && d.sharing.alerts && d.sharing.activity && Number.isInteger(d.sharing.rejectedFuture)));
  assert.equal(typeof CONSOLE.alertsCoverage.since, "number");
  assert.equal(CONSOLE.alertsCoverage.reason, "sharing-started");
  assert.ok(CONSOLE.alertsCoverage.byDevice[CONSOLE.devices[0].id]);
});

test("the Doing column draws coverage: zero only when complete, a floor under partial, a void with its reason otherwise", () => {
  // every fixed reason has its sentence and its word
  for (const reason of ["console-restarted", "sharing-started", "sharing-off", "reporter-undeclared", "not-heard"]) {
    assert.match(JS, new RegExp(`COVERAGE_WHY = \\{[\\s\\S]*?"${reason}": \\(`, "u"), reason + " has no sentence");
    assert.match(JS, new RegExp(`COVERAGE_WORD = \\{[^}]*"${reason}": "`, "u"), reason + " has no word");
  }
  // off, undeclared and unknown: a void word with the reason, the lane never read as idle
  assert.match(JS, /if \(cov\.state !== "complete" && cov\.state !== "partial"\) return \[`tool \$\{COVERAGE_WORD\[cov\.reason\] \|\| "unknown"\}`, "quiet", `\$\{activityWhy\(l\)\}; the lane may well be busy`\]/u);
  // partial with nothing held: unavailable, not idle, with the time sharing began
  assert.match(JS, /if \(cov\.state === "partial" && !act\) return \[`tool \$\{COVERAGE_WORD\[cov\.reason\] \|\| "not held"\}/u);
  assert.match(JS, /its recent tools are unavailable, not idle/u);
  // partial with counts: the floor mark travels with the figure, the reason on hover
  assert.match(JS, /const floor = cov\.state === "partial";/u);
  assert.match(JS, /const mark = floor \? `<em class="part" title="\$\{esc\(activityWhy\(l\)\)\}">\+<\/em>` : "";/u);
  assert.match(JS, /a floor: held only since \$\{hhmm\(cov\.since\)\}/u);
  // the old boolean alone no longer decides: a 0.4-pre hub's activityShared is folded into a coverage
  assert.doesNotMatch(JS, /if \(l\.activityShared === false\) return \["tool not shared"/u);
  assert.match(JS, /const activityCoverageOf = \(l\) => l\.activityCoverage \|\| \(l\.activityShared === false \? \{ state: "off"/u);
  // the lane inspector and the agent tree's foot say the same
  assert.match(JS, /activityFloor\(l\) \? "<em class=\\"part\\">\+<\/em>" : ""/u);
  assert.match(JS, /activityState\(l\) !== "complete" \? `<div class="ihead">Tools · 5 min <span>\$\{esc\(COVERAGE_WORD\[activityCoverageOf\(l\)\.reason\] \|\| "unknown"\)\}<\/span><\/div>/u);
  assert.match(JS, /a floor: held since \$\{hhmm\(l\.activityCoverage\.since\)\}/u);
});

test("a machine's row and inspector say what it shares, and flag future-dated entries it had refused", () => {
  assert.match(JS, /function sharingText\(d\) \{/u);
  // a 0.3 hub sends no sharing: nothing is said, never "shares nothing"
  assert.match(JS, /const s = d && d\.sharing && d\.sharing\.alerts && d\.sharing\.activity \? d\.sharing : null;\s*if \(!s\) return null;/u);
  // whole sharing sits on the status line; anything less is a line of its own in warn
  assert.match(JS, /const sharingHtml = \(d\) => \{[^\n]*class="\$\{s\.whole \? "sh" : "lk sh w"\}"/u);
  assert.match(JS, /\$\{plural\(s\.refused, "entry", "entries"\)\} refused · future-dated/u);
  assert.match(JS, /\$\{sharingHtml\(d\)\}<\/span><\/td>/u, "the Machines table's status cell carries the sharing line");
  assert.match(CSS, /\.status \.lk\.sh\.w, \.status \.lk\.flag \{ color: var\(--warn\); \}/u);
  // the inspector: the sharing line, the machine's own alert coverage, the refused count
  assert.match(JS, /const alertCov = D\.alertsCoverage && D\.alertsCoverage\.byDevice \? D\.alertsCoverage\.byDevice\[d\.id\] \|\| null : null;/u);
  assert.match(JS, /<b>Alerts held since \$\{hhmm\(alertCov\.since\)\}<\/b>: \$\{esc\(coverageWhy\(alertCov\)[^\n]*?\}; before then its quiet is not "no alert"/u);
  assert.match(JS, /<b>\$\{plural\(sh\.refused, "entry", "entries"\)\} refused<\/b>: dated more than two minutes in the future; counted here, never stored/u);
});

test("\"no alert\" is claimed only from alertsCoverage.since, and the sixty-minute strip is hatched before it", () => {
  assert.match(JS, /const known = cov && Number\.isFinite\(cov\.since\) \? cov\.since : null;/u);
  // the Attention hero, its stat, the alerts sheet's caption and Team's alert count all name the time
  assert.match(JS, /known \? `No alert since \$\{hhmm\(known\)\}`/u);
  assert.match(JS, /html: known \? `since \$\{hhmm\(known\)\}` : cov && unwatched \? `\$\{cov\.watched\} of \$\{current\} watched` : "last hour"/u);
  assert.match(JS, /foot = known \? `Not held before \$\{hhmm\(known\)\}: quiet then is not "no alert"\.`/u);
  // a sentence in the foot gives way at its end with the whole on hover
  assert.match(JS, /\$\("attnFoot"\)\.innerHTML = top \? foot : foot \? `<span class="ft">\$\{foot\}<\/span>` : "";\s*\$\("attnFoot"\)\.title = top \? "" : \$\("attnFoot"\)\.textContent;/u);
  assert.match(CSS, /\.attention \.afoot \.ft \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/u);
  assert.match(JS, /\(cov && Number\.isFinite\(cov\.since\) \? ` · known since \$\{hhmm\(cov\.since\)\}` : " · last hour"\)/u);
  assert.match(JS, /\+ \(known \? ` · known since \$\{hhmm\(known\)\}` : ""\)/u);
  assert.match(JS, /No alert \$\{known \? `held since \$\{hhmm\(known\)\}` : "has been raised today"\}/u);
  // the strip: hatched from the left edge up to the time alerts are held from, with the reason in its title
  assert.match(JS, /const before = known \? `<rect class="gap unknown" x="0" y="0" width="/u);
  assert.match(JS, /<title>Before \$\{hhmm\(known\)\} alerts are not held: /u);
  assert.match(CSS, /\.astrip svg rect\.gap\.unknown \{ fill: url\(#hatchfill\)/u);
  for (const reason of ["console-restarted", "sharing-started"]) assert.match(JS, new RegExp(`SINCE_WHY = \\{[^}]*"${reason}": "`, "u"));
});

test("every row's activity is the wave, never bars; nothing in the window is a dotted baseline", () => {
  assert.doesNotMatch(JS, /sparkBars|"<i><\/i>"\.repeat\(20\)/u, "a bar spark is still drawn");
  assert.doesNotMatch(CSS, /\.sp i\b/u, "bar CSS is still there");
  // one helper for lanes, tables and the inspector: a soft line over the gradient, the newest step lit when live, dim when the machine is gone
  assert.match(JS, /const sparkWave = \(spark, hot, title = "", \{ dim = false, W = 76, H = 16, cls = "spw", hidden = false \} = \{\}\) =>/u);
  assert.match(JS, /if \(!vals \|\| vals\.length < 2 \|\| !vals\.some\(\(v\) => v > 0\)\) \{\s*return `<svg class="\$\{cls\} none/u);
  assert.match(JS, /<line class="base" x1="0" x2="\$\{W\}"/u);
  assert.match(JS, /row\.querySelector\("\.sp"\)\.innerHTML = sparkWave\(\{ tokens: l\.spark \}, l\.state === "live"/u);
  assert.match(JS, /: sparkWave\(\{ tokens: s \? s\.spark : null \}, hot,/u, "the Team tables fall back to the wave, not bars");
  assert.match(JS, /: sparkWave\(\{ tokens: s \? s\.spark : null \}, Boolean\(s && s\.live > 0\)/u, "the Projects table falls back to the wave, not bars");
  assert.match(JS, /\{ dim, W: 300, H: 44, cls: "ispark" \}/u, "the inspector's hour is the same wave");
  assert.match(CSS, /\.spw \.line, \.ispark \.line \{ fill: none; stroke: var\(--spark\); stroke-width: 1\.25;/u);
  assert.match(CSS, /\.spw \.area, \.ispark \.area \{ fill: url\(#wg\); \}/u);
  assert.match(CSS, /\.spw\.none \.base, \.ispark\.none \.base \{ stroke: var\(--quiet\); stroke-width: 1; stroke-dasharray: 1\.5 3;/u);
  // the lit "now" marker is a round-capped zero-length stroke, so it stays a dot whatever the wave is stretched to
  assert.match(JS, /<path class="now" d="M\$\{W\} \$\{pts\[pts\.length - 1\]\[1\]\.toFixed\(1\)\}h0"\/>/u);
  assert.match(CSS, /\.spw \.now, \.ispark \.now \{ fill: none; stroke: var\(--spark-hot\); stroke-width: 3\.5; stroke-linecap: round; vector-effect: non-scaling-stroke;/u);
});

test("the spend legend flows as whole items, and the Attention timeline has an axis row of its own", () => {
  assert.match(CSS, /\.speclegend \{[^}]*display: flex;[^}]*flex-wrap: wrap;/u);
  assert.match(CSS, /\.speclegend span \{[^}]*white-space: nowrap;/u);
  assert.match(HTML, /<div class="astrip" title="[^"]*">\s*<svg id="attnStrip"[^>]*><\/svg>\s*<div class="bx ax"><span>60 min ago<\/span><span id="attnStripCap"><\/span><span>now<\/span><\/div>\s*<\/div>/u);
  assert.doesNotMatch(HTML, /class="visually-hidden" id="attnStripCap"/u);
  // the axis never gives way; the alert list above it does
  assert.match(CSS, /\.attention \.astrip \{ flex: none; \}/u);
  assert.match(CSS, /\.console\.two > \.col\.attention > \.alist \{ flex: 0 1 auto; min-height: 0; overflow: hidden; \}/u);
  // an Attention row is one line: the kind whole, the lane's name giving way, the whole on the row's hover
  assert.match(CSS, /\.arow b \{[^}]*white-space: nowrap;/u);
  assert.match(JS, /title="\$\{esc\(ALERT_LABEL\[a\.kind\] \|\| "Alert"\)\}\$\{name \? ` · \$\{esc\(name\)\}` : ""\} · \$\{esc\(alertCause\(a\)\)\} · \$\{hhmm\(a\.at\)\}/u);
  // the stat drops its least important parts whole when the caption is tight
  assert.match(JS, /fitLine\(\$\("attnStat"\), stat,/u);
  assert.match(HTML, /<span class="capr fit" id="attnStat">/u);
  // so does the Tokens caption: "Tokens · last 30 days", then since when the window is partial, the window's definition on hover
  assert.match(JS, /fitLine\(\$\("cCap"\), \[\{ html: "Tokens · " \+ esc\(label\), pri: 0 \}, since \? \{ html: esc\(since\.replace\(\/\^ · \/u, ""\)\), pri: 1 \} : null\]/u);
  assert.match(HTML, /<span id="cCap" class="fit">/u);
  assert.match(CSS, /#cCap \{ min-width: 0; overflow: hidden; \}/u);
  // the chart's hatched cap has an id of its own: it shared "cCap" with the caption and was never drawn
  assert.match(HTML, /<rect id="cCapStep" class="cap-step"/u);
  assert.equal((HTML.match(/id="cCap"/gu) || []).length, 1, "one element carries the id cCap");
  assert.match(JS, /const cap = \$\("cCapStep"\), c = chart\.cap;/u);
});

test("presenting aliases the address of an open inspector and every name in the add-a-machine sheet", () => {
  assert.match(JS, /function idInUrl\(kind, id\) \{\s*if \(!present\) return encodeURIComponent\(id\);/u);
  assert.match(JS, /openSheet\(inspectDialog, `\$\{view\}\/\$\{kind\}\/\$\{idInUrl\(kind, id\)\}`, from\);/u);
  assert.match(JS, /openInspect\(b, idFromUrl\(c\)\);/u);
  assert.match(JS, /if \(inspect\.open && inspectDialog\.open && inspect\.kind !== "lane"\) setHash\(`\$\{view\}\/\$\{inspect\.kind\}\/\$\{idInUrl\(inspect\.kind, inspect\.id\)\}`\);/u);
  // the people list is empty while presenting (a stand-in picked there would be sent as the person), the link's explanation and the joined line take stand-ins
  assert.match(JS, /\$\("peopleList"\)\.innerHTML = present \? "" : \(D \? D\.people : \[\]\)/u);
  assert.match(JS, /const who = \[pn\("person", j\.invitation\.person\), pn\("machine", j\.invitation\.machine\)\]/u);
  assert.match(JS, /\$\{esc\(device \? pn\("machine", device\.label\) : "the machine"\)\}\$\{device && device\.person \? " \(" \+ esc\(pn\("person", device\.person\)\) \+ "\)" : ""\}/u);
  // the restart command carries this start's --name and --person: internal while presenting
  assert.match(HTML, /<span class="copyrow" id="networkCmd" hidden data-internal>/u);
});
