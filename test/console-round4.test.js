/**
 * The fourth verified round of the ui-next branch, each gap held by the page's
 * own renderer run with plain helpers, or by the screen's own source:
 *
 * - on a phone the Effort and Shipped tables keep every cell; only the four
 *   dense tables become card rows (J4-01);
 * - a window in which nothing ran names its cause on every pane — the spend
 *   spectrum, the by-model rows, the activity waves, the class table and the
 *   chart — never "no model has reported" or "does not split" (J4-02);
 * - an alert from before today carries a dated stamp and sits under
 *   "earlier", never under "today", and stays out of today's count (J4-03);
 * - the lanes' footer says where the lanes on unavailable machines are —
 *   drawn dimmed or in the Cold fold — and the hairline names the states
 *   drawn under it (J4-04);
 * - with no machine watched the Team head, its rows, the strip and the
 *   Attention stat are a void with its reason, never "none" (J4-05);
 * - the sheet's disclosure and the phone's mark are 24px targets (J4-06);
 * - the lanes' footer wraps whole on a phone (J4-07, F4-01);
 * - the probes switch presenting on from the console, never into a field
 *   (J4-08);
 * - the restart command masks every folder option while presenting, and the
 *   account's name in any path segment outside the home directory (J4-09);
 * - the join page's step ordinals stay one word (J4-10);
 * - every figure stays while presenting: one rule (J4-11);
 * - the room the lanes leave goes to the folds that fit, then to the tray,
 *   never to a hatched tile (J4-12);
 * - a person's machine row shows its state whole (J4-13).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const read = (file) => fs.readFileSync(new URL("../public/" + file, import.meta.url), "utf8");
const JS = read("console.js");
const CSS = read("console.css");
const JOIN_CSS = read("join.css");
const HTML = read("index.html");
const PROBES = fs.readFileSync(new URL("../scripts/ui-probes.mjs", import.meta.url), "utf8");

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const esc = (s) => String(s ?? "");
/** One of the page's own functions (a `function name(` block ending at the first "\n  }\n"), run with plain helpers. */
function fn(name, helpers = {}) {
  const start = JS.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `console.js no longer defines ${name}`);
  const end = JS.indexOf("\n  }\n", start);
  const ctx = { plural, esc, ...helpers };
  vm.createContext(ctx);
  vm.runInContext(JS.slice(start, end + 4) + `\nthis.${name} = ${name};`, ctx);
  return ctx[name];
}
/** One of the page's `const name = …;` one-line helpers, run with plain helpers. */
function arrow(name, helpers = {}) {
  const start = JS.indexOf(`  const ${name} = `);
  assert.ok(start >= 0, `console.js no longer defines ${name}`);
  const end = JS.indexOf(";\n", start);
  const ctx = { plural, esc, ...helpers };
  vm.createContext(ctx);
  vm.runInContext(JS.slice(start, end + 1) + `\nthis.${name} = ${name};`, ctx);
  return ctx[name];
}
const elements = () => {
  const nodes = new Map();
  return (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: "", textContent: "", title: "", hidden: false, tBodies: [{ innerHTML: "" }], attrs: {},
      classList: { toggled: {}, toggle(c, on) { this.toggled[c] = on; }, add() {}, remove() {}, contains() { return false; } },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; }, querySelector() { return null; }, querySelectorAll() { return []; } });
    return nodes.get(id);
  };
};
const text = (html) => String(html).replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
const media = (query) => { const at = CSS.indexOf(`@media (${query})`); assert.ok(at >= 0, `no @media (${query}) block`); let depth = 0, i = CSS.indexOf("{", at); for (; i < CSS.length; i += 1) { if (CSS[i] === "{") depth += 1; else if (CSS[i] === "}") { depth -= 1; if (!depth) break; } } return CSS.slice(at, i + 1); };
const PERIOD_TEXT = { "1h": ["last hour", "1 h", "one hour ago"], "24h": ["last 24 hours", "24 h", "24 hours ago"], "7d": ["last 7 days", "7 days", "seven days ago"], "30d": ["last 30 days", "30 days", "30 days ago"] };
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const HOUR = 3_600_000, DAY = 86_400_000;

