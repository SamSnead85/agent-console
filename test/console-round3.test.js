/**
 * The third verified round of the ui-next branch, each gap held by the page's
 * own renderer run with plain helpers, or by the screen's own source:
 *
 * - the days before this console's first record fold into one hatched row
 *   and a counted zero day prints 0 (R3-03);
 * - an inspector's empty hour is a drawn void with its word (R3-11);
 * - a project outside Git is one void sentence in its inspector, and the Git
 *   columns leave the table when no project is in Git (R3-06);
 * - the restart command is shown with ~ and, while presenting, masked names
 *   (R3-09, R3-10);
 * - a demonstration's join page shows one warn line, and its wait is quiet
 *   (R3-13);
 * - the lane name gives way only beside a branch (R3-04); an inspector row's
 *   name keeps its cell (R3-05); the hero's line never clamps mid-word and a
 *   cut row is never drawn (R3-07); the first part of a fitted line is never
 *   folded away (R3-08); the lockup is a 24px target and a card lifts 2px
 *   (R3-12); a project ranking gives the name the room (R3-15);
 * - an empty console says where it looked (U1), the price table is the hub's
 *   own (U2), and nothing in the last hour draws the day's recent sessions
 *   instead of an empty hatch (U3).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";

// A Windows checkout has CRLF endings; the functions are sliced out of the source by their LF-delimited ends.
const read = (file) => fs.readFileSync(new URL("../public/" + file, import.meta.url), "utf8").replace(/\r\n/gu, "\n");
const JS = read("console.js");
const CSS = read("console.css");
const HOUSE = read("house.css");
const JOIN_JS = read("join.js");
const HTML = read("index.html");

/** One of the page's own functions (a `function name(` block ending at the first "\n  }\n"), run with plain helpers. */
function fn(name, helpers = {}) {
  const start = JS.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `console.js no longer defines ${name}`);
  const end = JS.indexOf("\n  }\n", start);
  const ctx = { plural: (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`, esc: (s) => String(s ?? ""), ...helpers };
  vm.createContext(ctx);
  vm.runInContext(JS.slice(start, end + 4) + `\nthis.${name} = ${name};`, ctx);
  return ctx[name];
}
/** One of the page's `const name = (…) =>` helpers, run with plain helpers. */
function arrow(name, helpers = {}) {
  const start = JS.indexOf(`  const ${name} = `);
  assert.ok(start >= 0, `console.js no longer defines ${name}`);
  const end = JS.indexOf(";\n", start);
  const ctx = { plural: (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`, esc: (s) => String(s ?? ""), ...helpers };
  vm.createContext(ctx);
  vm.runInContext(JS.slice(start, end + 1) + `\nthis.${name} = ${name};`, ctx);
  return ctx[name];
}
const elements = () => { const nodes = new Map(); return (id) => { if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", title: "", hidden: false, tBodies: [{ innerHTML: "" }], classList: { toggle() {} } }); return nodes.get(id); }; };
const text = (html) => html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
const DAY = 86_400_000;

test("R3-03: the days before this console's first record are one hatched row, a counted zero day prints 0, and no day says 'no usage'", () => {
  const $ = elements();
  const values = new Array(30).fill(0);
  const whole = values.map((_, i) => i >= 21);   // a 9-day-old hub: the rollup holds the last nine days whole
  for (let i = 21; i < 30; i += 1) values[i] = i === 25 ? 0 : (i - 20) * 1000;   // one held day with nothing in it, today so far
  values[29] = 0;
  const D = { series: { "30d": { start: Date.UTC(2026, 7, 28), step: DAY, values, whole, byDevice: { frame: { start: 0 }, bands: [{ deviceId: "d1", tokens: values }], rest: [] } } } };
  const paint = fn("paintDays", { $, D, fmt: (n) => String(n), pct: () => "100%", pn: (k, v) => v, deviceOf: () => ({ label: "Laptop" }), shareBar: () => "<i class=bar></i>", demoStamp: () => "" });
  paint();
  const body = $("dayTable").tBodies[0].innerHTML;
  assert.equal((body.match(/<tr class="void">/gu) || []).length, 1, "exactly one void row");
  assert.match(body, /21 days before this console's first record · not kept/u);
  assert.doesNotMatch(body, /no usage/u);
  assert.equal((body.match(/<tr[ >]/gu) || []).length, 10, "nine kept days and the one void row");
  // a held day with nothing in it is a counted zero, printed 0, with its bar empty; the void row carries its reason on hover
  assert.match(body, /title="0 tokens on [^"]*\(UTC\)">0<\/td>\s*<td class="k2"><\/td>/u);
  assert.match(body, /title="From [^"]* to [^"]* \(UTC\): before this console's first record/u);
  assert.match($("dayCount").innerHTML, /^7 of 9 kept days with usage/u);
  assert.match($("dayCount").title, /21 days before this console's first record are not kept: unknown, not quiet/u);
  // today with nothing so far prints 0, never a dash
  assert.match(body, /today · so far<\/em>[\s\S]*?data-l="tokens"[^>]*>0<\/td>/u);
  // a hub without `whole` holds every day it sends: no void row, thirty rows
  delete D.series["30d"].whole;
  paint();
  assert.doesNotMatch($("dayTable").tBodies[0].innerHTML, /class="void"/u);
  assert.equal(($("dayTable").tBodies[0].innerHTML.match(/<tr[ >]/gu) || []).length, 30);
  assert.match($("dayCount").innerHTML, /of 30 kept days with usage/u);
});

test("R3-11: an inspector's empty hour is a drawn void with its word inside the tile, and its head says 'nothing', never '0 tokens'", () => {
  const sparkWave = (spark, hot, title, { cls }) => `<svg class="${cls} none"><title>${title}</title></svg>`;
  const isparkHtml = arrow("isparkHtml", { sparkWave, fmt: String });
  const hourHead = arrow("hourHead", { fmt: String });
  const empty = { spark: new Array(20).fill(0) };
  assert.match(isparkHtml(empty, false), /<span class="word" aria-hidden="true">Nothing in the last hour<\/span>/u);
  assert.match(hourHead(empty), /Last hour <span>nothing<\/span>/u);
  const busy = { spark: [0, 0, 500] };
  assert.doesNotMatch(isparkHtml(busy, false), /class="word"/u);
  assert.match(hourHead(busy), /Last hour <span>500 tokens<\/span>/u);
  assert.match(hourHead(null), /Last hour <span>—<\/span>/u);
  assert.match(CSS, /\.isparkwrap \.word \{ position: absolute;/u);
});

test("R3-06: a project outside Git is one hatched sentence in its inspector, and the Git columns leave the Projects table when no project is in Git", () => {
  const helpers = { fmt: String, money: (n) => "$" + n, pn: (k, v) => v, demoStamp: () => "", present: false, D: null,
    mergeReading: () => ({ count: null, per: null, word: "no Git", why: "Not a Git repository: nothing to count" }),
    projMoney: () => "$1", ikv: (cells) => `<div class="ikv">${cells.map(([v, l]) => `<div><div class="v">${v}</div><div class="l">${l}</div></div>`).join("")}</div>`,
    na: (word, why) => `<span class="na" title="${why}">${word}</span>`, hourHead: () => "", isparkHtml: () => "", laneList: () => "", projectKeyOf: (x) => x.name };
  const body = fn("projectInspectBody", helpers);
  const outside = body({ name: "notes", tokens: 10, usd: 1, sessions: 2, repo: null, branches: [], costPerOutcome: { perCommitUsd: null, defaultMerges: null, perDefaultMergeUsd: null } }, "24 h", null, []);
  assert.equal((outside.match(/Not a Git repository/gu) || []).length, 1, "one void sentence");
  assert.doesNotMatch(outside, /no Git|no commit|not a Git repository<\/b>/u, "never a void word per figure");
  assert.match(outside, /<div class="na held iwide" data-src="projects.repo">Not a Git repository · commits, lines, PR-linked commits, \$ per commit and \$ per merge are not counted/u);
  assert.equal((outside.match(/<div class="l">/gu) || []).length, 2, "the estimate and the sessions keep their cells");
  const inside = body({ name: "app", tokens: 10, usd: 1, sessions: 2, repo: { name: "app", commits: 4, added: 10, removed: 2, prsMerged: 1 }, branches: ["main"], costPerOutcome: { perCommitUsd: 0.25, defaultMerges: 1, perDefaultMergeUsd: 1 } }, "24 h", null, []);
  assert.doesNotMatch(inside, /iwide/u);
  assert.equal((inside.match(/<div class="l">/gu) || []).length, 6);
  // the table: no project in Git at all leaves the seven Git columns out and says so once in the head
  assert.match(JS, /\$\("projTable"\)\.classList\.toggle\("nogit", noGitAtAll\);/u);
  assert.match(JS, /noGitAtAll \? "Git columns left out: no project here is in a Git repository"/u);
  assert.match(JS, /: p\.withRepo === 0 \? "" : `<td class="merged git" colspan="7" data-src="projects\.repo">\$\{na\("not in Git"/u);
  assert.match(CSS, /table\.grid\.nogit \.git \{ display: none; \}/u);
  assert.equal((HTML.match(/<th scope="col" class="r git[^"]*"/gu) || []).length, 6, "six right-aligned Git columns carry the class");
  assert.match(HTML, /<th scope="col" class="git">Branches<\/th>/u);
});

test("R3-09/R3-10: the restart command is shown with ~ for the home directory and, while presenting, masked names; Copy keeps the real one", () => {
  const source = JS.slice(JS.indexOf("  function shownCommand("), JS.indexOf("\n  }\n", JS.indexOf("  function shownCommand(")) + 4);
  const run = (present, cmd) => vm.runInNewContext(source + "\nshownCommand(cmd)", { present, cmd });
  const cmd = "/Users/someone/.nvm/versions/node/v22.0.0/bin/node /Users/someone/work/agent-console/bin/agent-console.mjs --name 'Mac Studio' --person Sam --state-dir /Users/someone/.agent-console/hub2 --listen 0.0.0.0";
  const plain = run(false, cmd);
  assert.doesNotMatch(plain, /\/Users\/someone/u);
  assert.equal(plain, "~/.nvm/versions/node/v22.0.0/bin/node ~/work/agent-console/bin/agent-console.mjs --name 'Mac Studio' --person Sam --state-dir ~/.agent-console/hub2 --listen 0.0.0.0");
  const shown = run(true, cmd);
  assert.doesNotMatch(shown, /Mac Studio|Sam\b|\/Users\/someone/u);
  // while presenting a folder's name is a project's (J4-09): --state-dir and the transcript roots are masked as --name and --person are
  assert.equal(shown, "~/.nvm/versions/node/v22.0.0/bin/node ~/work/agent-console/bin/agent-console.mjs --name '…' --person '…' --state-dir '…' --listen 0.0.0.0");
  assert.equal(run(true, "node x.mjs --name=\"Build box\" --person='O'\\''Neil' --listen 0.0.0.0"), "node x.mjs --name='…' --person='…' --listen 0.0.0.0");
  assert.equal(run(false, "C:\\Users\\someone\\node.exe \"C:\\Users\\someone\\x.mjs\""), "~\\node.exe \"~\\x.mjs\"");
  // the sheet takes the mask at once when presenting starts, and Copy still gives the hub's own command
  assert.match(JS, /if \(D && D\.hub\.networkCommand\) \$\("networkCmdShown"\)\.textContent = shownCommand\(D\.hub\.networkCommand\);/u);
  assert.match(JS, /copy\(D\.hub\.networkCommand, "Command copied\./u);
  // while presenting every figure stays (J4-11): one rule, and it is that no list-price figure and no header over one steps back;
  // the strip's scope line (counts only) stays; only the restart command's row, which carries this machine's addresses, steps back
  assert.doesNotMatch(CSS, /body\[data-present\] [^{]*(?:th\.est|\.c-usd|\.chead|\.count)[^{]*\{ visibility: hidden; \}/u);
  assert.match(CSS, /body\[data-present\] \[data-internal\] \{ visibility: hidden; \}/u);
  assert.equal((JS.match(/data-internal/gu) || []).length, 0, "no figure in the page carries the presenting mark");
  assert.equal((HTML.match(/data-internal/gu) || []).length, 1, "only the restart command's row carries it");
  assert.match(HTML, /id="networkCmd" hidden data-internal/u);
  assert.equal((HTML.match(/class="r est"|class="r git est"/gu) || []).length, 5, "every Est. \\$, \\$ / commit and \\$ / merge head carries the class");
  // the select is the sheet's own material, and the button beside a tall command does not stretch to its height
  assert.match(CSS, /\.sheet select \{ appearance: none;/u);
  assert.match(CSS, /\.warnline \.copyrow \.btn \{ align-self: flex-start; \}/u);
});

test("R3-13: a demonstration's join page shows one warn line, and its add-link sheet waits for nothing", () => {
  assert.match(JOIN_JS, /if \(info\.demo\) \{ \$\("demoStamp"\)\.hidden = false; \$\("demoNote"\)\.hidden = false; \$\("noCode"\)\.hidden = true; \}/u);
  // the page's own flow against a demo /api/join/info with a link that has no code: the DEMO note shows, the missing-code line does not
  const $ = elements();
  const shown = () => ["noCode", "demoNote"].filter((id) => !$(id).hidden);
  $("noCode").hidden = false;   // as the page does first for a link without a code
  vm.runInNewContext(`if (info.demo) { $("demoStamp").hidden = false; $("demoNote").hidden = false; $("noCode").hidden = true; }`, { info: { demo: true }, $ });
  assert.deepEqual(shown(), ["demoNote"], "one warn line on a demonstration");
  assert.match(JS, /status\.className = j\.demo \? "waiting demo" : "waiting";/u);
  assert.match(JS, /status\.innerHTML = j\.demo \? "<i><\/i>A demonstration console cannot be joined\." : "<i><\/i>Waiting for the machine to join…";/u);
  assert.match(CSS, /\.waiting\.demo i \{ animation: none;/u);
});

test("R3-04/R3-05/R3-07/R3-08/R3-12/R3-15: the CSS and source shapes of the smaller gaps", () => {
  // the lane name keeps its cell: the cell is a grid whose first track is the name's own width, the branch takes what is left
  assert.match(CSS, /\.lane \.pr \{ min-width: 0; display: grid; grid-template-columns: minmax\(0, auto\) minmax\(0, 1fr\);/u);
  assert.doesNotMatch(CSS, /\.lane \.pr b \{[^}]*max-width: 70%/u, "no fixed cap on the name at desk width");
  assert.match(CSS, /\.lane \.pr \{ display: flex; flex-direction: column;/u, "the phone keeps the name over its branch");
  assert.match(JS, /row\.querySelector\("\.pr"\)\.classList\.toggle\("branched", Boolean\(branchName\)\);/u);
  // an inspector row: the name-and-branch cell takes most of the row, and inside it only the branch gives way
  assert.match(CSS, /\.inspect \.irow \{ display: grid; grid-template-columns: minmax\(0, 2\.2fr\) minmax\(0, 1fr\) 56px 46px;/u);
  assert.match(CSS, /\.inspect \.irow \.nm \{ display: grid; grid-template-columns: minmax\(0, auto\) minmax\(0, 1fr\);/u);
  assert.match(CSS, /\.inspect \.irow b \{ font: 500 12\.5px var\(--sans\); color: var\(--ink\); flex: none;/u);
  // the hero's line is ordered parts on one line, never a clamp; only whole rows are drawn and the rule is a door
  assert.match(CSS, /\.attention \.aline \{[^}]*white-space: nowrap; text-overflow: ellipsis;/u);
  assert.doesNotMatch(CSS, /\.attention \.aline \{[^}]*line-clamp/u);
  assert.match(JS, /fitLine\(\$\("attnLine"\), line, lineTail\);/u);
  assert.match(JS, /function wholeRows\(list\)/u);
  assert.match(JS, /<button type="button" class="rule door" data-alerts title="[\s\S]*?">\$\{esc\(plural\(earlier\.length, "alert"\)\)\} earlier · open<\/button>/u);
  assert.match(CSS, /\.alist \.rule\.door \{ display: flex; align-items: center; min-height: 24px;/u);
  // the first part of a fitted line is never folded away
  assert.doesNotMatch(JS, /segs\[0\]\.hidden = true/u);
  assert.match(JS, /summary\("shipSum", unread \? \[stampPart, \{ html: `<span class="void" title="\$\{esc\(gitWhy\(t\)\)\}">not in Git<\/span>`, text: gitWhy\(t\), pri: 0 \}/u);
  // the lockup is a 24px target and a card lifts 2px with its rim brightened
  assert.match(HOUSE, /\.lockup \{[^}]*min-height: 24px; padding: 1px 0; \}/u);
  assert.match(CSS, /\.console > \.col:hover \{ transform: translateY\(-2px\); box-shadow: inset 0 1px 0 color-mix\(in srgb, var\(--card-rim\) 70%, #fff\)/u);
  // a project ranking gives the name the room and fixes the bar
  assert.match(CSS, /\.mrow\.proj \{ grid-template-columns: minmax\(0, 1fr\) auto minmax\(calc\(48px \* var\(--k\)\), calc\(72px \* var\(--k\)\)\) calc\(44px \* var\(--k\)\)/u);
  assert.match(JS, /<div class="mrow proj door" data-inspect="project:/u);
});

test("U1: an empty console says where it looked, in mono, with the flag that points it elsewhere", () => {
  const D = { hub: { local: { enabled: true, roots: [{ tool: "claude-code", path: "/Users/someone/.claude/projects", exists: true, files: 0 }, { tool: "codex", path: "/Users/someone/.codex/sessions", exists: false, files: 0 }] } } };
  const homeShort = arrow("homeShort");
  const line = fn("rootsLine", { D, TOOL: { "claude-code": "Claude Code", codex: "Codex" }, period: "7d", PERIOD_TEXT: { "7d": ["last 7 days"] }, homeShort });
  const r = line();
  assert.equal(r.found, 0);
  assert.equal(r.head, "No Claude Code or Codex transcript found. Looked in");
  assert.match(r.html, /<code title="Claude Code · 0 files">~\/\.claude\/projects<\/code> <span class="held">\(0 files\)<\/span>, <code title="Codex · not there">~\/\.codex\/sessions<\/code> <span class="held">\(not there\)<\/span>\./u);
  assert.match(r.html, /<code>--claude-root &lt;folder&gt;<\/code> or <code>--codex-root &lt;folder&gt;<\/code>, or set <code>CLAUDE_CONFIG_DIR<\/code> or <code>CODEX_HOME<\/code>/u);
  assert.doesNotMatch(r.html + r.text, /\/Users\/someone/u, "the account's name is never on screen in a path");
  D.hub.local.roots[0].files = 42;
  assert.equal(line().head, "Read 42 transcripts in");
  assert.match(line().html, /None has usage in the last 7 days\./u);
  D.hub.local.roots = [];
  assert.equal(line(), null, "a 0.4 hub without roots says nothing");
  assert.match(JS, /: looked && !looked\.found \? \["No Claude Code or Codex transcript found on this machine", ""\]/u);
});

test("U2/U3: the price table is the hub's own, a class with nothing in it is a clean void mark, the first start is not a restart, and an idle hour draws the day's recent sessions", () => {
  assert.match(JS, /const prices = D\.hub\.prices && \(D\.hub\.prices\.v \|\| D\.hub\.prices\.checkedOn\)/u);
  assert.match(JS, /"price table not reported by this hub"/u);
  // a class with nothing in it names the window — and the quiet window's cause when nothing at all ran in it (J4-02)
  assert.match(JS, /: t\.total === 0 \? `<em class="usd void" title="\$\{esc\(quietWindow\(\) \? quietReason\("nothing to price"\) : `No \$\{CLASS_LABEL\[k\]\} tokens in the \$\{PERIOD_TEXT\[period\]\[0\]\}, so nothing to price`\)\}">—<\/em>`/u);
  assert.doesNotMatch(JS, /— no reading/u);
  assert.match(JS, /"first-start": \(since\) => `The console first started at/u);
  assert.match(JS, /"first-start": "the console's first start; nothing ran before it"/u);
  assert.match(JS, /"first-start": \(t\) => `first start \$\{hhmm\(t\)\} · nothing before it`/u);
  // the hairline names the states drawn under it (J4-04): "idle", or "silent machine", never "idle" over a silent machine's row
  assert.match(JS, /"nothing in the last hour · the day's most recent sessions · " \+ which/u);
});
