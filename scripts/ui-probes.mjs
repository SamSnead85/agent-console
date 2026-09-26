#!/usr/bin/env node

/*
 * The console's mechanical bars, checked in a real browser against a --demo
 * console (or any console you sign into), and against any further console
 * given with --also (a synthetic month from bench/generate.mjs, a hub with
 * live alerts, a hub with four lanes), since a bar met on the demo alone is
 * not a bar:
 *
 *   node scripts/ui-probes.mjs http://127.0.0.1:6970 <server-log> [--out <dir>]
 *        [--also http://127.0.0.1:6972 <its-server-log>]…
 *
 *   - axe-core WCAG 2.2 AA: zero violations on Console, Projects, Team and
 *     Join, dark and light, 1440 and 390 (target-size and
 *     scrollable-region-focusable included), and Console at 1280; on the join
 *     page a Copy with nothing to copy is out and not drawn in the accent;
 *   - the strip's clock and scan note read over the artwork: the pixels
 *     behind them, sampled from a screenshot, hold 4.5:1 under their ink at
 *     1440 and 1920 in both themes;
 *   - label in name: #unitBtn, #voidBtn, #motionBtn;
 *   - composition: the lane rows drawn whole above the lanes' footer number at
 *     least eight at 1920×1080, 1440×900 and 1280×800 and six at 1024×768 —
 *     counted, not "room" — on every console given, and the canvas gives the
 *     pane room for that many; nothing stands empty under the last row (48px
 *     at most, the card hugging its rows when the day has fewer than the pane
 *     holds); the second band never exceeds 200px (72px in the compact
 *     frame); the fold strip is in frame; the document never scrolls; the
 *     status bar is one line (≤ 32px); every caption is one line (≤ 24px) at
 *     1280 and 1024; Projects and Team at 1440 and 1920 leave no empty tile
 *     taller than 48px under their last row, and no more than a quarter of the
 *     frame under the last card;
 *   - no clipped non-mono text at 360, 390, 1024, 1280 and 1440: every part
 *     of a lane header (its "24 h" group label whole inside the header), a
 *     caption, a fold summary, the strip's scope line, a model name and every
 *     listed selector fits or carries its whole on hover; an inspector's
 *     session rows keep a forty-character project name inside its own cell;
 *     no page scrolls sideways at 360;
 *   - nothing renders below 12px, with a sheet open too;
 *   - keyboard: at 390 every lane row is reachable by Tab and opens on Enter;
 *     at 1440 J and K move DOM focus onto the row; closing a sheet returns
 *     focus to what opened it — a lane opened with Enter, a Team people or
 *     machine row, a band machine row or a context button whose node was
 *     repainted while the sheet stayed open for five seconds; the context
 *     button opens the lane inspector at its Context section; the palette is
 *     a combobox with a listbox and an active descendant;
 *   - presenting: with P pressed, no project, branch, machine or person name
 *     from /api/console remains anywhere in the DOM — text, titles, labels
 *     and every data attribute — and the strip reads PRESENTING;
 *   - the DEMO stamp on the join page follows /api/join/info, and a link
 *     without a join code disables Copy and says why.
 *
 * The console polls its hub every two seconds, so the network is never idle:
 * every page is opened on DOMContentLoaded and then waited for by its own
 * reading (the band's total, the join page's command). Each section runs
 * whole or fails whole by name — a timeout is a named ✗, never an uncaught
 * exit that leaves the later bars unrun — and the last line counts the
 * checks and the failures for the gate to read.
 *
 * Needs Playwright and @axe-core/playwright, which this package does not
 * depend on: point AGENT_CONSOLE_PLAYWRIGHT_DIR at a node_modules that has
 * them, or install them beside this repository. Exit status 1 means a bar
 * was missed; the report says which.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
const hubs = [];
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--also") { hubs.push({ base: argv[i + 1], log: argv[i + 2], name: "also-" + hubs.length }); i += 2; }
  else if (argv[i] === "--out") { rest.push(argv[i], argv[i + 1]); i += 1; }
  else rest.push(argv[i]);
}
const [base, log] = rest.filter((a) => !a.startsWith("--") && !rest.includes("--out") || rest.indexOf(a) < rest.indexOf("--out"));
if (!base || !log) { process.stderr.write("usage: node scripts/ui-probes.mjs <console url> <server log> [--out <dir>] [--also <url> <log>]…\n"); process.exit(2); }
hubs.unshift({ base, log, name: "demo" });
const out = rest.includes("--out") ? rest[rest.indexOf("--out") + 1] : null;
if (out) fs.mkdirSync(out, { recursive: true });

const require = createRequire(path.join(process.env.AGENT_CONSOLE_PLAYWRIGHT_DIR || path.join(process.cwd(), "node_modules"), "/"));
let chromium, AxeBuilder;
try { ({ chromium } = require("playwright")); ({ AxeBuilder } = require("@axe-core/playwright")); }
catch (error) { process.stderr.write(`ui-probes: Playwright is not available (${error.message}). Set AGENT_CONSOLE_PLAYWRIGHT_DIR.\n`); process.exit(2); }

let checks = 0;
const failures = [];
const fail = (what) => { checks += 1; failures.push(what); process.stdout.write(`  ✗ ${what}\n`); };
const ok = (what) => { checks += 1; process.stdout.write(`  ✓ ${what}\n`); };
/* A section runs whole or fails whole by name: an error or a timeout inside it is one named ✗, and the sections after it still run. */
async function section(name, fn) {
  process.stdout.write(name + "\n");
  try { await fn(); } catch (error) { fail(`${name}: ${String(error.message || error).split("\n")[0]}`); }
}

/* A fresh sign-in link each time: the one printed to the server log after this request, never one printed before it (a link is
   single-use, and the log may hold spent ones from earlier runs) — the log's tail is read again until it holds one. */
const spent = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastPrint = 0;
async function signInUrl(hub) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // the console prints one link every three seconds at most ("a link was printed moments ago"): opens here come faster than that
    const wait = lastPrint + 3100 - Date.now();
    if (wait > 0) await sleep(wait);
    const before = fs.existsSync(hub.log) ? fs.statSync(hub.log).size : 0;
    const res = await fetch(hub.base + "/api/sign-in/print", { method: "POST", headers: { "x-agent-console": "1" } });
    lastPrint = Date.now();
    if (res.status === 429) continue;
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      const tail = fs.readFileSync(hub.log).subarray(before).toString("utf8");
      const fresh = [...tail.matchAll(/https?:\/\/127\.0\.0\.1:\d+\/login\?ticket=[A-Za-z0-9_-]+/gu)].map((m) => m[0]).filter((u) => !spent.has(u));
      if (fresh.length) { const u = fresh.pop(); spent.add(u); return u; }
    }
  }
  throw new Error("no fresh sign-in link printed to the server log " + hub.log);
}
const reportingBase = (hub) => { const u = new URL(hub.base); u.port = String(Number(u.port) + 1); return u.origin; };