/* A hub whose machine reported today and ran nothing in the last hour: the day has usage, the hour has none. */
function quietHub(now = Date.parse("2026-09-26T15:05:00")) {
  const lastAt = now - 67 * 60_000;
  const window = (total) => ({ tokens: { total, cacheRead: total * 0.6, cacheWrite: total * 0.1, output: total * 0.2, fresh: total * 0.1 }, shares: { cacheRead: 0.6, cacheWrite: 0.1, output: 0.2, fresh: 0.1, cacheHitOnInput: 0.8 },
    cost: total ? { usd: 12.5, status: "priced", byClass: { cacheRead: 2, cacheWrite: 1, output: 8.5, fresh: 1, unsplitUsd: 0 }, unpricedModels: [], unpricedTokens: 0 } : { usd: null, status: "none", byClass: null, unpricedModels: [], unpricedTokens: 0 },
    messages: total ? 40 : 0, models: total ? [{ model: "claude-sonnet-4-5", label: "sonnet 4.5", tokens: total, share: 1, usd: 12.5, vendor: "anthropic" }] : [], unknown: { cacheRead: 0, cacheWrite: 0, output: 0, fresh: 0 } });
  return { now, laneCount: 3, lanes: [{ key: "a", state: "idle", lastAt, tokensDay: 1000 }, { key: "b", state: "idle", lastAt: lastAt - HOUR, tokensDay: 500 }],
    devices: [{ id: "d1", label: "Studio", status: "reporting", local: true, coverage: { reported: true, dropped: 0 } }], hub: { demo: false, local: { enabled: true, firstRunComplete: true, roots: [] } },
    windows: { "1h": window(0), "24h": window(120_000) }, day: window(120_000), series: { "7d": { start: now - 7 * DAY, step: 2 * HOUR, values: new Array(84).fill(1000) }, "1h": { byDevice: { frame: { start: now - HOUR, step: 3 * 60_000, steps: 20 }, bands: [{ deviceId: "d1", tokens: new Array(20).fill(0) }], rest: [] } } }, coverage: null, alerts: [] };
}

