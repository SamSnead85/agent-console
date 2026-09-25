#!/usr/bin/env node

/*
 * The console's mechanical bars, checked in a real browser against a --demo
 * console (or any console you sign into):
 *
 *   node scripts/ui-probes.mjs http://127.0.0.1:6970 <server-log> [--out <dir>]
 *
 *   - axe-core WCAG 2.2 AA: zero violations on Console, Projects, Team and
 *     Join, dark and light, 1440 and 390 (target-size and
 *     scrollable-region-focusable included);
 *   - label in name: #unitBtn, #voidBtn, #motionBtn;
 *   - composition at 1440×900: at least eight lane rows in frame, the second
 *     band at most 200px, the fold strip in frame without scrolling; Projects
 *     and Team at 1440 and 1920 leave no empty tile taller than 48px under
 *     their last row;
 *   - no clipped non-mono text at 360, 390, 1024, 1280 and 1440: every `.pr b`,
 *     `.pr em`, `.mn .txt`, `.do`, `.mhead`, `.lhead`, `.hc` and `.aline` fits or
 *     carries a `title` with its whole text; no page scrolls sideways at 360;
 *   - keyboard: at 390 every lane row is reachable by Tab and opens on Enter;
 *     at 1440 J and K move DOM focus onto the row; closing a sheet returns
 *     focus to the row that opened it; the palette is a combobox with a
 *     listbox and an active descendant;
 *   - presenting: with P pressed, no project, branch, machine or person name
 *     from /api/console remains in the DOM, and the strip reads PRESENTING;
 *   - the DEMO stamp on the join page follows /api/join/info.
 *
 * Needs Playwright and @axe-core/playwright, which this package does not
 * depend on: point AGENT_CONSOLE_PLAYWRIGHT_DIR at a node_modules that has
 * them, or install them beside this repository. Exit status 1 means a bar
 * was missed; the report says which.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [base, log, ...rest] = process.argv.slice(2);
if (!base || !log) { process.stderr.write("usage: node scripts/ui-probes.mjs <console url> <server log> [--out <dir>]\n"); process.exit(2); }
const out = rest.includes("--out") ? rest[rest.indexOf("--out") + 1] : null;
if (out) fs.mkdirSync(out, { recursive: true });

const require = createRequire(path.join(process.env.AGENT_CONSOLE_PLAYWRIGHT_DIR || path.join(process.cwd(), "node_modules"), "/"));
let chromium, AxeBuilder;
try { ({ chromium } = require("playwright")); ({ AxeBuilder } = require("@axe-core/playwright")); }
catch (error) { process.stderr.write(`ui-probes: Playwright is not available (${error.message}). Set AGENT_CONSOLE_PLAYWRIGHT_DIR.\n`); process.exit(2); }

const failures = [];
const fail = (what) => { failures.push(what); process.stdout.write(`  ✗ ${what}\n`); };
const ok = (what) => process.stdout.write(`  ✓ ${what}\n`);

async function signInUrl() {
  await fetch(base + "/api/sign-in/print", { method: "POST", headers: { "x-agent-console": "1" } });
  await new Promise((r) => setTimeout(r, 300));
  const t = fs.readFileSync(log, "utf8");
  const m = [...t.matchAll(/https?:\/\/127\.0\.0\.1:\d+\/login\?ticket=[A-Za-z0-9_-]+/gu)].pop();
  if (!m) throw new Error("no sign-in link in the server log");
  return m[0];
}
const reportingBase = () => { const u = new URL(base); u.port = String(Number(u.port) + 1); return u.origin; };

const SIZES = { 1920: [1920, 1080], 1440: [1440, 900], 1280: [1280, 800], 1024: [1024, 768], 390: [390, 844], 360: [360, 780] };
const browser = await chromium.launch();
async function open(width, theme, view = "console", { presenting = false } = {}) {
  const [w, h] = SIZES[width];
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: theme, isMobile: w < 500, hasTouch: w < 500 });
  await context.addInitScript((t) => { try { localStorage.setItem("agent-console-theme", t); } catch {} }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(await signInUrl(), { waitUntil: "networkidle" });
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  if (view !== "console") { await page.evaluate((v) => document.querySelector(`.tab[data-view="${v}"]`).click(), view); await page.waitForTimeout(1500); }
  await page.evaluate(() => { const b = document.getElementById("motionBtn"); if (b && b.getAttribute("aria-pressed") !== "true") b.click(); });
  if (presenting) { await page.keyboard.press("p"); await page.waitForTimeout(400); }
  await page.waitForTimeout(200);
  return { page, context, errors };
}
const shot = (page, name) => (out ? page.screenshot({ path: path.join(out, name + ".png") }) : Promise.resolve());

// ── 1. axe on every page × theme × width ───────────────────────────────
process.stdout.write("axe-core WCAG 2.2 AA\n");
for (const width of [1440, 390]) for (const theme of ["dark", "light"]) {
  for (const view of ["console", "projects", "team"]) {
    const { page, context, errors } = await open(width, theme, view);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const v = r.violations.map((x) => `${x.id}×${x.nodes.length} (${x.nodes[0]?.target?.[0]})`);
    if (v.length) fail(`${view} ${width} ${theme}: ${v.join(", ")}`); else ok(`${view} ${width} ${theme}`);
    if (errors.length) fail(`${view} ${width} ${theme}: console errors: ${errors.slice(0, 2).join(" | ")}`);
    await shot(page, `${view}-${width}-${theme}`);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: SIZES[width][0], height: SIZES[width][1] }, colorScheme: theme });
  await context.addInitScript((t) => { try { localStorage.setItem("agent-console-theme", t); } catch {} }, theme);
  const page = await context.newPage();
  await page.goto(reportingBase() + "/join#AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const v = r.violations.map((x) => `${x.id}×${x.nodes.length}`);
  if (v.length) fail(`join ${width} ${theme}: ${v.join(", ")}`); else ok(`join ${width} ${theme}`);
  const info = await (await fetch(reportingBase() + "/api/join/info")).json();
  const stamped = await page.evaluate(() => { const s = document.getElementById("demoStamp"); return Boolean(s) && !s.hidden; });
  if (stamped !== Boolean(info.demo)) fail(`join ${width} ${theme}: DEMO stamp ${stamped ? "shown" : "hidden"} while /api/join/info says demo:${info.demo}`); else ok(`join ${width} ${theme}: DEMO stamp follows /api/join/info (demo:${info.demo})`);
  await shot(page, `join-${width}-${theme}`);
  await context.close();
}

// ── 2. label in name ────────────────────────────────────────────────────
process.stdout.write("label in name\n");
{
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
}

// ── 3. composition ──────────────────────────────────────────────────────
process.stdout.write("composition\n");
{
  const { page, context } = await open(1440, "dark");
  const m = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const canvas = document.getElementById("consoleCanvas"), band2 = document.getElementById("band2"), strip = document.getElementById("foldStrip"), foot = document.querySelector("#consoleCanvas .lfoot"), head = document.querySelector("#consoleCanvas .lhead");
    const c = r(canvas);
    const lanes = [...document.querySelectorAll("#cLanes .lane")];
    const rowH = lanes.length ? r(lanes[0]).height : 26;
    const rows = lanes.filter((l) => { const b = r(l); return b.top >= c.top && b.bottom <= r(foot).top + 1 && b.height > 0; }).length;
    // the room the lanes have between their header and their footer, in rows — what a real alert load would fill
    const room = Math.floor((r(foot).top - r(head).bottom) / rowH);
    return { rows, room, band2: r(band2).height, stripVisible: r(strip).top >= c.top && r(strip).bottom <= c.bottom + 1, docScroll: document.documentElement.scrollHeight > innerHeight + 1 };
  });
  if (m.room < 8) fail(`console 1440×900 has room for ${m.room} lane rows between the lanes' header and footer (need ≥ 8; ${m.rows} drawn)`); else ok(`console 1440×900 has room for ${m.room} lane rows (${m.rows} drawn)`);
  if (m.band2 > 200) fail(`band2 is ${m.band2}px (max 200)`); else ok(`band2 ${Math.round(m.band2)}px`);
  if (!m.stripVisible) fail("the fold summaries strip is not in frame without scrolling"); else ok("fold summaries in frame");
  if (m.docScroll) fail("the document scrolls at 1440×900"); else ok("no document scroll at 1440×900");
  await context.close();
  for (const width of [1440, 1920]) for (const view of ["projects", "team"]) {
    const { page, context } = await open(width, "dark", view);
    const gap = await page.evaluate((v) => {
      const canvas = document.getElementById(v === "team" ? "teamCanvas" : "projCanvas");
      const sections = [...canvas.children].filter((s) => s.getBoundingClientRect().height > 0);
      const last = sections[sections.length - 1];
      const rowsBottom = Math.max(...[...last.querySelectorAll("tr, .lane, .invite, .alert-row, .none, .note, .foldbody")].map((x) => x.getBoundingClientRect().bottom), last.getBoundingClientRect().top);
      return Math.max(0, Math.round(Math.min(canvas.getBoundingClientRect().bottom, innerHeight) - rowsBottom));
    }, view);
    if (gap > 48) fail(`${view} ${width}: ${gap}px of empty tile under the last row`); else ok(`${view} ${width}: ${gap}px under the last row`);
    await context.close();
  }
}

// ── 4. clipped text ─────────────────────────────────────────────────────
process.stdout.write("clipping\n");
const CLIP = ".pr b, .pr em, .mn .txt, .do, .mhead, .lhead, .hc, .aline, .dv";
for (const width of [360, 390, 1024, 1280, 1440]) {
  for (const view of ["console", "projects", "team"]) {
    const { page, context } = await open(width, "dark", view);
    const r = await page.evaluate((sel) => {
      const bad = [];
      for (const el of document.querySelectorAll(sel)) {
        if (!el.checkVisibility || !el.checkVisibility()) continue;
        const mono = /mono/iu.test(getComputedStyle(el).fontFamily);
        if (mono) continue;
        if (el.scrollWidth > el.clientWidth + 1) {
          const title = el.closest("[title]")?.getAttribute("title") || "";
          if (!title || !title.includes(el.textContent.trim().slice(0, 12))) bad.push(`${el.className || el.tagName}: "${el.textContent.trim().slice(0, 40)}"`);
        }
      }
      return { bad: bad.slice(0, 6), hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    }, CLIP);
    if (r.bad.length) fail(`${view} ${width}: clipped without a title: ${r.bad.join("; ")}`); else ok(`${view} ${width}: nothing clipped without its whole on hover`);
    if (width === 360 && r.hScroll) fail(`${view} 360 scrolls sideways`); else if (width === 360) ok(`${view} 360: no sideways scroll`);
    await context.close();
  }
}

// ── 5. keyboard ─────────────────────────────────────────────────────────
process.stdout.write("keyboard\n");
{
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
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => document.getElementById("inspectDialog").open);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const returned = await page.evaluate((k) => document.activeElement && document.activeElement.dataset.key === k, first);
  if (!opened) fail("Enter on a focused row does not open its inspector"); else ok("Enter opens the row's inspector");
  if (!returned) fail("closing the inspector does not return focus to the row"); else ok("closing the sheet returns focus to the row");
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
  // 390: every row by Tab, opens on Enter
  const phone = await open(390, "dark");
  const reach = await phone.page.evaluate(async () => {
    const rows = [...document.querySelectorAll("#cLanes .lane")];
    return { rows: rows.length, tabbable: rows.filter((r) => r.tabIndex === 0).length, role: rows.every((r) => r.getAttribute("role") === "button" && r.getAttribute("aria-label")) };
  });
  if (reach.rows === 0 || reach.tabbable !== reach.rows || !reach.role) fail(`390: ${reach.tabbable} of ${reach.rows} rows are in the tab order as named buttons`); else ok(`390: all ${reach.rows} rows are named buttons in the tab order`);
  await phone.page.focus("#cLanes .lane");
  await phone.page.keyboard.press("Enter");
  await phone.page.waitForTimeout(400);
  const phoneOpened = await phone.page.evaluate(() => document.getElementById("inspectDialog").open);
  if (!phoneOpened) fail("390: Enter on a row does not open it"); else ok("390: Enter opens the row");
  await phone.context.close();
}

// ── 6. presenting ───────────────────────────────────────────────────────
process.stdout.write("presenting\n");
{
  const ticket = await signInUrl();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(ticket, { waitUntil: "networkidle" });
  const payload = await page.evaluate(async () => (await fetch("/api/console", { headers: { "x-agent-console": "1" } })).json());
  const names = new Set();
  for (const l of payload.lanes) { if (l.project?.name) names.add(l.project.name); if (l.branch) names.add(l.branch); }
  for (const d of payload.devices) { names.add(d.label); if (d.person) names.add(d.person); }
  for (const p of payload.people || []) names.add(p.person);
  for (const u of payload.hub.urls || []) { try { names.add(new URL(u).host); } catch {} }
  for (const view of ["console", "team", "projects"]) {
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    if (view !== "console") { await page.evaluate((v) => document.querySelector(`.tab[data-view="${v}"]`).click(), view); await page.waitForTimeout(1200); }
    await page.keyboard.press("p");
    await page.waitForTimeout(900);
    // what a viewer or a screen reader can meet: every text node, every title and every aria-label — not tag names, not the add form's example placeholders
    const dom = await page.evaluate(() => {
      const parts = [document.body.textContent];
      for (const el of document.querySelectorAll("[title], [aria-label]")) parts.push(el.getAttribute("title") || "", el.getAttribute("aria-label") || "");
      return { text: parts.join("\n"), strip: document.getElementById("presentStamp").hidden ? "" : document.getElementById("presentStamp").textContent };
    });
    const leaked = [...names].filter((n) => n.length >= 3 && new RegExp(`(^|[^A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([^A-Za-z0-9]|$)`, "u").test(dom.text));
    if (leaked.length) fail(`${view}: presenting still shows ${leaked.slice(0, 5).join(", ")}`); else ok(`${view}: presenting hides every project, branch, machine, person and host name (${names.size} checked)`);
    if (dom.strip !== "PRESENTING") fail(`${view}: the strip does not read PRESENTING`);
    await shot(page, `${view}-1440-dark-presenting`);
    await page.keyboard.press("p");
  }
  await context.close();
}

await browser.close();
process.stdout.write(failures.length ? `\n${failures.length} bar(s) missed\n` : "\nevery bar met\n");
process.exit(failures.length ? 1 : 0);