const SIZES = { 1920: [1920, 1080], 1440: [1440, 900], 1280: [1280, 800], 1024: [1024, 768], 390: [390, 844], 360: [360, 780] };
const browser = await chromium.launch();
/* The console is ready when it is signed in and its band has a reading (or its lanes have drawn), never when the network is idle: it never is. */
async function settled(page) {
  try { await page.waitForFunction(() => { const so = document.getElementById("signedOut"); return so && so.hidden; }, null, { timeout: 8000 }); }
  catch { throw new Error("the console did not sign in (a spent ticket, or the hub is down)"); }
  await page.waitForFunction(() => {
    const t = document.getElementById("cTotal");
    return Boolean(t && t.textContent.trim() && t.textContent.trim() !== "—") || document.querySelectorAll("#cLanes > *").length > 0;
  }, null, { timeout: 20000 });
}
async function open(width, theme, view = "console", { presenting = false, hub = hubs[0], period = null } = {}) {
  const [w, h] = SIZES[width];
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: theme, isMobile: w < 500, hasTouch: w < 500 });
  await context.addInitScript((t) => { try { localStorage.setItem("agent-console-theme", t); } catch {} }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(await signInUrl(hub), { waitUntil: "domcontentloaded" });
  await page.goto(hub.base + "/", { waitUntil: "domcontentloaded" });
  await settled(page);
  await page.waitForTimeout(1200);
  if (period) { await page.evaluate((p) => document.querySelector(`#winSeg button[data-w="${p}"]`).click(), period); await page.waitForTimeout(1200); }
  if (view !== "console") { await page.evaluate((v) => document.querySelector(`.tab[data-view="${v}"]`).click(), view); await page.waitForTimeout(1500); }
  await page.evaluate(() => { const b = document.getElementById("motionBtn"); if (b && b.getAttribute("aria-pressed") !== "true") b.click(); });
  if (presenting) { await page.keyboard.press("p"); await page.waitForTimeout(400); }
  await page.waitForTimeout(200);
  return { page, context, errors };
}
/* The join page is ready when its command has been written. */
async function openJoin(width, theme, hash = "") {
  const context = await browser.newContext({ viewport: { width: SIZES[width][0], height: SIZES[width][1] }, colorScheme: theme });
  await context.addInitScript((t) => { try { localStorage.setItem("agent-console-theme", t); } catch {} }, theme);
  const page = await context.newPage();
  await page.goto(reportingBase(hubs[0]) + "/join" + hash, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const c = document.getElementById("cmd"); return Boolean(c && c.textContent.trim()); }, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  return { page, context };
}
const shot = (page, name) => (out ? page.screenshot({ path: path.join(out, name + ".png") }) : Promise.resolve());
const tag = (hub) => (hub.name === "demo" ? "" : ` [${hub.name}]`);
const rgbOf = (s) => { const hex = s.trim().match(/^#([0-9a-f]{6})$/iu); if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)); return (s.match(/[\d.]+/gu) || []).slice(0, 3).map(Number); };

/* A PNG as Chromium writes a screenshot — 8-bit, non-interlaced, RGB or RGBA — decoded far enough to read its pixels. */
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString("ascii", pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (type !== 2 && type !== 6)) throw new Error(`png: unsupported (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  const bpp = type === 6 ? 4 : 3, stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  return { width, height, bpp, px };
}
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
/* The ground behind an element: its pixels averaged, and the brightest of them, from a screenshot taken with its ink made transparent. */
async function groundBehind(page, id) {
  const m = await page.evaluate((i) => { const el = document.getElementById(i); const r = el.getBoundingClientRect(); const color = getComputedStyle(el).color; el.style.color = "transparent"; return { x: r.x, y: r.y, w: r.width, h: r.height, color, shown: r.width > 0 && r.height > 0 }; }, id);
  if (!m.shown) return null;
  const png = decodePng(await page.screenshot({ clip: { x: m.x, y: m.y, width: Math.max(1, m.w), height: Math.max(1, m.h) } }));
  await page.evaluate((i) => { document.getElementById(i).style.color = ""; }, id);
  let r = 0, g = 0, b = 0, brightest = [0, 0, 0], top = -1;
  const n = png.width * png.height;
  for (let i = 0; i < n; i += 1) {
    const p = [png.px[i * png.bpp], png.px[i * png.bpp + 1], png.px[i * png.bpp + 2]];
    r += p[0]; g += p[1]; b += p[2];
    const l = lum(p); if (l > top) { top = l; brightest = p; }
  }
  const avg = [r / n, g / n, b / n];
  return { ink: rgbOf(m.color), avg, brightest, ratio: contrast(rgbOf(m.color), avg), worst: contrast(rgbOf(m.color), brightest) };
}

// ── 1. axe on every page × theme × width ───────────────────────────────
await section("axe-core WCAG 2.2 AA", async () => {
  for (const hub of hubs) {
    const runs = hub.name === "demo" ? [[1440, "dark"], [1440, "light"], [390, "dark"], [390, "light"], [1280, "dark"]] : [[1440, "dark"], [1440, "light"]];
    for (const [width, theme] of runs) {
      for (const view of ["console", "projects", "team"]) {
        if (width === 1280 && view !== "console") continue;
        const { page, context, errors } = await open(width, theme, view, { hub });
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
        const v = r.violations.map((x) => `${x.id}×${x.nodes.length} (${x.nodes[0]?.target?.[0]})`);
        if (v.length) fail(`${view} ${width} ${theme}${tag(hub)}: ${v.join(", ")}`); else ok(`${view} ${width} ${theme}${tag(hub)}`);
        if (errors.length) fail(`${view} ${width} ${theme}${tag(hub)}: console errors: ${errors.slice(0, 2).join(" | ")}`);
        if (hub.name === "demo") await shot(page, `${view}-${width}-${theme}`);
        await context.close();
      }
    }
  }
  for (const width of [1440, 390]) for (const theme of ["dark", "light"]) {
    const { page, context } = await openJoin(width, theme, "#AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const v = r.violations.map((x) => `${x.id}×${x.nodes.length}`);
    if (v.length) fail(`join ${width} ${theme}: ${v.join(", ")}`); else ok(`join ${width} ${theme}`);
    const info = await (await fetch(reportingBase(hubs[0]) + "/api/join/info")).json();
    const stamped = await page.evaluate(() => { const s = document.getElementById("demoStamp"); return Boolean(s) && !s.hidden; });
    if (stamped !== Boolean(info.demo)) fail(`join ${width} ${theme}: DEMO stamp ${stamped ? "shown" : "hidden"} while /api/join/info says demo:${info.demo}`); else ok(`join ${width} ${theme}: DEMO stamp follows /api/join/info (demo:${info.demo})`);
    const circles = await page.evaluate(() => document.querySelectorAll(".cap .n").length);
    if (circles) fail(`join ${width} ${theme}: numbered step circles`);
    await shot(page, `join-${width}-${theme}`);
    await context.close();
    // a link without a join code: Copy is out and says why, and is not drawn in the accent as if it were live; the box says what is missing
    const bare = await openJoin(width, theme);
    // the box says what is missing — on a demonstration the one warn line is the demonstration's (R3-13), never two states at once
    const noCode = await bare.page.evaluate(() => { const b = document.getElementById("copyBtn"); const s = getComputedStyle(b); const warn = ["noCode", "demoNote"].filter((id) => !document.getElementById(id).hidden); return { disabled: b.disabled, title: b.title, cmd: document.getElementById("cmd").textContent, warn, bg: s.backgroundColor, opacity: parseFloat(s.opacity), accent: getComputedStyle(document.documentElement).getPropertyValue("--cobalt") }; });
    const expectWarn = info.demo ? "demoNote" : "noCode";
    if (!noCode.disabled || !/nothing to copy/iu.test(noCode.title) || noCode.warn.join() !== expectWarn || noCode.cmd === "—") fail(`join ${width} ${theme}: a link without a code leaves a live Copy or two warn lines (${JSON.stringify(noCode)})`); else ok(`join ${width} ${theme}: no code → Copy disabled with its reason, one warn line (${expectWarn})`);
    const accentFill = rgbOf(noCode.bg).join(",") === rgbOf(noCode.accent).join(",");
    if (accentFill || noCode.opacity < 1) fail(`join ${width} ${theme}: the disabled Copy is still drawn as the primary action (${noCode.bg} at opacity ${noCode.opacity})`); else ok(`join ${width} ${theme}: the disabled Copy is drawn out, not in the accent`);
    await bare.context.close();
  }
});

// ── 1b. the strip's ink over the artwork ────────────────────────────────
await section("strip contrast over the artwork", async () => {
  for (const width of [1440, 1920]) for (const theme of ["dark", "light"]) {
    const { page, context } = await open(width, theme);
    for (const id of ["clockDate", "scanNote"]) {
      const g = await groundBehind(page, id);
      if (!g) { ok(`#${id} ${width} ${theme}: not shown at this width`); continue; }
      const say = `#${id} ${width} ${theme}: ${g.ratio.toFixed(2)}:1 over its ground on average (rgb ${g.avg.map(Math.round).join(",")}), ${g.worst.toFixed(2)}:1 over its brightest pixel`;
      if (g.ratio < 4.5) fail(say + " — below 4.5"); else ok(say);
    }
    await context.close();
  }
});