test("J4-02: a window in which nothing ran names its cause and when anything last ran, on every pane", () => {
  const D = quietHub();
  const win = () => D.windows["1h"];
  const base = { D, win, period: "1h", PERIOD_TEXT, hhmm, fmt: (n) => String(n), money: (n) => "$" + n, pct: () => "0%" };
  const quietWindow = arrow("quietWindow", base);
  const lastUsageText = fn("lastUsageText", base);
  const quietReason = arrow("quietReason", { ...base, lastUsageText });
  const noModelText = arrow("noModelText", { ...base, quietWindow, quietReason });
  assert.equal(quietWindow(), true, "the hour is quiet on a hub whose machine reported");
  const last = hhmm(D.lanes[0].lastAt);
  assert.equal(quietReason(), `Nothing ran in the last hour · last usage ${last} · nothing is estimated in its place`);
  assert.equal(noModelText(), `Nothing ran in the last hour · last usage ${last}`);
  // the spend spectrum: the quiet window, never "does not split its estimate"
  const $ = elements();
  const paintSpectrum = fn("paintSpectrum", { ...base, $, quietWindow, quietReason, CLASSES: ["cacheRead", "fresh", "cacheWrite", "output"], ORDER: ["output", "cacheWrite", "fresh", "cacheRead"], specModelRows: () => "", compactMQ: { matches: false }, currentTheme: () => "dark", CLASS_LABEL: {}, floorLine: () => "" });
  paintSpectrum();
  assert.equal($("specReason").textContent, `Nothing ran in the last hour · last usage ${last} · nothing to draw in its place`);
  assert.doesNotMatch($("specReason").textContent, /does not split/u);
  // the by-model rows, on the Console and on Team, and the alerts sheet's spend by model
  const paintModels = fn("paintModels", { ...base, $, noModelText, modelRows: () => "rows", currentDevices: () => D.devices, pn: (k, v) => v, BAND_MODELS: 3, plural });
  D.burn = { excluded: [], reporting: 1, windowMinutes: 5 };
  paintModels();
  assert.equal(text($("cModels").innerHTML), `Nothing ran in the last hour · last usage ${last}`);
  assert.doesNotMatch($("cModels").innerHTML, /no model has reported yet/u);
  assert.match(JS, /\$\("tModels"\)\.innerHTML = whole\.models\.length \? modelRows\(whole\.models, "tModels", whole\.models\)\s*: `<div class="mrow"><span class="mn"><span class="none-text">\$\{esc\(noModelText\(\)\)\}<\/span><\/span><\/div>`;/u);
  assert.match(JS, /: `<div class="none">\$\{esc\(noModelText\(\)\.replace\(\/\^\.\/u, \(c\) => c\.toUpperCase\(\)\)\)\}\.<\/div>`;/u);
  // the activity waves on Team and Projects: the quiet window, never "no session has reported"
  const drawWaves = fn("drawWaves", { ...base, $, quietWindow, quietReason, waves: new Map() });
  const drawn = drawWaves({ svgId: "tFlow", wrapId: "tFlowWrap", reasonId: "tFlowReason", legendId: "tLegend", peakId: "tPeak", series: D.series["1h"].byDevice, nameOf: (k) => k, now: D.now, none: "machine" });
  assert.equal(drawn, null);
  assert.equal($("tFlowReason").textContent, `Nothing ran in the last hour · last usage ${last} · nothing is estimated in its place`);
  assert.equal($("tFlowWrap").classList.toggled.void, true);
  // the chart is a drawn void for the quiet window, with the same sentence, and the class table's mark carries it
  const paintClasses = fn("paintClasses", { ...base, $, quietWindow, quietReason, paintPeriod: () => {}, ORDER: ["output", "cacheWrite", "fresh", "cacheRead"], CLASS_LABEL: { cacheRead: "cache read", cacheWrite: "cache write", output: "output", fresh: "uncached input" },
    currentDevices: () => D.devices, pn: (k, v) => v, pw: () => D.windows["24h"], catchUpText: () => "", asOf: () => "", rootsLine: () => null, showUnavailable: false, plural });
  paintClasses();
  assert.equal($("flowWrap").classList.toggled.void, true, "the chart is a drawn void, not a flat line");
  assert.equal($("voidReason").innerHTML, `Nothing ran in the last hour · last usage ${last} · nothing is estimated in its place`);
  assert.match($("cClasses").innerHTML, new RegExp(`title="Nothing ran in the last hour · last usage ${last} · nothing to price">—`, "u"));
  assert.doesNotMatch($("cClasses").innerHTML, /does not split/u);
  // "does not split" is said only of a hub that priced something and sent no split; nothing priced says so
  assert.match(JS, /: w\.cost\.status === "none" \? `<em class="usd void" title="Nothing has been priced in the \$\{esc\(PERIOD_TEXT\[period\]\[0\]\)\}">—<\/em>`\s*: `<em class="usd void" title="This hub does not split its estimate by class">—<\/em>`;/u);
  assert.match(JS, /: !byClass && w\.cost\.status === "none" \? `Nothing has been priced in the \$\{PERIOD_TEXT\[period\]\[0\]\}\.`\s*: !byClass \? "This hub does not split its estimate by class\."/u);
  // and on the day the same hub is not quiet: the sentence never appears over a window with usage
  const day = { ...base, period: "24h", win: () => D.windows["24h"] };
  assert.equal(arrow("quietWindow", day)(), false);
  // a hub with no machine at all keeps its own sentence
  const empty = { ...base, D: { ...D, laneCount: 0, lanes: [], devices: [] } };
  assert.equal(arrow("quietWindow", empty)(), false);
  assert.equal(arrow("noModelText", { ...empty, quietWindow: () => false, quietReason })(), "no machine has reported yet");
});

