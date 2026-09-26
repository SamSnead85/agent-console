/**
 * The console's alert count and its alert list agree (docs/PRINCIPLES.md §7):
 * the hub lists up to twenty alerts from the last hour, the rail's chip counts
 * every one of them, and the panel shows them all or says how many are
 * hidden. The state column of a lane is a state, never a provenance stamp.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import crypto from "node:crypto";
import vm from "node:vm";

import { createAlerts } from "../lib/hub/alerts.js";

const JS = fs.readFileSync(new URL("../public/console.js", import.meta.url), "utf8");
const HTML = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const hashIdentity = (kind, value) => crypto.createHash("sha256").update(kind + "|" + value).digest("hex");

/** A session that repeats the same Edit call `n` times. */
function loops(engine, session, n, at) {
  for (let i = 0; i < n; i += 1) {
    engine.observeLine({ tool: "claude-code", sessionHash: session, parentSessionHash: null, projectHash: "p", hashIdentity,
      line: { type: "assistant", timestamp: new Date(at).toISOString(), message: { content: [{ type: "tool_use", id: session + i, name: "Edit", input: { file: "a.js" } }] } } });
  }
}

test("the hub lists more than three alerts when more than three sessions loop", () => {
  let now = Date.UTC(2026, 8, 22, 12);
  const engine = createAlerts({ repeat: 5, now: () => now });
  for (let s = 0; s < 7; s += 1) { loops(engine, "session-" + s, 6, now); now += 1000; }
  const listed = engine.list();
  assert.ok(listed.length >= 7, `expected at least 7 alerts, got ${listed.length}`);
  assert.ok(listed.length <= 20, "the hub lists at most twenty");
  assert.ok(listed[0].at >= listed[listed.length - 1].at, "newest first");
});