// ── 2. label in name ────────────────────────────────────────────────────
await section("label in name", async () => {
  const { page, context } = await open(1440, "dark");
  const names = await page.evaluate(() => ["unitBtn", "voidBtn", "motionBtn"].map((id) => { const b = document.getElementById(id); return [id, b.textContent.trim(), b.getAttribute("aria-label") || "", b.getAttribute("aria-pressed")]; }));
  for (const [id, text, label, pressed] of names) {
    const visible = text.replace(/\s*⇄\s*$/u, "").toLowerCase();
    if (!label.toLowerCase().includes(visible)) fail(`${id}: visible "${text}" is not in its name "${label}"`); else ok(`${id}: "${label}"${pressed !== null ? ` · aria-pressed=${pressed}` : ""}`);
    if ((id === "voidBtn" || id === "motionBtn") && pressed === null) fail(`${id} has no aria-pressed`);
  }
  await page.click("#voidBtn"); await page.click("#motionBtn");
  const after = await page.evaluate(() => ["voidBtn", "motionBtn"].map((id) => [id, document.getElementById(id).getAttribute("aria-label"), document.getElementById(id).getAttribute("aria-pressed")]));
  for (const [id, label, pressed] of after) if (/hide|resume/iu.test(label)) fail(`${id} renames itself when pressed ("${label}"); it should keep one name and set aria-pressed (${pressed})`); else ok(`${id} keeps its name when pressed (aria-pressed=${pressed})`);
  await context.close();
});

