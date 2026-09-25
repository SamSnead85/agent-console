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