test("the panel shows every alert or says how many are hidden; the chip counts them all", () => {
  // The page never trims the list to a fixed three in silence.
  assert.doesNotMatch(JS, /\(D\.alerts \|\| \[\]\)\.slice\(0, 3\)/u, "the panel is cut to three without saying so");
  assert.match(JS, /\$\("alertShown"\)\.textContent = \(shown\.length < all\.length \? `\$\{shown\.length\} of \$\{all\.length\} shown · `/u, "the panel does not say how many of the alerts it shows");
  assert.match(JS, /more\.textContent = alertsOpen \? "Show fewer" : `\$\{all\.length - ALERT_SHOWN\} more`/u, "no way to open the rest of the list");
  assert.match(JS, /chip\.innerHTML = `<span aria-hidden="true">▲<\/span> \$\{plural\(all\.length, "alert"\)\}/u, "the chip counts something other than every alert, or reads its glyph aloud");
  assert.match(HTML, /<button class="linkbtn" type="button" id="alertMore" hidden>/u);
});

test("a lane's state column says LIVE, and DEMO stays a stamp", () => {
  assert.match(JS, /const word = l\.state === "live" \? "LIVE"/u, "the state word is replaced by a provenance stamp");
  assert.doesNotMatch(JS, /\? \(demo \? "DEMO" : "LIVE"\)/u);
  // The demo's provenance is carried by the strip's stamp, the row's own class and the footer.
  assert.match(JS, /row\.className = "lane " \+ l\.state \+ \(demo \? " sim" : ""\)/u);
  assert.match(JS, /DEMO · every figure here is generated/u);
});

test("the scrollable regions and the numbers a hub may not send are handled without inventing anything", () => {
  // Tabindex and role follow whether the region actually scrolls.
  assert.match(JS, /el\.scrollWidth > el\.clientWidth \+ 1 \|\| el\.scrollHeight > el\.clientHeight \+ 1/u);
  // A lane whose hub sends no split by class draws a void, never a zero.
  assert.match(JS, /const cls = l\.tokensDayByClass \|\| null;/u);
  assert.match(JS, /el\.textContent = value === null \? "—" : fmt\(value\);/u);
  // The chart draws the stack only when the hub sent one.
  assert.match(JS, /const clsGoal = s\.classes \? /u);
});

// Execute the actual small renderers with synthetic readings and inert DOM
// nodes. Their numerical results and labels matter, not their source spelling.
function renderer(name, end, globals) {
  const start = JS.indexOf(`  function ${name}(`);
  assert.ok(start >= 0 && JS.indexOf(end, start) > start);
  return vm.runInNewContext(JS.slice(start, JS.indexOf(end, start)) + `\n${name}`, globals);
}
function elements() {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", title: "", classList: { toggle() {} },
      setAttribute(key, value) { this[key] = value; } });
    return nodes.get(id);
  };
  return $;
}

test("lane class readings distinguish missing, mixed and observed zero", () => {
  const read = renderer("laneClassReading", "  function fillLane(", {
    fmt: String, CLASS_LABEL: { fresh: "uncached input", output: "output" },
  });
  assert.equal(read({}, "fresh").value, null);
  const oldHub = read({ tokensDayByClass: { fresh: 0 } }, "fresh");
  assert.equal(oldHub.value, null, "an older hub's omitted completeness is not an observed zero");
  assert.match(oldHub.title, /does not report whether/u);
  const lane = { tokensDayByClass: { fresh: 0, output: 500 }, tokensDayUnknown: { fresh: 1, output: 1 } };
  for (const key of ["fresh", "output"]) {
    const value = read(lane, key);
    assert.equal(value.value, null, "an incomplete count is a void, including a mixed known sum");
    assert.match(value.title, /did not report .*floor/u);
  }
  lane.tokensDayUnknown.fresh = 0;
  assert.equal(read(lane, "fresh").value, 0, "a reported zero remains zero");
});

test("the burn median names active minutes and does not call empty history observed idle", () => {
  const $ = elements();
  const values = new Array(60).fill(0);
  const D = { devices: [{}], burn: { reporting: 1 }, now: 59.5 * 60_000,
    series: { "1h": { start: 0, step: 60_000, values } } };
  const paint = renderer("paintBurnSpark", "  // ── the rest of the day", { D, $, fmt: String, smooth: () => "" });
  values[20] = 100;
  paint();
  assert.match($("burnMedian").innerHTML, /median active minute <b>100<\/b>/u);
  assert.match($("burnMedian").title, /Empty minutes may be idle or unobserved and are excluded/u);
  values[30] = 300;
  values[59] = 5000;
  paint();
  assert.match($("burnMedian").innerHTML, /<b>200<\/b>/u, "even median averages the middle pair and excludes the ongoing minute");
  values.fill(0);
  paint();
  assert.equal($("burnMedian").innerHTML, "No usage recorded in completed minutes");
  assert.doesNotMatch($("cBurnSpark")["aria-label"], /median 0|no whole minute/u);
  D.devices = [];
  paint();
  assert.equal($("burnMedian").textContent, "—", "no machine is an unknown reading");
});

test("the local Git estimate never divides fleet dollars by local commits", () => {
  const $ = elements();
  const local = { totals: { commits: 2, prsMerged: null, added: 0, removed: 0 }, projects: [], withRepo: 0,
    tokens: 100, sessions: 1, demo: false };
  let fleetUsd = 20;
  const paint = renderer("paintFold", "  // ── scrollable regions", foldGlobals({ $, foldFetched: { data: local }, win: () => ({ tokens: { total: 200 }, cost: { usd: fleetUsd, status: "estimated" }, messages: 3 }) }));
  paint();
  const estimate = () => $("foldEffortBody").innerHTML.match(/<tr><td>Estimate<\/td><td[^>]*>.*?<\/td><td[^>]*>(.*?)<\/td>/u)?.[1];
  const before = estimate();
  assert.ok(before);
  fleetUsd = 2000; // A remote machine contributes another $1,980.
  paint();
  assert.equal(estimate(), before, "remote spend cannot change the local Git estimate");
  assert.doesNotMatch(before, /\$[\d.]+ per commit/u);
});

/** The globals paintFold needs besides the payload: the fitted-line and Git-void helpers as the page defines them, in plain form. */
function foldGlobals(extra) {
  return { period: "1h", PERIOD_TEXT: { "1h": ["last hour", "1 h"] }, view: "console", pn: (kind, value) => value, hhmm: () => "",
    esc: String, fmt: String, money: (n) => "$" + n, plural: (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`,
    gitN: (v) => (v === null ? "—" : String(v)), gitLines: (t) => (t.added === null || t.removed === null ? "—" : null),
    gitUnread: (t) => !t || t.commits === null || t.commits === undefined, gitWhy: (t) => (t && t.reason) || "Git figures could not be read on this machine",
    na: (word, why) => `<span class="na" title="${why}">${word}</span>`,
    fitLine: (el, parts, tail = "") => { const live = parts.filter((x) => x && x.html); el.innerHTML = live.map((x) => x.html).join(" · "); el.title = live.map((x) => x.text ?? x.html.replace(/<[^>]+>/gu, "")).join(" · ") + tail; },
    effortTable: () => "", shippedTable: () => "", paintProjectsEffort: () => {}, fleetOf: () => null, ...extra };
}

test("Git nobody could read is a void with the hub's reason, never 0 commits (F6)", () => {
  const $ = elements();
  const reason = "no project here is in a Git repository this console could read";
  const local = { totals: { commits: null, prsMerged: null, added: null, removed: null, reason }, projects: [{ name: "app", tokens: 10, usd: 1, sessions: 2, repo: null, branches: [], costPerOutcome: { perCommitUsd: null } }], withRepo: 0,
    tokens: 100, sessions: 1, demo: false, period: { basis: "minutes", sessionsKept: true, branchesKept: true } };
  const paint = renderer("paintFold", "  // ── scrollable regions", foldGlobals({ $, foldFetched: { data: local }, win: () => ({ tokens: { total: 200 }, cost: { usd: 20, status: "estimated" }, messages: 3 }) }));
  paint();
  for (const id of ["effortSum", "shipSum"]) {
    assert.doesNotMatch($(id).innerHTML, /0 commits/u, `${id} shows a measured zero for Git nobody read`);
    assert.ok($(id).innerHTML.includes(reason), `${id} carries the hub's reason`);
    assert.ok($(id).title.includes(reason), `${id} carries the reason on hover`);
  }
  assert.doesNotMatch($("shipSum").innerHTML, /\+—|−—|referencing/u, "no line count or PR count stands in for unread Git");
  // the fold row carries the same summary as the strip button (the phone shows the rows alone)
  assert.equal($("effortSumRow").innerHTML, $("effortSum").innerHTML);
  // the folder outside Git is said once over the table, never once per row
  assert.match($("foldProjBody").innerHTML, /1 of 1 not in Git/u);
  assert.doesNotMatch($("foldProjBody").innerHTML, /not a Git repository/u);
});

test("a money figure with records the reporter could not count is a floor, marked with the number (G6)", () => {
  const start = JS.indexOf("  function costMark(");
  const end = JS.indexOf("  const droppedOf", start);
  const costMark = vm.runInNewContext(JS.slice(start, end) + "\ncostMark", { money: (n) => "$" + n.toFixed(2) });
  const whole = costMark({ usd: 21.26, status: "estimated" }, 0);
  assert.equal(whole.html, "$21.26");
  assert.match(whole.title, /Not an invoice/u);
  const floor = costMark({ usd: 21.26, status: "estimated" }, 3);
  assert.match(floor.html, /^\$21\.26<em class="part">partial<\/em>$/u, "the mark sits with the number");
  assert.match(floor.title, /3 messages not counted · list-price estimate, a floor/u);
  assert.match(costMark({ usd: 21.26, status: "estimated" }, 3, false).html, /^\$21\.26<em class="part">\+<\/em>$/u, "a narrow cell carries the mark alone");
  assert.match(costMark({ usd: 5, status: "partial" }, 0).html, /partial/u, "a partly unpriced estimate is a floor too");
  assert.match(costMark({ usd: null, status: "unpriced" }, 3).html, /unpriced/u);
  assert.equal(costMark({ status: "none" }, 3).html, "—");
});