// ── 3. composition ──────────────────────────────────────────────────────
await section("composition", async () => {
  const MIN_ROWS = { 1920: 8, 1440: 8, 1280: 8, 1024: 6 };
  for (const hub of hubs) {
    for (const width of [1920, 1440, 1280, 1024]) {
      const { page, context } = await open(width, "dark", "console", { hub });
      const m = await page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect();
        const canvas = document.getElementById("consoleCanvas"), band2 = document.getElementById("band2"), strip = document.getElementById("foldStrip"), foot = document.querySelector("#consoleCanvas .lfoot"), head = document.querySelector("#consoleCanvas .lhead"), card = document.querySelector("#consoleCanvas .lanes");
        const c = r(canvas);
        const lanes = [...document.querySelectorAll("#cLanes .lane")];
        const rowH = lanes.length ? r(lanes[0]).height : 26;
        // rows drawn whole between the lanes' header and their footer — the footer never sits on a row
        const rows = lanes.filter((l) => { const b = r(l); return b.height > 0 && b.top >= r(head).bottom - 1 && b.bottom <= r(foot).top + 1; }).length;
        // the room the canvas gives the pane for rows, whether the card takes it all or hugs its rows and leaves the rest to the tray
        const cs = getComputedStyle(canvas);
        const room = Math.floor((canvas.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - (parseFloat(cs.rowGap) || 0) - r(strip).height - r(head).height - r(foot).height) / rowH);
        // nothing stands empty under the last thing drawn in the pane: the last row, the cold hairline, or the void that fills it
        const drawn = [...document.querySelectorAll("#cLanes > *")].filter((x) => r(x).height > 0);
        const last = drawn[drawn.length - 1];
        const under = Math.round(r(foot).top - (last ? r(last).bottom : r(head).bottom));
        const caps = [...document.querySelectorAll(".cap, .mhead")].filter((x) => x.checkVisibility()).map((x) => [x.textContent.replace(/\s+/gu, " ").trim().slice(0, 40), Math.round(r(x).height)]).filter(([, h]) => h > 24);
        // the Attention card's timeline and its axis sit whole inside the card's padding, and each legend item is one line
        const att = document.getElementById("attention"), ax = att.querySelector(".astrip .bx");
        const axisWhole = !ax || getComputedStyle(att.querySelector(".astrip")).display === "none" || (r(ax).bottom <= r(att).bottom - 6 && r(ax).top >= r(att).top && [...ax.children].every((s) => r(s).height <= 20));
        const legendLines = [...document.querySelectorAll("#specLegend span")].filter((s) => s.checkVisibility()).map((s) => Math.round(r(s).height)).filter((h) => h > 20);
        // nothing stands bare between the fold strip and the status bar (R3-02): a fold opens in the room or the lanes card keeps it
        const stripGap = Math.round(r(document.querySelector("footer.foot")).top - r(strip).bottom);
        // the Attention card draws only whole rows, and its hero's line is one line with nothing cut mid-word (R3-07)
        const list = document.getElementById("attnList"), lb = r(list);
        const cutRows = [...list.children].filter((x) => !x.hidden && r(x).height > 0 && (r(x).bottom > lb.bottom + 1 || r(x).top < lb.top - 1)).length;
        const line = document.getElementById("attnLine");
        const attnLine = { whole: line.scrollHeight <= line.clientHeight + 1, fits: line.scrollWidth <= line.clientWidth + 1, text: line.textContent.trim().slice(0, 60) };
        // every summary on the fold strip shows a reading or a reason (R3-08): never a bare label
        const emptyFs = [...document.querySelectorAll(".foldstrip .fs")].filter((x) => x.checkVisibility() && !x.innerText.trim()).map((x) => x.id);
        return { rows, room, drawn: lanes.length, under, hug: card.classList.contains("hug"), voidfill: Boolean(document.querySelector("#cLanes .empty.voidfill")), cold: document.querySelectorAll("#cLanes .lane.cold").length,
          band2: r(band2).height, stripVisible: r(strip).top >= c.top && r(strip).bottom <= c.bottom + 1, docScroll: document.documentElement.scrollHeight > innerHeight + 1,
          foot: Math.round(r(document.querySelector("footer.foot")).height), caps, attention: document.getElementById("attention").classList.contains("hot"), axisWhole, legendLines, stripGap, cutRows, attnLine, emptyFs };
      });
      if (m.stripGap > 48) fail(`console ${width}${tag(hub)}: ${m.stripGap}px of bare tray between the fold strip and the status bar (max 48)`); else ok(`console ${width}${tag(hub)}: ${m.stripGap}px between the fold strip and the status bar`);
      if (m.cutRows) fail(`console ${width}${tag(hub)}: ${m.cutRows} Attention row(s) drawn cut by the list's edge`); else ok(`console ${width}${tag(hub)}: only whole Attention rows are drawn`);
      if (!m.attnLine.whole || (width >= 1440 && !m.attnLine.fits)) fail(`console ${width}${tag(hub)}: the Attention hero's line does not fit ("${m.attnLine.text}")`); else ok(`console ${width}${tag(hub)}: the Attention hero's line is one whole line`);
      if (m.emptyFs.length) fail(`console ${width}${tag(hub)}: fold summaries with no visible text: ${m.emptyFs.join(", ")}`); else ok(`console ${width}${tag(hub)}: every fold summary shows its reading or its reason`);
      if (!m.axisWhole) fail(`console ${width}${tag(hub)}: the Attention timeline's axis is cut by the card's edge`); else ok(`console ${width}${tag(hub)}: the Attention timeline's axis is whole inside the card`);
      if (m.legendLines.length) fail(`console ${width}${tag(hub)}: ${m.legendLines.length} spend legend item(s) wrap mid-item`); else ok(`console ${width}${tag(hub)}: every spend legend item is one line`);
      const need = Math.min(MIN_ROWS[width], m.drawn);
      if (m.rows < need || m.room < MIN_ROWS[width]) fail(`console ${width}${tag(hub)}: ${m.rows} of ${m.drawn} lane rows drawn whole above the footer, room for ${m.room} (need ${MIN_ROWS[width]}; attention ${m.attention ? "hot" : "quiet"})`); else ok(`console ${width}${tag(hub)}: ${m.rows} of ${m.drawn} lane rows whole (${m.cold} cold), room for ${m.room} (attention ${m.attention ? "hot" : "quiet"})`);
      if (m.under > 48) fail(`console ${width}${tag(hub)}: ${m.under}px stand empty under the last row (max 48)`); else ok(`console ${width}${tag(hub)}: ${m.under}px under the last row${m.hug ? " · the card hugs its rows" : m.voidfill ? " · the void fills the pane" : ""}`);
      const maxBand2 = width <= 1280 ? 72 : 200;
      if (m.band2 > maxBand2) fail(`console ${width}${tag(hub)}: band2 is ${Math.round(m.band2)}px (max ${maxBand2})`); else ok(`console ${width}${tag(hub)}: band2 ${Math.round(m.band2)}px`);
      if (!m.stripVisible) fail(`console ${width}${tag(hub)}: the fold summaries strip is not in frame without scrolling`);
      if (m.docScroll) fail(`console ${width}${tag(hub)}: the document scrolls`);
      if (m.foot > 32) fail(`console ${width}${tag(hub)}: the status bar is ${m.foot}px (max 32)`); else ok(`console ${width}${tag(hub)}: status bar ${m.foot}px`);
      if (width <= 1280 && m.caps.length) fail(`console ${width}${tag(hub)}: captions taller than one line: ${m.caps.map(([t, h]) => `"${t}" ${h}px`).join("; ")}`); else if (width <= 1280) ok(`console ${width}${tag(hub)}: every caption is one line`);
      await context.close();
    }
    for (const width of [1440, 1920]) for (const view of ["projects", "team"]) {
      const { page, context } = await open(width, "dark", view, { hub });
      const g = await page.evaluate((v) => {
        const canvas = document.getElementById(v === "team" ? "teamCanvas" : "projCanvas");
        const sections = [...canvas.children].filter((s) => s.getBoundingClientRect().height > 0);
        const last = sections[sections.length - 1];
        const rowsBottom = Math.max(...[...last.querySelectorAll("tr, .lane, .invite, .alert-row, .none, .note, .foldbody")].map((x) => x.getBoundingClientRect().bottom), last.getBoundingClientRect().top);
        const frame = Math.min(canvas.getBoundingClientRect().bottom, innerHeight);
        return { tile: Math.max(0, Math.round(Math.min(last.getBoundingClientRect().bottom, frame) - rowsBottom)), under: Math.max(0, Math.round(innerHeight - document.querySelector("footer.foot").getBoundingClientRect().height - last.getBoundingClientRect().bottom)), docScroll: document.documentElement.scrollHeight > innerHeight + 1 };
      }, view);
      if (g.tile > 48) fail(`${view} ${width}${tag(hub)}: ${g.tile}px of empty tile under the last row`); else ok(`${view} ${width}${tag(hub)}: ${g.tile}px under the last row`);
      if (g.under > SIZES[width][1] / 4) fail(`${view} ${width}${tag(hub)}: ${g.under}px of frame under the last card (max a quarter)`);
      if (g.docScroll) fail(`${view} ${width}${tag(hub)}: the document scrolls`);
      await context.close();
    }
  }
});

