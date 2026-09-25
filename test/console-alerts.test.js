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
  const paint = renderer("paintBurnSpark", "  // ── the rest of the day", { D, $, fmt: String });
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
  const paint = renderer("paintFold", "  // ── scrollable regions", { $, foldFetched: { data: local },
    period: "1h", PERIOD_TEXT: { "1h": ["last hour", "1 h"] },
    win: () => ({ tokens: { total: 200 }, cost: { usd: fleetUsd, status: "estimated" }, messages: 3 }),
    esc: String, fmt: String, money: (n) => "$" + n, plural: (n, word) => `${n} ${word}`,
    gitN: (v) => (v === null ? "—" : String(v)), gitLines: () => null,
  });
  paint();
  const estimate = () => $("foldEffortBody").innerHTML.match(/<tr><td>Estimate<\/td><td[^>]*>.*?<\/td><td[^>]*>(.*?)<\/td>/u)?.[1];
  const before = estimate();
  assert.ok(before);
  fleetUsd = 2000; // A remote machine contributes another $1,980.
  paint();
  assert.equal(estimate(), before, "remote spend cannot change the local Git estimate");
  assert.doesNotMatch(before, /\$[\d.]+ per commit/u);
});