test("J4-03: an alert from before today is dated, listed under 'earlier', and out of today's count", () => {
  const now = Date.parse("2026-09-26T11:05:00");
  const from = Date.parse("2026-09-26T00:00:00");
  const yesterday = Date.parse("2026-09-25T14:58:00"), older = Date.parse("2026-09-23T09:10:00"), thisMorning = Date.parse("2026-09-26T08:20:00");
  const D = { now, hub: { demo: false }, alertsToday: { from, since: from, count: 1, kept: 1, exact: true, tz: "America/New_York" }, alertsCoverage: null,
    alerts: [{ kind: "loop", at: thisMorning, historical: true, tokens: 5 }, { kind: "loop", at: yesterday, historical: true, tokens: 10 }, { kind: "spike", at: older, historical: true, tokens: 900 }] };
  const base = { D, hhmm, plural, esc };
  const alertDayFrom = arrow("alertDayFrom", base);
  const beforeToday = arrow("beforeToday", { ...base, alertDayFrom });
  const alertWhen = arrow("alertWhen", { ...base, alertDayFrom });
  assert.equal(alertWhen(thisMorning), hhmm(thisMorning));
  assert.equal(alertWhen(yesterday), `yesterday ${hhmm(yesterday)}`);
  assert.equal(alertWhen(older), `${new Date(older).toLocaleDateString([], { day: "numeric", month: "short" })} ${hhmm(older)}`);
  assert.equal(beforeToday(D.alerts[1]), true);
  assert.equal(beforeToday(D.alerts[0]), false);
  const alertRow = arrow("alertRow", { ...base, alertWhen, beforeToday, ALERT_LABEL: { loop: "Repeated tool call", spike: "Burn spike" }, alertLane: () => null, alertWho: () => "Session", alertDevice: () => null, alertCause: () => "cause", pn: (k, v) => v });
  const rowYesterday = alertRow(D.alerts[1], true);
  assert.match(rowYesterday, new RegExp(`<time>yesterday ${hhmm(yesterday)}</time>`, "u"));
  assert.match(rowYesterday, /earlier, before today, not counted as live/u);
  assert.doesNotMatch(rowYesterday, /earlier today/u);
  assert.match(alertRow(D.alerts[0], true), /earlier today, not counted as live/u);
  // the Team canvas: today's one alert counted, the two older ones under their own head, never "today"
  const $ = elements();
  const paintTeamAlerts = fn("paintTeamAlerts", { ...base, $, beforeToday, liveAlerts: () => [], alertRow, pn: (k, v) => v, deviceOf: () => null, SINCE_WHY: {}, NOT_WATCHED_WHY: "" });
  paintTeamAlerts();
  assert.match($("teamAlertCount").textContent, /^1 alert today · 0 live$/u);
  const rows = $("teamAlerts").innerHTML;
  const [todayPart, earlierPart] = rows.split(`<div class="alert-head earlier"><span>earlier · before today</span></div>`);
  assert.ok(earlierPart, "the alerts before today sit under their own head");
  assert.match(todayPart, new RegExp(`<time>${hhmm(thisMorning)}</time>`, "u"));
  assert.doesNotMatch(todayPart, /yesterday/u);
  assert.match(earlierPart, new RegExp(`<time>yesterday ${hhmm(yesterday)}</time>`, "u"));
  assert.equal((earlierPart.match(/<div class="alert-row/gu) || []).length, 2);
  // without the hub's counter the count is today's own list
  const noCounter = { ...D, alertsToday: null };
  const $2 = elements();
  fn("paintTeamAlerts", { ...base, D: noCounter, $: $2, beforeToday: arrow("beforeToday", { ...base, alertDayFrom: arrow("alertDayFrom", { ...base, D: noCounter }) }), liveAlerts: () => [], alertRow, pn: (k, v) => v, deviceOf: () => null, SINCE_WHY: {}, NOT_WATCHED_WHY: "" })();
  assert.match($2("teamAlertCount").textContent, /^1 alert today · 0 live$/u);
  // the alerts sheet: "earlier today" over this morning's, "earlier · before today" over the rest; the Attention rule says "earlier", not "earlier today"
  const $3 = elements();
  const paintAlerts = fn("paintAlerts", { ...base, $: $3, beforeToday, alertWhen, alertRow, liveAlerts: () => [], earlierAlerts: () => D.alerts, alertsOpen: false, ALERT_SHOWN: 6, SINCE_WHY: {}, NOT_WATCHED_WHY: "", alertStrip: () => {}, serverNow: () => now, PERIOD_TEXT, period: "24h", win: () => ({ models: [] }), specModelRows: () => "", noModelText: () => "no model" });
  paintAlerts();
  assert.equal($3("alertEarlierHead").innerHTML, "<span>earlier today</span>");
  assert.match($3("alertEarlier").innerHTML, /earlier today, not counted[\s\S]*<div class="alert-head earlier"><span>earlier · before today<\/span><\/div>[\s\S]*yesterday/u);
  assert.match(JS, /const earlierWord = earlier\.every\(\(a\) => !beforeToday\(a\)\) \? "earlier today" : "earlier";/u);
  assert.match(JS, /raised \$\{earlierWord\}, not counted as live · open the alert list/u);
});

test("J4-04: the footer says where the lanes on unavailable machines are, and the hairline names the states drawn under it", () => {
  const STATE_WORD = arrow("STATE_WORD"), STATE_ON = arrow("STATE_ON");
  const states = fn("footStates", { STATE_ON });
  const footStates = (...a) => [...states(...a)];   // into this realm: a vm's array has another Array.prototype
  const lanes = [{ key: "s1", state: "silent" }, { key: "s2", state: "silent" }, { key: "s3", state: "silent" }, { key: "i1", state: "idle" }, { key: "g1", state: "revoked" }, { key: "c1", state: "catching-up" }];
  const drawn = new Set(["s1", "s2", "c1"]);
  // silent: two drawn dimmed, one in the Cold fold; gone: none drawn; catching up: the one drawn — nothing "(hidden)" over a drawn row
  assert.deepEqual(footStates(lanes, (l) => drawn.has(l.key), false), ["1 on a machine still catching up · drawn dimmed", "3 on silent machines · 2 drawn dimmed · 1 in the Cold fold", "1 on a machine that left or was removed · in the Cold fold"]);
  assert.deepEqual(footStates(lanes, () => false, false), ["1 on a machine still catching up · in the Cold fold", "3 on silent machines · in the Cold fold", "1 on a machine that left or was removed · in the Cold fold"]);
  // with Show unavailable on every one is a lane of its own: the count alone
  assert.deepEqual(footStates(lanes, () => false, true), ["1 on a machine still catching up", "3 on silent machines", "1 on a machine that left or was removed"]);
  assert.ok(footStates(lanes, (l) => drawn.has(l.key), false).every((p) => !p.includes("(hidden)")));
  const laneSepText = fn("laneSepText", { STATE_WORD });
  const fill = [{ state: "idle" }, { state: "silent" }, { state: "silent" }];
  assert.equal(laneSepText(0, fill, fill), "nothing in the last hour · the day's most recent sessions · idle · silent machine");
  assert.equal(laneSepText(0, [{ state: "silent" }], [{ state: "silent" }, { state: "silent" }]), "nothing in the last hour · the day's most recent sessions · silent machine · 1 more in the Cold fold");
  assert.equal(laneSepText(3, [{ state: "idle" }], [{ state: "idle" }]), "cold · idle for more than an hour");
  assert.equal(laneSepText(3, [{ state: "idle" }, { state: "revoked" }], [{ state: "idle" }, { state: "revoked" }]), "cold · idle · machine left or removed");
  assert.match(JS, /parts\.push\(\.\.\.footStates\(D\.lanes, \(l\) => fillRows\.has\(l\.key\), showUnavailable\)\);/u);
  assert.match(JS, /laneSep\.innerHTML = `<span>\$\{laneSepText\(visible\.length, fill, cold\)\}<\/span>`;/u);
  assert.doesNotMatch(JS, /on silent machines\$\{showUnavailable \? "" : " \(hidden\)"\}/u);
});

test("J4-05: with no machine watched the Team head, its rows, the strip and the Attention stat are a void with its reason", () => {
  const now = Date.parse("2026-09-26T11:05:00");
  const D = { now, hub: { demo: false }, devices: [{ id: "d1", label: "Studio", status: "reporting", local: true }], alerts: [], alertsToday: { from: Date.parse("2026-09-26T00:00:00"), since: Date.parse("2026-09-26T00:00:00"), count: 0, kept: 0, exact: true },
    alertsCoverage: { watched: 0, unwatched: 1, unwatchedDevices: ["d1"], since: null, reason: null, byDevice: { d1: { state: "off", since: null, reason: "sharing-off" } } }, silentSince: null };
  const NOT_WATCHED_WHY = arrow("NOT_WATCHED_WHY");
  assert.equal(NOT_WATCHED_WHY, "No machine shares its alerts (--share-alerts), so no alert can be known here · nothing is estimated in its place");
  const base = { D, hhmm, plural, esc, NOT_WATCHED_WHY, SINCE_WHY: {}, pn: (k, v) => v, deviceOf: (id) => D.devices.find((d) => d.id === id) };
  const $ = elements();
  fn("paintTeamAlerts", { ...base, $, beforeToday: () => false, liveAlerts: () => [], alertRow: () => "" })();
  assert.equal($("teamAlertCount").textContent, "not watched · 0 of 1 machine share alerts");
  assert.match($("teamAlertCount").title, /^No machine shares its alerts \(--share-alerts\)/u);
  assert.equal($("teamAlerts").innerHTML, `<div class="none held">${NOT_WATCHED_WHY}</div>`);
  assert.doesNotMatch($("teamAlertCount").textContent + $("teamAlerts").innerHTML, /none today|0 watched/u);
  assert.match(CSS, /\.alert-rows \.none\.held \{ background: repeating-linear-gradient/u);
  // the sixty-minute strip: hatched whole and named "not watched", never "no alert"
  const $2 = elements();
  fn("alertStrip", { ...base, $: $2, ALERT_LABEL: {} })("attnStrip", "attnStripCap", [], now);
  assert.equal($2("attnStripCap").textContent, "not watched");
  assert.match($2("attnStrip").innerHTML, /<rect class="gap unknown" x="0" y="0" width="520" height="18"><title>No machine shares its alerts/u);
  // the Attention card: its head and its stat say "not watched"; the unpriced-model hero still comes first
  assert.match(JS, /head = !D\.devices\.length \? "No machine yet" : unwatchedAll \? "Alerts not watched" : known \?/u);
  assert.match(JS, /const stat = cov && cov\.watched === 0 && !alerts\.length && D\.devices\.length \? \[\{ html: "not watched", pri: 0 \}, \{ html: `0 of \$\{current\} share alerts`, pri: 1 \}\]/u);
  assert.ok(JS.indexOf("} else if (unpriced.length) {") < JS.indexOf("const unwatchedAll = Boolean(cov) && cov.watched === 0"), "the unpriced-model hero ranks before the not-watched card");
  // a hub with a watched machine keeps its sentence
  const watched = { ...D, alertsCoverage: { watched: 1, unwatched: 0, unwatchedDevices: [], since: null, reason: null } };
  const $3 = elements();
  fn("paintTeamAlerts", { ...base, D: watched, $: $3, beforeToday: () => false, liveAlerts: () => [], alertRow: () => "" })();
  assert.equal($3("teamAlertCount").textContent, "none today");
  assert.equal($3("teamAlerts").innerHTML, `<div class="none">No alert has been raised today.</div>`);
});

test("J4-01: on a phone only the four dense tables become card rows; the Effort and Shipped tables keep every cell and scroll sideways", () => {
  const phone = media("max-width: 760px");
  assert.match(phone, /\.tablewrap table\.grid td \{ display: none;/u);
  assert.doesNotMatch(phone, /\n\s*table\.grid td \{ display: none/u, "a bare table.grid rule would hide the fold tables' cells");
  assert.doesNotMatch(phone, /\n\s*table\.grid, table\.grid tbody \{ display: block; \}/u);
  assert.match(phone, /\.foldbody \{ overflow-x: auto;/u);
  assert.match(phone, /\.foldbody\.fademore \{ -webkit-mask-image: linear-gradient\(90deg/u);
  assert.match(phone, /\.foldbody table\.grid \{ width: max-content; min-width: 100%; \}/u);
  // the fold tables are watched for the right-edge fade with every reading
  assert.match(JS, /for \(const el of document\.querySelectorAll\("\.foldbody"\)\) watchScroll\(el, "x"\);/u);
  // the four dense tables are all inside a scroller, so the card-row rules reach them and nothing else
  for (const id of ["peopleTable", "machineTable", "dayTable", "projTable"]) assert.match(HTML, new RegExp(`<div class="tablewrap"[^>]*><table class="grid" id="${id}">`, "u"), id);
  assert.match(HTML, /<div id="pEffortBody" class="foldbody" aria-label="Effort table, scrollable"><\/div>/u);
  assert.doesNotMatch(HTML, /<div class="tablewrap"[^>]*>\s*<div id="pEffortBody"/u);
  // the probe holds it at 360 and 390
  assert.match(PROBES, /#pEffortBody td, #pShipBody td, #pEffortBody tr, #pShipBody tr/u);
  assert.match(PROBES, /#foldEffortBody td, #foldShipBody td, #foldProjBody td/u);
});

test("J4-06 / J4-13: the sheet's disclosure and the phone's mark are 24px targets; a person's machine row shows its state whole", () => {
  assert.match(CSS, /\.sheet \.why summary \{[^}]*display: flex; align-items: center; min-height: 24px; \}/u);
  assert.match(media("max-width: 760px"), /\.lockup \{ min-width: 24px; min-height: 24px; justify-content: center; \}/u);
  assert.match(PROBES, /add sheet \(link step\) \$\{width\} \$\{theme\}: targets under 24px/u);
  assert.match(CSS, /\.inspect \.irow\.mach \{ grid-template-columns: minmax\(0, 1fr\) auto auto auto; \}/u);
  assert.match(CSS, /\.inspect \.irow\.mach \.status > span \{ overflow: visible; text-overflow: clip; \}/u);
  // the phone keeps its own layout for that row: the state whole on its own line
  assert.match(media("max-width: 760px"), /\.inspect \.irow\.mach \{ grid-template-columns: minmax\(0, 1fr\) 64px 60px;/u);
});

test("J4-07 / F4-01: the lanes' footer wraps whole on a phone, and the probe watches it", () => {
  const phone = media("max-width: 760px");
  assert.match(phone, /\.lfoot \{ padding: 8px 14px; flex-wrap: wrap; white-space: normal; overflow: visible; row-gap: 2px; \}/u);
  assert.match(phone, /\.lfoot span \{ flex: 0 1 auto; min-width: 0; padding-right: 10px; \}/u);
  assert.match(phone, /\.lfoot span \+ span \{ padding-left: 0; box-shadow: none; \}/u);
  assert.match(phone, /\.lfoot span\.end \{ flex-basis: 100%;[^}]*overflow: visible; \}/u);
  assert.match(PROBES, /const CLIP = "[^"]*\.lfoot, \.lfoot span, #lFoot span"/u);
  assert.match(PROBES, /the lanes' footer is cut at the card's edge/u);
});

test("J4-08 / J4-09: presenting is switched on from the console before the scan, and the restart command masks every folder option and the account's name", () => {
  assert.match(PROBES, /await p2\.keyboard\.press\("Escape"\);\s*await p2\.waitForTimeout\(300\);\s*await p2\.keyboard\.press\("p"\);/u);
  assert.match(PROBES, /if \(!stamped\) \{ fail\(`\$\{hub\.name\}: P did not switch presenting on before the scan`\); await c2\.close\(\); continue; \}/u);
  assert.match(PROBES, /--\(\?:name\|person\|state-dir\|claude-root\|codex-root\)/u);
  const source = JS.slice(JS.indexOf("  function shownCommand("), JS.indexOf("\n  }\n", JS.indexOf("  function shownCommand(")) + 4);
  const run = (present, cmd, D = null) => vm.runInNewContext(source + "\nshownCommand(cmd)", { present, cmd, D });
  const cmd = "/Users/someone/.nvm/bin/node /Users/someone/work/agent-console/bin/agent-console.mjs --name 'Mac Studio' --person Sam --state-dir /private/tmp/claude-1/someone/atlas-web/state --claude-root /private/tmp/claude-1/someone/atlas-web/home/.claude/projects --listen 0.0.0.0";
  // outside presenting: the home directory is ~, and the account's name in a path outside it is masked at that segment; the project's name stays
  const plain = run(false, cmd);
  assert.equal(plain, "~/.nvm/bin/node ~/work/agent-console/bin/agent-console.mjs --name 'Mac Studio' --person Sam --state-dir /private/tmp/claude-1/…/atlas-web/state --claude-root /private/tmp/claude-1/…/atlas-web/home/.claude/projects --listen 0.0.0.0");
  assert.doesNotMatch(plain, /someone/u);
  // while presenting: every folder option is masked as the names are
  const shown = run(true, cmd);
  assert.equal(shown, "~/.nvm/bin/node ~/work/agent-console/bin/agent-console.mjs --name '…' --person '…' --state-dir '…' --claude-root '…' --listen 0.0.0.0");
  assert.doesNotMatch(shown, /atlas-web|someone|Mac Studio|Sam\b/u);
  assert.equal(run(true, "node x.mjs --codex-root=/srv/codex/sessions --listen 0.0.0.0"), "node x.mjs --codex-root='…' --listen 0.0.0.0");
  // with no home path in the command, the account's name comes from the folders this console reads
  const roots = { hub: { local: { roots: [{ path: "/Users/someone/.claude/projects" }] } } };
  assert.equal(run(false, "node x.mjs --state-dir /private/tmp/someone/state", roots), "node x.mjs --state-dir /private/tmp/…/state");
  assert.equal(run(false, "node x.mjs --state-dir /private/tmp/someone/state"), "node x.mjs --state-dir /private/tmp/someone/state", "no name is known without a home path");
});

test("J4-10 / J4-11 / J4-12: the join page's ordinals stay one word; every figure stays while presenting; the room goes to the folds, then the tray", () => {
  assert.match(JOIN_CSS, /\.cap \.step \{[^}]*white-space: nowrap; flex: none; \}/u);
  assert.match(JOIN_CSS, /\.cap \{ display: flex; align-items: baseline;/u);
  // presenting: one rule, and it is that no figure steps back; the scope line stays; the restart command's row steps back
  assert.match(CSS, /body\[data-present\] \[data-internal\] \{ visibility: hidden; \}/u);
  assert.doesNotMatch(CSS, /body\[data-present\] \.conhead \.count/u);
  assert.doesNotMatch(CSS, /body\[data-present\][^{]*(?:th\.est|\.c-usd|\.chead|data-money)/u);
  assert.equal((JS.match(/data-money/gu) || []).length, 17, "every list-price figure carries data-money, and none data-internal");
  assert.equal((JS.match(/data-internal/gu) || []).length, 0);
  // the room the lanes leave: the card hugs its rows, the folds that fit open, the rest is the tray; the probe allows a quarter of the frame when the card hugs
  assert.match(PROBES, /const maxGap = m\.hug \? Math\.round\(SIZES\[width\]\[1\] \/ 4\) : 48;/u);
  assert.match(PROBES, /if \(m\.tile > 48\) fail\(`console \$\{width\}\$\{tag\(hub\)\}: a \$\{m\.tile\}px hatched tile stands in for rows \(max 48\)`\);/u);
  assert.match(CSS, /#consoleCanvas \.lanes\.hug \{ flex: 0 0 auto; min-height: 0; \}/u);
});