// ── 4. clipped text ─────────────────────────────────────────────────────
await section("clipping", async () => {
  const CLIP = ".pr b, .pr em, .mn .txt, .do, .mhead, .mhead span, .lhead span, .hc, .aline, .dv, .fs, .foldrow .fs, .count, .lane .md .mname, .cap, .capr, .bx span, .kv .s, .kv .l, .tline, .afoot, .xn b, .xn em, .speclegend span, .astrip .bx span, .ahead, .arow b em, .status .sh, .status .lk, #attnLine, #attnHead, .floorline";
  for (const hub of hubs) for (const width of hub.name === "demo" ? [360, 390, 1024, 1280, 1440] : [1024, 1440]) {
    for (const view of ["console", "projects", "team"]) {
      const { page, context } = await open(width, "dark", view, { hub, period: hub.name === "demo" ? null : "30d" });
      const r = await page.evaluate((sel) => {
        const bad = [];
        for (const el of document.querySelectorAll(sel)) {
          if (!el.checkVisibility || !el.checkVisibility()) continue;
          if (el.classList.contains("visually-hidden")) continue;   // a 1px box for screen readers, by design
          const mono = /mono/iu.test(getComputedStyle(el).fontFamily);
          if (mono && !el.classList.contains("mname")) continue;
          if (el.scrollWidth > el.clientWidth + 1) {
            const title = el.closest("[title]")?.getAttribute("title") || "";
            if (!title || !title.includes(el.textContent.replace(/\s+/gu, " ").trim().slice(0, 12))) bad.push(`${el.className || el.tagName}: "${el.textContent.trim().slice(0, 40)}"`);
          }
        }
        // the "24 h" group label over the four day columns sits whole inside its header: nothing of it above the header's top edge or below its line
        const grp = [];
        for (const head of document.querySelectorAll(".lhead")) {
          const g = head.querySelector(".grp"), s = g && g.querySelector("span");
          if (!g || !s || !g.checkVisibility()) continue;
          const hr = head.getBoundingClientRect(), sr = s.getBoundingClientRect();
          if (sr.top < hr.top - .5 || sr.bottom > hr.bottom + .5 || g.scrollHeight > g.offsetHeight + 1) grp.push(`"${s.textContent.trim()}" top ${Math.round(sr.top - hr.top)} bottom ${Math.round(hr.bottom - sr.bottom)} in a ${Math.round(hr.height)}px header`);
        }
        const small = Math.min(...[...document.querySelectorAll("body *")].filter((e) => e.checkVisibility() && e.textContent.trim() && !e.classList.contains("visually-hidden") && !e.closest("dialog")).map((e) => parseFloat(getComputedStyle(e).fontSize)));
        return { bad: bad.slice(0, 6), grp, hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth, small };
      }, CLIP);
      if (r.bad.length) fail(`${view} ${width}${tag(hub)}: clipped without a title: ${r.bad.join("; ")}`); else ok(`${view} ${width}${tag(hub)}: nothing clipped without its whole on hover`);
      if (r.grp.length) fail(`${view} ${width}${tag(hub)}: the day group label is cut by its header: ${r.grp.join("; ")}`); else if (view !== "team" && width >= 1024) ok(`${view} ${width}${tag(hub)}: the "24 h" group label is whole inside its header`);
      if (r.small < 12) fail(`${view} ${width}${tag(hub)}: text at ${r.small}px (floor 12)`);
      if (width === 360 && r.hScroll) fail(`${view} 360 scrolls sideways`); else if (width === 360) ok(`${view} 360: no sideways scroll`);
      await context.close();
    }
  }
  // nothing below 12px with a sheet open, either
  for (const width of [1440, 390]) {
    const { page, context } = await open(width, "dark");
    await page.evaluate(() => document.getElementById("addBtn").click());
    await page.waitForTimeout(400);
    const small = await page.evaluate(() => Math.min(...[...document.querySelectorAll("#addDialog *")].filter((e) => e.checkVisibility() && e.textContent.trim()).map((e) => parseFloat(getComputedStyle(e).fontSize))));
    if (small < 12) fail(`add-a-machine sheet ${width}: text at ${small}px (floor 12)`); else ok(`add-a-machine sheet ${width}: smallest text ${small}px`);
    await shot(page, `sheet-add-${width}-dark`);
    await context.close();
  }
  // an inspector's session rows: a forty-character project name gives way inside its own cell with its whole on hover, and no cell runs under its neighbour
  for (const width of [1440, 390]) {
    const { page, context } = await open(width, "dark", "team");
    const opened = await page.evaluate(() => { const b = document.querySelector("#peopleTable .rowbtn"); if (!b) return false; b.click(); return true; });
    if (!opened) { fail(`person inspector ${width}: no person row to open`); await context.close(); continue; }
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#inspectBody .irow")].filter((x) => x.checkVisibility());
      if (!rows.length) return { none: true };
      const LONG = "a-forty-character-project-name-for-probe";
      const b = rows[0].querySelector(".nm b, b");
      if (b) { b.textContent = LONG; rows[0].title = (rows[0].title ? rows[0].title + " · " : "") + LONG; }
      const bad = [];
      for (const row of rows) {
        // two cells on the same line never overlap; a cell the phone layout moves to a line of its own is not "under" the one before it
        const cells = [...row.children].filter((c) => c.checkVisibility());
        for (let i = 1; i < cells.length; i += 1) {
          const a = cells[i - 1].getBoundingClientRect(), b = cells[i].getBoundingClientRect();
          const sameLine = a.bottom > b.top + 1 && a.top < b.bottom - 1;
          if (sameLine && a.right > b.left + 1) bad.push(`"${cells[i - 1].textContent.trim().slice(0, 24)}" runs under "${cells[i].textContent.trim().slice(0, 16)}"`);
        }
        for (const el of row.querySelectorAll("*")) {
          if (!el.checkVisibility() || !el.textContent.trim()) continue;
          if (el.scrollWidth > el.clientWidth + 1) {
            const title = el.closest("[title]")?.getAttribute("title") || "";
            if (!title.includes(el.textContent.replace(/\s+/gu, " ").trim().slice(0, 12))) bad.push(`${el.className || el.tagName}: "${el.textContent.trim().slice(0, 40)}" clipped without its whole on hover`);
          }
        }
      }
      // a twenty-four-character name keeps its cell whole beside its branch (R3-05): only the branch gives way
      const short = "twenty-four-char-project";
      let kept = null;
      if (b) { b.textContent = short; kept = b.scrollWidth <= b.clientWidth + 1; }
      return { rows: rows.length, bad: bad.slice(0, 5), gaveWay: b ? b.scrollWidth > b.clientWidth : null, kept };
    });
    if (r.none) fail(`person inspector ${width}: no session rows to check`);
    else if (r.bad.length) fail(`person inspector ${width}: ${r.bad.join("; ")}`);
    else ok(`person inspector ${width}: ${r.rows} rows keep every cell in its place, a forty-character name ${r.gaveWay ? "giving way with its whole on hover" : "fitting whole"}`);
    if (r.kept === false) fail(`person inspector ${width}: a twenty-four-character project name is cut inside its cell`); else if (r.kept) ok(`person inspector ${width}: a twenty-four-character name keeps its cell whole`);
    await shot(page, `sheet-person-long-${width}-dark`);
    await context.close();
  }
  // a lane's name alone in its cell keeps the whole cell (R3-04): a twenty-four-character name with no branch is never cut at 1440 or 1920
  for (const width of [1440, 1920]) {
    const { page, context } = await open(width, "dark");
    const r = await page.evaluate(() => {
      const row = document.querySelector("#cLanes .lane");
      if (!row) return null;
      const pr = row.querySelector(".pr"), b = pr.querySelector("b"), em = pr.querySelector("em");
      b.textContent = "twenty-four-char-project"; if (em) em.textContent = ""; pr.classList.remove("branched");
      const alone = b.scrollWidth <= b.clientWidth + 1;
      b.textContent = "twenty-four-char-project"; if (em) em.textContent = "feat/branch"; pr.classList.add("branched");
      return { alone, cap: Math.round(parseFloat(getComputedStyle(b).maxWidth) || 0), cell: Math.round(pr.clientWidth) };
    });
    if (!r) fail(`lanes ${width}: no lane row to probe`);
    else if (!r.alone) fail(`lanes ${width}: a twenty-four-character project name with no branch is cut inside a ${r.cell}px cell`); else ok(`lanes ${width}: a twenty-four-character name alone keeps its ${r.cell}px cell`);
    await context.close();
  }
});

// ── 5. keyboard ─────────────────────────────────────────────────────────
await section("keyboard", async () => {
  const { page, context } = await open(1440, "dark");
  await page.keyboard.press("j");
  await page.waitForTimeout(150);
  const first = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("lane") ? document.activeElement.dataset.key : null);
  await page.keyboard.press("j");
  await page.waitForTimeout(150);
  const second = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("lane") ? document.activeElement.dataset.key : null);
  await page.keyboard.press("k");
  await page.waitForTimeout(150);
  const back = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("lane") ? document.activeElement.dataset.key : null);
  if (!first || !second || first === second || back !== first) fail(`J/K do not move DOM focus across rows (${first}, ${second}, ${back})`); else ok("J/K move DOM focus onto the rows");
  // five more presses land on five consecutive rows, none skipped, and the focus is still on that row after two polls with no key pressed (R3-01)
  const order = await page.evaluate(() => [...document.querySelectorAll("#cLanes .lane")].map((r) => r.dataset.key));
  const walk = [];
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("j");
    await page.waitForTimeout(150);
    walk.push(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("lane") ? document.activeElement.dataset.key : null));
  }
  await page.waitForTimeout(4600);
  const held = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("lane") ? document.activeElement.dataset.key : (document.activeElement && document.activeElement.tagName) || null);
  const consecutive = walk.every((k, i) => k && order.indexOf(k) === Math.min(order.length - 1, order.indexOf(first) + 1 + i));
  if (!consecutive) fail(`J skips rows or loses focus across polls: ${walk.map((k) => (k ? order.indexOf(k) : "BODY")).join(" → ")} from row ${order.indexOf(first)}`); else ok(`five J presses land on five consecutive rows (${walk.map((k) => order.indexOf(k)).join(" → ")})`);
  if (held !== walk[4]) fail(`the focused row is on ${held} 4.6 s later with no key pressed`); else ok("the focused row keeps DOM focus through two polls");
  for (let i = 0; i < 5; i += 1) { await page.keyboard.press("k"); await page.waitForTimeout(120); }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => document.getElementById("inspectDialog").open);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const returned = await page.evaluate((k) => document.activeElement && document.activeElement.classList.contains("lane") && document.activeElement.dataset.key === k, first);
  if (!opened) fail("Enter on a focused row does not open its inspector"); else ok("Enter opens the row's inspector");
  if (!returned) fail("closing the inspector opened with Enter does not return focus to the row"); else ok("closing the sheet returns focus to the row it was opened from with Enter");
  // a machine row opens its inspector; five seconds later (two repaints) Escape still lands on that machine's row
  const machine = await page.evaluate(() => { const r = document.querySelector("#cMachines .xrow[data-inspect]"); r.focus(); r.click(); return r.dataset.inspect; });
  await page.waitForTimeout(5200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const backOn = await page.evaluate(() => document.activeElement && document.activeElement.closest("#cMachines") && document.activeElement.dataset.inspect);
  if (backOn !== machine) fail(`closing the machine inspector after 5 s leaves focus on ${backOn || "BODY"}, not ${machine}`); else ok("closing the machine inspector after 5 s returns focus to the band's machine row");
  // the context button opens the lane inspector at its Context section; Escape after 5 s returns to that button
  const ctx = await page.evaluate(() => { const b = document.querySelector("#cLanes .lane .cx button"); b.focus(); b.click(); return b.closest(".lane").dataset.key; });
  await page.waitForTimeout(600);
  const landed = await page.evaluate(() => { const d = document.getElementById("inspectDialog"); const h = document.getElementById("inspectContext"); if (!d.open || !h) return null; const r = h.getBoundingClientRect(); return { open: d.open, top: Math.round(r.top), visible: r.top >= 0 && r.top < innerHeight, hash: location.hash }; });
  if (!landed || !landed.visible || !/\/context$/u.test(landed.hash)) fail(`the context button does not open the inspector at its Context section (${JSON.stringify(landed)})`); else ok(`the context button opens the lane inspector at Context (${landed.hash})`);
  await page.waitForTimeout(5200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const ctxBack = await page.evaluate(() => { const a = document.activeElement; return a && a.closest(".cx") ? a.closest(".lane").dataset.key : null; });
  if (ctxBack !== ctx) fail(`closing the context inspector after 5 s leaves focus on ${await page.evaluate(() => document.activeElement.tagName)}, not the lane's context button`); else ok("closing the context inspector after 5 s returns focus to the context button");
  // the palette: combobox, listbox, active descendant, announced option
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(300);
  const pal = await page.evaluate(() => { const q = document.getElementById("palq"); const on = document.getElementById(q.getAttribute("aria-activedescendant")); return { role: q.getAttribute("role"), controls: q.getAttribute("aria-controls"), expanded: q.getAttribute("aria-expanded"), auto: q.getAttribute("aria-autocomplete"), listbox: document.getElementById("palres").getAttribute("role"), tab: document.getElementById("palres").getAttribute("tabindex"), active: on ? on.getAttribute("role") + ":" + on.textContent.trim().slice(0, 20) : null }; });
  if (pal.role !== "combobox" || pal.controls !== "palres" || pal.expanded !== "true" || pal.auto !== "list" || pal.listbox !== "listbox" || pal.tab !== "-1" || !pal.active) fail(`palette a11y: ${JSON.stringify(pal)}`); else ok(`palette: combobox → listbox, active ${pal.active}`);
  await page.keyboard.press("ArrowDown");
  const moved = await page.evaluate(() => document.getElementById(document.getElementById("palq").getAttribute("aria-activedescendant"))?.textContent.trim().slice(0, 20));
  const snapshot = await page.locator("#pal").ariaSnapshot();
  if (!/combobox/u.test(snapshot) || !/listbox/u.test(snapshot) || !/option/u.test(snapshot)) fail("the palette's accessibility tree lacks combobox/listbox/option"); else ok(`palette accessibility tree: combobox, listbox, options; highlighted "${moved}"`);
  await page.keyboard.press("Escape");
  await context.close();
  // Team: a people row and a machine row opened by click; five seconds later Escape lands on the same row's handle inside the same table,
  // never on the band's row for the same person and never on the body
  const team = await open(1440, "dark", "team");
  for (const [table, what] of [["#peopleTable", "person"], ["#machineTable", "machine"]]) {
    const key = await team.page.evaluate((t) => { const tr = document.querySelector(`${t} tbody tr[data-inspect]`); if (!tr) return null; const h = tr.querySelector(".rowbtn"); if (h) h.focus(); tr.click(); return tr.dataset.inspect; }, table);
    if (!key) { fail(`team: no ${what} row to open`); continue; }
    await team.page.waitForTimeout(5200);
    const still = await team.page.evaluate(() => document.getElementById("inspectDialog").open);
    await team.page.keyboard.press("Escape");
    // past the next poll's repaint of the table: the focus must survive the row being rebuilt, not only land on it
    await team.page.waitForTimeout(2600);
    const landed = await team.page.evaluate((t) => { const a = document.activeElement; const tr = a && a.closest("tr"); return { key: tr && tr.closest(t) ? tr.dataset.inspect : null, on: a ? a.tagName + (a.id ? "#" + a.id : "") + (a.className ? "." + String(a.className).split(" ")[0] : "") : "none" }; }, table);
    if (!still) fail(`team: the ${what} row's inspector did not open`);
    else if (landed.key !== key) fail(`team: closing the ${what} inspector after 5 s leaves focus on ${landed.on}, not the ${table} row that opened it`);
    else ok(`team: closing the ${what} inspector after 5 s returns focus to its row in ${table}`);
  }
  await team.context.close();
  // 390: every row by Tab, opens on Enter
  const phone = await open(390, "dark");
  const reach = await phone.page.evaluate(async () => {
    const rows = [...document.querySelectorAll("#cLanes .lane")];
    return { rows: rows.length, tabbable: rows.filter((r) => r.tabIndex === 0).length, role: rows.every((r) => r.getAttribute("role") === "button" && r.getAttribute("aria-label")), strip: getComputedStyle(document.getElementById("foldStrip")).display, rowsSummaries: [...document.querySelectorAll(".foldrow .fs")].every((x) => x.textContent.trim().length > 0) };
  });
  if (reach.rows === 0 || reach.tabbable !== reach.rows || !reach.role) fail(`390: ${reach.tabbable} of ${reach.rows} rows are in the tab order as named buttons`); else ok(`390: all ${reach.rows} rows are named buttons in the tab order`);
  if (reach.strip !== "none" || !reach.rowsSummaries) fail(`390: the fold strip shows beside the fold rows (${reach.strip}), or a fold row has no summary`); else ok("390: the fold rows alone carry the summaries");
  await phone.page.focus("#cLanes .lane");
  await phone.page.keyboard.press("Enter");
  await phone.page.waitForTimeout(400);
  const phoneOpened = await phone.page.evaluate(() => document.getElementById("inspectDialog").open);
  if (!phoneOpened) fail("390: Enter on a row does not open it"); else ok("390: Enter opens the row");
  await phone.context.close();
});

// ── 6. presenting ───────────────────────────────────────────────────────
await section("presenting", async () => {
  const ticket = await signInUrl(hubs[0]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(ticket, { waitUntil: "domcontentloaded" });
  await page.goto(hubs[0].base + "/", { waitUntil: "domcontentloaded" });
  await settled(page);
  const payload = await page.evaluate(async () => (await fetch("/api/console", { headers: { "x-agent-console": "1" } })).json());
  const names = new Set();
  for (const l of payload.lanes) { if (l.project?.name) names.add(l.project.name); if (l.branch) names.add(l.branch); }
  for (const d of payload.devices) { names.add(d.label); if (d.person) names.add(d.person); }
  for (const p of payload.people || []) names.add(p.person);
  for (const u of payload.hub.urls || []) { try { names.add(new URL(u).host); } catch {} }
  const pattern = (n) => new RegExp(`(^|[^A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([^A-Za-z0-9]|$)`, "u");
  for (const view of ["console", "team", "projects"]) {
    await page.goto(hubs[0].base + "/", { waitUntil: "domcontentloaded" });
    await settled(page);
    await page.waitForTimeout(1200);
    if (view !== "console") { await page.evaluate((v) => document.querySelector(`.tab[data-view="${v}"]`).click(), view); await page.waitForTimeout(1200); }
    await page.keyboard.press("p");
    await page.waitForTimeout(900);
    // what a viewer, a screen reader or the page source can meet: every text node, every title, every label and every attribute value that
    // is not markup of its own (class, id, style, geometry) — the add form's example placeholders are the static page, not the hub's names
    const dom = await page.evaluate(() => {
      const skip = new Set(["class", "id", "style", "d", "viewbox", "placeholder", "src", "for", "role", "type", "name", "points", "transform", "fill", "stroke", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "preserveaspectratio", "xmlns", "autocomplete", "list", "content", "http-equiv", "rel", "sizes", "lang", "charset", "media", "spellcheck", "inputmode", "enterkeyhint"]);
      const text = [], attrs = [];
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === 3) { if (!n.parentElement.closest("script, style")) text.push(n.textContent); continue; }
        for (const a of n.attributes) if (!skip.has(a.name.toLowerCase())) attrs.push(`${n.tagName.toLowerCase()}[${a.name}=${a.value}]`);
      }
      return { text: text.join("\n"), attrs, strip: document.getElementById("presentStamp").hidden ? "" : document.getElementById("presentStamp").textContent };
    });
    const leaked = [...names].filter((n) => n.length >= 3 && pattern(n).test(dom.text));
    if (leaked.length) fail(`${view}: presenting still shows ${leaked.slice(0, 5).join(", ")}`); else ok(`${view}: presenting hides every project, branch, machine, person and host name from the text (${names.size} checked)`);
    // the page source itself, hidden nodes and comments included (R3-09): no home path anywhere in the document (the names are held by the
    // walk above, which reads every text node and attribute whether or not it is shown; the source also holds the static page's own words)
    const outer = await page.evaluate(() => document.documentElement.outerHTML);
    const homePath = /\/(?:Users|home)\/[A-Za-z0-9._-]+\//u.test(outer) || outer.includes(process.env.HOME || "\u0000");
    if (homePath) fail(`${view}: the presented document's source still holds a home path`); else ok(`${view}: the presented document's source holds no home path (hidden nodes included)`);
    const inAttrs = [];
    for (const n of names) if (n.length >= 3) { const hit = dom.attrs.find((a) => pattern(n).test(a.slice(a.indexOf("=") + 1))); if (hit) inAttrs.push(`${n} in ${hit.slice(0, 60)}`); }
    if (inAttrs.length) fail(`${view}: presenting leaves a name in an attribute: ${inAttrs.slice(0, 4).join("; ")}`); else ok(`${view}: no name remains in any attribute (${dom.attrs.length} attribute values scanned)`);
    if (dom.strip !== "PRESENTING") fail(`${view}: the strip does not read PRESENTING`);
    await shot(page, `${view}-1440-dark-presenting`);
    // an inspector opened while presenting: its address carries a token, never a name; its title is a stand-in
    if (view === "team") {
      const person = payload.people?.[0]?.person;
      if (person) {
        await page.evaluate(() => document.querySelector("#peopleTable .rowbtn").click());
        await page.waitForTimeout(400);
        const addr = await page.evaluate(() => ({ hash: location.hash, title: document.getElementById("inspectTitle").textContent }));
        const leak = [...names].filter((n) => n.length >= 3 && (decodeURIComponent(addr.hash).includes(n) || addr.title.includes(n)));
        if (leak.length || !/^#team\/person\/[a-z0-9]{6}$/u.test(addr.hash)) fail(`team: presenting leaves ${leak.join(", ") || addr.hash} in the inspector's address or title (${addr.hash})`); else ok(`team: the presented inspector's address is a token (${addr.hash})`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
      // the add-a-machine sheet while presenting: no name in its people list, the restart command stepped back
      await page.evaluate(() => document.getElementById("addBtn").click());
      await page.waitForTimeout(400);
      const add = await page.evaluate(() => ({ options: document.getElementById("peopleList").children.length, cmd: getComputedStyle(document.getElementById("networkCmd")).visibility, text: document.getElementById("addDialog").textContent }));
      const addLeak = [...names].filter((n) => n.length >= 3 && add.text.includes(n));
      if (add.options || addLeak.length) fail(`team: the add-a-machine sheet shows ${add.options} people and ${addLeak.join(", ") || "no name"} while presenting`); else ok("team: the add-a-machine sheet names nobody while presenting");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
    await page.keyboard.press("p");
  }
  await context.close();
  // a console that listens on this machine only (any hub given with --also): its add-a-machine sheet carries the restart command, and while
  // presenting neither the account's home path nor the --name / --person values survive anywhere in the document (R3-09, R3-10)
  for (const hub of hubs.slice(1)) {
    const { page: p2, context: c2 } = await open(1440, "dark", "console", { hub });
    const cmd = await p2.evaluate(async () => (await (await fetch("/api/console", { headers: { "x-agent-console": "1" } })).json()).hub.networkCommand);
    if (!cmd) { ok(`${hub.name}: listens on the network already, no restart command to mask`); await c2.close(); continue; }
    await p2.evaluate(() => document.getElementById("addBtn").click());
    await p2.waitForTimeout(400);
    const plain = await p2.evaluate(() => document.getElementById("networkCmdShown").textContent);
    const home = process.env.HOME || "";
    if (home && plain.includes(home)) fail(`${hub.name}: the restart command shows the home directory (${home.replace(/[^/]+$/u, "…")})`); else ok(`${hub.name}: the restart command writes the home directory as ~`);
    await p2.keyboard.press("p");
    await p2.waitForTimeout(500);
    const values = [...cmd.matchAll(/--(?:name|person)(?:=|\s+)(?:'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+))/gu)].map((m) => m[1] ?? m[2] ?? m[3]).filter((v) => v && v.length >= 3);
    const outer = await p2.evaluate(() => document.documentElement.outerHTML);
    const left = values.filter((v) => outer.includes(v)).concat(home && outer.includes(home) ? ["the home path"] : []);
    if (left.length) fail(`${hub.name}: while presenting the document still holds ${left.length} of the command's names or the home path`); else ok(`${hub.name}: while presenting, the restart command's names and the home path are out of the document (${values.length} value(s) checked)`);
    await c2.close();
  }
});

await browser.close();
process.stdout.write(failures.length ? `\n${failures.length} bar(s) missed:\n${failures.map((f) => "  - " + f).join("\n")}\n` : "\nevery bar met\n");
process.stdout.write(`${checks} checks · ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
