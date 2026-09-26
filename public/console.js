/*
 * The console screen.
 *
 * DATA. Everything on this page comes from /api/console, which the hub
 * computes from what machines actually reported (or, in demo mode, from a
 * synthetic team — and then every surface says DEMO). Nothing here invents a
 * figure: the page only formats, eases and draws what it was given.
 *
 * MOTION. One requestAnimationFrame loop drives every moving thing, and each
 * moves for a reason of its own, so nothing is in step with anything else:
 *   - the chart's time axis glides left with the real clock, and each point
 *     eases toward the value the hub reported for it;
 *   - the big figures ease toward the latest measured value (never beyond it);
 *   - a lane's spark changes only when that lane's own data does, and the
 *     machines report on their own jittered schedules.
 * Text redraws at most eight times a second. Pause motion stops the loop, not
 * the data: figures keep updating, each new reading painted at once without
 * travel, exactly as prefers-reduced-motion does. A paused screen is never a
 * stale one.
 *
 * GAPS. An unknown reading is drawn as a hatched void with its reason,
 * never a zero. A machine that stopped reporting shows when it stopped. Cost
 * is a list-price estimate and says when it is partial.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const HEADERS = { "x-agent-console": "1" };
  const POLL_MS = 2000;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ── formatting ───────────────────────────────────────────────────────
  // A Git figure the hub could not read is null: a dash, never a measured 0; the reason travels with it (totals.reason).
  const gitN = (v) => (v === null || v === undefined ? "—" : v.toLocaleString("en-US"));
  const gitLines = (t) => (t.added === null || t.removed === null ? "—" : null);
  const gitWhy = (t) => (t && t.reason) || "Git figures could not be read on this machine";
  // Git totals nobody could read: every figure null, with the hub's reason.
  const gitUnread = (t) => !t || t.commits === null || t.commits === undefined;
  const fmt = (n) => {
    if (n === null || n === undefined || !Number.isFinite(n)) return "—";
    const a = Math.abs(n);
    return a >= 1e9 ? (n / 1e9).toFixed(2) + "B"
      : a >= 1e6 ? (n / 1e6).toFixed(a >= 1e8 ? 0 : 1) + "M"
      : a >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n));
  };
  const money = (n) => (n === null || n === undefined || !Number.isFinite(n)) ? "—"
    : "$" + n.toLocaleString("en-US", Math.abs(n) >= 1000
      ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (x, digits = 1) => (x === null || x === undefined || !Number.isFinite(x)) ? "—" : (x * 100).toFixed(digits) + "%";
  const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const ago = (ms, now) => {
    if (!ms) return "never";
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 10) return "now";
    if (s < 60) return s + " s ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 36) return h + " h ago";
    return Math.round(h / 24) + " days ago";
  };
  const observedSpan = (minutes) => minutes == null ? "Span unavailable" : minutes < 60
    ? `${minutes} m observed` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} m` : ""} observed`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TOOL = { "claude-code": "Claude Code", codex: "Codex" };
  // the tool as a two-letter chip before the model, whole at every width; the full name is on the chip
  const TOOL_SHORT = { "claude-code": "CC", codex: "CX" };
  const toolChip = (tool) => `<i class="tool" title="${esc(TOOL[tool] || tool)}">${esc(TOOL_SHORT[tool] || String(tool).slice(0, 2).toUpperCase())}</i>`;
  // the compact frame (1280 wide or 820 tall and under): the second band is one row and the spectrum is its cost bar alone
  const compactMQ = window.matchMedia("(min-width: 1024px) and ((max-width: 1280px) or (max-height: 820px))");
  // "input" is uncached input only; cached input is the cache read and write classes.
  const CLASS_LABEL = { cacheRead: "cache read", cacheWrite: "cache write", output: "output", fresh: "uncached input" };
  // One period for every view (lib/hub/aggregate.js, PERIODS): the headline,
  // the chart, Team and Projects all answer for it.
  const PERIOD_TEXT = { "1h": ["last hour", "1 h", "one hour ago"], "24h": ["last 24 hours", "24 h", "24 hours ago"],
    "7d": ["last 7 days", "7 days", "seven days ago"], "30d": ["last 30 days", "30 days", "30 days ago"] };
  const vendorMark = (vendor) => vendor
    ? `<svg aria-label="${vendor === "anthropic" ? "Anthropic" : "OpenAI"}" role="img"><use href="#mk-${vendor}"/></svg>`
    : `<i class="none" title="No vendor mark for this model"></i>`;
  // The viewer's zone, said once in the strip and on every hover: "6:24 AM EDT".
  const zoneName = () => { try { return new Intl.DateTimeFormat([], { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || ""; } catch { return ""; } };
  const asOf = () => D ? `as of ${hhmm(D.now)} ${zoneName()}`.trim() : "";
  // A generated row is stamped where it is read: after the state word, beside the figure.
  const demoStamp = () => (D && D.hub.demo ? `<span class="stamp sm" title="Generated: nothing was read from any machine">DEMO</span>` : "");
  // Sparks summed by a key over the lanes the hub sent: a machine's, a person's or a project's own last hour.
  const SPARK_N = 20;
  function sparksBy(keyOf, lanes = (D && D.lanes) || []) {
    const out = new Map();
    for (const l of lanes) {
      const key = keyOf(l);
      if (key === null || key === undefined) continue;
      let s = out.get(key);
      if (!s) { s = { spark: new Array(SPARK_N).fill(0), live: 0, lanes: [] }; out.set(key, s); }
      for (let i = 0; i < SPARK_N; i += 1) s.spark[i] += l.spark[i] || 0;
      if (l.state === "live") s.live += 1;
      s.lanes.push(l);
    }
    return out;
  }
  /* A row's activity as a small wave, the same grammar as the chart above it: a soft line over a gradient fill.
     Team and Projects rows draw the hub's own per-row series at the period's resolution (3 min, 15 min, 2 h, a day),
     so they follow the period control; a lane and the inspector draw the last hour in three-minute steps. A row with
     nothing in the window is a flat dotted baseline with its reason, never a zero wave; a row whose machine is
     silent or gone is drawn dim. The title carries the figure and the window. */
  const sparkWave = (spark, hot, title = "", { dim = false, W = 76, H = 16, cls = "spw", hidden = false } = {}) => {
    const vals = spark && Array.isArray(spark.tokens) ? spark.tokens : Array.isArray(spark) ? spark : null;
    const aria = hidden ? `aria-hidden="true"` : `role="img" aria-label="${esc(title || "No activity in the period")}"`;
    if (!vals || vals.length < 2 || !vals.some((v) => v > 0)) {
      return `<svg class="${cls} none${dim ? " dim" : ""}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" ${aria}><title>${esc(title || "No activity in the period")}</title><line class="base" x1="0" x2="${W}" y1="${(H - 1.5).toFixed(1)}" y2="${(H - 1.5).toFixed(1)}"/></svg>`;
    }
    const top = Math.max(...vals, 1);
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * W, H - 1.5 - (Math.max(0, v) / top) * (H - 4)]);
    const line = smooth(pts);
    const all = vals.reduce((a, b) => a + b, 0);
    const text = title || fmt(all) + " tokens over the period";
    return `<svg class="${cls}${hot ? " hot" : ""}${dim ? " dim" : ""}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" ${aria}><title>${esc(text)}</title><path class="area" d="${line}L${W} ${H}L0 ${H}Z"/><path class="line" d="${line}"/>${hot ? `<path class="now" d="M${W} ${pts[pts.length - 1][1].toFixed(1)}h0"/>` : ""}</svg>`;
  };
  /* A line of ordered parts that never ellipsizes meaning: each part carries a priority; when the line does not fit its box,
     the least important parts drop whole until it does, and the element carries the whole line on hover. */
  const fitted = new Set();
  let fitObserver = null;
  function fitLine(el, parts, tail = "") {
    if (!el) return;
    const live = parts.filter((x) => x && x.html);
    el.innerHTML = live.map((x, i) => `<span class="fseg" data-pri="${x.pri ?? 9}">${i ? `<span class="sep">·</span>` : ""}${x.html}</span>`).join("");
    el.title = live.map((x) => x.text ?? x.html.replace(/<[^>]+>/gu, "")).join(" · ").replace(/\s+/gu, " ").trim() + tail;
    fitOne(el);
    if (!fitted.has(el)) {
      fitted.add(el);
      if (typeof ResizeObserver === "function") { fitObserver = fitObserver || new ResizeObserver((entries) => { for (const e of entries) fitOne(e.target); }); fitObserver.observe(el); }
    }
  }
  function fitOne(el) {
    const segs = [...el.querySelectorAll(":scope > .fseg")];
    for (const x of segs) x.hidden = false;
    if (!el.clientWidth) return;
    const order = segs.slice(1).sort((a, b) => Number(b.dataset.pri) - Number(a.dataset.pri));
    for (const x of order) { if (el.scrollWidth <= el.clientWidth + 1) break; x.hidden = true; }
    // a first part that still cannot fit is folded away whole (the line is on hover), never cut mid-word
    if (segs[0] && el.scrollWidth > el.clientWidth + 1) segs[0].hidden = true;
  }
  window.addEventListener("resize", () => { for (const el of fitted) fitOne(el); });
  /* A caption that names its window in its shortest form ("30 d"; the pressed period button says the words): the window drops where the frame is tight (.win), the head stays. */
  const capWin = (id, head, win) => { const el = $(id); if (el) el.innerHTML = `${esc(head)}<span class="win"> · ${esc(String(win).replace(/ days$/u, " d"))}</span>`; };
  /* A money figure that is a floor says so with the number: "+" for records the hub priced only in part, and the count it could
     not count at all on hover; the word "partial" where the cell has room (tables), the mark alone where it does not (band rows). */
  function costMark(c, dropped = 0, word = true) {
    if (!c || c.status === "none") return { html: "—", title: "Nothing to price yet" };
    if (c.status === "unpriced") return { html: `<span class="void">unpriced</span>`, title: "No verified list price for what ran here" };
    const floor = c.status === "partial" || dropped > 0;
    const why = [c.status === "partial" ? "some records are unpriced" : "", dropped > 0 ? `${dropped.toLocaleString("en-US")} ${dropped === 1 ? "message" : "messages"} not counted` : ""].filter(Boolean).join(" · ");
    return { html: money(c.usd) + (floor ? (word ? `<em class="part">partial</em>` : `<em class="part">+</em>`) : ""),
      title: floor ? `${why} · list-price estimate, a floor` : "List-price estimate. Not an invoice." };
  }
  const droppedOf = (d) => (d && d.coverage && Number.isFinite(d.coverage.dropped) ? d.coverage.dropped : 0);
  // Identity for a stacked-by-thing series (machines, projects): one accent stepped by
  // opacity over six steps, the biggest series solid, the rest of them quieter — never the
  // token-class ramp, which means price on this screen. Whatever is folded into "others" is
  // hatched in the same light, never the idle grey.
  const IDENT = [1, 0.8, 0.62, 0.47, 0.34, 0.24];
  const identAt = (i) => ({ fill: "var(--lit)", opacity: IDENT[Math.min(i, IDENT.length - 1)] });
  // How long a step is, in words: "3 min", "15 min", "2 h", "day".
  const stepText = (step) => step >= 86_400_000 ? "day" : step >= 3_600_000 ? `${Math.round(step / 3_600_000)} h` : step >= 60_000 ? `${Math.round(step / 60_000)} min` : "step";
  /* Presenting: every project, branch, machine and person is shown under a stable stand-in
     name for the session (project A, machine 1, person 1) so a screen can be shared without
     naming anyone's work. Nothing else changes: the figures, the states and the times stay. */
  let present = false;
  const aliases = { project: new Map(), branch: new Map(), machine: new Map(), person: new Map() };
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function pn(kind, name) {
    if (!present || name === null || name === undefined || name === "") return name;
    const book = aliases[kind] || aliases.project;
    if (!book.has(name)) {
      const n = book.size;
      book.set(name, kind === "project" ? `project ${LETTERS[n % 26]}${n >= 26 ? Math.floor(n / 26) : ""}` : kind === "branch" ? `branch ${n + 1}` : kind === "machine" ? `machine ${n + 1}` : `person ${n + 1}`);
    }
    return book.get(name);
  }
  /* A stacked wave series over the period: one band per key at the chart's own
     resolution (3 min, 15 min, 2 h, a day), the biggest at the floor, each band a
     smooth area in the chart's light stepped quieter as it climbs, the total drawn
     as one line over them. The step still filling is drawn at what was measured,
     with a hatched cap to what it would be at this pace. Drawn from the hub's own
     per-key series (H04), so the bands add up to the headline for the period. */
  const waves = new Map();   // svgId → the last drawn frame, for hover
  function drawWaves({ svgId, wrapId, reasonId, legendId, peakId, capId, series, nameOf, liveOf, now, none }) {
    const svg = $(svgId), wrap = $(wrapId);
    const frame = series && series.frame;
    const bands = (series && series.bands) || [];
    const rest = (series && series.rest) || [];
    const restCount = (series && series.restCount) || 0;
    const rows = bands.map((b) => ({ key: b.deviceId ?? b.projectHash ?? b.key, tokens: b.tokens, total: b.tokens.reduce((a, v) => a + v, 0) }));
    const restTotal = rest.reduce((a, v) => a + v, 0);
    if (restCount > 0 || restTotal > 0) rows.push({ key: "__rest", tokens: rest, total: restTotal, n: restCount });
    const all = rows.reduce((a, r) => a + r.total, 0);
    wrap.classList.toggle("void", !frame || all <= 0);
    if (peakId) $(peakId).hidden = !frame || all <= 0;
    if (!frame || all <= 0) {
      $(reasonId).textContent = !frame ? "This hub does not send the series by " + (none || "machine") + ". Nothing is estimated in its place."
        : rows.length ? `Nothing reported in the ${PERIOD_TEXT[period][0]}. Nothing is estimated in its place.` : "No session has reported. Nothing is estimated in its place.";
      svg.innerHTML = ""; $(legendId).innerHTML = ""; if (capId) $(capId).innerHTML = "";
      waves.delete(svgId);
      return null;
    }
    const W = 520, H = 100, n = frame.steps;
    const totals = new Array(n).fill(0);
    for (const r of rows) for (let i = 0; i < n; i += 1) totals[i] += r.tokens[i] || 0;
    // the step still filling: measured as it is, and what it would be at this pace
    const elapsed = Math.max(0.05, Math.min(1, (now - (frame.start + frame.step * (n - 1))) / frame.step));
    const projected = totals[n - 1] / elapsed;
    const peak = Math.max(...totals.slice(0, -1), 0);
    const max = Math.max(peak, totals[n - 1], projected, 1) * 1.08;
    const xOf = (i) => (i / (n - 1)) * W;
    const yOf = (v) => H - 2 - (Math.max(0, v) / max) * (H - 8);
    const base = new Array(n).fill(0);
    let out = `<line class="grid" x1="0" x2="${W}" y1="${(H / 4).toFixed(1)}" y2="${(H / 4).toFixed(1)}"/><line class="grid" x1="0" x2="${W}" y1="${(H / 2).toFixed(1)}" y2="${(H / 2).toFixed(1)}"/><line class="grid" x1="0" x2="${W}" y1="${(3 * H / 4).toFixed(1)}" y2="${(3 * H / 4).toFixed(1)}"/>`;
    rows.forEach((r, k) => {
      const upper = base.map((b, i) => [xOf(i), yOf(b + (r.tokens[i] || 0))]);
      const lower = base.map((b, i) => [xOf(i), yOf(b)]);
      const back = lower.slice().reverse().map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join("");
      const id = identAt(k);
      const fill = r.key === "__rest" ? `fill="url(#hatchrest)"` : `fill-opacity="${id.opacity}"`;
      out += `<path class="band" d="${smooth(upper)}${back}Z" ${fill}/>`;
      out += `<path class="crest" d="${smooth(upper)}" stroke-opacity="${(r.key === "__rest" ? 0.35 : id.opacity * 0.9).toFixed(2)}"/>`;
      for (let i = 0; i < n; i += 1) base[i] += r.tokens[i] || 0;
    });
    const top = totals.map((v, i) => [xOf(i), yOf(v)]);
    out += `<path class="top" d="${smooth(top)}"/>`;
    if (peak > 0) out += `<line class="peakline" x1="0" x2="${W}" y1="${yOf(peak).toFixed(1)}" y2="${yOf(peak).toFixed(1)}"/>`;
    // the cap: hatched from the measured last step up to what it would be, over the last step's own width
    if (projected > totals[n - 1] && totals[n - 1] > 0) {
      const x0 = xOf(n - 1.5), y1 = yOf(projected), y0 = yOf(totals[n - 1]);
      out += `<rect class="cap-step" x="${x0.toFixed(1)}" y="${y1.toFixed(1)}" width="${(W - x0).toFixed(1)}" height="${Math.max(0, y0 - y1).toFixed(1)}" fill="url(#hatchcap)"><title>${fmt(totals[n - 1])} so far this ${stepText(frame.step)} · ${fmt(projected)} projected at this pace</title></rect>`;
    }
    out += `<line class="hover" x1="0" x2="0" y1="0" y2="${H}" opacity="0"/>`;
    svg.innerHTML = out;
    if (peakId) $(peakId).innerHTML = `peak <b>${fmt(peak)}</b> / ${stepText(frame.step)}`;
    const live = (key) => (liveOf ? liveOf(key) : 0);
    $(legendId).innerHTML = rows.map((r, i) => {
      const id = identAt(i);
      const name = r.key === "__rest" ? `others (${r.n})` : nameOf(r.key);
      const lv = r.key === "__rest" ? 0 : live(r.key);
      return `<span title="${esc(name)} · ${fmt(r.total)} tokens in the ${esc(PERIOD_TEXT[period][0])}${lv ? ` · ${lv} live` : ""}"><i class="sw k${r.key === "__rest" ? " rest" : ""}" style="${r.key === "__rest" ? "" : `background:${id.fill};opacity:${id.opacity}`}"></i>${esc(name)} <b>${fmt(r.total)}</b>${lv ? `<em>${lv} live</em>` : ""}</span>`;
    }).join("");
    waves.set(svgId, { frame, rows, totals, xOf, W, nameOf });
    return { all, peak, frame, projected, measured: totals[n - 1] };
  }
  /* Hover on a wave: the step under the pointer, its time range and every band's tokens in it. */
  function waveHover(svgId, tipId) {
    const svg = $(svgId), tip = $(tipId);
    svg.addEventListener("mousemove", (ev) => {
      const w = waves.get(svgId); if (!w) return;
      const rect = svg.getBoundingClientRect();
      const fx = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const i = Math.round(fx * (w.frame.steps - 1));
      const from = w.frame.start + i * w.frame.step;
      const last = i === w.frame.steps - 1;
      const when = w.frame.step >= 86_400_000 ? new Date(from).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) : `${hhmm(from)}–${last ? "now" : hhmm(from + w.frame.step)}`;
      tip.hidden = false;
      tip.style.left = Math.max(12, Math.min(88, fx * 100)) + "%";
      tip.innerHTML = `${esc(when)}${last ? " <em>so far</em>" : ""} · <b>${fmt(w.totals[i])}</b> tokens<small>${w.rows.map((r) => `${esc(r.key === "__rest" ? `others (${r.n})` : w.nameOf(r.key))} ${fmt(r.tokens[i] || 0)}`).join(" · ")}</small>`;
      const hover = svg.querySelector(".hover");
      if (hover) { hover.setAttribute("x1", (fx * w.W).toFixed(1)); hover.setAttribute("x2", (fx * w.W).toFixed(1)); hover.setAttribute("opacity", ".5"); }
    });
    svg.addEventListener("mouseleave", () => { tip.hidden = true; const hover = svg.querySelector(".hover"); if (hover) hover.setAttribute("opacity", "0"); });
  }

  // ── state ────────────────────────────────────────────────────────────
  let D = null;                 // the last payload
  let receivedAt = 0;           // performance.now() when it arrived
  let view = "console";
  let period = "24h";
  let perSecond = false;
  let paused = false;
  let showUnavailable = false;
  let laneFocus = null;         // the lane the keyboard is on (J/K)
  let opener = null;            // what opened the sheet on top — a stable key it is found again by, since rows repaint while a sheet is open
  const inspect = { open: false, kind: null, id: null, confirm: null };   // what the inspector beside the canvas shows, and whether Remove is armed
  let projCache = null;         // the last /api/projects answer, for the Projects band and its inspector
  let pollTimer = null;
  let offline = false;
  let scanMs = null;            // how long the last /api/console answer took
  const target = { total: 0, spend: 0, msgs: 0, burn: 0 };
  const shown = { total: 0, spend: 0, msgs: 0, burn: 0 };
  let first = true;
  // The four classes in one order everywhere, by price per token: output dearest, cache read cheapest.
  // The chart stacks them bottom-up (CLASSES) so that, read from the top, the order is the same as every table and legend (ORDER).
  const CLASSES = ["cacheRead", "fresh", "cacheWrite", "output"];
  const ORDER = ["output", "cacheWrite", "fresh", "cacheRead"];
  let chart = { key: null, vals: [], goal: [], max: 1, goalMax: 1, cls: null, clsGoal: null };
  let routed = false;           // the URL is read once the first reading is in

  const serverNow = () => (D ? D.now + (performance.now() - receivedAt) : Date.now());

  // ── polling ──────────────────────────────────────────────────────────
  async function poll() {
    clearTimeout(pollTimer);
    try {
      const asked = performance.now();
      const response = await fetch("/api/console", { headers: HEADERS, cache: "no-store" });
      if (response.status === 401) { signedOut(); return; }
      if (!response.ok) throw new Error(String(response.status));
      document.body.classList.remove("signed-out");
      $("signedOut").hidden = true;
      D = await response.json();
      receivedAt = performance.now();
      scanMs = Math.round(receivedAt - asked);   // how long the hub took to answer, for the strip
      offline = false;
      onData();
    } catch {
      if (!offline) toast("The console lost its connection to the hub. Retrying…");
      offline = true;
      document.body.classList.add("offline");
    } finally {
      // Signed out, there is nothing to poll for until the sign-in link reloads the page.
      if (!document.body.classList.contains("signed-out")) pollTimer = setTimeout(poll, POLL_MS);
    }
  }

  function onData() {
    document.body.classList.remove("offline");
    document.body.dataset.demo = String(Boolean(D.hub.demo));
    $("ver").textContent = "v" + D.hub.version + (D.hub.demo ? " · demo" : "");
    const net = D.hub.listen.network;
    $("reach").classList.toggle("network", net);
    $("reachText").textContent = D.hub.demo ? "Synthetic team" : net ? "Accepting machines on this network" : "This machine only";
    // the addresses name this machine on the network: kept off the screen while presenting
    $("reach").dataset.title = D.hub.demo ? "Demo mode: nothing is read and no machine can join."
      : net ? "Other machines can join at " + D.hub.urls.join(", ") + ". The console itself answers only here."
      : "Only this machine can reach this console. Start it with --listen 0.0.0.0 to add other computers.";
    $("reach").title = present ? "" : $("reach").dataset.title;
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    const current = currentDevices().length;
    $("tabTeam").textContent = current ? reporting + "/" + current : "0";
    const liveNow = D.lanes.filter((l) => l.state === "live").length;
    $("tabLive").textContent = liveNow ? liveNow + " live" : "";
    $("clockZone").textContent = zoneName();

    const w = win();
    target.total = w.tokens.total;
    target.spend = w.cost.usd ?? 0;
    target.msgs = w.messages;
    target.burn = D.burn.tokensPerMinute;
    if (first || reducedMotion.matches || paused) Object.assign(shown, target);
    first = false;

    paintAll();
    watchJoin();
    if (reducedMotion.matches || paused) { paintText(); drawChart(); }
    paintClock();
    fitRegions();
    if (!routed) { routed = true; route(); }
  }
  /* Everything drawn from the payload, in one place, so a change of period or of presenting repaints it all. */
  function paintAll() {
    paintStrip();
    paintClasses();
    paintModels();
    paintLanes();
    paintAlerts();
    paintAttention();
    paintInterop();
    paintMachines();
    setChartGoal();
    paintWeek();
    paintSpectrum();
    paintBurnSpark();
    paintFoot();
    loadFold();
    if (view === "team") paintTeam();
    if (view === "projects") paintProjectsLive();
    if (inspect.open) paintInspect();
  }

  /* The status bar carries the reading's provenance, as the reference does: the
     price table the estimate used, what could not be counted, how long the
     readings are kept, and how long the hub took. The privacy contract lives on
     the Source link and in Add a machine, not on every screen. */
  function paintFoot() {
    const table = (D.lanes || []).map((l) => l.context && l.context.priceTable).find((p) => p && p.version) || null;
    const cov = D.coverage;
    const parts = [];
    parts.push(table ? `price table <b>v${esc(String(table.version))}</b>${table.checkedOn ? ` · checked ${esc(String(table.checkedOn))}` : ""}` : "price table not reported");
    // "every record counted" only when every current machine's reporter said what it could not count; a machine whose version never said is a void, not a zero
    const unsaid = currentDevices().filter((d) => !d.coverage || d.coverage.reported === false || d.coverage.dropped === null);
    parts.push(cov && cov.dropped ? `<span class="w">${cov.dropped.toLocaleString("en-US")} not counted</span>` : unsaid.length && D.devices.length ? `<span class="w">coverage not reported by ${plural(unsaid.length, "machine")}</span>` : D.devices.length ? "every record counted" : "no machine yet");
    if (D.hub.retentionDays) parts.push(`kept ${D.hub.retentionDays} days`);
    parts.push(`<span id="footScan">scan ${scanMs ?? "—"} ms</span>`);
    $("footProv").innerHTML = parts.join(" · ");
    $("footProv").title = [
      table ? `List prices from the console's own price table, version ${table.version}${table.checkedOn ? ", checked " + table.checkedOn : ""}. Not an invoice.` : "No priced reading yet.",
      cov && cov.dropped ? `${cov.dropped} transcript records could not be counted: ${cov.reasons.map((r) => r.count + " × " + r.label).join("; ")}.` : "",
      unsaid.length ? `${unsaid.map((d) => pn("machine", d.label)).join(", ")}: the reporter version there never said what it could not count, so its coverage is unknown, not zero.` : "",
      D.hub.retentionDays ? `Minute detail is kept ${D.hub.retentionDays} days; daily totals longer.` : "",
      "Only counts, model names, times and salted hashes leave a machine — never a prompt, a reply, a file path or file contents.",
    ].filter(Boolean).join(" ");
  }

  function paintInterop() {
    const data = D.interop || {};
    const sources = [['otel', 'Claude Code OpenTelemetry · 24 h'], ['kong', 'Kong · cumulative'], ['litellm', 'LiteLLM · cumulative']];
    $('interopPanel').hidden = !D.hub.interop;
    // Each source names what its token total adds up (input+output, or with cache); OTel says how many points it dropped as repeats or ignored as cumulative.
    $('interopRows').innerHTML = sources.map(([key, label]) => {
      const item = data[key];
      const def = item?.tokenDefinition ? `tokens are ${item.tokenDefinition.replace(/\+/gu, " + ")}` : "token definition not reported";
      const notes = [];
      if (item?.dedupedSamples) notes.push(`${plural(item.dedupedSamples, "repeated point")} dropped`);
      if (item?.cumulativeIgnored) notes.push(`<span class="w">cumulative temporality ignored (${item.cumulativeIgnored})</span>`);
      return `<div class="interop-row" title="${esc(label)} · ${esc(def)}${item?.dedupedSamples ? ` · a point sent again with the same series and time is counted once` : ""}${item?.cumulativeIgnored ? ` · cumulative counters are not summed; only delta points count` : ""}"><span>${label}</span><b>${item?.available ? fmt(item.tokens.total) + ' tokens' : 'No reading yet'}</b>${item?.available ? `<small>${hhmm(item.receivedAt)}${D.hub.demo ? ' · DEMO' : ''}</small>` : ''}${notes.length ? `<small>${notes.join(" · ")}</small>` : ""}</div>`;
    }).join('');
  }

  // ── words used the same way on every view ────────────────────────────
  /* A machine removed from the console, or one that left, is not counted
     among "the machines": it is shown only when Show unavailable is on. */
  const currentDevices = () => D.devices.filter((d) => d.status !== "revoked");
  const plural = (n, one, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  /* A session is one top-level Claude Code or Codex session; its subagents are
     counted apart, as subagents, never as more sessions. */
  // Counts come from the hub's rollups over every lane (laneTotals), never from the 80 rows it sends to draw.
  const laneTotal = () => (D.laneTotals && Number.isFinite(D.laneTotals.total) ? D.laneTotals.total : D.laneCount);
  const subagentCount = () => (D.laneTotals && Number.isFinite(D.laneTotals.subagentCount) ? D.laneTotals.subagentCount : Math.max(0, D.day.sessions - D.laneCount));
  const sessionWords = () => {
    const subagents = subagentCount();
    return plural(laneTotal(), "session") + " in the last 24 h" + (subagents ? " · " + plural(subagents, "subagent") : "");
  };

  // ── the strip ────────────────────────────────────────────────────────
  /* One line: what this is, where it reads, what is live right now, the
     machines, the clock and how fresh the reading is. The glow is spent on
     the one thing that is live: a session that reported in the last two
     minutes. Sessions and alerts are counted with different words. */
  function paintStrip() {
    const live = D.lanes.filter((l) => l.state === "live").length;
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    const catching = D.devices.filter((d) => d.status === "catching-up").length;
    $("liveDot").classList.toggle("on", live > 0);
    $("liveCount").innerHTML = live ? `${live} live<span class="w"> ${live === 1 ? "session" : "sessions"}</span>` : "no live session";
    $("liveCap").title = live ? "Sessions that reported within the last two minutes" : "No session has reported in the last two minutes";
    // One line states the scope: machines reporting, sessions in the last 24 h, subagents — counted over every lane; where the strip is
    // tight the least important part drops whole (never an ellipsis), and the whole line is on hover.
    fitLine($("machineCount"), D.devices.length
      ? [{ html: `${reporting} of ${currentDevices().length} reporting`, pri: 0 }, catching ? { html: `${catching} catching up`, pri: 1 } : null,
        { html: plural(laneTotal(), "session"), pri: 2 }, { html: plural(subagentCount(), "subagent"), pri: 3 }]
      : [{ html: "no machine has joined yet", pri: 0 }], D.devices.length ? " · a session is one top-level Claude Code or Codex session; its subagents are counted apart" : "");
    $("presentStamp").hidden = !present;
    document.body.toggleAttribute("data-present", present);
  }
  /* The clock and the freshness note tick with the loop (or with each poll
     when motion is paused): a paused screen is never a stale one. */
  let clockShown = "";
  function paintClock() {
    if (!D) return;
    const now = serverNow();
    const time = new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    if (time !== clockShown) {
      clockShown = time;
      $("clockTime").textContent = time;
      $("clockDate").textContent = new Date(now).toLocaleDateString([], { day: "numeric", month: "short" });
      const age = Math.max(0, Math.round((performance.now() - receivedAt) / 1000));
      $("scanNote").textContent = offline ? "connection lost · retrying" : `${age}s · scan ${scanMs ?? "—"}ms`;
    }
  }

  /* The week, as data: seven days in two-hour steps, today's steps lit, the
     busiest day named as the scale. Drawn on the Console and the Team band. */
  function paintWeek(ids = ["weekBars", "weekTotal", "weekPeak"]) {
    const s = D.series["7d"];
    const n = s.values.length, W = 84, H = 20;
    const vals = s.values.slice();
    const elapsed = Math.max(0.05, Math.min(1, (D.now - (s.start + s.step * (n - 1))) / s.step));
    const projected = vals[n - 1] / elapsed;
    const max = Math.max(...vals, projected, 1);
    const dayStart = new Date(D.now); dayStart.setHours(0, 0, 0, 0);
    const xOf = (i) => (i / (n - 1)) * W;
    const yOf = (v) => H - 1 - (Math.max(0, v) / max) * (H - 2);
    const pts = vals.map((v, i) => [xOf(i), yOf(v)]);
    const line = smooth(pts);
    const todayFrom = Math.max(0, vals.findIndex((v, i) => s.start + i * s.step >= dayStart.getTime()));
    const todayX = xOf(todayFrom);
    // one wave for the seven days, today's part lit under it, the step still filling capped in hatch
    $(ids[0]).innerHTML = `<path class="area" d="${line}L${W} ${H}L0 ${H}Z"/>`
      + `<rect class="today" x="${todayX.toFixed(2)}" y="0" width="${(W - todayX).toFixed(2)}" height="${H}"/>`
      + `<path class="line" d="${line}"/>`
      + (projected > vals[n - 1] && vals[n - 1] > 0 ? `<rect class="cap-step" x="${xOf(n - 1.5).toFixed(2)}" y="${yOf(projected).toFixed(2)}" width="${(W - xOf(n - 1.5)).toFixed(2)}" height="${Math.max(0, yOf(vals[n - 1]) - yOf(projected)).toFixed(2)}"/>` : "");
    const week = (D.windows && D.windows["7d"]) || null;
    $(ids[1]).textContent = week ? fmt(week.tokens.total) : "—";
    $(ids[1]).title = week ? `${fmt(week.tokens.total)} tokens in the last 7 days · ${week.cost.usd === null ? "no priced model" : money(week.cost.usd) + " est."}` : "";
    // The busiest day, exact: the hub's day totals by this console's own calendar, with the zone named. A hub that cannot say gives an approximation from the two-hour steps, marked ≈.
    const byDay = s.byLocalDay && Array.isArray(s.byLocalDay.days) ? s.byLocalDay : null;
    let top = null, approx = false, tz = "";
    if (byDay) { top = byDay.days.slice().sort((a, b) => b.tokens - a.tokens)[0]; tz = byDay.tz || ""; if (top) top = [Date.parse(top.date + "T12:00:00"), top.tokens, top.partial]; }
    else {
      const days = new Map();
      vals.forEach((v, i) => { const day = new Date(s.start + i * s.step).toDateString(); days.set(day, (days.get(day) || 0) + v); });
      top = [...days.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top) { top = [Date.parse(top[0]), top[1], false]; approx = true; }
    }
    $(ids[2]).innerHTML = top && top[1] > 0 ? `peak <b>${approx ? "≈ " : ""}${new Date(top[0]).toLocaleDateString([], { weekday: "short" })} ${fmt(top[1])}</b>` : "";
    $(ids[2]).title = top && top[1] > 0 ? `The busiest calendar day of the seven: ${new Date(top[0]).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" })}, ${fmt(top[1])} tokens${tz ? ` · days by ${tz}` : ""}${top[2] ? " · that day is still filling" : ""}${approx ? " · approximated from two-hour steps; this hub does not send day totals" : ""}` : "";
  }

  // The summary for the chosen period; a 0.2 hub sends only the day.
  const win = () => (D.windows && D.windows[period]) || D.day;
  const pw = (x) => (x.windows && x.windows[period]) || x.day;
  function paintPeriod() {
    const [label, short] = PERIOD_TEXT[period];
    const w = win();
    const day = (iso) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" });
    const since = !w.partial ? ""
      : period === "30d" ? (w.since && Date.parse(w.since + "T00:00:00Z") > w.from ? " · daily totals kept since " + day(w.since + "T00:00:00Z")
        : " · partial: some usage arrived after its day's detail was gone")
      : w.since ? " · minute detail kept since " + day(w.since) : " · partial";
    // the window, then since when it is partial: parts that drop whole when the caption is tight, the whole on hover with the window's definition
    fitLine($("cCap"), [{ html: "Tokens · " + esc(label), pri: 0 }, since ? { html: esc(since.replace(/^ · /u, "")), pri: 1 } : null],
      " · " + (period === "30d" ? "The last 30 calendar days in UTC, today included, from the daily totals the console keeps after its minute-by-minute detail."
        : "The whole minutes of the " + label + ", ending with the current one. The chart's bars add up to this figure."));
    capWin("cModelCap", "by model", short);
  }

  // ── tokens for the period ────────────────────────────────────────────
  function paintClasses() {
    paintPeriod();
    const w = win();
    const t = w.tokens, sh = w.shares;
    const order = ORDER;
    $("cMix").innerHTML = t.total > 0
      ? order.map((k) => `<i class="${k}" style="flex-grow:${Math.max(t[k], 0)}" title="${CLASS_LABEL[k]} ${pct(sh[k])}"></i>`).join("")
      : "";
    $("cMix").setAttribute("aria-label", "Token composition: " + order.map((k) => `${CLASS_LABEL[k]} ${pct(sh[k])}`).join(", "));
    // No machine yet: every reading is unknown, drawn as a dash, never as 0.
    const none = D.devices.length === 0 && t.total === 0;
    const byClass = w.cost.byClass || null;   // null until something is priced (a 0.2 hub never sends it)
    const usdCell = (k) => none ? `<em class="usd void" title="No machine has reported yet">—</em>`
      : byClass ? `<em class="usd" title="List-price estimate for ${esc(CLASS_LABEL[k])} tokens, from records priced by model and tier">${money(byClass[k])}</em>`
      : w.cost.status === "unpriced" ? `<em class="usd void" title="${esc(w.cost.unpricedModels.join(", "))}: no verified list price, so no dollar figure">unpriced</em>`
      : `<em class="usd void" title="This hub does not split its estimate by class">— no reading</em>`;
    $("cClasses").innerHTML = order.map((k) =>
      `<span title="${esc(CLASS_LABEL[k])} — ${pct(sh[k], 2)} of all tokens${k === "cacheRead" ? `; ${pct(sh.cacheHitOnInput, 1)} of input tokens` : ""}${k === "cacheWrite" && t.cacheWrite5m !== undefined ? `; 5-minute ${fmt(t.cacheWrite5m)} · 1-hour ${fmt(t.cacheWrite1h)} · lifetime not reported ${fmt(t.cacheWriteUnknownTtl)}` : ""}${k === "fresh" ? "; input the cache did not serve" : ""}${w.unknown[k] ? `; ${w.unknown[k]} records did not report this class` : ""}"><i class="sw ${k}"></i><span>${CLASS_LABEL[k]}</span><b>${none ? "—" : fmt(t[k])}</b><em class="pc">${none ? "—" : pct(sh[k])}</em>${usdCell(k)}</span>`).join("")
      // Dollars that could not be told apart by class are named, never spread across the classes.
      + (byClass && byClass.unsplitUsd > 0 ? `<span class="note" title="Records from mixed or partly unpriced minutes: their dollars are in the estimate but cannot be split by class">${money(byClass.unsplitUsd)} of the estimate is not split by class</span>` : "")
      + (byClass && w.cost.status === "partial" ? `<span class="note"><b>${esc(w.cost.unpricedModels.join(", "))}</b> unpriced · ${fmt(w.cost.unpricedTokens)} tokens in no class's dollars</span>` : "");

    const silent = D.devices.filter((d) => d.status === "silent");
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    const current = currentDevices().length;
    // One provenance line under the figure; what it cannot say in one line it says on hover.
    // The silent machine is named once on this screen — in the chart's gap — and counted here.
    const parts = [], why = [];
    if (!D.devices.length) parts.push("no machine has joined yet");
    else if (D.hub.demo) parts.push("generated", `${plural(D.devices.length, "machine")}`);
    else parts.push(`reported by ${reporting} of ${plural(current, "machine")}`);
    // A silent machine's figures stopped moving when it did: they stay in the total as its last known reading, and the line says so.
    if (silent.length) { parts.push(`<b>${silent.length} silent</b>`); why.push(silent.map((d) => `${pn("machine", d.label)} silent since ${hhmm(d.lastContactAt)}; its ${fmt(pw(d).tokens.total)} tokens are its last known reading, still in the total`).join("; ")); }
    const catching = D.devices.filter((d) => d.status === "catching-up");
    if (catching.length) { parts.push(`<b>${catching.length} catching up</b>`); why.push(catching.map((d) => `${pn("machine", d.label)} ${catchUpText(d)} — incomplete until it has sent everything`).join("; ")); }
    const unknown = Math.max(...Object.values(w.unknown));
    if (unknown) { parts.push(`<b>floor</b>`); why.push(`${unknown} record${unknown === 1 ? "" : "s"} missing a token class, so the figure is a floor, not a total`); }
    // What could not be counted is said here, never left out quietly.
    const cov = D.coverage;
    if (cov && cov.dropped) { parts.push(`<b>${cov.dropped.toLocaleString("en-US")} not counted</b>`); why.push(`${cov.dropped} transcript record${cov.dropped === 1 ? "" : "s"} could not be counted: ${cov.reasons.map((r) => r.count + " × " + r.label).join("; ")}`); }
    $("cProv").innerHTML = parts.join(" · ");
    $("cProv").title = [why.join(". "), asOf()].filter(Boolean).join(" · ");
    const flow = $("flowWrap");
    const empty = D.day.tokens.total === 0 && D.series["7d"].values.every((v) => v === 0);
    flow.classList.toggle("void", empty || (showUnavailable && D.devices.length === 0));
    $("voidReason").textContent = D.devices.length === 0
      ? "No machine is connected yet. Nothing is estimated in its place."
      : D.hub.local && D.hub.local.enabled && !D.hub.local.firstRunComplete
        ? "Reading this machine's transcripts for the first time" + (D.hub.local.progress && D.hub.local.progress.filesTotal
          ? ` · ${D.hub.local.progress.files.toLocaleString("en-US")} of ${D.hub.local.progress.filesTotal.toLocaleString("en-US")} files` : "…")
        : "No usage has been reported in the last seven days. Nothing is estimated in its place.";
  }

  // ── burn and models ───────────────────────────────────────────────────
  /* Top five by estimate, then a quiet "n more" that opens the rest in place: a model is never dropped without saying so. */
  const moreOpen = new Set();
  const MODELS_SHOWN = 5;
  function modelRows(models, boxId, allModels, limit = MODELS_SHOWN) {
    const open = moreOpen.has(boxId);
    const shown = open ? allModels : allModels.slice(0, limit);
    const max = Math.max(...allModels.map((m) => m.tokens), 1);
    return shown.map((m) => `<div class="mrow">
        <span class="mn" title="${esc(m.model)} · ${fmt(m.tokens)} tokens · ${pct(m.share)} of the period · ${asOf()}" data-src="windows.models.tokens">${vendorMark(m.vendor)}<span class="txt">${esc(m.label)}</span></span><span class="ms">${demoStamp()}</span>
        <span class="mbar" aria-hidden="true"><i style="width:${Math.max(1, Math.round((m.tokens / max) * 100))}%"></i></span>
        <span class="mv" data-src="windows.models.share">${pct(m.share, 0)}</span>
        ${m.usd === null ? `<span class="mc unp" title="No verified list price for ${esc(m.model)}; left out of the dollar figure">unpriced</span>` : `<span class="mc" data-internal data-src="windows.models.usd" title="List-price estimate · ${asOf()}">${money(m.usd)}</span>`}
      </div>`).join("") + (allModels.length > limit ? `<button type="button" class="more" data-more="${boxId}">${open ? "fewer" : `${allModels.length - limit} more`}</button>` : "");
  }
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-more]"); if (!b) return;
    if (moreOpen.has(b.dataset.more)) moreOpen.delete(b.dataset.more); else moreOpen.add(b.dataset.more);
    if (D) { paintModels(); paintMachines(); paintSpectrum(); paintAlerts(); if (inspect.open) paintInspect(); if (view === "projects") loadProjects(); if (view === "team") paintTeam(); }
  });
  // The Console band shows four models and opens the rest, so the band keeps the height the lanes need.
  const BAND_MODELS = 3;
  function paintModels() {
    const models = win().models;
    $("cModels").innerHTML = models.length ? modelRows(models, "cModels", models, BAND_MODELS)
      : `<div class="mrow"><span class="mn"><span class="none-text">no model has reported yet</span></span></div>`;
    const ex = D.burn.excluded;
    const reporting = D.burn.reporting;
    // The machines left out of the burn are counted here and named on hover; the chart's gap names them on the screen.
    $("cBurnNote").innerHTML = D.devices.length === 0 ? "no machine yet"
      : `${D.burn.windowMinutes}-min average · ${reporting} of ${plural(currentDevices().length, "machine")}` +
        (ex.length ? ` · <b>${ex.length} left out</b>` : "");
    $("cBurnNote").title = ex.length ? `${ex.map((d) => pn("machine", d.label)).join(", ")} left out of the burn because what ${ex.length === 1 ? "it is" : "they are"} doing right now is unknown` : "";
  }

  // ── lanes ────────────────────────────────────────────────────────────
  const laneRows = new Map();
  function laneVisible(l, now) {
    if (showUnavailable) return true;
    return (l.state === "live" || l.state === "idle") && now - l.lastAt < 60 * 60_000;
  }
  function paintLanes() {
    const now = serverNow();
    const box = $("cLanes");
    const visible = D.lanes.filter((l) => laneVisible(l, now));
    const hidden = D.lanes.length - visible.length;
    if (!visible.length) {
      laneRows.clear();
      box.innerHTML = `<div class="empty">${D.devices.length === 0
        ? "<b>No machine is reporting yet.</b> This console reads this machine once it has Claude Code or Codex transcripts, and any machine you add."
        : hidden
          ? `<b>No lane has worked in the last hour.</b> ${hidden} older or unavailable lane${hidden === 1 ? " is" : "s are"} hidden — Show unavailable draws ${hidden === 1 ? "it" : "them"}.`
          : "<b>No session has reported in the last 24 hours.</b>"}</div>`;
    } else {
      if (box.querySelector(".empty")) box.innerHTML = "";
      const keep = new Set();
      for (const l of visible) {
        keep.add(l.key);
        let row = laneRows.get(l.key);
        if (!row) { row = makeLaneRow(l); laneRows.set(l.key, row); }
        // Every lane takes its new reading at its own moment inside the poll
        // interval, so the sparks never step together. The data is the same;
        // only when each row repaints differs.
        if (!row._painted || reducedMotion.matches || paused) { fillLane(row, l, now); row._painted = true; }
        else {
          clearTimeout(row._timer);
          row._timer = setTimeout(() => fillLane(row, l, serverNow()), parseInt(l.key.slice(0, 6), 16) % 1700);
        }
        box.appendChild(row);   // moves it into sorted position
        box.appendChild(row._tree);
      }
      for (const [key, row] of laneRows) if (!keep.has(key)) { row.remove(); row._tree.remove(); laneRows.delete(key); }
    }
    // The lane burning hardest right now gets the reference's RUN treatment: rail, outline, its figure lit.
    const top = D.lanes.filter((l) => l.state === "live" && l.tokens5m > 0).sort((a, b) => b.tokens5m - a.tokens5m)[0] || null;
    for (const [key, row] of laneRows) row.classList.toggle("top", Boolean(top) && key === top.key);
    roving(box);
    const body = box.closest(".lanebody");
    if (body) watchScroll(body, "x");
    const live = D.lanes.filter((l) => l.state === "live").length;
    const idle = D.lanes.filter((l) => l.state === "idle").length;
    const silent = D.lanes.filter((l) => l.state === "silent").length;
    const gone = D.lanes.filter((l) => l.state === "revoked").length;
    const catching = D.lanes.filter((l) => l.state === "catching-up" || l.state === "reconnecting").length;
    // Idle lanes that have not worked for an hour are hidden too: say how many.
    const quiet = showUnavailable ? 0 : D.lanes.filter((l) => l.state === "idle" && !laneVisible(l, now)).length;
    const parts = [sessionWords(), `${live} live`, `${idle} idle` + (quiet ? ` (${quiet} of them idle for more than an hour, hidden)` : "")];
    // The hub draws at most 80 lanes; the count above is over every one, and the table says what share it shows.
    if (laneTotal() > D.lanes.length) parts.push(`${D.lanes.length} of ${laneTotal()} shown`);
    if (catching) parts.push(`${catching} on machines still catching up${showUnavailable ? "" : " (hidden)"}`);
    if (silent) parts.push(`${silent} on silent machines${showUnavailable ? "" : " (hidden)"}`);
    if (gone) parts.push(`${gone} on machines that left or were removed${showUnavailable ? "" : " (hidden)"}`);
    const tail = D.hub.demo ? "DEMO · every figure here is generated · never combined with a measured one" : "figures are what each machine reported · costs are list-price estimates";
    $("lFoot").innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join("") + `<span class="end">${esc(tail)}</span>`;
    watchScroll($("consoleCanvas"));
    placeGroup();
  }
  /* Rows are one tab stop at desk width (J/K and the arrows move between them); on a phone, where the cell buttons are folded
     away, every row is in the tab order so each can be reached and opened by Tab and Enter. */
  function roving(box) {
    const rows = [...box.querySelectorAll(".lane")];
    const phone = matchMedia("(max-width: 760px)").matches;
    const current = rows.find((r) => r.dataset.key === laneFocus) || rows[0];
    // On a phone the cell buttons are folded away, so the row is a button outright; at desk width it holds two buttons of its
    // own (agents, context), so it is a named, focusable group that Enter opens — a button may not contain buttons.
    for (const r of rows) { r.tabIndex = phone || r === current ? 0 : -1; r.setAttribute("role", phone ? "button" : "group"); }
  }
  /* The lane header's "24 h" group label sits over the four day columns, wherever the grid puts them. */
  function placeGroup() {
    for (const head of document.querySelectorAll(".lhead")) {
      const grp = head.querySelector(".grp"), a = head.querySelector(".c-in"), b = head.querySelector(".c-usd");
      if (!grp || !a || !b || getComputedStyle(a).display === "none") continue;
      const h = head.getBoundingClientRect(), ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      grp.style.left = (ra.left - h.left).toFixed(0) + "px";
      grp.style.right = (h.right - rb.right).toFixed(0) + "px";
    }
  }
  window.addEventListener("resize", placeGroup);

  /* A pane with more below fades its last rows until it is scrolled to the end, so a cut row reads as "more", never as a bug.
     A lane body that scrolls sideways fades its right edge the same way until it is at the end. */
  function watchScroll(el, axis = "y") {
    if (!el) return;
    const mark = () => el.classList.toggle("fademore", axis === "x"
      ? el.scrollWidth > el.clientWidth + 1 && el.scrollLeft + el.clientWidth < el.scrollWidth - 2
      : el.scrollHeight > el.clientHeight + 1 && el.scrollTop + el.clientHeight < el.scrollHeight - 2);
    if (!el._watched) { el._watched = true; el.addEventListener("scroll", mark, { passive: true }); window.addEventListener("resize", mark); }
    mark();
  }

  /* What a lane is doing, from what the hub knows and nothing more: its newest
     alert, its last tool and its calls per minute (kinds and counts only, sent by
     the machine as such), its subagents at work, a cache signal, a context that
     keeps growing — else its state in a word. Never a prompt, a tool argument or a path. */
  const DOING_KIND = { loop: "loop", spike: "spike", stall: "stall" };
  const DOING_LONG = { loop: "repeated tool call", spike: "burn spike", stall: "spending without progress" };
  const TOOL_KIND = { read: "Read", edit: "Edit", shell: "Shell", search: "Search", web: "Web", agent: "Agent", mcp: "MCP", other: "Tool" };
  const TOOL_VERB = { read: "reading", edit: "editing", shell: "running commands", search: "searching", web: "fetching", agent: "delegating", mcp: "calling MCP", other: "working" };
  /* How much of a window a machine's sharing covers (docs/COLLECTOR-CONTRACT.md, "What the console shows for them"):
     complete is the only state a zero may be drawn in; partial makes what is held a floor and what is not held
     unavailable; off, undeclared and unknown are voids, each with the reporter's own reason. */
  const COVERAGE_WHY = {
    "console-restarted": (since) => `The console restarted at ${hhmm(since)} and keeps these counts in memory: before then they are not held`,
    "sharing-started": (since) => `This machine began sharing at ${hhmm(since)}: nothing from before is held`,
    "sharing-off": () => "This machine's reporter runs without sharing it (--share-tool-activity, --share-alerts): unknown, not none",
    "reporter-undeclared": () => "This machine runs an older reporter that does not say whether it shares: unknown, not none",
    "not-heard": (since) => `Nothing from this machine's reporter since the console started${since ? " at " + hhmm(since) : ""}: unknown, not none`,
  };
  const COVERAGE_WORD = { "console-restarted": "not held", "sharing-started": "not held", "sharing-off": "not shared", "reporter-undeclared": "not declared", "not-heard": "not heard" };
  // Why "no alert" is known only since a time (alertsCoverage.since): the hour is held only from then.
  const SINCE_WHY = { "console-restarted": "the console restarted then and holds no alert from before", "sharing-started": "a watched machine began sharing then; nothing from before is held" };
  // A coverage's reason in words, for a hover: the reporter's fixed reason, or the state alone when it names none.
  const coverageWhy = (c) => (c && COVERAGE_WHY[c.reason] ? COVERAGE_WHY[c.reason](c.since) : c && c.state === "complete" ? "Shared for the whole window" : "Coverage unknown: not sent by this hub");
  // A lane's tool-activity coverage: the hub's own field, or what a 0.4-pre hub's activityShared implies.
  const activityCoverageOf = (l) => l.activityCoverage || (l.activityShared === false ? { state: "off", since: null, reason: "sharing-off" } : l.activityShared === true ? { state: "complete", since: null, reason: null } : { state: "unknown", since: null, reason: "not-heard" });
  const activityState = (l) => activityCoverageOf(l).state;
  const activityWhy = (l) => coverageWhy(activityCoverageOf(l));
  // Under partial coverage, the counts held are a floor: the mark travels with the figure, the reason on hover.
  const activityFloor = (l) => activityState(l) === "partial" && Boolean(l.activity && l.activity.calls);
  function doingOf(l, now) {
    if (l.state === "silent" || l.state === "revoked") return ["since " + hhmm(l.device.lastContactAt || l.lastAt), "quiet", "The machine's last report; what the lane has done since is unknown"];
    if (l.state === "catching-up" || l.state === "reconnecting") return ["unknown", "quiet", "Not known until the machine has sent its backlog"];
    const alert = (D.alerts || []).filter((a) => a.laneHash && a.laneHash.slice(0, 16) === l.key && !a.historical).sort((a, b) => b.at - a.at)[0];
    if (alert && now - alert.at < 60 * 60_000) return [`▲ ${DOING_KIND[alert.kind] || "alert"} ${hhmm(alert.at)}`, "warn", `${DOING_LONG[alert.kind] || "Alert"} · ${alertCause(alert)}`];
    if (l.state === "idle") return ["idle " + ago(l.lastAt, now).replace(" ago", ""), "quiet", "No tokens since " + hhmm(l.lastAt)];
    // tool activity: what the machine shares, as kinds and counts — a machine whose sharing does not cover the window is
    // marked with the reporter's reason, never shown as idle; counts held under partial coverage are a floor, marked +
    const cov = activityCoverageOf(l);
    const act = l.activity && l.activity.calls ? l.activity : null;
    if (cov.state !== "complete" && cov.state !== "partial") return [`tool ${COVERAGE_WORD[cov.reason] || "unknown"}`, "quiet", `${activityWhy(l)}; the lane may well be busy`];
    if (cov.state === "partial" && !act) return [`tool ${COVERAGE_WORD[cov.reason] || "not held"}${cov.since ? ` <em class="since">since ${hhmm(cov.since)}</em>` : ""}`, "quiet", `${activityWhy(l)}; its recent tools are unavailable, not idle`];
    if (act) {
      const calls = Object.values(act.calls).reduce((a, b) => a + (b || 0), 0);
      const res = act.results || { ok: 0, error: 0 };
      const perMin = calls / 5;
      const floor = cov.state === "partial";
      const mark = floor ? `<em class="part" title="${esc(activityWhy(l))}">+</em>` : "";
      const shellErr = act.calls.shell && res.error > 0 && res.error >= Math.max(1, Math.round(act.calls.shell / 2)) ? `${TOOL_KIND.shell.toLowerCase()} failing ${res.error}/${res.error + res.ok}${mark}` : null;
      const lead = l.lastTool && l.lastTool.kind ? `<span class="k">${esc(TOOL_KIND[l.lastTool.kind] || "Tool")}</span> · ${esc(ago(l.lastTool.at, now).replace(" ago", "").replace(/ (s|min|h)$/u, "$1"))}` : null;
      const kinds = Object.entries(act.calls).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
      const why = `Last five minutes on this machine: ${kinds.map(([k, c]) => `${c} ${TOOL_KIND[k] || k}`).join(", ") || "no tool call"} · ${res.ok} ok, ${res.error} error${floor ? ` · a floor: held only since ${hhmm(cov.since)} (${activityWhy(l).replace(/^./u, (c) => c.toLowerCase())})` : ""} · kinds and counts only, never a name, an argument or a path`;
      if (shellErr) return [`${lead ? lead + " · " : ""}${shellErr}`, "warn", why];
      if (lead) return [`${lead}${calls ? ` · ${perMin >= 1 ? Math.round(perMin) : perMin.toFixed(1)}/min${mark}` : mark}`, "", why];
      if (calls) return [`${TOOL_VERB[kinds[0][0]] || "working"} · ${perMin >= 1 ? Math.round(perMin) : perMin.toFixed(1)} calls/min${mark}`, "", why];
    }
    if (l.agents.live) return [`${l.agents.live} of ${l.agents.total} subagents`, "", "Subagents that reported in the last five minutes"];
    const brk = (l.context?.breaks || []).slice(-1)[0];
    if (brk && now - brk.at < 30 * 60_000) return [`cache ${brk.kind === "prefix-change" ? "rewrite" : "cold"} ${hhmm(brk.at)}`, "", brk.kind === "idle-gap" ? `Idle gap past the cache lifetime (${brk.gapMinutes} min)` : brk.kind === "lifetime-unknown" ? `Cache lifetime unknown (${brk.gapMinutes} min gap)` : "Possible prefix rewrite: the cache was written again"];
    if (l.context?.status === "bloated") return ["context growing", "warn", `Input per response is ${l.context.growth ? l.context.growth.toFixed(1) + "× " : ""}the first retained reading`];
    return ["responding", "", "Reported tokens within the last two minutes; no alert, subagent or cache signal"];
  }

  /* A lane's row: state, project and branch, model, the last hour drawn, then
     the numbers that cost money — five minutes, uncached input, output, the
     day, its estimate — the agents, the context, the machine and when it last
     reported. The same row serves the lanes above and the cold ones below. */
  function makeLaneRow(l) {
    const row = document.createElement("div");
    row.className = "lane";
    // The whole row is the door to the lane's inspector, by pointer and by keyboard, at every width.
    row.setAttribute("role", "button");
    row.tabIndex = -1;
    row.dataset.key = l.key;
    row.innerHTML = `<span class="st"><i></i><span></span><span class="stamp sm" title="Generated: nothing was read from any machine">DEMO</span></span><span class="pr"><b></b><em></em></span><span class="md"></span>
      <span class="sp" aria-hidden="true"></span><span class="fm r" data-src="lanes.tokens5m"></span>
      <span class="nums"><span class="num in r" data-l="in" data-src="lanes.tokensDayByClass.fresh"></span><span class="num out r" data-l="out" data-src="lanes.tokensDayByClass.output"></span><span class="num tot r" data-l="24 h" data-src="lanes.tokensDay"></span><span class="num usd r" data-l="est." data-src="lanes.costDay.usd" data-internal></span></span>
      <span class="ag r"><button type="button" aria-expanded="false"><span class="l">agents</span><span class="v"></span></button></span>
      <span class="cx r"><button type="button"><span class="l">context</span><span class="v"></span></button></span><span class="do" data-src="lanes.state"></span><span class="dv"></span><span class="la r" data-src="lanes.lastAt"></span>`;
    row._tree = document.createElement("div");
    row._tree.className = "agent-tree";
    row._tree.hidden = true;
    row.querySelector(".ag button").addEventListener("click", () => {
      openTree(row, l.key, row._tree.hidden);
      if (!row._tree.hidden && matchMedia('(max-width: 760px)').matches) {
        row.closest('.lanebody, .fold').scrollLeft = 0;
        row.parentElement.scrollLeft = 0;
      }
    });
    row.querySelector(".cx button").addEventListener("click", () => {
      const current = D?.lanes.find((item) => item.key === l.key);
      if (current) showContext(current);
    });
    // The row is the door to the lane's inspector; its two cell buttons keep their own job.
    row.addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;
      laneFocus = l.key;
      openInspect("lane", l.key, row);
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.target !== row) return;
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); laneFocus = l.key; openInspect("lane", l.key, row); }
    });
    row.addEventListener("focus", () => { laneFocus = l.key; for (const r of document.querySelectorAll(".lane.focused")) r.classList.remove("focused"); row.classList.add("focused"); roving(row.parentElement); });
    return row;
  }
  /* The agent tree opens under its lane; the URL carries it and Esc closes it. */
  function openTree(row, key, open) {
    row._tree.hidden = !open;
    row.querySelector(".ag button").setAttribute("aria-expanded", String(open));
    setHash(open ? `lane/${key}/agents` : view === "console" ? "" : view);
  }
  function closeTrees() {
    let any = false;
    for (const rows of [laneRows, coldRows]) for (const [key, row] of rows) if (!row._tree.hidden) { any = true; openTree(row, key, false); }
    return any;
  }

  function laneClassReading(l, key) {
    const cls = l.tokensDayByClass || null;
    if (!cls || cls[key] == null) return { value: null, title: "No reading: this hub does not split a lane's day by class" };
    const missing = l.tokensDayUnknown?.[key];
    if (!Number.isSafeInteger(missing)) return { value: null, title: "No reading: this hub does not report whether this lane's token class is complete" };
    const label = CLASS_LABEL[key];
    return missing > 0
      ? { value: null, title: `Incomplete: ${missing} ${missing === 1 ? "record" : "records"} did not report ${label}; ${fmt(cls[key])} known tokens in the last 24 h is a floor` }
      : { value: cls[key], title: `${fmt(cls[key])} ${label} tokens in the last 24 h, subagents included` };
  }

  function fillLane(row, l, now) {
    const demo = D.hub.demo;
    row.className = "lane " + l.state + (demo ? " sim" : "");
    // The state column says the state; DEMO is a stamp on the strip, the row's
    // cobalt edge and the footer, never a substitute for the state word.
    const word = l.state === "live" ? "LIVE" : l.state === "idle" ? "IDLE" : l.state === "revoked" ? "REMOVED"
      : l.state === "catching-up" ? "CATCHING UP" : l.state === "reconnecting" ? "RECONNECTING" : "SILENT";
    row.querySelector(".st span:not(.stamp)").textContent = word;
    row.querySelector(".st").title = l.state === "live" ? "Reported within the last two minutes" + (demo ? " (generated)" : "")
      : l.state === "idle" ? "The machine is reporting; this session has not worked for a while"
      : l.state === "catching-up" ? "The machine is still sending its backlog; what it is doing right now is not known yet"
      : l.state === "reconnecting" ? "The console restarted moments ago; this machine was reporting then and has not reconnected yet"
      : "The machine stopped reporting; what it has done since is unknown";
    const b = row.querySelector(".pr b");
    const projectName = pn("project", l.project.name);
    const branchName = pn("branch", l.branch);
    b.textContent = projectName;
    b.className = l.project.source === "hash" && !present ? "hash" : "";
    const source = l.project.source === "hash" ? "That machine did not name this project; only a salted hash reached the hub"
      : l.project.source === "label" ? "A label chosen on that machine" : "Named from this machine's own disk; never sent anywhere";
    b.title = source;
    // the branch beside the name; the whole "project · branch · tool" on hover, so nothing cut is lost
    const em = row.querySelector(".pr em");
    em.textContent = branchName || "";
    row.querySelector(".pr").title = `${projectName}${branchName ? " · " + branchName : ""} · ${TOOL[l.tool] || l.tool} · ${source}`;
    // the tool as a chip before the model, whole at every width; the model name is the part that gives way, its whole on hover
    row.querySelector(".md").innerHTML = toolChip(l.tool) + vendorMark(vendorOf(l.model)) + `<span class="mname">${esc(l.modelLabel)}</span>`;
    row.querySelector(".md").title = `${l.model} · ${TOOL[l.tool] || l.tool}`;
    row.setAttribute("aria-label", `${projectName}${branchName ? " · " + branchName : ""} · ${word.toLowerCase()} · ${l.tokensDay == null ? "tokens unknown" : fmt(l.tokensDay) + " tokens today"}: open`);
    // The lane's own hour as a wave, normalised to its own peak — the shape is the information; the absolute
    // level is the five-minute figure beside it. Nothing in the hour is a dotted baseline, never a zero wave.
    const hour = l.spark.reduce((a, b) => a + b, 0);
    const sparkKey = l.spark.join(",") + "|" + l.state;
    if (row._sparkKey !== sparkKey) {
      row._sparkKey = sparkKey;
      row.querySelector(".sp").innerHTML = sparkWave({ tokens: l.spark }, l.state === "live" && l.spark[l.spark.length - 1] > 0,
        hour > 0 ? `${fmt(hour)} tokens in the last hour, three-minute steps` : l.state === "live" || l.state === "idle" ? "Nothing in the last hour" : "Nothing reported in the last hour; the machine is " + l.state.replace("-", " "),
        { dim: l.state !== "live" && l.state !== "idle", hidden: true });
    }
    const fm = row.querySelector(".fm");
    if (l.tokens5m === null) {
      fm.textContent = "—";
      fm.className = "fm r unk";
      fm.title = "Unknown: the machine has not reported since " + hhmm(l.device.lastContactAt || l.lastAt);
    } else {
      const prev = row._last ?? l.tokens5m;
      const up = l.tokens5m >= prev;
      row._last = l.tokens5m;
      fm.className = "fm r";
      fm.title = "";
      fm.innerHTML = l.tokens5m > 0 ? `<u class="${up ? "" : "dn"}" aria-hidden="true">${up ? "▲" : "▼"}</u>${fmt(l.tokens5m)}` : "0";
    }
    // The day's tokens by class and its estimate: a hub that does not send them
    // draws a void with its reason, never a zero or a missing column.
    const numCell = (name, value, title) => {
      const el = row.querySelector(".num." + name);
      el.classList.toggle("void", value === null);
      el.textContent = value === null ? "—" : fmt(value);
      el.title = title;
    };
    for (const [name, key] of [["in", "fresh"], ["out", "output"]]) {
      const reading = laneClassReading(l, key);
      numCell(name, reading.value, reading.title);
    }
    const partialDay = Object.values(l.tokensDayUnknown || {}).some((n) => n > 0);
    numCell("tot", l.tokensDay ?? null, `${fmt(l.tokensDay)} tokens in the last 24 h, subagents included${partialDay ? "; a floor because some records did not report every class" : ""}`);
    if (partialDay && l.tokensDay != null) row.querySelector(".num.tot").textContent += "+";
    const usd = row.querySelector(".num.usd");
    const cost = l.costDay || null;
    usd.classList.toggle("void", !cost || cost.usd === null);
    usd.textContent = !cost ? "—" : cost.usd === null ? (cost.status === "none" ? "—" : "unpriced") : money(cost.usd) + (cost.status === "partial" ? "+" : "");
    usd.title = !cost ? "No reading: this hub does not price a lane's day" : cost.usd === null ? (cost.status === "none" ? "Nothing to price yet" : "No verified list price for this lane's model")
      : cost.status === "partial" ? "List-price estimate; some of this lane's records are unpriced, so this is a floor" : "List-price estimate for the last 24 h. Not an invoice.";
    const ag = row.querySelector(".ag");
    const agButton = ag.querySelector("button");
    agButton.querySelector(".v").textContent = l.agents.total ? `${l.agents.live}/${l.agents.total}` : "—";
    agButton.disabled = !l.agents.total;
    agButton.title = l.agents.total ? `${l.agents.live} subagents worked in the last five minutes, of ${l.agents.total} today. Open the agent tree.` : "No subagents";
    // The label carries the reading and the row, so a screen reader hears both.
    agButton.setAttribute("aria-label", l.agents.total ? `Agents ${l.agents.live} of ${l.agents.total} live, ${projectName}: show tree` : `No subagents, ${projectName}`);
    // Each agent against the lane's day: named by when it started, a share bar, its tokens, the observed span on hover; what the tools returned (ok and error counts) stands in for an outcome the transcripts never record.
    const laneTotalTokens = Math.max(l.tokensDay || 0, 1);
    const tree = l.agentTree || [];
    const res = l.activity && l.activity.results ? l.activity.results : null;
    const unknownN = tree.filter((agent) => agent.outcome === "unknown").length;
    row._tree.innerHTML = tree.map((agent, index) => `<div class="agent-node" style="--depth:${Math.min(agent.depth, 8)}" title="${esc(observedSpan(agent.durationMinutes))}"><span class="who">${index === 0 ? 'Orchestrator' : '↳ Subagent'}${agent.firstAt ? `<b>${hhmm(agent.firstAt)}</b>` : ""}</span><span class="agent-model">${vendorMark(vendorOf(agent.model))}${esc(agent.modelLabel)}</span><span class="abar">${agent.tokens == null ? '<span>tokens unavailable</span>' : `<i><b style="width:${Math.min(100, Math.round((agent.tokens / laneTotalTokens) * 100))}%"></b></i><span>${fmt(agent.tokens)}</span>`}</span><span>${agent.tokens == null ? '—' : pct(agent.tokens / laneTotalTokens, 0) + ' of lane'}</span><span>${agent.outcome === 'unknown' ? esc(observedSpan(agent.durationMinutes)) : esc(agent.outcome)}</span></div>`).join('')
      + (res ? `<div class="agent-foot">Tool results in the last five minutes, this lane: <span class="ok">${res.ok} ok</span> · <span class="${res.error ? "err" : ""}">${res.error} error</span>${activityFloor(l) ? ` · <span class="floor" title="${esc(activityWhy(l))}">a floor: held since ${hhmm(l.activityCoverage.since)}</span>` : ""}${unknownN ? " · the transcripts carry usage, not each agent's result" : ""}</div>`
        : unknownN ? `<div class="agent-foot">${unknownN === tree.length ? "Every" : unknownN} outcome unknown · no result recorded: the transcripts carry usage, not results${activityState(l) !== "complete" ? `; ${esc(activityWhy(l).replace(/^./u, (c) => c.toLowerCase()))}` : ""}.</div>` : "");
    // What the lane is doing now, from what the hub knows; the whole of it on hover.
    const [doing, doingCls, doingWhy] = doingOf(l, now);
    const doEl = row.querySelector(".do");
    doEl.innerHTML = doing;
    doEl.className = "do" + (doingCls ? " " + doingCls : "");
    doEl.title = `${doEl.textContent} · ${doingWhy}`;
    const cx = row.querySelector(".cx");
    cx.classList.toggle("bloated", l.context?.status === "bloated");
    cx.querySelector("button .v").textContent = l.context?.latest === null || l.context?.latest === undefined
      ? "—" : fmt(l.context.latest) + (l.context.status === "bloated" ? " ↑" : "");
    cx.title = l.context?.latest === null ? "Context unavailable: input classes were not reported" : "Latest reported input tokens per API response. Open for history and cache signals.";
    cx.querySelector("button").setAttribute("aria-label", (l.context?.latest === null || l.context?.latest === undefined
      ? "Context unavailable" : `Context ${fmt(l.context.latest)}${l.context.status === "bloated" ? ", growing" : ""}`) + `, ${projectName}: details`);
    // The machine only; its person on hover, so the cell never cuts a name short.
    const dv = row.querySelector(".dv");
    dv.innerHTML = `<b>${esc(pn("machine", l.device.label))}</b>`;
    dv.title = `${pn("machine", l.device.label)}${l.device.person ? " · " + pn("person", l.device.person) : ""}`;
    const la = row.querySelector(".la");
    la.textContent = l.state === "catching-up" ? "catching up" : l.state === "reconnecting" ? "reconnecting"
      : l.state === "silent" || l.state === "revoked" ? hhmm(l.device.lastContactAt || l.lastAt)   // the time alone: the state column says SILENT, and "since" does not fit the cell
      : l.state === "live" ? "now" : ago(l.lastAt + 60_000, now).replace(" ago", "");
    la.title = l.state === "silent" || l.state === "revoked" ? "The machine's last report · silent since " + hhmm(l.device.lastContactAt || l.lastAt) : "When this session last reported · " + hhmm(l.lastAt);
  }

  function showContext(lane, from = null) {
    openInspect("lane", lane.key, from);
    setHash(`lane/${lane.key}/context`);
    const head = $("inspectContext");
    if (head) head.scrollIntoView({ behavior: reducedMotion.matches || paused ? "auto" : "smooth", block: "start" });
  }
  /* The context of a session: the responses drawn as bars, latest lit; a cache signal ticked under the bar it followed; the extra write cost summed once.
     In its own sheet it also carries the lane's last hour and its day by class, so the sheet holds the whole reading and no raised surface stands empty. */
  function contextHtml(lane, whole = false) {
    const c = lane.context;
    const samples = c?.samples || [];
    const breaks = c?.breaks || [];
    // The responses drawn as bars, latest lit; a cache signal is a tick under the bar it followed; the extra write cost summed once.
    const top = Math.max(...samples.map((s) => s.tokens), 1);
    const breakAt = new Set(breaks.map((b) => b.at));
    const extra = breaks.reduce((a, b) => a + (b.estimatedExtraUsd || 0), 0);
    const unpricedBreaks = breaks.filter((b) => b.estimatedExtraUsd == null).length;
    const kind = (b) => b.kind === "idle-gap" ? `idle gap past cache lifetime (${b.gapMinutes} min)` : b.kind === "lifetime-unknown" ? `cache lifetime unknown (${b.gapMinutes} min gap)` : "possible prefix rewrite";
    const cls = lane.tokensDayByClass || null;
    const dayTotal = cls ? ORDER.reduce((a, k) => a + (cls[k] || 0), 0) : 0;
    const head = whole ? `<div class="iline"><span class="st ${lane.state}">${stateWord(lane.state)}</span> · <span class="mono">${esc(pn("branch", lane.branch) || TOOL[lane.tool] || lane.tool)}</span> · <span class="mono">${esc(lane.modelLabel)}</span> · <b>${esc(pn("machine", lane.device.label))}</b></div>
      <div class="ihead">Last hour <span>${fmt(lane.spark.reduce((a, b) => a + b, 0))} tokens</span></div>${isparkHtml({ spark: lane.spark }, lane.state !== "live")}
      ${cls && dayTotal > 0 ? `<div class="ihead">Day by class <span>${fmt(dayTotal)} tokens</span></div><div class="mix" role="img" aria-label="Token composition">${ORDER.map((k) => `<i class="${k}" style="flex-grow:${Math.max(cls[k] || 0, 0)}" title="${CLASS_LABEL[k]} ${pct(cls[k] / dayTotal)}"></i>`).join("")}</div><div class="legend">${ORDER.map((k) => `<span><i class="sw ${k}"></i>${CLASS_LABEL[k]} <b>${fmt(cls[k] || 0)}</b></span>`).join("")}</div>` : ""}
      <div class="ihead">Context</div>` : "";
    return head + `<p>${c?.latest == null ? "No complete input reading is available." :
      `Latest response carried <b>${fmt(c.latest)} input tokens</b>. ${c.growth == null ? "Growth needs two readings." :
        `That is ${c.growth.toFixed(1)}× the first retained reading.`} ${c.status === "bloated" ? "This session is flagged for context weight." : ""}`}</p>` +
      (samples.length ? `<div class="cbars" role="img" aria-label="${samples.length} recent responses, input tokens each">${samples.map((s, i) => `<i class="${i === samples.length - 1 ? "last" : ""}${breakAt.has(s.at) ? " brk" : ""}" style="height:${Math.max(4, Math.round((s.tokens / top) * 100))}%" title="${hhmm(s.at)} · ${fmt(s.tokens)} input tokens${breakAt.has(s.at) ? " · cache signal" : ""}"></i>`).join("")}</div><div class="cax"><span>${hhmm(samples[0].at)}</span><span>peak ${fmt(top)}</span><span>${hhmm(samples[samples.length - 1].at)}</span></div>` : "") +
      `<p>Cache signals · <b>${breaks.length ? breaks.length + " recent" : "none in retained readings"}</b>${breaks.length ? ` · extra write cost ${extra > 0 && extra < 0.005 ? "&lt; $0.01" : money(extra)} est.${unpricedBreaks ? ` · ${unpricedBreaks} unpriced` : ""}` : ""}</p>` +
      (breaks.length ? `<ol>${breaks.map((b) => `<li>${hhmm(b.at)} · ${kind(b)}</li>`).join("")}</ol>` : "") +
      `<p class="iquiet">Inferred from token counts and minute timestamps; they cannot prove the cause of a cache write. Extra cost compares observed writes with a hypothetical cache read at offline list prices (table v${esc(c?.priceTable?.version ?? "?")}, checked ${esc(c?.priceTable?.checkedOn ?? "unknown")}).</p>`;
  }

  const ALERT_LABEL = { loop: "Repeated tool call", spike: "Burn spike", stall: "Spending without progress" };
  // How far above the session's own normal an alarm is, when the hub measured it: "6.9× normal".
  const alertFactor = (a) => (Number.isFinite(a.factor) && a.factor > 0 ? `${a.factor >= 10 ? Math.round(a.factor) : a.factor.toFixed(1)}× normal` : null);
  const alertCause = (a) => a.kind === "loop" ? `Same tool and arguments ${fmt(a.tokens)} times`
    : a.kind === "spike" ? `${fmt(a.tokens)} tokens in one response${alertFactor(a) ? ` · ${fmt(a.tokens5m)} in 5 min · ${alertFactor(a)}` : " · above the session's baseline"}`
    : `${fmt(a.tokens)} tokens since the last tool success${alertFactor(a) ? ` · ${alertFactor(a)}` : ""}`;
  const alertLane = (a) => (D.lanes || []).find((item) => item.key === (a.lane && a.lane.key) || item.key === a.laneHash?.slice(0, 16)) || null;
  const alertWho = (a) => pn("project", alertLane(a)?.project?.name || (a.lane && a.lane.displayName) || (a.projectHash ? `project ${a.projectHash.slice(0, 6)}` : D.hub.demo ? "Demo session" : "Session"));
  const alertDevice = (a) => (a.deviceId && deviceOf(a.deviceId)) || alertLane(a)?.device || null;
  // Live alerts are the ones dated inside the last hour by their own line's clock; the rest are earlier today (H01), listed apart and never counted as live.
  const liveAlerts = () => (D.alerts || []).filter((a) => !a.historical);
  const earlierAlerts = () => (D.alerts || []).filter((a) => a.historical);
  const ALERT_SHOWN = 6;
  let alertsOpen = false;   // "N more" opens the whole list; it stays open until the page reloads
  const alertRow = (a, earlier = false) => `<div class="alert-row${earlier ? " earlier" : ""}" ${alertLane(a) ? `data-lane="${esc(alertLane(a).key)}" tabindex="0" role="button"` : ""} title="${esc(ALERT_LABEL[a.kind] || "Alert")} · raised ${hhmm(a.at)} by the line's own clock${a.seenAt && a.seenAt !== a.at ? ` · read ${hhmm(a.seenAt)}` : ""}${earlier ? " · earlier today, not counted as live" : ""}"><span class="sev" aria-hidden="true">▲</span><b>${ALERT_LABEL[a.kind] || "Alert"}</b>` +
    `<span class="who">${esc(alertWho(a))}${alertDevice(a) ? ` · ${esc(pn("machine", alertDevice(a).label))}` : ""}</span><span class="cause">${alertCause(a)}</span><time>${hhmm(a.at)}${D.hub.demo ? " · DEMO" : ""}</time></div>`;
  function paintAlerts() {
    const all = liveAlerts();   // newest first, as the hub lists them
    const earlier = earlierAlerts();
    $("alertPanel").hidden = all.length === 0 && earlier.length === 0;
    // The rail carries the count, the panel the words; the two always agree.
    const chip = $("alertChip");
    chip.hidden = !all.length;
    chip.innerHTML = `<span aria-hidden="true">▲</span> ${plural(all.length, "alert")}`;
    chip.title = (D.hub.demo ? "Generated alerts. " : "Live alerts in the last hour, dated by their own lines. ") + "Open the panel.";
    const shown = alertsOpen ? all : all.slice(0, ALERT_SHOWN);
    const cov = D.alertsCoverage || null;
    // the window is the hour only when every watched machine's alerts are held for the whole of it; otherwise it is known since alertsCoverage.since
    $("alertShown").textContent = (shown.length < all.length ? `${shown.length} of ${all.length} shown · ` : "") + (cov && cov.unwatched > 0 ? `${cov.watched} of ${cov.watched + cov.unwatched} machines watched` : "every machine") + (cov && Number.isFinite(cov.since) ? ` · known since ${hhmm(cov.since)}` : " · last hour");
    $("alertShown").title = cov && Number.isFinite(cov.since) ? `Alerts are held only since ${hhmm(cov.since)}: ${SINCE_WHY[cov.reason] || "unknown before"}` : "";
    const more = $("alertMore");
    more.hidden = all.length <= ALERT_SHOWN;
    more.textContent = alertsOpen ? "Show fewer" : `${all.length - ALERT_SHOWN} more`;
    $("alertRows").innerHTML = shown.map((a) => alertRow(a)).join("") || `<div class="none">No live alert in the last hour.</div>`;
    $("alertEarlierHead").hidden = earlier.length === 0;
    $("alertEarlier").innerHTML = earlier.map((a) => alertRow(a, true)).join("");
    // the sheet's own sixty minutes, the same strip the Attention card draws
    alertStrip("alertStrip", "alertStripCap", all, serverNow());
    // and the spend-by-model rows whole, which the compact frame folds away from the band
    $("alertModelsCap").textContent = "spend by model · " + PERIOD_TEXT[period][1];
    $("alertModels").innerHTML = win().models.length ? specModelRows(win(), "alertModels", 8) : `<div class="none">No model has reported yet.</div>`;
  }
  $("alertMore").addEventListener("click", () => { alertsOpen = !alertsOpen; if (D) paintAlerts(); });
  /* Sixty minutes, one tick per live alert, hatched from the moment a machine went silent. */
  function alertStrip(svgId, capId, alerts, now) {
    const W = 520, H = 18, span = 60 * 60_000;
    const ticks = alerts.filter((a) => now - a.at < span).map((a) => { const x = ((a.at - (now - span)) / span) * W; return `<rect class="tick" x="${(x - 1.5).toFixed(1)}" y="3" width="3" height="${H - 6}" rx="1"><title>${esc(ALERT_LABEL[a.kind] || "Alert")} · ${hhmm(a.at)}</title></rect>`; });
    const gap = D.silentSince && D.silentSince > now - span ? `<rect class="gap" x="${(((D.silentSince - (now - span)) / span) * W).toFixed(1)}" y="0" width="${(W - ((D.silentSince - (now - span)) / span) * W).toFixed(1)}" height="${H}"/>` : "";
    // and hatched up to the time from which alerts are held at all (alertsCoverage.since): before it, quiet is not "no alert"
    const cov = D.alertsCoverage || null;
    const known = cov && Number.isFinite(cov.since) && cov.since > now - span ? cov.since : null;
    const before = known ? `<rect class="gap unknown" x="0" y="0" width="${(((known - (now - span)) / span) * W).toFixed(1)}" height="${H}"><title>Before ${hhmm(known)} alerts are not held: ${esc(SINCE_WHY[cov.reason] || "unknown")}</title></rect>` : "";
    $(svgId).innerHTML = `<line class="base" x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}"/>` + before + gap + ticks.join("");
    $(capId).textContent = (ticks.length ? plural(ticks.length, "alert") : "no alert") + (known ? ` · since ${hhmm(known)}` : "");
    $(capId).title = [known ? `Hatched to ${hhmm(known)}: alerts are held only from then (${SINCE_WHY[cov.reason] || "unknown before"})` : "",
      D.silentSince && D.silentSince > now - span ? `Hatched from ${hhmm(D.silentSince)}: a machine went silent, so alerts from it cannot be known` : "One tick per alert in the last sixty minutes"].filter(Boolean).join(" · ");
  }
  /* The Team canvas lists today's alerts, live and earlier, each named for its machine. */
  function paintTeamAlerts() {
    const all = D.alerts || [];
    const live = liveAlerts().length;
    const cov = D.alertsCoverage || null;
    const known = cov && Number.isFinite(cov.since) ? cov.since : null;
    $("teamAlertCount").textContent = (all.length ? `${plural(all.length, "alert")} · ${live} live` : "none today") + (cov && cov.unwatched > 0 ? ` · ${plural(cov.unwatched, "machine")} not watched` : "") + (known ? ` · known since ${hhmm(known)}` : "");
    $("teamAlertCount").title = [cov && cov.unwatched > 0 ? `${cov.unwatchedDevices.map((id) => pn("machine", (deviceOf(id) || { label: id }).label)).join(", ")}: the reporter there does not share alerts (--share-alerts is off), so their silence is not "no alert"` : "Every current machine shares its alerts",
      known ? `held only since ${hhmm(known)}: ${SINCE_WHY[cov.reason] || "unknown before"}` : ""].filter(Boolean).join(" · ");
    $("teamAlerts").innerHTML = all.length ? all.map((a) => alertRow(a, Boolean(a.historical))).join("") : `<div class="none">No alert ${known ? `held since ${hhmm(known)}` : "has been raised today"}${cov && cov.unwatched > 0 ? ` on the ${plural(cov.watched, "watched machine")}` : ""}.</div>`;
  }

  // ── attention: the one thing that needs it ───────────────────────────
  /* Ranked: a burn spike, then spending without progress, then a loop, then
     an unpriced model in the estimate, then a silent machine. Quiet when
     nothing needs it — the panel never invents an alarm. */
  function paintAttention() {
    const box = $("attention");
    const w = win();
    const alerts = liveAlerts();
    const earlier = earlierAlerts();
    const order = { spike: 0, stall: 1, loop: 2 };
    // The hero: the worst kind first, the newest of that kind — a spike over a stall over a loop.
    const top = alerts.slice().sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3) || b.at - a.at)[0] || null;
    const silent = D.devices.filter((d) => d.status === "silent");
    const catching = D.devices.filter((d) => d.status === "catching-up" || d.status === "reconnecting");
    const unpriced = w.cost.status === "partial" || w.cost.status === "unpriced" ? w.cost.unpricedModels : [];
    const cov = D.alertsCoverage || null;
    const unwatched = cov && cov.unwatched > 0 ? cov.unwatched : 0;
    // "no alert" is known only from this time (H03): before it a watched machine's alerts are not held
    const known = cov && Number.isFinite(cov.since) ? cov.since : null;
    const current = currentDevices().length;
    let head, line, foot, hot = true;
    if (top) {
      const lane = alertLane(top);
      head = ALERT_LABEL[top.kind] || "Alert";
      const who = `<b>${esc(alertWho(top))}</b>${lane?.branch ? ` <em>${esc(pn("branch", lane.branch))}</em>` : ""}${alertDevice(top) ? ` · ${esc(pn("machine", alertDevice(top).label))}` : ""}`;
      const measure = top.kind === "spike" && Number.isFinite(top.tokens5m) ? `${fmt(top.tokens5m)} tokens / 5 min${alertFactor(top) ? ` · <span class="x">${alertFactor(top)}</span>` : ""}`
        : top.kind === "stall" ? `${fmt(top.tokens)} tokens since the last tool success${alertFactor(top) ? ` · <span class="x">${alertFactor(top)}</span>` : ""}`
        : `same tool and arguments ${fmt(top.tokens)} times`;
      line = `${who} · ${measure}`;
      foot = `<time>${hhmm(top.at)}</time>${D.hub.demo ? " · DEMO" : ""}${Number.isFinite(top.median5m) ? ` · normal ${fmt(top.median5m)} / 5 min` : ""}` + (lane ? `<button class="linkbtn" type="button" data-lane="${esc(lane.key)}">Open lane →</button>` : "");
    } else if (unpriced.length) {
      head = "Unpriced model in use";
      line = `<em>${esc(unpriced.join(", "))}</em> · ${fmt(w.cost.unpricedTokens)} tokens with no verified list price`;
      foot = w.cost.status === "unpriced" ? "The estimate shows no dollar figure until a priced model reports." : "Left out of the estimate, which is therefore a floor.";
    } else if (silent.length) {
      head = plural(silent.length, "machine") + " silent";
      line = `<em>${esc(silent.map((d) => pn("machine", d.label)).join(", "))}</em> · silent since ${hhmm(silent[0].lastContactAt)}`;
      foot = "What it has done since is unknown; the chart is incomplete from then.";
    } else if (catching.length) {
      head = plural(catching.length, "machine") + " catching up";
      line = `<em>${esc(catching.map((d) => pn("machine", d.label)).join(", "))}</em> · ${esc(catchUpText(catching[0]))}`;
      foot = "Its figures are incomplete until the backlog is in.";
      hot = false;
    } else {
      // "no alert" is only said for the machines that are watched, and only from the time their alerts are held; the others
      // are named as not watched, never read as quiet
      const unwatchedNames = unwatched ? cov.unwatchedDevices.map((id) => pn("machine", (deviceOf(id) || { label: id }).label)).join(", ") : "";
      head = !D.devices.length ? "No machine yet" : known ? `No alert since ${hhmm(known)}` : unwatched ? `No alert on ${cov.watched === 1 && D.devices.some((d) => d.local && cov.watched) ? "this machine" : plural(cov.watched, "watched machine")}` : "Nothing needs attention";
      line = !D.devices.length ? "Add a machine, or run the console where Claude Code or Codex transcripts are."
        : known ? `<em>${esc(SINCE_WHY[cov.reason] || "alerts are held only since then")}</em>${unwatched ? ` · ${plural(unwatched, "machine")} not watched: <em>${esc(unwatchedNames)}</em>` : " · every model priced, every machine reporting"}.`
        : unwatched ? `${plural(unwatched, "machine")} not watched: <em>${esc(unwatchedNames)}</em> · every model priced, every machine reporting.`
        : "No alert in the last hour, every model priced, every machine reporting.";
      foot = known ? `Not held before ${hhmm(known)}: quiet then is not "no alert".` : unwatched ? "A reporter shares its alerts only with --share-alerts; until then its silence is not \"no alert\"." : "";
      hot = false;
    }
    box.classList.toggle("hot", hot);
    $("attnHead").textContent = head;
    $("attnLine").innerHTML = line;
    $("attnLine").title = $("attnLine").textContent;
    // a foot that is a sentence gives way at its end with the whole on hover; the alert's foot keeps its time and its door
    $("attnFoot").innerHTML = top ? foot : foot ? `<span class="ft">${foot}</span>` : "";
    $("attnFoot").title = top ? "" : $("attnFoot").textContent;
    // "0 alerts · last hour" is only said when every current machine is watched for the whole hour; otherwise the count names its coverage: since when, or how many watched.
    // ordered parts that drop whole from the least important when the caption is tight, the whole line on hover — never a cut word
    const stat = [{ html: `<b>${alerts.length}</b> ${alerts.length === 1 ? "alert" : "alerts"}`, pri: 0 }, { html: known ? `since ${hhmm(known)}` : cov && unwatched ? `${cov.watched} of ${current} watched` : "last hour", pri: 1 }];
    if (unpriced.length) stat.push({ html: `<span class="tag" title="${esc(unpriced.join(", "))}">${unpriced.length} unpriced</span>`, text: `${unpriced.length} unpriced`, pri: 2 });
    if (silent.length && top) stat.push({ html: `<b>${silent.length}</b> silent`, pri: 3 });
    if (catching.length && (top || unpriced.length || silent.length)) stat.push({ html: `<b>${catching.length}</b> catching up`, pri: 4 });
    fitLine($("attnStat"), stat, cov ? ` · ${cov.watched} of ${current} current machines share their alerts${unwatched ? `; not watched: ${cov.unwatchedDevices.map((id) => pn("machine", (deviceOf(id) || { label: id }).label)).join(", ")}` : ""}${known ? `; held only since ${hhmm(known)}: ${SINCE_WHY[cov.reason] || "unknown before"}` : ""}` : "");
    // The other current alerts as compact rows, newest first, each the door to its lane; earlier ones under a rule, never counted as live.
    const rest = alerts.filter((a) => a !== top).sort((a, b) => b.at - a.at);
    const rows = rest.slice(0, 2);
    // one line per row: the kind whole, the lane's name giving way, and the whole of it — kind, lane, cause, time — on the row's hover
    const row = (a, cls = "") => { const lane = alertLane(a); const name = lane ? `${pn("project", lane.project.name)}${lane.branch ? " · " + pn("branch", lane.branch) : ""}` : ""; return `<div class="arow${cls}" ${lane ? `data-lane="${esc(lane.key)}"` : "data-alerts"} tabindex="0" role="button" title="${esc(ALERT_LABEL[a.kind] || "Alert")}${name ? ` · ${esc(name)}` : ""} · ${esc(alertCause(a))} · ${hhmm(a.at)} · ${lane ? "open the lane" : "open the alert list"}"><span class="sev" aria-hidden="true"></span><b><span>${ALERT_LABEL[a.kind] || "Alert"}</span>${lane ? `<em>${esc(name)}</em>` : ""}</b><time>${hhmm(a.at)}${D.hub.demo ? " · DEMO" : ""}</time><span class="cause">${alertCause(a)}</span></div>`; };
    $("attnList").innerHTML = rows.map((a) => row(a)).join("")
      + (rest.length > rows.length ? `<button type="button" class="more" data-alerts>${rest.length - rows.length} more</button>` : "")
      + (earlier.length && !rest.length ? `<div class="rule">earlier · ${plural(earlier.length, "alert")}</div>` + earlier.slice(0, 2).map((a) => row(a, " earlier")).join("") : "");
    // The card's own series: sixty minutes, one tick per live alert, hatched from the moment a machine went silent.
    alertStrip("attnStrip", "attnStripCap", alerts, serverNow());
  }
  /* Moving to a lane moves DOM focus to its row (document.activeElement is the row), so J/K, the palette and an alert row all land where the keyboard can act. */
  function focusLane(key, open = false) {
    const row = laneRows.get(key) || coldRows.get(key);
    if (!row) return false;
    if (coldRows.has(key)) $("foldCold").open = true;
    if (view !== "console") show("console");
    row.scrollIntoView({ behavior: reducedMotion.matches || paused ? "auto" : "smooth", block: "center" });
    for (const r of document.querySelectorAll(".lane.focused")) r.classList.remove("focused");
    row.classList.add("focused");
    laneFocus = key;
    roving(row.parentElement);
    row.focus({ preventScroll: true });
    if (open) { const lane = D.lanes.find((l) => l.key === key); if (lane) openInspect("lane", key, row); }
    return true;
  }
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-alerts]")) { openAlerts(ev.target.closest("[data-alerts]")); return; }
    const go = ev.target.closest("[data-lane]"); if (!go) return;
    if (go.closest("dialog")) go.closest("dialog").close();
    // an Attention row whose lane is not on the canvas (hidden, or gone) still opens: the alert list carries it
    if (!focusLane(go.dataset.lane) && go.classList.contains("arow")) openAlerts(go);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const door = ev.target.closest && ev.target.closest("[role='button'][data-lane], [role='button'][data-alerts], [role='button'][data-inspect]");
    if (!door || ev.target.tagName === "BUTTON") return;
    ev.preventDefault(); door.click();
  });

  // ── spend spectrum: cost share over token share ───────────────────────
  /* Two bars: the estimate split by class, over the tokens split by class,
     joined by bands so the eye sees where a small share of tokens becomes a
     large share of the money. Dollars that could not be split are hatched. */
  function paintSpectrum() {
    const w = win();
    const wrap = $("specWrap"), svg = $("cSpec");
    const t = w.tokens, byClass = w.cost.byClass || null;
    const total = t.total;
    const usd = byClass ? CLASSES.reduce((sum, k) => sum + byClass[k], 0) + byClass.unsplitUsd : 0;
    const none = D.devices.length === 0 && total === 0;
    const void_ = none || !byClass || usd <= 0 || total <= 0;
    wrap.classList.toggle("void", void_);
    $("specCap").innerHTML = none ? "—" : `<b>${w.cost.usd === null ? "—" : money(w.cost.usd)}</b> est. · <b>${fmt(total)}</b> tokens · ${esc(PERIOD_TEXT[period][1])}`;
    if (void_) {
      $("specReason").textContent = none ? "No machine has reported yet." : !byClass && w.cost.status === "unpriced"
        ? `${w.cost.unpricedModels.join(", ")}: no verified list price, so no dollar share to draw.`
        : !byClass ? "This hub does not split its estimate by class." : "Nothing has been priced in this period.";
      svg.innerHTML = "";
      $("specLegend").innerHTML = "";
    } else {
      // two 22px bars; any segment wide enough (≥ 12 %) carries its class and its dollars printed inside, in the ink the ramp's end needs;
      // the compact frame draws the cost bar alone (the token bar's shares stay in the legend's title and the aria label)
      const compact = compactMQ.matches;
      const W = 520, TOP = [2, 24], BOT = [36, 58];
      svg.setAttribute("viewBox", compact ? "0 0 520 24" : "0 0 520 60");
      const floor = w.cost.status === "partial" ? "+" : "";
      let x1 = 0, x2 = 0, parts = [];
      const cost = ORDER.map((k) => [k, byClass[k] / usd]).concat(byClass.unsplitUsd > 0 ? [["unsplit", byClass.unsplitUsd / usd]] : []);
      const tok = ORDER.map((k) => [k, t[k] / total]);
      const seg = (k, x, wdt, y) => `<rect class="${k}" x="${x.toFixed(1)}" y="${y[0]}" width="${Math.max(0, wdt).toFixed(1)}" height="${y[1] - y[0]}"/>`;
      // the light end of the ramp (output, cache write) takes dark ink on dark; the dark end (input, cache read) takes white — reversed on the light theme, where the ramp is reversed
      const dark = currentTheme() === "dark";
      const inkFor = (k) => (dark ? (k === "output" || k === "cacheWrite" ? "onlight" : "ondark") : (k === "output" || k === "cacheWrite" ? "ondark" : "onlight"));
      const label = (k, x, wdt, y, text) => wdt >= W * 0.12 ? `<text class="${inkFor(k)}" x="${(x + 6).toFixed(1)}" y="${(y[0] + 15).toFixed(1)}" textLength="${Math.min(wdt - 12, text.length * 6.6).toFixed(1)}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>` : "";
      let out = "";
      const topX = {}, botX = {};
      for (const [k, share] of cost) { const wdt = share * W; out += seg(k, x1, wdt, TOP); if (k !== "unsplit") out += label(k, x1, wdt, TOP, `${CLASS_LABEL[k].replace("uncached ", "")} · ${money(byClass[k])}${floor} est.`); topX[k] = [x1, x1 + wdt]; x1 += wdt; }
      if (!compact) {
        for (const [k, share] of tok) { const wdt = share * W; out += seg(k, x2, wdt, BOT); out += label(k, x2, wdt, BOT, `${CLASS_LABEL[k].replace("uncached ", "")} · ${fmt(t[k])}`); botX[k] = [x2, x2 + wdt]; x2 += wdt; }
        for (const k of CLASSES) {
          const a = topX[k], b = botX[k];
          if (!a || !b) continue;
          parts.push(`<polygon class="${k} band" points="${a[0].toFixed(1)},${TOP[1]} ${a[1].toFixed(1)},${TOP[1]} ${b[1].toFixed(1)},${BOT[0]} ${b[0].toFixed(1)},${BOT[0]}"/>`);
        }
      }
      svg.innerHTML = parts.join("") + out + `<rect class="edge" x="0" y="${TOP[0]}" width="${W}" height="${TOP[1] - TOP[0]}"/>` + (compact ? "" : `<rect class="edge" x="0" y="${BOT[0]}" width="${W}" height="${BOT[1] - BOT[0]}"/>`);
      svg.setAttribute("aria-label", "Cost share over token share: " + ORDER.map((k) => `${CLASS_LABEL[k]} ${pct(byClass[k] / usd, 0)} of cost, ${pct(t[k] / total, 0)} of tokens`).join("; ") + (floor ? `; the estimate is a floor: ${w.cost.unpricedModels.join(", ")} unpriced` : ""));
      const partialWhy = floor ? ` · a floor: ${w.cost.unpricedModels.join(", ")} unpriced` : "";
      $("specLegend").innerHTML = ORDER.map((k) => `<span title="${esc(CLASS_LABEL[k])}: ${money(byClass[k])}${floor} est. · ${pct(byClass[k] / usd)} of the estimate · ${pct(t[k] / total)} of tokens${esc(partialWhy)}"><i class="sw ${k}"></i>${CLASS_LABEL[k].replace("uncached ", "")} <b>${pct(byClass[k] / usd, 0)}</b><em>est.</em><em class="sep">·</em><b>${pct(t[k] / total, 0)}</b><em>tok</em></span>`).join("");
    }
    // Per model: its share of the money over its share of the tokens; the rest opens in place. The alerts sheet carries the same rows whole.
    $("specModels").innerHTML = specModelRows(w, "specModels", 3);
  }
  /* Each model's share of the money over its share of the tokens: a share too small to see is still 8px wide, never a bar that vanishes; an unpriced model is hatched and named. */
  function specModelRows(w, boxId, limit) {
    const open = moreOpen.has(boxId);
    const models = open ? w.models : w.models.slice(0, limit);
    const usdAll = w.cost.usd || 0;
    const floor = w.cost.status === "partial" ? "+" : "";
    const wid = (share) => (share > 0 ? `max(8px, ${Math.round(share * 100)}%)` : "0");
    return models.map((m) => `<div class="srow" title="${esc(m.model)}: ${pct(m.share)} of tokens · ${m.usd === null ? "unpriced" : money(m.usd) + " est." + (usdAll ? " · " + pct(m.usd / usdAll) + " of the estimate" : "")} · ${asOf()}" data-src="windows.models">
        <span class="mn"><span class="txt">${esc(m.label)}</span></span>
        <span class="sbars${m.usd === null ? " unp" : ""}" aria-hidden="true"><i><b style="width:${m.usd === null ? "100%" : wid(usdAll ? m.usd / usdAll : 0)}"></b></i><i><b style="width:${wid(m.share)}"></b></i></span>
        ${m.usd === null ? `<span class="sc void">unpriced</span>` : `<span class="sc" data-internal>${money(m.usd)}${floor ? `<em class="part">+</em>` : ""}</span>`}
      </div>`).join("") + (w.models.length > limit ? `<button type="button" class="more" data-more="${boxId}">${open ? "fewer" : `${w.models.length - limit} more`}</button>` : "");
  }
  compactMQ.addEventListener?.("change", () => { if (D) { paintSpectrum(); paintMachines(); placeGroup(); for (const el of fitted) fitOne(el); } });

  // ── burn: the last sixty minutes drawn ────────────────────────────────
  /* One bar per minute from the hour series, every machine; the newest minute
     is drawn as a rate over the part of it that has elapsed. The dashed rule
     is the median of completed minutes with recorded usage. Empty bins can
     mean idle or unobserved: this series cannot establish an all-minute median. */
  function paintBurnSpark() {
    const s = D.series["1h"];
    const wrap = $("burnWrap"), svg = $("cBurnSpark");
    const excludedAll = D.devices.length > 0 && D.burn.reporting === 0;
    const none = D.devices.length === 0;
    wrap.classList.toggle("void", none || excludedAll || !s);
    if (none || excludedAll || !s) {
      $("burnReason").textContent = none ? "No machine has reported yet." : "No machine is reporting right now; nothing is estimated in its place.";
      svg.innerHTML = "";
      $("burnMedian").textContent = "—";
      $("burnGapNote").innerHTML = "";
      return;
    }
    const vals = s.values.slice();
    const n = vals.length, W = 520, H = 44;
    // the minute still filling: measured as it is, and what it would be at this pace, drawn as a hatched cap
    const elapsed = Math.max(0.1, Math.min(1, (D.now - (s.start + s.step * (n - 1))) / s.step));
    const projected = vals[n - 1] / elapsed;
    const whole = vals.slice(0, -1).filter((v) => v > 0).sort((a, b) => a - b);
    const middle = Math.floor(whole.length / 2);
    const median = whole.length ? (whole[middle] + whole[Math.ceil(whole.length / 2) - 1]) / 2 : null;
    const max = Math.max(...vals, projected, 1) * 1.06;
    const xOf = (i) => (i / (n - 1)) * W;
    const yOf = (v) => H - 1 - (Math.max(0, v) / max) * (H - 4);
    const pts = vals.map((v, i) => [xOf(i), yOf(v)]);
    const line = smooth(pts);
    // From the moment a machine went silent the series is incomplete: the same hatch the chart draws, the reason on the line above.
    const silentX = D.silentSince && D.silentSince > s.start ? ((D.silentSince - s.start) / (s.step * n)) * W : null;
    svg.innerHTML = (silentX !== null ? `<rect class="gap" x="${silentX.toFixed(1)}" y="0" width="${(W - silentX).toFixed(1)}" height="${H}"/>` : "")
      + `<path class="area" d="${line}L${W} ${H}L0 ${H}Z"/><path class="line" d="${line}"/>`
      + `<circle class="now" cx="${W}" cy="${yOf(vals[n - 1]).toFixed(1)}" r="2"/>`
      + (projected > vals[n - 1] && vals[n - 1] > 0 ? `<rect class="cap-step" x="${xOf(n - 1.5).toFixed(1)}" y="${yOf(projected).toFixed(1)}" width="${(W - xOf(n - 1.5)).toFixed(1)}" height="${Math.max(0, yOf(vals[n - 1]) - yOf(projected)).toFixed(1)}"><title>${fmt(vals[n - 1])} so far this minute · ${fmt(projected)} projected at this pace</title></rect>` : "")
      + (median > 0 ? `<line class="median" x1="0" x2="${W}" y1="${yOf(median).toFixed(1)}" y2="${yOf(median).toFixed(1)}"/>` : "");
    $("burnGapNote").innerHTML = silentX !== null ? `<b>incomplete from ${hhmm(D.silentSince)}</b>` : "";
    $("burnMedian").innerHTML = median !== null ? `median active minute <b>${fmt(median)}</b>` : "No usage recorded in completed minutes";
    $("burnMedian").title = "Median of completed minutes with recorded tokens, across every machine in the last hour. Empty minutes may be idle or unobserved and are excluded; missing token classes make readings floors.";
    svg.setAttribute("aria-label", `Recorded tokens per minute over the last 60 minutes; ${median === null ? "no usage recorded in completed minutes" : `median active minute ${fmt(median)} tokens; idle and unobserved minutes excluded`}`);
  }

  // ── the rest of the day, folded under the lanes ───────────────────────
  /* Cold sessions are the lanes the list above hides: idle for more than an
     hour, or on a machine that is silent, catching up or gone. Projects,
     Effort and Shipped come from this machine's own transcripts and Git
     history (/api/projects), read at most once a minute per period. */
  const coldRows = new Map();
  let foldFetched = { key: null, at: 0, data: null, error: null };
  async function loadFold() {
    const now = serverNow();
    const cold = showUnavailable ? [] : D.lanes.filter((l) => !laneVisible(l, now));
    const coldTokens = cold.reduce((sum, l) => sum + (l.tokensDay || 0), 0);
    summary("coldSum", showUnavailable ? [{ html: "shown above · Show unavailable is on", pri: 0 }]
      : cold.length ? [{ html: `<b>${cold.length}</b> ${cold.length === 1 ? "session" : "sessions"}`, pri: 0 }, { html: `<b>${fmt(coldTokens)}</b> tokens · 24 h`, pri: 1 },
        laneTotal() > D.lanes.length ? { html: `${laneTotal() - D.lanes.length} more not sent by the hub`, pri: 2 } : null]
      : [{ html: "none · every session of the day is above", pri: 0 }], cold.length ? " · idle for more than an hour, or on a machine that is silent, catching up or gone · open" : " · open");
    const box = $("coldLanes");
    if (!cold.length) { box.innerHTML = ""; coldRows.clear(); }
    else {
      const keep = new Set();
      for (const l of cold) {
        keep.add(l.key);
        let row = coldRows.get(l.key);
        if (!row) { row = makeLaneRow(l); coldRows.set(l.key, row); }
        fillLane(row, l, now);
        box.appendChild(row); box.appendChild(row._tree);
      }
      for (const [key, row] of coldRows) if (!keep.has(key)) { row.remove(); row._tree.remove(); coldRows.delete(key); }
      roving(box);
    }
    // Projects, Effort, Shipped: one read per minute per period, never on every poll.
    const key = period;
    if (foldFetched.key === key && performance.now() - foldFetched.at < 60_000) return;
    foldFetched = { key, at: performance.now(), data: null, error: null };
    try {
      const r = await fetch("/api/projects?period=" + key, { headers: HEADERS });
      const p = await r.json();
      if (!r.ok) throw new Error(p.reason || String(r.status));
      if (foldFetched.key !== key) return;
      foldFetched.data = p;
    } catch (error) {
      foldFetched.error = error.message;
    }
    paintFold();
  }
  function paintFold() {
    const p = foldFetched.data;
    const label = PERIOD_TEXT[period][1];
    if (!p) {
      const why = foldFetched.error ? `This machine's projects could not be read: ${esc(foldFetched.error)}` : "Reading this machine…";
      for (const id of ["projSum", "effortSum", "shipSum"]) $(id).textContent = foldFetched.error ? "unavailable" : "—";
      for (const id of ["foldProjBody", "foldEffortBody", "foldShipBody"]) $(id).innerHTML = `<div class="note">${why}</div>`;
      return;
    }
    const t = p.totals;
    const stamp = p.demo ? "DEMO · " : "";
    // The fleet's figures come from the same /api/projects answer, computed at the same clock as its own rows — never from a separate poll.
    const fleet = fleetOf(p);
    const w = fleet || win();
    const fleetUsd = fleet ? fleet.cost.usd : w.cost.usd;
    const fleetStatus = fleet ? fleet.cost.status : w.cost.status;
    const clampNote = fleet && p.tokens > fleet.tokens ? ` <span class="clamp" title="This machine's transcripts count more than the fleet total computed at the same clock; the fleet figure is shown as the larger of the two">≥</span>` : "";
    const stampPart = stamp ? { html: "DEMO", text: "DEMO", pri: 0 } : null;
    const notGit = p.projects.length - p.withRepo;
    const kept = !(p.period && p.period.sessionsKept === false);
    summary("projSum", [stampPart, { html: `<b>${p.projects.length}</b> ${p.projects.length === 1 ? "project" : "projects"}`, pri: 0 }, { html: `<b>${p.withRepo}</b> in Git`, pri: 1 }, { html: `this machine · ${esc(label)}`, pri: 2 }], " · open");
    // a folder outside Git, and a period whose sessions and branches are not kept, are said once over the table, never once per row
    const once = [notGit ? `${notGit} of ${p.projects.length} not in Git` : "", kept ? "" : "sessions and branches not kept at " + label + " (read from the daily rollup)"].filter(Boolean).join(" · ");
    $("foldProjBody").innerHTML = p.projects.length ? `<table class="grid"><thead><tr><th scope="col">Project</th><th scope="col" class="r">Tokens</th><th scope="col" class="r">Est. $</th><th scope="col" class="r">Sessions</th><th scope="col" class="r">Commits</th><th scope="col" class="r">Lines + / −</th><th scope="col" class="r">$ / commit</th><th scope="col">Branches</th></tr></thead><tbody>`
      + p.projects.map((x) => `<tr><td><b>${esc(pn("project", x.name))}</b></td>
        <td class="num r">${fmt(x.tokens)}</td><td class="num r">${x.usd === null ? "unpriced" : money(x.usd) + (x.cost && x.cost.status === "partial" ? "+" : "")}</td><td class="num r">${x.sessions === null ? na("—", "Sessions are kept with the minute detail (8 days), not with the daily rollup this period reads") : x.sessions}</td>
        <td class="num r">${x.repo ? x.repo.commits : na("—", "Not a Git repository: nothing to count")}</td><td class="num r">${x.repo ? `+${fmt(x.repo.added)} / −${fmt(x.repo.removed)}` : na("—", "Not a Git repository: nothing to count")}</td>
        <td class="num r">${x.costPerOutcome.perCommitUsd === null ? (x.repo ? na("unpriced", "No verified list price for what ran here") : na("—", "Not a Git repository: nothing to count")) : money(x.costPerOutcome.perCommitUsd)}</td>
        <td class="num mono">${esc((x.branches || []).slice(0, 3).map((b) => pn("branch", b)).join(", ")) || (p.period && p.period.branchesKept === false ? na("—", "Branches are kept with the minute detail (8 days), not with the daily rollup this period reads") : na("—", "No branch name reached the console from this project's sessions"))}</td></tr>`).join("") + `</tbody></table><div class="note">${once ? esc(once) + " · " : ""}This machine only. $ / commit is spend in the window of the work, not attribution. <button class="linkbtn" type="button" data-go="projects">Projects view →</button></div>`
      : `<div class="note">No project on this machine has transcripts in this period.</div>`;
    // Git nobody could read is a void with the hub's reason, never "0 commits"
    const unread = gitUnread(t);
    summary("effortSum", [stampPart, { html: `<b>${fmt(Math.max(w.tokens.total, fleet ? Math.min(p.tokens, w.tokens.total) : 0))}</b>${clampNote} tokens`, pri: 0 },
      { html: `<b>${fleetUsd === null ? "unpriced" : money(fleetUsd) + (fleetStatus === "partial" ? "+" : "")}</b> est.`, pri: 1 },
      unread ? { html: `<span class="void" title="${esc(gitWhy(t))}">${esc(gitWhy(t))}</span>`, text: gitWhy(t), pri: 2 } : { html: `<b>${plural(t.commits, "commit")}</b> on this machine`, pri: 2 }, { html: esc(label), pri: 3 }],
      fleet ? ` · fleet and this machine computed at ${hhmm(p.computedAt)} in one answer · open` : " · fleet figures from the console reading · open");
    $("foldEffortBody").innerHTML = effortTable(p, w, label);
    summary("shipSum", unread ? [stampPart, { html: `<span class="void">${esc(gitWhy(t))}</span>`, text: gitWhy(t), pri: 0 }, { html: `this machine · ${esc(label)}`, pri: 1 }]
      : [stampPart, { html: `<b>${plural(t.commits, "commit")}</b>`, pri: 0 }, { html: `<b>${t.prsMerged === null ? "no remote" : t.prsMerged}</b> referencing #N`, pri: 1 },
        { html: gitLines(t) ? `<span class="void">lines not read</span>` : `<b>+${fmt(t.added)}</b> / <b>−${fmt(t.removed)}</b> lines`, pri: 2 }, { html: `this machine · ${esc(label)}`, pri: 3 }], " · open");
    $("foldShipBody").innerHTML = shippedTable(p);
    if (view === "projects") paintProjectsEffort(p, label);
  }
  /* A fold's summary: fitted parts on the strip's button (the least important drop whole when the strip is tight, the whole on hover),
     and the same parts whole on the fold's own row, which is what the phone shows. */
  function summary(id, parts, tail = "") {
    fitLine($(id), parts, tail);
    const row = $(id + "Row");
    if (row) { row.innerHTML = $(id).innerHTML.replace(/ hidden=""/gu, ""); row.title = $(id).title.replace(/ · open$/u, ""); }
  }
  /* The fleet for a period from /api/projects, when the hub sends it (H08): the same clock as the rows. */
  const fleetOf = (p) => (p && p.fleet && p.fleet[period] && p.fleet[period].tokens != null ? { tokens: { total: p.fleet[period].tokens }, cost: p.fleet[period].cost || { usd: null, status: "none" }, messages: null } : null);
  function effortTable(p, w, label) {
    const t = p.totals;
    return `<table class="grid"><thead><tr><th scope="col">Effort · ${esc(label)}</th><th scope="col" class="r">Every machine</th><th scope="col" class="r">This machine's Git</th></tr></thead><tbody>
      <tr><td>Tokens</td><td class="num r">${fmt(w.tokens.total)}</td><td class="num r">${fmt(p.tokens)}<span class="sub">this machine's transcripts</span></td></tr>
      <tr><td>Estimate</td><td class="num r">${w.cost.usd === null ? "unpriced" : money(w.cost.usd) + (w.cost.status === "partial" ? " · partial" : "")}</td><td class="num r">—<span class="sub">see each project's matched $ / commit</span></td></tr>
      <tr><td>Messages</td><td class="num r">${w.messages == null ? "—" : w.messages.toLocaleString("en-US")}</td><td class="num r">${p.sessions === null ? "not kept" : plural(p.sessions, "session")}</td></tr>
      <tr><td>Commits</td><td class="num r">—</td><td class="num r">${gitUnread(t) ? na("—", gitWhy(t), true, true) + `<span class="sub">${esc(gitWhy(t))}</span>` : t.commits.toLocaleString("en-US") + (p.author === true ? `<span class="sub">yours, by this machine's Git email</span>` : p.author === false ? `<span class="sub">every author — no Git email set here</span>` : "")}</td></tr>
      </tbody></table><div class="note">Tokens measure usage, not value; this is not a productivity score. Git figures are this machine's local history only.</div>`;
  }
  function shippedTable(p) {
    const shipped = p.projects.filter((x) => x.repo);
    return shipped.length ? `<table class="grid"><thead><tr><th scope="col">Repository</th><th scope="col" class="r">Commits</th><th scope="col" class="r">Lines + / −</th><th scope="col" class="r" title="Commits whose subject ends (#N) or merges a pull request; #N may name an issue">Referencing #N</th><th scope="col" class="r">Default merges</th><th scope="col" class="r">$ / default merge</th></tr></thead><tbody>`
      + shipped.map((x) => `<tr><td><b>${esc(pn("project", x.repo.name))}</b>${x.repo.name !== x.name ? `<span class="sub">${esc(pn("project", x.name))}</span>` : ""}</td><td class="num r">${x.repo.commits}</td><td class="num r">+${fmt(x.repo.added)} / −${fmt(x.repo.removed)}</td>
        <td class="num r">${x.repo.prsMerged === null ? "no remote" : x.repo.prsMerged}</td><td class="num r">${x.costPerOutcome.defaultMerges === null ? "no default" : x.costPerOutcome.defaultMerges}</td>
        <td class="num r">${x.costPerOutcome.perDefaultMergeUsd === null ? (x.costPerOutcome.defaultMerges ? "unpriced" : "no merge") : money(x.costPerOutcome.perDefaultMergeUsd)}</td></tr>`).join("")
      + `</tbody></table><div class="note">What Git recorded on this machine in the period; a word in place of a figure says why there is none.</div>`
      : `<div class="note">No project on this machine is in a Git repository${p.projects.length ? "" : ", or none has transcripts in this period"}.</div>`;
  }

  // ── scrollable regions are announced only when they scroll ───────────
  function fitRegions() {
    for (const el of document.querySelectorAll(".tablewrap, .lanescroll, .lanebody")) {
      if (el.classList.contains("lanebody") && !el._label) el._label = el.querySelector(".lanescroll")?.getAttribute("aria-label")?.replace("Lanes", "Lanes and their header") || "Lanes, scrollable";
      const scrolls = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      if (!el._label) el._label = el.getAttribute("aria-label") || "";
      if (scrolls) { el.setAttribute("tabindex", "0"); el.setAttribute("role", "region"); el.setAttribute("aria-label", el._label); }
      else { el.removeAttribute("tabindex"); el.removeAttribute("role"); el.setAttribute("aria-label", el._label.replace(/, scrollable$/u, "")); }
    }
  }
  window.addEventListener("resize", fitRegions);

  const vendorOf = (model) => /^claude-/.test(model) ? "anthropic" : /^(gpt-|codex-|o\d)/.test(model) ? "openai" : null;

  // ── machines on the console ─────────────────────────────────────────
  /** "catching up · 12,000 of 68,430 records" — never "Reporting · now" before the backlog is in. */
  function catchUpText(d) {
    const b = d.backlog;
    return b ? `catching up · ${b.delivered.toLocaleString("en-US")} of ${b.total.toLocaleString("en-US")} records` : "catching up";
  }
  function statusText(d, now) {
    if (d.status === "catching-up") return catchUpText(d).replace(/^c/u, "C");
    if (d.local && D.hub.local && D.hub.local.enabled && !D.hub.local.firstRunComplete) {
      const p = D.hub.local.progress;
      return "Reading its transcripts" + (p && p.filesTotal ? ` · ${p.files.toLocaleString("en-US")} of ${p.filesTotal.toLocaleString("en-US")} files` : "…");
    }
    if (d.status === "reporting") return (d.mode === "periodic" ? "Reporting periodically · " : "Reporting · ") + ago(d.lastContactAt, now);
    if (d.status === "reconnecting") return "Reconnecting — it was reporting when the console restarted";
    if (d.status === "silent") return `Silent since ${hhmm(d.lastContactAt)} · ${ago(d.lastContactAt, now)}`;
    if (d.status === "waiting") return "Joined — waiting for its first report";
    return (d.leftAt ? "Left " : "Removed ") + (d.revokedAt ? hhmm(Date.parse(d.revokedAt)) : "");
  }
  function paintMachines() {
    const now = serverNow();
    const rows = D.devices.filter((d) => d.status !== "revoked" || showUnavailable);
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    // The share of machines that left or were removed, when their cards are hidden.
    const goneShare = showUnavailable ? 0 : D.devices.filter((d) => d.status === "revoked").reduce((a, d) => a + (pw(d).shareOfWhole || 0), 0);
    const hint = D.devices.length ? `${reporting} of ${currentDevices().length} reporting` + (goneShare > 0 ? ` · ${pct(goneShare)} left or removed` : "") : "none yet";
    $("machinesHint").textContent = " · " + hint;
    capWin("cMachineCap", "by machine", PERIOD_TEXT[period][1]);
    // the head carries the count and the share left out on hover: the strip already says how many report
    $("cMachineCap").title = hint + (D.devices.length ? ` · share of the ${PERIOD_TEXT[period][0]}` + (goneShare > 0 ? `; ${pct(goneShare)} of it from machines that left or were removed, hidden unless Show unavailable is on` : "") : "");
    // the band shows up to five machines whole, or four and "n more", so the card keeps the height the lanes need
    const whole = compactMQ.matches ? 4 : 5;
    $("cMachines").innerHTML = machineRows(rows, now, false, moreOpen.has("cMachines") ? Infinity : rows.length > whole ? whole - 1 : whole, "cMachines");
  }
  /* One row per machine, biggest first: its state as a ring or a lit dot, name, person, share, tokens, estimate.
     A silent machine keeps its name in warn and says when it stopped on hover — never a zero. The row is the
     door to the machine's inspector. Shared by the Console and Team bands. */
  function machineRows(rows, now, withPerson = false, limit = Infinity, boxId = null) {
    const sorted = rows.slice().sort((a, b) => pw(b).tokens.total - pw(a).tokens.total);
    const shown = sorted.slice(0, limit);
    return sorted.length ? shown.map((d) => {
      const a = pw(d);
      // a machine with records its reporter could not count is a floor: the mark sits with the money (G6), the count on hover
      const cost = costMark(a.cost, droppedOf(d), false);
      return `<div class="xrow door ${d.status}" title="${esc(pn("machine", d.label))}${d.person ? " · " + esc(pn("person", d.person)) : ""} · ${esc(statusText(d, now))} · open" data-inspect="machine:${esc(d.id)}" tabindex="0" role="button">
        <span class="xn"><i aria-hidden="true"></i><b>${esc(pn("machine", d.label))}</b>${withPerson && d.person ? `<em>${esc(pn("person", d.person))}</em>` : ""}${d.local ? '<span class="here">HERE</span>' : ""}</span>
        <span class="xp" data-src="devices.windows.shareOfWhole" title="${pct(a.shareOfWhole)} of the ${esc(PERIOD_TEXT[period][0])} · ${asOf()}">${pct(a.shareOfWhole, 0)}</span>
        <span class="xv" data-src="devices.windows.tokens.total" title="${fmt(a.tokens.total)} tokens · ${esc(PERIOD_TEXT[period][1])} · ${asOf()}">${fmt(a.tokens.total)}</span>
        <span class="xc${a.cost.status === "unpriced" ? " void" : ""}" ${a.cost.status === "unpriced" || a.cost.status === "none" ? "" : "data-internal"} data-src="devices.windows.cost.usd" title="${esc(cost.title)}">${cost.html}</span>
      </div>`;
    }).join("") + (sorted.length > shown.length ? `<button type="button" class="more" data-more="${boxId}">${sorted.length - shown.length} more</button>` : boxId && moreOpen.has(boxId) ? `<button type="button" class="more" data-more="${boxId}">fewer</button>` : "") : `<div class="xrow"><span class="xn"><em>no machine has joined yet</em></span></div>`;
  }

  // ── the chart ────────────────────────────────────────────────────────
  const W = 520, H = 100;
  function setChartGoal() {
    const s = D.series[period];
    const key = period + ":" + s.start;
    const goal = s.values.slice();
    // The newest step is still filling. It is drawn at what was measured — the
    // bars add up to the headline — with a hatched cap up to what it would be
    // at this pace, so the wave neither dips at the edge nor claims the rest.
    const elapsed = Math.max(0.05, Math.min(1, (D.now - (s.start + s.step * (goal.length - 1))) / s.step));
    chart.cap = { measured: goal[goal.length - 1], projected: goal[goal.length - 1] / elapsed, step: s.step };
    // The four classes, each a series of its own, stacked quietest first; a
    // hub that sends no split (0.2) draws the total alone.
    const clsGoal = s.classes ? Object.fromEntries(CLASSES.map((k) => [k, s.classes[k].slice()])) : null;
    if (chart.key !== null && chart.key.split(":")[0] === period && chart.vals.length === goal.length) {
      // same window, the frame advanced by whole steps: shift what is on screen
      const shift = Math.round((s.start - Number(chart.key.split(":")[1])) / s.step);
      if (shift > 0) {
        chart.vals = chart.vals.slice(shift).concat(goal.slice(-shift));
        if (chart.cls && clsGoal) for (const k of CLASSES) chart.cls[k] = chart.cls[k].slice(shift).concat(clsGoal[k].slice(-shift));
      }
      if (!chart.cls && clsGoal) chart.cls = Object.fromEntries(CLASSES.map((k) => [k, clsGoal[k].slice()]));
    } else {
      chart.vals = goal.slice();
      chart.cls = clsGoal ? Object.fromEntries(CLASSES.map((k) => [k, clsGoal[k].slice()])) : null;
      chart.max = Math.max(...goal, chart.cap.projected, 1) * 1.12;
    }
    chart.key = key;
    chart.goal = goal;
    chart.clsGoal = clsGoal;
    chart.goalMax = Math.max(...goal, chart.cap.projected, 1) * 1.12;
    chart.series = s;
    // The legend under the axis: each class, its tokens and its dollars for the period, the same figures as the tokens panel.
    const w = win();
    const byClass = w.cost.byClass || null;
    const floor = w.cost.status === "partial";
    $("cLegend").innerHTML = ORDER.map((k) => `<span title="${esc(CLASS_LABEL[k])} · ${pct(w.shares[k])} of tokens${byClass ? ` · ${money(byClass[k])}${floor ? "+" : ""} est.${floor ? ` · a floor: ${esc(w.cost.unpricedModels.join(", "))} unpriced` : ""}` : ""}"><i class="sw ${k}"></i>${CLASS_LABEL[k]} <b>${fmt(w.tokens[k])}</b>${byClass ? `<em>${money(byClass[k])}${floor ? "+" : ""} est.</em>` : w.cost.status === "unpriced" ? `<em title="no verified list price">unpriced</em>` : ""}</span>`).join("");
    $("cFlow").setAttribute("aria-label", "Tokens over time, stacked by class: " + ORDER.map((k) => `${CLASS_LABEL[k]} ${fmt(w.tokens[k])}`).join(", "));
    // The scale, said once: the busiest whole step in the period, and how long a step is.
    const peak = Math.max(...s.values.slice(0, -1), 0);
    const stepText = s.step >= 86_400_000 ? "day" : s.step >= 3_600_000 ? `${Math.round(s.step / 3_600_000)} h` : s.step >= 60_000 ? `${Math.round(s.step / 60_000)} min` : "step";
    $("cPeak").hidden = peak <= 0;
    $("cPeak").innerHTML = `peak <b>${fmt(peak)}</b> / ${stepText}`;
    // No travel without the loop: a paused or reduced-motion chart shows the reading as it is.
    if (paused || reducedMotion.matches) {
      chart.vals = goal.slice(); chart.max = chart.goalMax;
      chart.cls = clsGoal ? Object.fromEntries(CLASSES.map((k) => [k, clsGoal[k].slice()])) : null;
    }
  }

  function smooth(pts) {
    if (!pts.length) return "";
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[i + 1], e = pts[Math.min(pts.length - 1, i + 2)];
      const c1 = [b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6];
      const c2 = [c[0] - (e[0] - b[0]) / 6, c[1] - (e[1] - b[1]) / 6];
      d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${c[0].toFixed(1)} ${c[1].toFixed(1)}`;
    }
    return d;
  }

  function drawChart() {
    if (!D || !chart.series) return;
    const s = chart.series;
    const now = serverNow();
    const span = s.step * chart.vals.length;
    const left = now - span;
    // x is the real time of each step's middle: as the clock moves, the chart glides
    const xOf = (i) => ((s.start + (i + 0.5) * s.step - left) / span) * W;
    const yOf = (v) => H - 2 - (Math.max(0, v) / chart.max) * (H - 8);
    const lastX = Math.min(W, ((Math.min(now, s.start + s.step * chart.vals.length) - left) / span) * W);
    const pts = chart.vals.map((v, i) => [xOf(i), yOf(v)]);
    pts.push([lastX, pts[pts.length - 1][1]]);
    const line = smooth(pts);
    $("cLine").setAttribute("d", line);
    $("cArea").setAttribute("d", line + `L${lastX.toFixed(1)} ${H}L${pts[0][0].toFixed(1)} ${H}Z`);
    // the step still filling: hatched from its measured height up to what it would be at this pace, over its own width
    // (the rect's own id: "cCap" is the caption's, and an id shared with it left this hatch never drawn)
    const cap = $("cCapStep"), c = chart.cap;
    if (c && c.projected > c.measured && c.measured > 0) {
      const x0 = xOf(chart.vals.length - 1.5);
      cap.setAttribute("x", x0.toFixed(1)); cap.setAttribute("width", Math.max(0, lastX - x0).toFixed(1));
      cap.setAttribute("y", yOf(c.projected).toFixed(1)); cap.setAttribute("height", Math.max(0, yOf(c.measured) - yOf(c.projected)).toFixed(1));
    } else { cap.setAttribute("width", "0"); cap.setAttribute("height", "0"); }
    // The stack: each class drawn from the class below it up to its own top, quietest at the bottom.
    const stack = $("cStack");
    if (chart.cls) {
      const base = new Array(chart.vals.length).fill(0);
      for (const k of CLASSES) {
        const top = base.map((b, i) => b + Math.max(0, chart.cls[k][i] || 0));
        const upper = top.map((v, i) => [xOf(i), yOf(v)]);
        upper.push([lastX, upper[upper.length - 1][1]]);
        const lower = base.map((v, i) => [xOf(i), yOf(v)]);
        lower.push([lastX, lower[lower.length - 1][1]]);
        const back = lower.slice().reverse().map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join("");
        stack.querySelector("." + k).setAttribute("d", smooth(upper) + back + "Z");
        for (let i = 0; i < base.length; i += 1) base[i] = top[i];
      }
    } else {
      for (const p of stack.children) p.removeAttribute("d");
    }
    // a machine that went silent: from then on, this chart is incomplete — say so
    const gap = $("cGap"), label = $("cGapLabel");
    if (D.silentSince && D.silentSince > left) {
      const x = Math.max(0, ((D.silentSince - left) / span) * W);
      gap.setAttribute("x", x.toFixed(1));
      gap.setAttribute("width", Math.max(0, W - x).toFixed(1));
      const n = D.devices.filter((d) => d.status === "silent").length;
      label.hidden = false;
      label.style.left = (x / W * 100).toFixed(2) + "%";
      label.classList.toggle("end", x > W * 0.55);
      label.textContent = `${n} machine${n === 1 ? "" : "s"} silent · incomplete from ${hhmm(D.silentSince)}`;
    } else {
      gap.setAttribute("width", "0");
      label.hidden = true;
    }
  }

  // hover: the exact step under the pointer
  const flow = $("cFlow");
  flow.addEventListener("mousemove", (ev) => {
    if (!D || !chart.series) return;
    const rect = flow.getBoundingClientRect();
    const fx = (ev.clientX - rect.left) / rect.width;
    const s = chart.series;
    const span = s.step * s.values.length;
    const t = serverNow() - span + fx * span;
    const i = Math.max(0, Math.min(s.values.length - 1, Math.floor((t - s.start) / s.step)));
    const from = s.start + i * s.step;
    const tip = $("cTip");
    tip.hidden = false;
    tip.style.left = Math.max(12, Math.min(88, fx * 100)) + "%";
    const last = i === s.values.length - 1;
    const until = last ? "now" : hhmm(from + s.step);
    const day = period === "7d" ? new Date(from).toLocaleDateString([], { weekday: "short" }) + " " : "";
    const split = s.classes ? `<small>${ORDER.map((k) => `${CLASS_LABEL[k].replace("uncached ", "")} ${fmt(s.classes[k][i])}`).join(" · ")}</small>` : "";
    const soFar = last && chart.cap ? ` <em>so far</em>${chart.cap.projected > chart.cap.measured ? ` · ${fmt(chart.cap.projected)} <em>projected</em>` : ""}` : "";
    tip.innerHTML = (period === "30d"
      ? `${new Date(from).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })} (UTC) · <b>${fmt(s.values[i])}</b> tokens${soFar}`
      : `${day}${hhmm(from)}–${until} · <b>${fmt(s.values[i])}</b> tokens${soFar}`) + split;
    const hover = $("cHover");
    hover.setAttribute("x1", (fx * W).toFixed(1));
    hover.setAttribute("x2", (fx * W).toFixed(1));
    hover.setAttribute("opacity", ".5");
  });
  flow.addEventListener("mouseleave", () => { $("cTip").hidden = true; $("cHover").setAttribute("opacity", "0"); });

  // ── the one loop ─────────────────────────────────────────────────────
  let last = performance.now(), textAcc = 1;
  function paintText() {
    if (!D) return;
    const w = win();
    const empty = !D.devices.length && w.tokens.total === 0;
    $("cTotal").innerHTML = empty ? "—" : fmt(shown.total);
    const cost = w.cost;
    // No machine yet: the estimate, the messages and the burn are unknown, not 0.
    $("cSpend").textContent = empty ? "no reading yet" : cost.status === "none" ? "no spend yet"
      : cost.status === "unpriced" ? "no priced model"
      : money(shown.spend) + (cost.status === "partial" ? " est. · partial" : " est.");
    $("cSpend").title = cost.status === "partial"
      ? `${fmt(cost.unpricedTokens)} tokens from ${cost.unpricedModels.join(", ")} have no verified list price and are not in this figure`
      : "Standard API list prices, applied on this machine. Not an invoice.";
    $("cMsgs").textContent = empty ? "—" : Math.round(shown.msgs).toLocaleString("en-US");
    const perMin = shown.burn;
    const none = D.devices.length === 0;
    const excludedAll = D.devices.length > 0 && D.burn.reporting === 0;
    $("cBurn").innerHTML = excludedAll || none ? "—" : perSecond
      ? `${fmt(perMin / 60)}<span class="u">tok/s</span>` : `${fmt(perMin)}<span class="u">tok/min</span>`;
    const bc = D.burn.cost || { status: "estimated", unpricedModels: [] };
    const per = perSecond ? "/min" : "/hour";
    const dollars = D.burn.usdPerMinute === null
      ? "—" + per + " · unpriced"
      : money(D.burn.usdPerMinute * (perSecond ? 1 : 60)) + per + (bc.status === "partial" ? " est. · partial" : " est.");
    // the dollars beside the figure; the other unit of the same rate on hover
    $("cRate").textContent = none ? "no machine has reported yet" : excludedAll ? "no machine reporting right now" : dollars;
    const names = bc.unpricedModels.join(", ");
    const has = bc.unpricedModels.length === 1 ? "has" : "have";
    const alt = none || excludedAll ? "" : (perSecond ? fmt(perMin) + " per minute" : fmt(perMin / 60) + " per second") + " · ";
    $("cRate").title = alt + (bc.status === "unpriced" ? `${names} ${has} no verified list price, so no dollar rate is shown`
      : bc.status === "partial" ? `${names} ${has} no verified list price; ${fmt(bc.unpricedTokensPerMinute)} tok/min are not in this figure`
      : "Standard API list prices. Not an invoice.");
  }

  function frame(t) {
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    const k = 1 - Math.exp(-dt * 3.2);
    for (const key of Object.keys(target)) shown[key] += (target[key] - shown[key]) * k;
    if (chart.vals.length) {
      for (let i = 0; i < chart.vals.length; i += 1) chart.vals[i] += ((chart.goal[i] ?? 0) - chart.vals[i]) * k;
      if (chart.cls && chart.clsGoal) for (const c of CLASSES) {
        for (let i = 0; i < chart.cls[c].length; i += 1) chart.cls[c][i] += ((chart.clsGoal[c][i] ?? 0) - chart.cls[c][i]) * k;
      }
      chart.max += (chart.goalMax - chart.max) * k;
    }
    drawChart();
    textAcc += dt;
    if (textAcc >= 0.125) { textAcc = 0; paintText(); paintClock(); }
    if (!paused && !reducedMotion.matches) requestAnimationFrame(frame);
  }
  function startLoop() {
    last = performance.now();
    if (!reducedMotion.matches) requestAnimationFrame(frame);
  }
  reducedMotion.addEventListener?.("change", () => { if (!reducedMotion.matches && !paused) startLoop(); });

  // ── controls ─────────────────────────────────────────────────────────
  $("winSeg").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-w]"); if (!b) return;
    setPeriod(b.dataset.w);
  });
  /* Changing the period anywhere changes it everywhere. */
  function setPeriod(next) {
    if (!PERIOD_TEXT[next]) return;
    period = next;
    hideToast();
    for (const seg of ["winSeg", "periodSeg", "projSeg"]) {
      for (const x of $(seg).querySelectorAll("button")) {
        const on = (x.dataset.w || x.dataset.p) === next;
        x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on));
      }
    }
    $("axLeft").textContent = PERIOD_TEXT[period][2];
    chart.key = null;
    if (D) {
      const w = win();
      Object.assign(target, { total: w.tokens.total, spend: w.cost.usd ?? 0, msgs: w.messages });
      Object.assign(shown, { total: target.total, spend: target.spend, msgs: target.msgs });
      paintClasses(); paintModels(); paintMachines(); setChartGoal(); drawChart(); paintText();
      paintAttention(); paintSpectrum(); loadFold();
      if (view === "team") paintTeam();
      if (inspect.open) paintInspect();
    }
    if (view === "projects") loadProjects();
  }
  // The unit toggle's name carries its state and what pressing it does, so the visible text is in the name (WCAG 2.5.3).
  $("unitBtn").addEventListener("click", (ev) => {
    perSecond = !perSecond;
    ev.currentTarget.textContent = (perSecond ? "per second" : "per minute") + " ⇄";
    ev.currentTarget.setAttribute("aria-label", perSecond ? "Burn per second, switch to per minute" : "Burn per minute, switch to per second");
    paintText();
  });
  // The two presenter controls keep one name each; aria-pressed carries the state (never a "Hide unavailable, pressed" double negative).
  $("motionBtn").addEventListener("click", (ev) => {
    paused = !paused;
    const b = ev.currentTarget;
    b.setAttribute("aria-pressed", String(paused));
    b.querySelector("use").setAttribute("href", paused ? "#ic-play" : "#ic-pause");
    b.title = paused ? "Motion is paused: figures still update; they change without moving" : "Stop the animation; figures keep updating";
    document.body.classList.toggle("paused", paused);
    // Polling carries on either way: only the travel stops.
    if (paused && D) { Object.assign(shown, target); setChartGoal(); paintText(); drawChart(); }
    if (!paused) startLoop();
  });
  function openAlerts(from = null) { if (D && (D.alerts || []).length) openSheet($("alertPanel"), view + "/alerts", from); else toast("No alert in the last hour."); }
  $("alertChip").addEventListener("click", (ev) => openAlerts(ev.currentTarget));
  $("voidBtn").addEventListener("click", (ev) => {
    showUnavailable = !showUnavailable;
    const b = ev.currentTarget;
    b.setAttribute("aria-pressed", String(showUnavailable));
    b.title = showUnavailable ? "Unavailable lanes and machines are drawn; press to fold them away again" : "Draw the lanes and machines that are silent, removed or idle for more than an hour";
    if (D) { paintLanes(); paintMachines(); paintClasses(); loadFold(); }
  });
  /* The fold strip's buttons open their fold and bring it into view. */
  $("foldStrip").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-fold]"); if (!b) return;
    const d = $(b.dataset.fold);
    d.open = true;
    d.scrollIntoView({ behavior: reducedMotion.matches || paused ? "auto" : "smooth", block: "start" });
    d.querySelector("summary").focus({ preventScroll: true });
  });
  /* Presenting: P, or the palette. Every name becomes a stable stand-in, internal figures step back, the strip says PRESENTING. */
  function setPresent(on) {
    present = Boolean(on);
    document.body.toggleAttribute("data-present", present);
    $("presentStamp").hidden = !present;
    $("reach").title = present ? "" : $("reach").dataset.title || "";
    // every row takes its new name at once, not at its own moment inside the poll interval
    for (const rows of [laneRows, coldRows, projLaneRows]) for (const row of rows.values()) row._painted = false;
    if (D) { paintAll(); if (foldFetched.data) paintFold(); if (view === "projects") loadProjects(true); }
    // an open inspector's address takes the stand-in too, at once
    if (inspect.open && inspectDialog.open && inspect.kind !== "lane") setHash(`${view}/${inspect.kind}/${idInUrl(inspect.kind, inspect.id)}`);
    if (addDialog.open) $("peopleList").innerHTML = present ? "" : (D ? D.people : []).map((p) => `<option value="${esc(p.person)}"></option>`).join("");
    toast(present ? "Presenting: names are stand-ins until you press P again." : "Presenting is off: real names are back.");
  }

  // theme
  function currentTheme() {
    const set = document.documentElement.getAttribute("data-theme");
    if (set) return set;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function labelTheme() {
    const next = currentTheme() === "dark" ? "Light" : "Dark";
    $("themeBtn").textContent = next;
    $("themeBtn").setAttribute("aria-label", "Switch to the " + next.toLowerCase() + " theme");
  }
  $("themeBtn").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("agent-console-theme", next); } catch { /* not kept */ }
    labelTheme();
  });
  labelTheme();

  // views
  function show(next) {
    view = next;
    hideToast();
    for (const t of $("tabs").querySelectorAll(".tab")) {
      if (t.dataset.view === next) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    }
    for (const v of ["console", "team", "projects"]) $("view-" + v).hidden = v !== next;
    document.body.dataset.view = next;
    // The strip is shared: its title says which view is under it.
    $("stripView").textContent = next === "team" ? "Team" : next === "projects" ? "Projects" : "";
    $("stripView").hidden = next === "console";
    if (next === "team" && D) paintTeam();
    if (next === "projects") { loadProjects(); paintProjectsLive(); }
    setHash(next === "console" ? "" : next);
  }
  // The URL carries the view and whatever is open beside it: #team, #team/machine/<id>, #lane/<key>/context, #console/add.
  function setHash(h) { try { history.replaceState(null, "", h ? "#" + h : location.pathname); } catch { /* fine */ } }
  /* While presenting, the address names what is open by an opaque token of this session's own, never by a person's,
     a machine's or a project's name (#team/person/<token>): a token is minted once per thing and resolved on the way
     back, so a shared screen's address bar gives nothing away and the address still opens the same sheet here. */
  const urlTokens = new Map(), urlBack = new Map();
  function idInUrl(kind, id) {
    if (!present) return encodeURIComponent(id);
    const key = kind + ":" + id;
    if (!urlTokens.has(key)) {
      let token;
      do { token = Math.random().toString(36).slice(2, 8); } while (urlBack.has(token));
      urlTokens.set(key, token); urlBack.set(token, String(id));
    }
    return urlTokens.get(key);
  }
  const idFromUrl = (token) => (urlBack.has(token) ? urlBack.get(token) : token);
  /* The opener, remembered by what names it rather than by its node: a lane row by its key, a machine, person or project row by its
     data-inspect, a control by its id — with the cell button inside a row kept too. Rows are repainted while a sheet is open, so the node
     that was clicked is often gone by the time the sheet closes; its successor is found by the same key and takes the focus. */
  const cssq = (v) => String(v).replace(/["\\]/gu, "\\$&");
  function openerRef(el) {
    if (!el || !el.closest) return null;
    const anchor = el.closest("[data-key], [data-inspect], [id]");
    if (!anchor) return { node: el, sel: null };
    const sel = anchor.dataset.key ? `.lane[data-key="${cssq(anchor.dataset.key)}"]` : anchor.dataset.inspect ? `[data-inspect="${cssq(anchor.dataset.inspect)}"]` : `#${cssq(anchor.id)}`;
    const inner = el === anchor ? "" : el.closest(".cx") ? " .cx button" : el.closest(".ag") ? " .ag button" : el.classList.contains("rowbtn") ? " .rowbtn" : "";
    return { node: el, sel: sel + inner };
  }
  function openerNode(ref) {
    if (!ref) return null;
    if (ref.sel) for (const el of document.querySelectorAll(ref.sel)) if (el.isConnected && (!el.checkVisibility || el.checkVisibility())) return el;
    return ref.node && ref.node.isConnected ? ref.node : null;
  }
  function openSheet(dialog, hash, from = null) {
    if (!dialog.open) {
      // whoever opened the sheet gets focus back when it closes: the row, the chip, the palette's button
      opener = openerRef(from && from.focus ? from : (document.activeElement && document.activeElement !== document.body ? document.activeElement : null));
      dialog.showModal();
      // Focus lands on the sheet's name, not on its close button, so the ring does not light on every open.
      const h = dialog.querySelector("h2[tabindex]");
      if (h && !dialog.querySelector("form")) h.focus({ preventScroll: true });
    }
    setHash(hash);
    dialog.addEventListener("close", () => {
      setHash(view === "console" ? "" : view);
      const back = openerNode(opener); opener = null;
      if (back && !document.querySelector("dialog[open]")) { if (back.classList.contains("lane")) { laneFocus = back.dataset.key; roving(back.parentElement); } back.focus({ preventScroll: true }); }
    }, { once: true });
  }
  $("tabs").addEventListener("click", (ev) => { const t = ev.target.closest(".tab"); if (t) show(t.dataset.view); });
  document.addEventListener("click", (ev) => { const g = ev.target.closest("[data-go]"); if (g) show(g.dataset.go); });

  // ── team ─────────────────────────────────────────────────────────────
  /* The Team view is the Console's instrument pointed at machines: the
     figure, the last hour stacked by machine, machines and people as rows
     with share bars — then two dense tables where every row is a door to the
     machine's or the person's inspector. Nothing here is a strip of tiles. */
  $("periodSeg").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-p]"); if (!b) return;
    setPeriod(b.dataset.p);
  });
  const shareBar = (x, src) => `<span class="sharebar" ${src ? `data-src="${src}"` : ""}><i><b style="width:${Math.round((x || 0) * 100)}%"></b></i><span>${pct(x)}</span></span>`;
  // The split reads in the ink ramp; the top two names and "+n" so no name is cut short.
  const modelSplit = (models) => models.length
    ? `<span class="models" title="${esc(models.map((m) => `${m.label} ${pct(m.share)}`).join(" · "))}"><span class="split">${models.map((m) => `<i style="flex-grow:${m.tokens}"></i>`).join("")}</span>
       <span class="names"><b>${esc(models[0].label)}</b> ${pct(models[0].share, 0)}${models.length > 1 ? ` · +${models.length - 1}` : ""}</span></span>`
    : `<span class="names">—</span>`;
  const costCell = (c) => c.status === "none" ? "—" : c.status === "unpriced" ? "unpriced" : money(c.usd) + (c.status === "partial" ? "+" : "");
  const costTitle = (c) => c.status === "none" ? "Nothing to price yet" : c.status === "unpriced" ? "No verified list price for what ran here" : c.status === "partial" ? "List-price estimate; some records are unpriced, so this is a floor" : "List-price estimate. Not an invoice.";
  const deviceOf = (id) => (D ? D.devices.find((d) => d.id === id) || null : null);
  const deviceKey = (l) => l.device.id;
  /* What a machine shares beyond its records (sharing: alerts over the last hour, tool activity over the last five
     minutes), in a few words with the reporter's own reason on hover; entries refused for being dated in the future
     are a quiet flag when there are any. A 0.3 hub sends no sharing: nothing is said, never "shares nothing". */
  function sharingText(d) {
    const s = d && d.sharing && d.sharing.alerts && d.sharing.activity ? d.sharing : null;
    if (!s) return null;
    const one = (name, c) => (c.state === "complete" ? name : c.state === "partial" ? `${name} since ${hhmm(c.since)}` : `${name} ${COVERAGE_WORD[c.reason] || c.state}`);
    const same = s.alerts.state === s.activity.state && s.alerts.reason === s.activity.reason && s.alerts.state !== "partial";
    const text = same ? (s.alerts.state === "complete" ? "shares alerts · tools" : `alerts and tools ${COVERAGE_WORD[s.alerts.reason] || s.alerts.state}`) : `${one("alerts", s.alerts)} · ${one("tools", s.activity)}`;
    const whole = s.alerts.state === "complete" && s.activity.state === "complete";
    const title = `Alerts, last hour: ${coverageWhy(s.alerts)}. Tool activity, last five minutes: ${coverageWhy(s.activity)}.`;
    return { text, title, whole, refused: Number.isFinite(s.rejectedFuture) ? s.rejectedFuture : 0 };
  }
  const refusedTitle = (n) => `${plural(n, "entry", "entries")} from this machine dated more than two minutes in the future, refused: counted here, never stored, so nothing from them can become "now" later`;
  // on the status line when the machine shares everything ("· shares alerts · tools"); on a line of its own, in warn, when it does not
  const sharingHtml = (d) => { const s = sharingText(d); return s ? `<span class="${s.whole ? "sh" : "lk sh w"}" title="${esc(s.title)}">${s.whole ? "· " : ""}${esc(s.text)}</span>${s.refused ? `<span class="lk flag" title="${esc(refusedTitle(s.refused))}">${plural(s.refused, "entry", "entries")} refused · future-dated</span>` : ""}` : ""; };
  const personOfDevice = (id) => (deviceOf(id) || {}).person || "Unassigned";
  // Machines and people with a current (not removed) machine: the denominators "per machine" and "per person" name.
  const peopleCurrent = () => D.people.filter((p) => p.devices.some((id) => { const d = deviceOf(id); return d && d.status !== "revoked"; }));

  function paintTeam() {
    if (!D) return;
    const now = serverNow();
    // The same period, and the same figures, as the Console headline.
    const of = (x) => (x.windows && x.windows[period]) || (period === "7d" ? x.week : x.day);
    const whole = win();
    const total = whole.tokens.total;
    const cr = whole.tokens.cacheRead, cw = whole.tokens.cacheWrite;
    const cost = whole.cost;
    const msgs = whole.messages;
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    const silent = D.devices.filter((d) => d.status === "silent");
    const current = currentDevices().length;
    const none = D.devices.length === 0;   // nothing has reported: unknown, never 0
    const label = PERIOD_TEXT[period][1];
    $("teamTotals").innerHTML = "";
    $("tCap").title = "Tokens · " + PERIOD_TEXT[period][0] + " · every machine";
    $("tTotal").textContent = none ? "—" : fmt(total);
    $("tTotal").title = none ? "No machine has reported yet" : `${fmt(total)} tokens across ${plural(D.devices.length, "machine")} · ${asOf()}`;
    // Every model unpriced is "no priced model", never $0.00.
    $("tSpend").textContent = none ? "no reading yet" : cost.status === "unpriced" ? "no priced model" : cost.status === "none" ? "no spend yet" : money(cost.usd) + (cost.status === "partial" ? " est. · partial" : " est.");
    $("tSpend").title = costTitle(cost);
    $("tMsgs").textContent = none ? "—" : msgs.toLocaleString("en-US");
    const gone = D.devices.filter((d) => d.status === "revoked");
    // A session is a top-level session everywhere; outside the last 24 h the
    // count kept per period includes subagents, and says so.
    const sessions = none ? "—" : period === "24h" ? sessionWords()
      : whole.sessions === null ? "sessions not kept past the minute detail"
      : plural(whole.sessions, "session or subagent", "sessions and subagents");
    // One provenance line: generated or reported, the silent machines with their last known figures still in the total; the sessions on hover.
    const lastKnown = silent.reduce((a, d) => a + of(d).tokens.total, 0);
    $("tProv").innerHTML = none ? "no machine has joined yet"
      : (D.hub.demo ? "generated · " : "") + `${reporting} of ${current} reporting` + (silent.length ? ` · <b>${silent.length} silent</b> · ${fmt(lastKnown)} last known` : "") + (gone.length ? ` · ${gone.length} left or removed` : "");
    $("tProv").title = [sessions, silent.length ? silent.map((d) => `${pn("machine", d.label)} silent since ${hhmm(d.lastContactAt)}; its ${fmt(of(d).tokens.total)} tokens are its last known reading, still in the total`).join("; ") : ""].filter(Boolean).join(" · ");
    // Four figures no other pane carries: the cache split, the estimate per machine, the tokens per person — each naming its denominator.
    // Per machine comes from the hub (H09): the reporting machines' own estimates over the reporting machines, never the fleet total over a count.
    const pm = D.team && D.team.perMachine && D.team.perMachine[period] ? D.team.perMachine[period] : null;
    const perMachine = none ? ["—", "no machine yet"]
      : pm ? (pm.status === "unpriced" || pm.reporting === 0 || pm.usdReporting == null ? ["—", pm.reporting === 0 ? "none reporting" : "no priced model"]
        : [money(pm.usdReporting / pm.reporting) + (pm.status === "partial" ? "+" : ""), `${pm.reporting} of ${pm.current} heard · est.${pm.status === "partial" ? " · partial" : ""}`])
      : ["—", "not sent by this hub"];
    const people = peopleCurrent();
    const perPerson = none || !people.length ? ["—", none ? "no machine yet" : "nobody with a current machine"] : [fmt(total / people.length), `avg over ${plural(people.length, "person", "people")}`];
    const kv = [
      [pct(total ? cr / total : null), "cache read", "of all tokens", "windows.shares.cacheRead"],
      [pct(total ? cw / total : null), "cache write", "of all tokens", "windows.shares.cacheWrite"],
      [perMachine[0], "per machine", perMachine[1], "team.perMachine.usdReporting"],
      [perPerson[0], "per person", perPerson[1], "windows.tokens.total"],
    ];
    $("teamTotals").innerHTML = kv.map(([v, l, s, src]) => `<div><div class="v" data-src="${src}" title="${esc(l)} · ${esc(s)} · ${asOf()}">${v}</div><div class="l">${esc(l)}</div><div class="s">${esc(s)}</div></div>`).join("");
    paintWeek(["tWeekBars", "tWeekTotal", "tWeekPeak"]);
    // The period stacked by machine, from the hub's own per-machine series at the chart's resolution (H04): the period control moves it with every other figure.
    const byDevice = sparksBy(deviceKey);
    const s = D.series[period] || {};
    const drawn = drawWaves({ svgId: "tFlow", wrapId: "tFlowWrap", reasonId: "tFlowReason", legendId: "tLegend", peakId: "tPeak", series: s.byDevice, now,
      nameOf: (id) => pn("machine", (deviceOf(id) || { label: "Unknown machine" }).label), liveOf: (id) => (byDevice.get(id) || { live: 0 }).live, none: "machine" });
    $("tFlowTitle").textContent = "Activity · " + PERIOD_TEXT[period][0];
    $("tAxLeft").textContent = PERIOD_TEXT[period][2];
    $("tFlowCap").innerHTML = drawn ? `<b>${fmt(drawn.all)}</b> tokens · ${D.lanes.filter((l) => l.state === "live").length} live<span class="win"> · ${stepText(drawn.frame.step)} steps</span>` : s.byDevice && s.byDevice.frame ? `${stepText(s.byDevice.frame.step)} steps` : "";
    $("tFlowCap").title = drawn ? `Every machine's tokens in the ${PERIOD_TEXT[period][0]} at ${stepText(drawn.frame.step)} steps; the bands add up to the figure beside the period control. The last step is measured so far, capped in hatch to its pace.` : "";
    $("tFlow").setAttribute("aria-label", `Tokens in the ${PERIOD_TEXT[period][0]}, stacked by machine`);
    // Models across every machine, and the sessions by tool over every lane (laneTotals): what the tables under the band do not carry.
    capWin("tModelCap", "by model", label);
    $("tModels").innerHTML = whole.models.length ? modelRows(whole.models, "tModels", whole.models)
      : `<div class="mrow"><span class="mn"><span class="none-text">no model has reported yet</span></span></div>`;
    // By tool and by person for the chosen period, from the hub's rollup over every lane (laneTotals.periods); a 0.3 hub sends the day only.
    // Thirty days are read from the daily rollup, which keeps no sessions: the cell is a void with that reason, never the day's count under a month's caption.
    const lt = D.laneTotals || null;
    const tally = lt && lt.periods && lt.periods[period] ? lt.periods[period] : null;
    const sessionsCell = (n, reason) => (n === null || n === undefined ? na("not kept", reason || (tally && tally.reason) || "Sessions are not kept for this period", true, true) : String(n));
    const tools = new Map();
    if (tally) for (const [tool, t] of Object.entries(tally.byTool)) tools.set(tool, { tokens: t.tokens || 0, lanes: t.sessions, live: (lt.byTool && lt.byTool[tool] && lt.byTool[tool].live) || 0 });
    else if (lt && lt.byTool) for (const [tool, t] of Object.entries(lt.byTool)) tools.set(tool, { tokens: t.tokensDay || 0, lanes: t.sessions || 0, live: t.live || 0 });
    else for (const l of D.lanes) { const t = tools.get(l.tool) || { tokens: 0, lanes: 0, live: 0 }; t.tokens += l.tokensDay || 0; t.lanes += 1; if (l.state === "live") t.live += 1; tools.set(l.tool, t); }
    const toolLabel = tally ? label : "24 h";
    const toolTotal = [...tools.values()].reduce((a, t) => a + t.tokens, 0);
    capWin("tToolCap", "by tool", toolLabel);
    $("tTools").innerHTML = tools.size ? [...tools.entries()].sort((a, b) => b[1].tokens - a[1].tokens).map(([tool, t]) => `<div class="xrow" title="${esc(TOOL[tool] || tool)} · ${t.lanes === null ? "sessions not kept for this period" : plural(t.lanes, "session") + " in the " + PERIOD_TEXT[period][0]} · ${t.live} live now${lt ? " · counted over every session, not only the lanes drawn" : ""} · ${asOf()}" data-src="${tally ? "laneTotals.periods.byTool" : lt ? "laneTotals.byTool" : "lanes.tool"}">
        <span class="xn"><b>${esc(TOOL[tool] || tool)}</b></span>
        <span class="xp">${pct(toolTotal ? t.tokens / toolTotal : null, 0)}</span>
        <span class="xv">${fmt(t.tokens)}</span>
        <span class="xc">${sessionsCell(t.lanes)}</span>
      </div>`).join("") : `<div class="xrow"><span class="xn"><em>no session in the ${esc(PERIOD_TEXT[period][0])}</em></span></div>`;
    // Messages by person: how much each person's sessions asked of the models, which the People table does not carry; sessions from the rollup over every lane.
    const lanesByPerson = new Map();
    if (tally) for (const [who, t] of Object.entries(tally.byPerson)) lanesByPerson.set(who, t.sessions);
    else if (lt && lt.byPerson) for (const [who, t] of Object.entries(lt.byPerson)) lanesByPerson.set(who, t.sessions || 0);
    else for (const l of D.lanes) { const who = personOfDevice(l.device.id); lanesByPerson.set(who, (lanesByPerson.get(who) || 0) + 1); }
    const peopleRanked = D.people.slice().sort((a, b) => of(b).messages - of(a).messages);
    capWin("tPeopleCap", "by person", label);
    $("tPeople").innerHTML = peopleRanked.length ? peopleRanked.map((p) => { const a = of(p); const n = lanesByPerson.has(p.person) ? lanesByPerson.get(p.person) : tally ? null : 0; return `<div class="xrow msgs door" data-inspect="person:${esc(p.person)}" tabindex="0" role="button" title="${esc(pn("person", p.person))} · ${a.messages.toLocaleString("en-US")} messages · ${pct(msgs ? a.messages / msgs : null)} of every message · open">
        <span class="xn"><b>${esc(pn("person", p.person))}</b></span>
        <span class="xp" data-src="people.windows.messages">${pct(msgs ? a.messages / msgs : null, 0)}</span>
        <span class="xv" data-src="people.windows.messages">${a.messages.toLocaleString("en-US")}</span>
        <span class="xc" title="Sessions in the ${esc(PERIOD_TEXT[period][0])}${lt ? ", over every session" : ""}">${sessionsCell(n)}</span>
      </div>`; }).join("") : `<div class="xrow"><span class="xn"><em>nobody yet</em></span></div>`;
    $("tHint").textContent = tally ? (tally.sessionsKept ? `every figure here is the ${PERIOD_TEXT[period][0]}` : `${label} read the daily rollup: tokens only, sessions not kept`) : "models over the period · tools and sessions from the day";
    for (const th of document.querySelectorAll("#peopleTable th.act, #machineTable th.act")) th.textContent = "Activity · " + label;

    const peopleRows = D.people.slice().sort((a, b) => of(b).tokens.total - of(a).tokens.total);
    const byPerson = sparksBy((l) => personOfDevice(l.device.id));
    // a row's activity over the period: the hub's own per-row series (sparks[period]); a 0.3 hub gives the hour from the lanes' sparks
    const rowSpark = (x, s, hot, who, dim = false) => (x.sparks && x.sparks[period]
      ? sparkWave(x.sparks[period], hot, `${who} · ${x.sparks[period].tokens.some((v) => v > 0) ? `${fmt(x.sparks[period].tokens.reduce((a, b) => a + b, 0))} tokens over the ${PERIOD_TEXT[period][0]}, ${stepText(x.sparks[period].step)} steps` : `nothing in the ${PERIOD_TEXT[period][0]}`}`, { dim })
      : sparkWave({ tokens: s ? s.spark : null }, hot, `${who} · ${s ? fmt(s.spark.reduce((a, b) => a + b, 0)) + " tokens in the last hour" : "no session in the last 24 hours"}`, { dim }));
    $("peopleCount").innerHTML = `${plural(D.people.length, "person", "people")} <span class="win">· ${esc(label)}</span>`;
    $("peopleTable").tBodies[0].innerHTML = D.people.length ? peopleRows.map((p) => {
      const a = of(p);
      const s = byPerson.get(p.person);
      // records a person's machines could not count make the estimate a floor, said with the money (G6)
      const dropped = p.devices.reduce((n, id) => n + droppedOf(deviceOf(id)), 0);
      const cost = costMark(a.cost, dropped);
      return `<tr class="door" data-inspect="person:${esc(p.person)}">
        <td class="k1"><button type="button" class="rowbtn" data-inspect="person:${esc(p.person)}" title="Open ${esc(pn("person", p.person))}">${esc(pn("person", p.person))}</button>${demoStamp()}</td>
        <td>${p.devices.map((id) => esc(pn("machine", (deviceOf(id) || {}).label || ""))).join(", ")}<em class="q">${p.reporting} of ${p.devices.length} reporting</em></td>
        <td>${rowSpark(p, s, Boolean(s && s.live > 0), pn("person", p.person))}</td>
        <td class="num r k3" data-l="tokens" data-src="people.windows.tokens.total" title="${fmt(a.tokens.total)} tokens · ${esc(label)}">${fmt(a.tokens.total)}</td><td class="k2">${shareBar(a.shareOfWhole, "people.windows.shareOfWhole")}</td>
        <td class="num r k3" data-l="cache read" data-src="people.windows.shares.cacheRead">${pct(a.shares.cacheRead)}</td><td class="num r k3" data-l="cache write" data-src="people.windows.shares.cacheWrite">${pct(a.shares.cacheWrite)}</td>
        <td>${modelSplit(a.models)}</td><td class="num r k3" data-l="est." data-internal data-src="people.windows.cost.usd" title="${esc(cost.title)}">${cost.html}</td></tr>`;
    }).join("") : `<tr><td colspan="9">Nobody yet — add a machine.</td></tr>`;

    const devices = D.devices.slice().sort((a, b) => of(b).tokens.total - of(a).tokens.total);
    $("machineCountHead").textContent = `${plural(current, "machine")} · ${reporting} reporting` + (silent.length ? ` · ${silent.length} silent` : "") + (gone.length ? ` · ${gone.length} left or removed` : "");
    $("machineTable").tBodies[0].innerHTML = D.devices.length ? devices.map((d) => {
      const a = of(d);
      const s = byDevice.get(d.id);
      const action = d.local ? `<span class="sub">this machine</span>`
        : d.status === "revoked" ? `<span class="sub">${d.leftAt ? "left" : "removed"}</span>`
        : `<button type="button" class="btn small danger" data-revoke="${esc(d.id)}" data-label="${esc(pn("machine", d.label))}">Remove</button>`;
      // Records the reporter could not count make the estimate a floor: the mark sits with the money (G6), the reasons on hover; the joined line is on hover and in the inspector.
      const joined = d.local ? "the hub itself" : "joined " + new Date(d.createdAt).toLocaleDateString([], { day: "numeric", month: "short" }) + " · " + hhmm(Date.parse(d.createdAt)) + (d.joinedVia === "link" ? " by link" : "");
      const stale = d.status === "silent" || d.status === "revoked";
      const cost = costMark(a.cost, droppedOf(d));
      const costWhy = droppedOf(d) ? `${cost.title} · ${esc(d.coverage.reasons.map((r) => r.count + " × " + r.label).join("; "))}` : cost.title;
      return `<tr class="door ${d.status}" data-inspect="machine:${esc(d.id)}" title="${esc(pn("machine", d.label))} · ${esc(joined)}">
        <td class="k1"><button type="button" class="rowbtn" data-inspect="machine:${esc(d.id)}" title="Open ${esc(pn("machine", d.label))} · ${esc(joined)}">${esc(pn("machine", d.label))}</button>${demoStamp()}<span class="sub joined">${d.local ? "the hub itself" : "joined " + new Date(d.createdAt).toLocaleDateString([], { day: "numeric", month: "short" }) + " · " + hhmm(Date.parse(d.createdAt)) + (d.joinedVia === "link" ? " by link" : "")}</span></td>
        <td class="k3" data-l="person">${esc(pn("person", d.person) || "—")}</td>
        <td class="k3 full"><span class="status ${d.status}"><i></i>${esc(statusText(d, now))}${stale ? `<span class="lk" title="Its figures stopped moving when it did; they stay in the total as its last known reading">last known</span>` : ""}${sharingHtml(d)}</span></td>
        <td>${rowSpark(d, s, Boolean(s && s.live > 0 && d.status === "reporting"), pn("machine", d.label), stale)}</td>
        <td class="num r k3" data-l="tokens" data-src="devices.windows.tokens.total" title="${fmt(a.tokens.total)} tokens · ${esc(label)}${stale ? " · last known" : ""}">${fmt(a.tokens.total)}</td><td class="k2">${shareBar(a.shareOfWhole, "devices.windows.shareOfWhole")}</td>
        <td class="num r k3" data-l="cache read" data-src="devices.windows.shares.cacheRead">${pct(a.shares.cacheRead)}</td><td class="num r k3" data-l="cache write" data-src="devices.windows.shares.cacheWrite">${pct(a.shares.cacheWrite)}</td>
        <td>${modelSplit(a.models)}</td><td class="num r k3" data-l="est." data-internal data-src="devices.windows.cost.usd" title="${esc(costWhy)}">${cost.html}</td><td class="r">${action}</td></tr>`;
    }).join("") : `<tr><td colspan="11">No machine yet.</td></tr>`;

    const open = D.invitations.filter((i) => i.state === "open");
    $("inviteCount").textContent = D.invitations.length ? `${open.length} waiting` + (open.length ? ` · expires ${hhmm(Math.min(...open.map((i) => i.expiresAt)))}` : "") + ` · ${D.invitations.length - open.length} joined · 7 days` : "none · 7 days";
    $("invites").innerHTML = D.invitations.length ? D.invitations.map((i) => {
      const who = [pn("person", i.person), pn("machine", i.machine)].filter(Boolean).map(esc).join(" · ") || "Unnamed";
      const joined = i.state === "joined" ? D.devices.find((d) => d.id === i.deviceId) : null;
      return `<div class="invite"><span class="k ${i.state}">${i.state === "open" ? "Waiting" : "Joined"}</span>
        <span class="w">${who}${joined ? ` <em>→ ${esc(pn("machine", joined.label))}</em>` : ""}</span>
        <span class="t">${i.state === "open" ? "expires " : "joined "}<b>${hhmm(i.state === "open" ? i.expiresAt : Date.parse(i.usedAt))}</b></span>
        ${i.state === "open" ? `<button type="button" class="btn small" data-cancel="${esc(i.id)}" title="Press twice: the first press arms it, the second cancels the link">Cancel link</button>` : "<span></span>"}</div>`;
    }).join("") : `<div class="none">No join link in the last seven days.</div>`;
    paintTeamAlerts();
    paintDays();
    watchScroll($("teamCanvas"));
  }
  /* The last thirty days, newest first, from the daily series every machine adds up to (series['30d'], UTC days): the day's tokens,
     its share of the thirty, and the machine that carried most of it with how many others had usage. Today is measured so far. */
  function paintDays() {
    const s = D.series && D.series["30d"];
    const frame = s && s.byDevice && s.byDevice.frame;
    const vals = s && Array.isArray(s.values) ? s.values : null;
    if (!vals || !vals.length) { $("dayCount").textContent = "not sent by this hub"; $("dayTable").tBodies[0].innerHTML = `<tr><td colspan="4">This hub does not send the daily series.</td></tr>`; return; }
    const total = vals.reduce((a, b) => a + b, 0);
    const bands = (s.byDevice && s.byDevice.bands) || [];
    const rest = (s.byDevice && s.byDevice.rest) || [];
    const withUsage = vals.filter((v) => v > 0).length;
    $("dayCount").innerHTML = `${plural(withUsage, "day")} with usage of ${vals.length} · UTC <span class="win">· 30 days</span>`;
    $("dayCount").title = "The daily totals the console keeps after its minute detail, by UTC calendar day, every machine; today is measured so far";
    const dayName = (i) => new Date(s.start + i * s.step).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    const rows = vals.map((v, i) => [i, v]).reverse();
    $("dayTable").tBodies[0].innerHTML = rows.map(([i, v]) => {
      const today = i === vals.length - 1;
      const who = frame ? bands.map((b) => [b.deviceId, b.tokens[i] || 0]).filter(([, t]) => t > 0).sort((a, b) => b[1] - a[1]) : [];
      const others = (rest[i] || 0) > 0 ? 1 : 0;
      const lead = who[0] ? `<b>${esc(pn("machine", (deviceOf(who[0][0]) || { label: "Unknown machine" }).label))}</b> ${pct(v ? who[0][1] / v : null, 0)}${who.length + others > 1 ? `<em class="q">+${who.length - 1 + others}</em>` : ""}` : v > 0 ? `<span class="na" title="This hub does not split the day by machine">—</span>` : `<span class="na">no usage</span>`;
      return `<tr>
        <td class="k1"><b>${esc(dayName(i))}</b>${today ? `<em class="q">today · so far</em>` : ""}${demoStamp()}</td>
        <td class="num r k3" data-l="tokens" data-src="series.30d.values" title="${fmt(v)} tokens on ${esc(dayName(i))} (UTC)${today ? " so far" : ""}">${v > 0 ? fmt(v) : "—"}</td>
        <td class="k2">${v > 0 ? shareBar(total ? v / total : null, "series.30d.values") : ""}</td>
        <td class="k3" data-l="machines">${lead}</td></tr>`;
    }).join("");
  }
  waveHover("tFlow", "tTip");
  waveHover("pFlow", "pTip");

  /* Cancel link and Remove are both two-step, in place: the first press arms
     the control, the second does it. Remove confirms inside the machine's own
     inspector — never a modal over the canvas. */
  let armed = null;
  document.addEventListener("click", async (ev) => {
    const cancel = ev.target.closest("[data-cancel]");
    if (cancel) {
      if (armed !== cancel) {
        if (armed) { armed.classList.remove("danger"); armed.textContent = "Cancel link"; }
        armed = cancel; cancel.classList.add("danger"); cancel.textContent = "Confirm cancel";
        setTimeout(() => { if (armed === cancel) { armed = null; cancel.classList.remove("danger"); cancel.textContent = "Cancel link"; } }, 6000);
        return;
      }
      armed = null;
      await fetch(`/api/invitations/${cancel.dataset.cancel}/cancel`, { method: "POST", headers: HEADERS });
      toast("That join link no longer works.");
      poll();
      return;
    }
    const revoke = ev.target.closest("[data-revoke]");
    if (revoke) {
      inspect.confirm = revoke.dataset.revoke;
      openInspect("machine", revoke.dataset.revoke);
      return;
    }
    if (ev.target.closest("[data-keep]")) { inspect.confirm = null; paintInspect(); return; }
    const go = ev.target.closest("[data-revoke-go]");
    if (go) {
      const r = await fetch(`/api/devices/${go.dataset.revokeGo}/revoke`, { method: "POST", headers: HEADERS });
      inspect.confirm = null;
      toast(r.ok ? `${go.dataset.label} was removed.` : "It could not be removed.");
      poll();
    }
  });

  // ── projects (this machine only) ─────────────────────────────────────
  /* The Projects view is the same instrument pointed at this machine's own
     transcripts and Git history: the figure, the last hour stacked by project
     (from the local lanes' sparks), tokens and spend-per-commit as share bars
     — then the dense table, every row the door to the project's inspector, and
     the Effort and Shipped blocks under it. */
  $("projSeg").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-p]"); if (!b) return;
    setPeriod(b.dataset.p);
  });
  const localLanes = () => (D ? D.lanes.filter((l) => l.device.local) : []);
  // A project is its folder's hash (H07), so two folders called "app" stay two rows. A lane names its project; it is keyed to
  // the project of that name in this machine's own list, or to its hash when the hub sends one, and to the name otherwise.
  const projectKeyOf = (x) => x.projectHash || x.name;
  const projectKey = (l) => {
    if (l.project.projectHash || l.project.hash) return l.project.projectHash || l.project.hash;
    const x = projCache && projCache.projects.find((y) => y.name === l.project.name);
    return x ? projectKeyOf(x) : l.project.name;
  };
  const projectNameByKey = (key) => { const x = projCache && projCache.projects.find((y) => projectKeyOf(y) === key); if (x) return pn("project", x.name); const l = localLanes().find((item) => projectKey(item) === key); return pn("project", l ? l.project.name : key.slice(0, 6)); };
  /* The parts of the Projects view that come from the console payload — live
     sessions and the sparks — repaint with every poll; the Git figures and the
     per-project series come from /api/projects once a minute. */
  function paintProjectsLive() {
    if (!D) return;
    const by = sparksBy(projectKey, localLanes());
    const p = projCache;
    const series = p && p.series && p.series[period] ? p.series[period].byProject : null;
    const drawn = drawWaves({ svgId: "pFlow", wrapId: "pFlowWrap", reasonId: "pFlowReason", legendId: "pLegend", peakId: "pPeak", series, now: serverNow(),
      nameOf: projectNameByKey, liveOf: (key) => (by.get(key) || { live: 0 }).live, none: "project" });
    if (!p) $("pFlowReason").textContent = "Reading this machine…";
    $("pFlowTitle").textContent = "Activity · " + PERIOD_TEXT[period][0];
    $("pAxLeft").textContent = PERIOD_TEXT[period][2];
    $("pFlowCap").innerHTML = drawn ? `<b>${fmt(drawn.all)}</b> tokens · ${localLanes().filter((l) => l.state === "live").length} live<span class="win"> · ${stepText(drawn.frame.step)} steps</span>` : series && series.frame ? `${stepText(series.frame.step)} steps` : p ? "" : "reading this machine…";
    $("pFlowCap").title = drawn ? `This machine's projects in the ${PERIOD_TEXT[period][0]} at ${stepText(drawn.frame.step)} steps; the bands add up to the figure beside the period control. The last step is measured so far, capped in hatch to its pace.` : "";
    $("pFlow").setAttribute("aria-label", `Tokens in the ${PERIOD_TEXT[period][0]}, stacked by project`);
    for (const cell of document.querySelectorAll("#projTable [data-live]")) {
      const s = by.get(cell.dataset.live);
      const live = s ? s.live : 0;
      cell.innerHTML = `<span class="live-dot${live ? " on" : ""}${D.hub.demo ? " sim" : ""}" title="${live ? plural(live, "session") + " reported within the last two minutes" : "No session reported within the last two minutes"}"><i></i>${live || "—"}</span>`;
    }
    // Each project's activity over the period from the hub's own per-row series (spark); a 0.3 hub gives the hour from its lanes' sparks.
    for (const cell of document.querySelectorAll("#projTable [data-spark]")) {
      const s = by.get(cell.dataset.spark);
      const x = p && p.projects.find((y) => projectKeyOf(y) === cell.dataset.spark);
      cell.innerHTML = x && x.spark ? sparkWave(x.spark, Boolean(s && s.live > 0), `${pn("project", x.name)} · ${x.spark.tokens.some((v) => v > 0) ? `${fmt(x.tokens)} tokens over the ${PERIOD_TEXT[period][0]}, ${stepText(x.spark.step)} steps` : `nothing in the ${PERIOD_TEXT[period][0]}`}`)
        : sparkWave({ tokens: s ? s.spark : null }, Boolean(s && s.live > 0), s ? `${fmt(s.spark.reduce((a, b) => a + b, 0))} tokens in the last hour` : "No session on this project in the period");
    }
    for (const th of document.querySelectorAll("#projTable th.act")) th.textContent = "Activity · " + PERIOD_TEXT[period][1];
    // The sessions behind the projects: this machine's own lanes, by project then by burn, in the Console's row grammar.
    const now = serverNow();
    const lanes = localLanes().slice().sort((a, b) => a.project.name.localeCompare(b.project.name) || (b.tokens5m ?? -1) - (a.tokens5m ?? -1));
    const box = $("pLanes");
    const keep = new Set();
    for (const l of lanes) {
      keep.add(l.key);
      let row = projLaneRows.get(l.key);
      if (!row) { row = makeLaneRow(l); projLaneRows.set(l.key, row); }
      fillLane(row, l, now);
      box.appendChild(row); box.appendChild(row._tree);
    }
    for (const [key, row] of projLaneRows) if (!keep.has(key)) { row.remove(); row._tree.remove(); projLaneRows.delete(key); }
    if (!lanes.length) box.innerHTML = `<div class="empty"><b>No session on this machine in the last 24 hours.</b></div>`;
    roving(box);
    if (box.closest(".lanebody")) watchScroll(box.closest(".lanebody"), "x");
    const live = lanes.filter((l) => l.state === "live").length;
    // sessions over every local lane from the hub's rollup (H05), not only the rows drawn
    const lt = D.laneTotals && D.laneTotals.byLocalProject ? Object.values(D.laneTotals.byLocalProject) : null;
    const total = lt ? lt.reduce((a, t) => a + (t.sessions || 0), 0) : lanes.length;
    $("pLaneCount").innerHTML = total ? `${plural(total, "session")} · ${live} live · ${plural(Math.max(0, lanes.reduce((a, l) => a + l.agents.total, 0)), "subagent")}${total > lanes.length ? ` · ${lanes.length} of ${total} shown` : ""} <span class="win">· 24 h</span>` : `none <span class="win">· 24 h</span>`;
    placeGroup();
  }
  const projLaneRows = new Map();
  // A cell the hub cannot fill says why in a word, never a dash; a reading held back by a named cause is hatched.
  // `spoken` also gives the reason to a screen reader, which does not read a title.
  const na = (word, why, held = false, spoken = false) => `<span class="na${held ? " held" : ""}" title="${esc(why)}">${esc(word)}${spoken ? `<span class="visually-hidden"> — ${esc(why)}</span>` : ""}</span>`;
  const noGit = na("no Git", "Not a Git repository: nothing to count");
  // Merges into the default branch, read three ways and never by truthiness: null is evidence the console could
  // not read (no default branch is known), 0 is an observed none, a positive number is that count.
  function mergeReading(x) {
    const c = x.costPerOutcome, n = c.defaultMerges;
    if (!x.repo) return { count: null, per: null, word: "no Git", why: "Not a Git repository: nothing to count" };
    if (!Number.isSafeInteger(n) || n < 0) return { count: null, per: null, word: "no default", why: "No default branch is known here, so merges into it could not be counted: unavailable, not zero" };
    if (c.perDefaultMergeUsd !== null) return { count: n, per: c.perDefaultMergeUsd };
    return n === 0 ? { count: 0, per: null, word: "no merge", why: "No local default-branch integration in the period, so nothing to divide by" }
      : { count: n, per: null, word: "unpriced", why: "No verified list price for what ran here, so no dollar figure" };
  }
  // A project's money with its status (H06): a floor is marked +, an unpriced one is named, never $0.
  const projCost = (x) => (x.cost && x.cost.status ? x.cost : { usd: x.usd, status: x.usd === null ? "unpriced" : "priced", unpricedModels: [] });
  const projMoney = (x) => { const c = projCost(x); return c.usd === null ? "unpriced" : money(c.usd) + (c.status === "partial" ? "+" : ""); };
  const projMoneyWhy = (x) => { const c = projCost(x); return c.usd === null ? "No verified list price for what ran here" : c.status === "partial" ? `List-price estimate, a floor: ${fmt(c.unpricedTokens || 0)} tokens from ${(c.unpricedModels || []).join(", ") || "an unpriced model"} are not in it` : "List-price estimate. Not an invoice."; };
  // One row of the Projects table. A folder outside Git, and a period whose sessions and branches are not kept, are said once in the
  // table's own head; each such cell is a plain void mark with the reason on hover, never a sentence per row or per column.
  function projectRow(x, p, label) {
    const c = x.costPerOutcome, m = mergeReading(x);
    const key = projectKeyOf(x), name = pn("project", x.name);
    const basis = p.period && p.period.basis === "utc-days";
    const sessionsCell = x.sessions === null ? na("—", basis ? "Sessions are kept with the minute detail (8 days), not with the daily rollup this period reads; nothing is estimated in their place" : "Sessions are kept with the minute detail (8 days); nothing is estimated in their place") : x.sessions;
    const branchesCell = (x.branches || []).length ? esc(x.branches.slice(0, 3).map((b) => pn("branch", b)).join(", "))
      : basis || (p.period && p.period.branchesKept === false) ? na("—", "Branches are kept with the minute detail (8 days), not with the daily rollup this period reads") : na("—", "No branch name reached the console from this project's sessions");
    const gitCells = x.repo ? `<td class="num r k3" data-l="commits" data-src="projects.repo.commits" title="${plural(x.repo.commits, "commit") + " in local Git · " + esc(label)}">${x.repo.commits}</td>
      <td class="num r" data-src="projects.repo.added" title="Lines added and removed in local Git · ${esc(label)}">+${x.repo.added.toLocaleString("en-US")} / −${x.repo.removed.toLocaleString("en-US")}</td>
      <td class="num r" data-src="projects.repo.prsMerged" title="Commits whose subject ends (#N) or merges a pull request">${x.repo.prsMerged === null ? na("no remote", "Needs a remote to tell pull requests from issues") : x.repo.prsMerged}</td>
      <td class="num r" data-src="projects.costPerOutcome.defaultMerges" title="Local default-branch integration commits">${m.count === null ? na(m.word, m.why, false, true) : m.count}</td>
      <td class="num r" data-internal data-src="projects.costPerOutcome.perCommitUsd" title="Spend in the work window per local commit, not attribution">${c.perCommitUsd === null ? (x.repo.commits ? na("unpriced", "No verified list price for what ran here, so no dollar figure") : na("no commit", "No local commit in the period")) : money(c.perCommitUsd) + " est."}</td>
      <td class="num r" data-internal data-src="projects.costPerOutcome.perDefaultMergeUsd" title="Spend in the work window per local default-branch integration, not attribution">${m.per === null ? na(m.word, m.why, false, true) : money(m.per) + " est."}</td>
      <td class="num mono" data-src="projects.branches">${branchesCell}</td>`
      : `<td class="merged" colspan="7" data-src="projects.repo">${na("—", "Not a Git repository: no commits, lines, merges, spend per commit or branches to count; its tokens, estimate and sessions are still measured", false, true)}</td>`;
    return `<tr class="door" data-inspect="project:${esc(key)}">
      <td class="k1"><button type="button" class="rowbtn" data-inspect="project:${esc(key)}" title="Open ${esc(name)}${x.parent && !present ? ` · in ${esc(x.parent)}/` : ""}">${esc(name)}</button>${demoStamp()}${x.repo ? (x.repo.name !== x.name ? `<span class="sub">${esc(pn("project", x.repo.name))}</span>` : "") : ""}</td>
      <td class="k3" data-l="live" data-live="${esc(key)}"><span class="live-dot"><i></i>—</span></td>
      <td data-spark="${esc(key)}"><span class="sp none">—</span></td>
      <td class="num r k3" data-l="tokens" data-src="projects.tokens" title="${fmt(x.tokens)} tokens in this machine's transcripts · ${esc(label)}">${fmt(x.tokens)}</td><td class="k2">${shareBar(p.tokens ? x.tokens / p.tokens : null, "projects.tokens")}</td>
      <td class="num r k3" data-l="est." data-internal data-src="projects.usd" title="${esc(projMoneyWhy(x))}">${x.usd === null ? "unpriced" : money(x.usd)}${projCost(x).status === "partial" ? "+" : ""}</td>
      <td class="num r" data-src="projects.sessions" title="${x.sessions === null ? "Sessions are kept with the minute detail" : plural(x.sessions, "session") + " · " + esc(label)}">${sessionsCell}</td>
      ${gitCells}</tr>`;
  }
  async function loadProjects(fromCache = false) {
    const body = $("projTable").tBodies[0];
    if (!projCache) body.innerHTML = `<tr><td colspan="14">Reading this machine…</td></tr>`;
    try {
      let p = projCache;
      if (!fromCache || !p || (p.period && p.period.id !== period)) {
        const r = await fetch("/api/projects?period=" + period, { headers: HEADERS });
        p = await r.json();
        if (!r.ok) throw new Error(p.reason || String(r.status));
        projCache = p;
      }
      const t = p.totals;
      const label = PERIOD_TEXT[period][1];
      // The payload's own money and status (H06): partial counts the partial and the unpriced projects, never a bare figure over an unpriced one.
      const cost = p.cost && p.cost.status ? p.cost : { usd: p.projects.some((x) => x.usd !== null) ? p.projects.reduce((a, x) => a + (x.usd || 0), 0) : null, status: p.projects.some((x) => x.usd === null && x.tokens > 0) ? "partial" : "priced", unpricedModels: [] };
      const partialN = p.projects.filter((x) => projCost(x).status === "partial").length;
      const unpricedN = p.projects.filter((x) => x.usd === null && x.tokens > 0).length;
      const stampAt = p.computedAt ? `as of ${hhmm(p.computedAt)} ${zoneName()}`.trim() : asOf();
      $("pCap").title = `Tokens · ${PERIOD_TEXT[period][0]} · this machine's transcripts`;
      $("pTotal").textContent = fmt(p.tokens);
      $("pTotal").title = `${fmt(p.tokens)} tokens in this machine's transcripts · ${label} · ${stampAt}`;
      $("pSpend").textContent = cost.usd === null ? "no priced model" : money(cost.usd) + (cost.status === "partial" ? "+ est. · partial" : " est.");
      $("pSpend").title = cost.status === "partial" ? `A floor: ${plural(partialN, "project is partly", "projects are partly")} unpriced and ${plural(unpricedN, "project is", "projects are")} wholly unpriced (${(cost.unpricedModels || []).join(", ") || "no verified list price"}); their tokens are not in this figure` : "List-price estimate. Not an invoice.";
      $("pSessions").innerHTML = p.sessions === null ? `<span class="s">sessions not kept</span>` : `${p.sessions.toLocaleString("en-US")} sessions`;
      $("pSessions").title = p.sessions === null ? (p.period && p.period.sessionsKept === false ? "Sessions are kept with the minute detail (8 days), not with the daily rollup this period reads; none is estimated" : "Sessions are kept with the minute detail; none is estimated for this period") : `${plural(p.sessions, "session")} on this machine · ${label}`;
      $("pProv").innerHTML = (p.demo ? "generated · this machine · " : "this machine's transcripts and Git · ") + (p.author === true ? "commits by this machine's Git email" : p.author === false ? "every author — no Git email set here" : "local Git history");
      $("pProv").title = (p.author === false ? "No Git email (user.email) is set in one of these repositories, so its Git figures count every author. None of this leaves this machine." : "Read from this machine only. None of this leaves this machine.") + " · " + stampAt;
      // Git nobody could read is a void with the hub's reason under it, never "0 commits" (F6)
      const unread = gitUnread(t);
      $("pKv").innerHTML = [
        [String(p.projects.length), plural(p.projects.length, "project").replace(/^\S+ /u, ""), `${p.withRepo} in Git`, "projects.length"],
        [gitN(t.commits), "commits", unread ? gitWhy(t) : "local Git · " + label, "projects.totals.commits", unread ? gitWhy(t) : ""],
        [gitLines(t) ?? `+${fmt(t.added)}<span class="u">−${fmt(t.removed)}</span>`, "lines", unread ? "not read" : "added / removed", "projects.totals.added", unread ? gitWhy(t) : ""],
        [t.prsMerged === null ? "—" : String(t.prsMerged), plural(t.prsMerged === null ? 2 : t.prsMerged, "PR-linked commit").replace(/^\S+ /u, ""), unread ? "not read" : t.prsMerged === null ? "needs a remote" : "(#N) or PR merge", "projects.totals.prsMerged", unread ? gitWhy(t) : "Commits referencing #N: a subject ending (#N) or a pull-request merge; #N may name an issue rather than a merged pull request"],
      ].map(([v, l, s, src, why]) => `<div><div class="v${v === "—" ? " void" : ""}" data-src="${src}" title="${esc(why || l + " · " + s)} · ${stampAt}">${v}</div><div class="l">${esc(l)}</div><div class="s" title="${esc(s)}">${esc(s)}</div></div>`).join("");
      // Effort: the fleet on one line, this machine's Git on the other — both from this one answer, at one clock, never divided into each other.
      const fleet = fleetOf(p);
      const w = fleet || win();
      const over = fleet && p.tokens > w.tokens.total;
      const fleetTokens = over ? p.tokens : w.tokens.total;
      $("pEffort").innerHTML = `<div title="Every machine on the console · ${esc(label)}${fleet ? " · computed with this machine's figures at " + hhmm(p.computedAt) : " · " + w.messages.toLocaleString("en-US") + " messages"}${over ? " · the fleet total computed at that clock was below this machine's own, so it is shown as this machine's, marked" : ""}"><span class="el">every machine</span><span class="ev"><span class="eg"><b data-src="${fleet ? "fleet.tokens" : "windows.tokens.total"}">${fmt(fleetTokens)}</b><em>tokens${over ? ` <span class="clamp">≥</span>` : ""}</em></span> · <span class="eg"><b data-internal data-src="${fleet ? "fleet.cost.usd" : "windows.cost.usd"}">${w.cost.usd === null ? "unpriced" : money(w.cost.usd)}</b><em>${w.cost.usd === null ? "" : "est." + (w.cost.status === "partial" ? "+" : "")}</em></span></span></div>
        <div title="This machine's own transcripts and Git · ${esc(label)}${p.sessions === null ? "" : " · " + plural(p.sessions, "session")}${unread ? " · " + esc(gitWhy(t)) : ""}"><span class="el">this machine</span><span class="ev"><span class="eg"><b data-src="projects.tokens">${fmt(p.tokens)}</b><em>tokens</em></span> · <span class="eg"><b data-src="projects.totals.commits">${gitN(t.commits)}</b><em>${t.commits === 1 ? "commit" : "commits"}</em></span></span></div>`;
      // Share of tokens per project, sorted, top five and "n more"; spend per commit as bars against the costliest.
      const ranked = p.projects.slice().sort((a, b) => b.tokens - a.tokens);
      const max = Math.max(...ranked.map((x) => x.tokens), 1);
      const open = moreOpen.has("pShare");
      const shown = open ? ranked : ranked.slice(0, MODELS_SHOWN);
      capWin("pShareCap", "tokens by project", label);
      $("pShare").innerHTML = shown.map((x) => `<div class="mrow door" data-inspect="project:${esc(projectKeyOf(x))}" tabindex="0" role="button" title="${esc(pn("project", x.name))} · ${fmt(x.tokens)} tokens · ${pct(p.tokens ? x.tokens / p.tokens : null)} of this machine · open">
          <span class="mn"><span class="txt">${esc(pn("project", x.name))}</span></span><span class="ms">${demoStamp()}</span>
          <span class="mbar" aria-hidden="true"><i style="width:${Math.max(1, Math.round((x.tokens / max) * 100))}%"></i></span>
          <span class="mv" data-src="projects.tokens">${pct(p.tokens ? x.tokens / p.tokens : null, 0)}</span>
          ${x.usd === null ? `<span class="mc unp" title="No verified list price for what ran here">unpriced</span>` : `<span class="mc" data-internal data-src="projects.usd" title="${esc(projMoneyWhy(x))}">${projMoney(x)}</span>`}
        </div>`).join("") + (ranked.length > MODELS_SHOWN ? `<button type="button" class="more" data-more="pShare">${open ? "fewer" : `${ranked.length - MODELS_SHOWN} more`}</button>` : "")
        || `<div class="mrow"><span class="mn"><span class="none-text">no project has transcripts in this period</span></span></div>`;
      const priced = ranked.filter((x) => x.costPerOutcome.perCommitUsd !== null).sort((a, b) => b.costPerOutcome.perCommitUsd - a.costPerOutcome.perCommitUsd);
      const pmax = Math.max(...priced.map((x) => x.costPerOutcome.perCommitUsd), 0.01);
      // spend per default-branch merge, the outcome the product argues for: rows against the costliest
      const merged = ranked.map((x) => [x, mergeReading(x)]).filter(([, m]) => m.per !== null).sort((a, b) => b[1].per - a[1].per);
      const mmax = Math.max(...merged.map(([, m]) => m.per), 0.01);
      const anyGit = ranked.some((x) => x.repo);
      // one void sentence per card: what neither block can show is said once under spend per commit, and the merge block folds away
      const commitWhy = priced.length ? "" : anyGit ? "no priced commit in this period" : "no project here is in a Git repository";
      const mergeWhy = merged.length ? "" : anyGit ? (ranked.some((x) => mergeReading(x).count > 0) ? "no priced merge in this period" : "no default-branch merge in this period") : "";
      const voidLine = (why) => `<div class="xrow"><span class="xn"><em>${esc(why)}</em></span></div>`;
      $("pSpendRows").innerHTML = priced.length ? priced.slice(0, MODELS_SHOWN).map((x) => `<div class="mrow door" data-inspect="project:${esc(projectKeyOf(x))}" tabindex="0" role="button" title="${esc(pn("project", x.name))} · spend in the window of the work per local commit — not attribution · open">
          <span class="mn"><span class="txt">${esc(pn("project", x.name))}</span></span><span class="ms"></span>
          <span class="mbar" aria-hidden="true"><i style="width:${Math.max(1, Math.round((x.costPerOutcome.perCommitUsd / pmax) * 100))}%"></i></span>
          <span class="mv" data-src="projects.repo.commits">${x.repo ? x.repo.commits : "—"}</span>
          <span class="mc" data-internal data-src="projects.costPerOutcome.perCommitUsd">${money(x.costPerOutcome.perCommitUsd)}</span>
        </div>`).join("") : voidLine([commitWhy, merged.length ? "" : mergeWhy].filter(Boolean).join(" · "));
      $("pMergeHead").hidden = !merged.length;
      $("pMergeRows").innerHTML = merged.length ? merged.slice(0, MODELS_SHOWN).map(([x, m]) => `<div class="mrow door" data-inspect="project:${esc(projectKeyOf(x))}" tabindex="0" role="button" title="${esc(pn("project", x.name))} · spend in the window of the work per local default-branch integration — not attribution · open">
          <span class="mn"><span class="txt">${esc(pn("project", x.name))}</span></span><span class="ms"></span>
          <span class="mbar" aria-hidden="true"><i style="width:${Math.max(1, Math.round((m.per / mmax) * 100))}%"></i></span>
          <span class="mv" data-src="projects.costPerOutcome.defaultMerges">${m.count}</span>
          <span class="mc" data-internal data-src="projects.costPerOutcome.perDefaultMergeUsd">${money(m.per)}</span>
        </div>`).join("") : "";
      $("pEffortHint").textContent = "spend in the window of the work, not attribution";
      $("pEffortHint").title = "Tokens measure usage, not value; this is not a productivity score.";

      // what the table cannot count is said once here, over the rows, never once per row or per column (F5)
      const notGit = p.projects.length - p.withRepo;
      const kept = !(p.period && p.period.sessionsKept === false);
      const once = [notGit ? `${notGit} not in Git` : "", kept ? "" : "sessions and branches not kept (daily rollup)"].filter(Boolean);
      $("projTableCount").innerHTML = `${plural(p.projects.length, "project")} · ${p.withRepo} in Git${once.length ? " · " + esc(once.join(" · ")) : ""} <span class="win">· ${esc(label)}</span>`;
      $("projTableCount").title = [notGit ? `${notGit} of ${p.projects.length} folders are not inside a Git repository: no commits, lines, merges, spend per commit or branches to count there; their tokens, estimate and sessions are still measured` : "", kept ? "" : `${PERIOD_TEXT[period][0]} is read from the daily rollup, which keeps tokens by day but not sessions or branch names; nothing is estimated in their place`].filter(Boolean).join(". ");
      body.innerHTML = p.projects.length ? ranked.map((x) => projectRow(x, p, label)).join("")
        : `<tr><td colspan="14">No project on this machine has transcripts in this period.</td></tr>`;
      paintProjectsLive();
      paintProjectsEffort(p, label);
      watchScroll($("projCanvas"));
      if (inspect.open && inspect.kind === "project") paintInspect();
    } catch (error) {
      body.innerHTML = `<tr><td colspan="14">This machine's projects could not be read: ${esc(error.message)}</td></tr>`;
    }
  }
  /* Under the sessions on Projects: the Effort and Shipped tables, so the frame is filled with the reading, never with an empty tile. */
  function paintProjectsEffort(p, label) {
    const t = p.totals;
    const w = fleetOf(p) || win();
    $("pEffortCount").textContent = `every machine beside this machine's Git · ${label}`;
    $("pEffortBody").innerHTML = effortTable(p, w, label);
    $("pShipCount").textContent = gitUnread(t) ? gitWhy(t) : `${plural(t.commits, "commit")} · ${t.prsMerged === null ? "no remote" : t.prsMerged + " referencing #N"} · ${gitLines(t) ? "lines not read" : `+${fmt(t.added)} / −${fmt(t.removed)} lines`}`;
    $("pShipBody").innerHTML = shippedTable(p);
  }

  /* Every console request needs the sign-in cookie. Without it the page says
     how to get one instead of showing an empty console. */
  function signedOut() {
    document.body.classList.add("signed-out");
    $("signedOut").hidden = false;
  }
  // The way back in without restarting: the console prints a new sign-in link
  // in its own window. Nothing comes back here but that it was printed.
  $("printSignIn").addEventListener("click", async () => {
    const say = $("printSay");
    try {
      const response = await fetch("/api/sign-in/print", { method: "POST", headers: HEADERS, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      say.textContent = response.ok ? "A new sign-in link is in the window where the console runs. It works once."
        : body.reason || "The console did not print a link. Try again in a few seconds.";
    } catch {
      say.textContent = "The console did not answer. Is it still running?";
    }
    say.hidden = false;
  });
  // Ends this browser's session on the console, not just the page.
  $("signOutBtn").addEventListener("click", async () => {
    try {
      const response = await fetch("/api/signout", { method: "POST", headers: HEADERS, cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      clearTimeout(pollTimer);
      closeAdd();
      signedOut();
    } catch {
      toast("Signing out did not reach the console. Try again.");
    }
  });

  // ── add a machine ───────────────────────────────────────────────────
  const addDialog = $("addDialog");
  let pending = null;   // { id, link, command, typed }
  function step(name) {
    for (const s of addDialog.querySelectorAll(".step")) s.hidden = s.dataset.step !== name;
  }
  function openAdd() {
    step("form");
    $("addForm").reset();
    // the people already on the console, to pick from — none while presenting: a name list is a name list, and a stand-in would be sent as the person
    $("peopleList").innerHTML = present ? "" : (D ? D.people : []).map((p) => `<option value="${esc(p.person)}"></option>`).join("");
    $("loopbackWarn").hidden = !D || D.hub.listen.network || D.hub.demo;
    // The first remote machine needs the console restarted to listen on the
    // network: the exact command, with the options it runs with now.
    const again = D && D.hub.networkCommand;
    $("networkCmd").hidden = !again;
    $("networkCmdShown").textContent = again || "";
    openSheet(addDialog, view + "/add");
    $("fPerson").focus();
  }
  $("addBtn").addEventListener("click", openAdd);
  addDialog.addEventListener("click", (ev) => { if (ev.target.closest("[data-close]")) closeAdd(); });
  addDialog.addEventListener("close", () => clearSecret());
  function closeAdd() { if (addDialog.open) addDialog.close(); }
  function clearSecret() {
    // The link is a credential until it is used or expires. It is not kept
    // on the page once the sheet is closed.
    $("linkField").value = "";
    $("cmdShown").textContent = "—";
    $("typedShown").textContent = "—";
    if (pending) { pending.link = null; pending.command = null; pending.typed = null; }
  }
  $("anotherBtn").addEventListener("click", () => { clearSecret(); pending = null; openAdd(); });
  $("addForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("createBtn").disabled = true;
    try {
      const r = await fetch("/api/invitations", {
        method: "POST", headers: { ...HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ person: $("fPerson").value, machine: $("fMachine").value, minutes: Number($("fMinutes").value) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.reason || "The link could not be made.");
      pending = { id: j.invitation.id, link: j.link, command: j.command, typed: j.typed };
      $("linkField").value = j.link;
      // Commands are shown with their codes masked; Copy puts the real one on the clipboard.
      const secret = j.link.slice(j.link.indexOf("#") + 1, j.link.lastIndexOf("."));
      // The verify-then-run check at the front is shortened on screen; Copy gives it whole.
      const short = (text) => text.replace(/^node -e '[^']*'/u, "node -e '…'");
      $("cmdShown").textContent = short(j.command.replace(secret, "••••••••"));
      $("typedShown").textContent = short(j.typed.replace(j.code, "••••-••••"));
      // the names just typed, through the same stand-ins as every other name while presenting
      const who = [pn("person", j.invitation.person), pn("machine", j.invitation.machine)].filter(Boolean).join("'s ").replace(/'s$/, "") || "them";
      $("linkSay").innerHTML = j.demo
        ? "This is a demonstration console, so this link cannot actually be used. On a real console, the steps are exactly these."
        : j.network
          ? `Send ${esc(who)} the command below by any message. They paste it into a terminal on their computer, which must be on the same network as this machine. Agent Console itself comes from its GitHub release, never from this machine.`
          : `This console listens on this machine only, so the link works only here — for example for a second account on this computer. To add another computer, restart with <code>--listen 0.0.0.0</code>.`;
      $("linkExpiry").textContent = `Works once. Expires at ${hhmm(j.invitation.expiresAt)}.`
        + (j.adjusted && j.adjusted.minutes ? ` (${j.adjusted.minutes.used} minutes, not ${j.adjusted.minutes.asked}: ${j.adjusted.minutes.reason}.)` : "");
      const status = $("joinStatus");
      status.className = "waiting";
      status.innerHTML = "<i></i>Waiting for the machine to join…";
      step("link");
      $("copyCmd").focus();
      poll();
    } catch (error) {
      toast(error.message);
    } finally {
      $("createBtn").disabled = false;
    }
  });
  async function copy(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done); }
    catch { toast("Copying is blocked in this browser. Select the command and copy it by hand."); }
  }
  $("copyLink").addEventListener("click", () => pending && pending.link && copy(pending.link, "Join link copied. It works once."));
  $("copyCmd").addEventListener("click", () => pending && pending.command && copy(pending.command, "Command copied."));
  $("copyTyped").addEventListener("click", () => pending && pending.typed && copy(pending.typed, "Command copied."));
  $("copyNetworkCmd").addEventListener("click", () => D && D.hub.networkCommand && copy(D.hub.networkCommand, "Command copied. Stop the console with Ctrl+C, then run it."));
  function watchJoin() {
    if (!pending || !addDialog.open) return;
    const inv = D.invitations.find((i) => i.id === pending.id);
    if (inv && inv.state === "joined") {
      const device = D.devices.find((d) => d.id === inv.deviceId);
      const status = $("joinStatus");
      status.className = "waiting done";
      status.innerHTML = `<i></i>Joined at ${hhmm(Date.parse(inv.usedAt))} — ${esc(device ? pn("machine", device.label) : "the machine")}${device && device.person ? " (" + esc(pn("person", device.person)) + ")" : ""} is reporting.`;
      clearSecret();
    }
  }

  // ── small things ─────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(message, html = false) {
    const t = $("toast");
    if (html) t.innerHTML = message; else t.textContent = message;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 4200);
  }
  function hideToast() { clearTimeout(toastTimer); $("toast").classList.remove("show"); }
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); });
    for (const c of d.querySelectorAll("[data-close]")) if (d.id !== "addDialog") c.addEventListener("click", () => d.close());
  }

  // ── the inspector: a machine, a person or a project, opened beside the canvas by its row ──
  /* Everything in it is the payload regrouped — the machine's own lanes, its
     sparks summed, its models, its join record — never a figure the page made
     up. Esc closes it; the URL carries it while it is open. */
  const inspectDialog = $("inspectDialog");
  function openInspect(kind, id, from = null) {
    inspect.open = true; inspect.kind = kind; inspect.id = id;
    paintInspect();
    openSheet(inspectDialog, `${view}/${kind}/${idInUrl(kind, id)}`, from);
  }
  inspectDialog.addEventListener("close", () => { inspect.open = false; });
  document.addEventListener("click", (ev) => {
    const door = ev.target.closest("[data-inspect]"); if (!door) return;
    const other = ev.target.closest("button, a");
    if (other && !other.hasAttribute("data-inspect")) return;   // Remove and Cancel keep their own job
    const [kind, ...rest] = door.dataset.inspect.split(":");
    openInspect(kind, rest.join(":"), door);
  });
  const ikv = (cells) => `<div class="ikv">${cells.map(([v, l, cls, src]) => `<div><div class="v${cls ? " " + cls : ""}"${src ? ` data-src="${src}"` : ""}>${v}</div><div class="l">${esc(l)}</div></div>`).join("")}</div>`;
  // What a machine's reporter said it could not count: a count, or a void with its reason when that version never said (never a zero).
  const coverageCell = (d) => {
    const c = d.coverage;
    if (!c || c.reported === false || c.dropped === null || c.dropped === undefined) return [na("not reported", "Not reported by this machine's reporter version: what it could not count is unknown, not zero", true, true), "not counted", "warn"];
    return [String(c.dropped) + (c.since ? `<span class="u"> since ${esc(new Date(c.since).toLocaleDateString([], { day: "numeric", month: "short" }))}</span>` : ""), "not counted", c.dropped ? "warn" : ""];
  };
  // The inspector's last hour: the same wave as every row, taller, sunk into its tile.
  const isparkHtml = (s, dim) => s
    ? `<div class="isparkwrap">${sparkWave({ tokens: s.spark }, !dim && s.spark[s.spark.length - 1] > 0, s.spark.some((v) => v > 0) ? `${fmt(s.spark.reduce((a, b) => a + b, 0))} tokens in the last hour, three-minute steps` : "Nothing in the last hour", { dim, W: 300, H: 44, cls: "ispark" })}</div>`
    : `<div class="iquiet">No session in the last 24 hours.</div>`;
  const stateWord = (s) => s === "live" ? "LIVE" : s === "idle" ? "IDLE" : s === "revoked" ? "REMOVED" : s === "catching-up" ? "CATCHING UP" : s === "reconnecting" ? "RECONNECTING" : "SILENT";
  const laneList = (lanes, cap = "24 h", total = null) => lanes.length
    ? `<div class="ihead">Sessions <span>${total && total > lanes.length ? `${lanes.length} of ${total}` : lanes.length} · ${esc(cap)}</span></div>` + lanes.slice(0, 12).map((l) => `<div class="irow" data-lane="${esc(l.key)}" tabindex="0" role="button" title="Open the lane · ${esc(pn("project", l.project.name))}${l.branch ? " · " + esc(pn("branch", l.branch)) : ""}"><span class="nm"><b>${esc(pn("project", l.project.name))}</b>${l.branch ? `<em>${esc(pn("branch", l.branch))}</em>` : ""}</span><span class="md">${esc(l.modelLabel)}</span><span class="r" data-src="lanes.tokensDay">${l.tokensDay == null ? "—" : fmt(l.tokensDay)}</span><span class="st ${l.state}">${stateWord(l.state)}</span></div>`).join("")
      + (lanes.length > 12 ? `<div class="iquiet">${lanes.length - 12} more in the lanes</div>` : "")
      + (total && total > lanes.length ? `<div class="iquiet">${plural(total, "session")} in all; the hub sends ${lanes.length} to draw</div>` : "")
    : total ? `<div class="iquiet">${plural(total, "session")} in the last 24 hours, none among the lanes the hub sent to draw.</div>` : `<div class="iquiet">No session in the last 24 hours.</div>`;
  const modelList = (models, cap) => models.length ? `<div class="ihead">Models <span>${esc(cap)}</span></div>` + modelRows(models, "inspect", models) : "";
  // The Projects inspector for one project with transcripts in the period.
  function projectInspectBody(x, cap, s, lanes) {
    const c = x.costPerOutcome, m = mergeReading(x);
    return `<div class="ihero"><span class="big" data-src="projects.tokens">${fmt(x.tokens)}</span><span class="u">tokens · ${esc(cap)} · this machine</span>${demoStamp()}</div>
    <div class="iline">${x.repo ? `<b>${esc(pn("project", x.repo.name))}</b> · ${plural(x.repo.commits, "commit")}` : "<b>not a Git repository</b>"}${x.branches && x.branches.length ? ` · <span class="mono">${x.branches.map((b) => esc(pn("branch", b))).join(", ")}</span>` : ""}${x.parent && !present ? ` · in <span class="mono">${esc(x.parent)}/</span>` : ""}</div>
    ${ikv([[projMoney(x), "est. $", x.usd === null ? "warn" : "", "projects.usd"], [x.sessions === null ? "not kept" : String(x.sessions), "sessions", "", "projects.sessions"],
      [x.repo ? `+${fmt(x.repo.added)} <span class="u">−${fmt(x.repo.removed)}</span>` : "no Git", "lines", "", "projects.repo.added"], [x.repo && x.repo.prsMerged !== null ? String(x.repo.prsMerged) : x.repo ? "no remote" : "no Git", "PR-linked commits", "", "projects.repo.prsMerged"],
      [c.perCommitUsd === null ? (x.repo && x.repo.commits ? "unpriced" : "no commit") : money(c.perCommitUsd), "$ / commit · est.", "", "projects.costPerOutcome.perCommitUsd"], [m.per === null ? na(m.word, m.why, false, true) : money(m.per), `$ / merge · est. · ${m.count === null ? "merges not counted" : plural(m.count, "merge")}`, "", "projects.costPerOutcome.perDefaultMergeUsd"]])}
    <div class="ihead">Last hour <span>${s ? fmt(s.spark.reduce((a, b) => a + b, 0)) + " tokens" : "—"}</span></div>${isparkHtml(s, false)}
    ${laneList(lanes, "24 h", D && D.laneTotals && D.laneTotals.byLocalProject && D.laneTotals.byLocalProject[projectKeyOf(x)] ? D.laneTotals.byLocalProject[projectKeyOf(x)].sessions : null)}`;
  }
  function paintInspect() {
    if (!D || !inspect.open) return;
    const now = serverNow();
    const cap = PERIOD_TEXT[period][1];
    const foot = $("inspectFoot");
    let title = "—", body = "";
    foot.innerHTML = "";
    if (inspect.kind === "machine") {
      const d = D.devices.find((x) => x.id === inspect.id);
      if (!d) { title = "Machine"; body = `<div class="iquiet">This machine is no longer on the console.</div>`; }
      else {
        const a = pw(d);
        const s = sparksBy(deviceKey).get(d.id);
        title = pn("machine", d.label);
        const lost = d.coverage && d.coverage.dropped ? d.coverage.dropped : 0;
        const cov = coverageCell(d);
        const unsaid = !d.coverage || d.coverage.reported === false || d.coverage.dropped === null;
        const lt = D.laneTotals && D.laneTotals.byDevice ? D.laneTotals.byDevice[d.id] : null;
        const watched = D.alertsCoverage && Array.isArray(D.alertsCoverage.unwatchedDevices) ? !D.alertsCoverage.unwatchedDevices.includes(d.id) : null;
        // this machine's own coverage of the hour (alertsCoverage.byDevice) and what it shares (sharing): "no alert" is claimed only from the time its alerts are held
        const alertCov = D.alertsCoverage && D.alertsCoverage.byDevice ? D.alertsCoverage.byDevice[d.id] || null : null;
        const sh = sharingText(d);
        body = `<div class="ihero"><span class="big" data-src="devices.windows.tokens.total">${fmt(a.tokens.total)}</span><span class="u">tokens · ${esc(cap)}${d.status === "silent" ? " · last known" : ""}</span></div>
          <div class="iline"><span class="status ${d.status}"><i></i>${esc(statusText(d, now))}</span>${d.person ? ` · <b>${esc(pn("person", d.person))}</b>` : ""}${d.local ? " · this machine" : ""}</div>
          ${sh ? `<div class="iline" title="${esc(sh.title)}">${sh.whole ? "shares · <b>alerts · tools</b>" : `<b>${esc(sh.text)}</b>`}${sh.refused ? ` · <b class="w">${plural(sh.refused, "entry", "entries")} refused</b> · future-dated` : ""}</div>` : ""}
          ${ikv([[pct(a.shareOfWhole, 0), "share of every machine", "", "devices.windows.shareOfWhole"], [costMark(a.cost, lost).html, "est. $", a.cost.status === "unpriced" ? "warn" : "", "devices.windows.cost.usd"],
            [pct(a.shares.cacheRead), "cache read", "", "devices.windows.shares.cacheRead"], [pct(a.shares.cacheWrite), "cache write", "", "devices.windows.shares.cacheWrite"],
            [a.messages.toLocaleString("en-US"), "messages", "", "devices.windows.messages"], [cov[0], cov[1], cov[2], "devices.coverage.dropped"]])}
          <div class="ihead">Last hour <span>${s ? fmt(s.spark.reduce((x, y) => x + y, 0)) + " tokens" : "—"}</span></div>${isparkHtml(s, d.status !== "reporting")}
          ${modelList(a.models, cap)}
          ${laneList(D.lanes.filter((l) => l.device.id === d.id), "24 h", lt ? lt.sessions : null)}
          <div class="iquiet">${d.local ? "The hub itself." : `Joined ${new Date(d.createdAt).toLocaleDateString([], { day: "numeric", month: "short" })} · ${hhmm(Date.parse(d.createdAt))}${d.joinedVia === "link" ? " by link" : ""}.`}${lost ? ` <b>${lost} not counted</b>: ${esc(d.coverage.reasons.map((r) => r.count + " × " + r.label).join("; "))}.` : ""}${unsaid ? ` <b>Coverage not reported</b> by this machine's version: what it could not count is unknown, not zero.` : ""}${alertCov ? (alertCov.state === "complete" ? "" : alertCov.state === "partial" ? ` <b>Alerts held since ${hhmm(alertCov.since)}</b>: ${esc(coverageWhy(alertCov).replace(/^./u, (c) => c.toLowerCase()))}; before then its quiet is not "no alert".` : ` <b>Alerts ${esc(COVERAGE_WORD[alertCov.reason] || alertCov.state)}</b>: ${esc(coverageWhy(alertCov).replace(/^./u, (c) => c.toLowerCase()))}, so no alert from it can be known here.`) : watched === false ? ` <b>Alerts not shared</b>: its reporter runs without --share-alerts, so no alert from it can be known here.` : ""}${sh && sh.refused ? ` <b>${plural(sh.refused, "entry", "entries")} refused</b>: dated more than two minutes in the future; counted here, never stored.` : ""}</div>`;
        // Remove confirms here, in the sheet's own foot: the first press asks, the second does it.
        if (!d.local && d.status !== "revoked") foot.innerHTML = inspect.confirm === d.id
          ? `<span class="confirm"><b>Remove ${esc(pn("machine", d.label))}?</b> It stops being accepted at once. What it already reported stays on the console, marked as removed. A new join link brings it back.</span><button type="button" class="btn" data-keep>Keep it</button><button type="button" class="btn danger solid" data-revoke-go="${esc(d.id)}" data-label="${esc(pn("machine", d.label))}">Remove</button>`
          : `<button type="button" class="btn danger" data-revoke="${esc(d.id)}" data-label="${esc(pn("machine", d.label))}">Remove</button>`;
      }
    } else if (inspect.kind === "person") {
      const p = D.people.find((x) => x.person === inspect.id);
      if (!p) { title = "Person"; body = `<div class="iquiet">Nobody by that name is on the console.</div>`; }
      else {
        const a = pw(p);
        const s = sparksBy((l) => personOfDevice(l.device.id)).get(p.person);
        const lt = D.laneTotals && D.laneTotals.byPerson ? D.laneTotals.byPerson[p.person] : null;
        title = pn("person", p.person);
        body = `<div class="ihero"><span class="big" data-src="people.windows.tokens.total">${fmt(a.tokens.total)}</span><span class="u">tokens · ${esc(cap)}</span></div>
          <div class="iline">${p.reporting} of ${plural(p.devices.length, "machine")} reporting · <b>${p.devices.map((id) => esc(pn("machine", (deviceOf(id) || {}).label || ""))).join(", ")}</b></div>
          ${ikv([[pct(a.shareOfWhole, 0), "share of every machine", "", "people.windows.shareOfWhole"], [costCell(a.cost), "est. $", a.cost.status === "unpriced" ? "warn" : "", "people.windows.cost.usd"],
            [pct(a.shares.cacheRead), "cache read", "", "people.windows.shares.cacheRead"], [pct(a.shares.cacheWrite), "cache write", "", "people.windows.shares.cacheWrite"],
            [a.messages.toLocaleString("en-US"), "messages", "", "people.windows.messages"], [String(p.devices.length), plural(p.devices.length, "machine").replace(/^\S+ /u, ""), "", "people.devices"]])}
          <div class="ihead">Last hour <span>${s ? fmt(s.spark.reduce((x, y) => x + y, 0)) + " tokens" : "—"}</span></div>${isparkHtml(s, p.reporting === 0)}
          ${modelList(a.models, cap)}
          <div class="ihead">Machines <span>${p.devices.length}</span></div>
          ${p.devices.map((id) => deviceOf(id)).filter(Boolean).map((d) => `<div class="irow mach" data-inspect="machine:${esc(d.id)}" tabindex="0" role="button" title="Open ${esc(pn("machine", d.label))}"><b>${esc(pn("machine", d.label))}</b><span class="status ${d.status}"><i></i>${esc(statusText(d, now))}</span><span class="r" data-src="devices.windows.tokens.total">${fmt(pw(d).tokens.total)}</span><span class="r">${pct(pw(d).shareOfWhole, 0)}</span></div>`).join("")}
          ${laneList(D.lanes.filter((l) => p.devices.includes(l.device.id)), "24 h", lt ? lt.sessions : null)}`;
      }
    } else if (inspect.kind === "project") {
      // opened by the project's hash (H07), or by its name for a 0.3 hub without hashes
      const x = projCache && (projCache.projects.find((y) => projectKeyOf(y) === inspect.id) || projCache.projects.find((y) => y.name === inspect.id));
      const key = x ? projectKeyOf(x) : inspect.id;
      const lanes = localLanes().filter((l) => projectKey(l) === key || (x && l.project.name === x.name));
      const s = sparksBy(projectKey, lanes).get(key) || (lanes.length ? sparksBy(() => key, lanes).get(key) : null);
      title = x ? pn("project", x.name) : lanes.length ? pn("project", lanes[0].project.name) : "Project";
      if (!x) body = `<div class="iquiet">${projCache ? "This project has no transcripts in this period." : "Reading this machine…"}</div>` + laneList(lanes);
      else {
        body = projectInspectBody(x, cap, s, lanes);
      }
    } else if (inspect.kind === "lane") {
      // A lane, whole: what the row's cells fold away on a phone — its day by class, its context, its cache signals, its agents.
      const l = D.lanes.find((x) => x.key === inspect.id);
      if (!l) { title = "Session"; body = `<div class="iquiet">This session is no longer in the last 24 hours.</div>`; }
      else {
        const [doing, , doingWhy] = doingOf(l, now);
        const cls = l.tokensDayByClass || {};
        const cost = l.costDay || null;
        const res = l.activity && l.activity.results ? l.activity.results : null;
        title = pn("project", l.project.name);
        body = `<div class="ihero"><span class="big" data-src="lanes.tokensDay">${l.tokensDay == null ? "—" : fmt(l.tokensDay)}</span><span class="u">tokens · 24 h</span>${demoStamp()}</div>
          <div class="iline"><span class="st ${l.state}">${stateWord(l.state)}</span> · <span class="mono">${esc(pn("branch", l.branch) || TOOL[l.tool] || l.tool)}</span> · <span class="mono">${esc(l.modelLabel)}</span> · <b>${esc(pn("machine", l.device.label))}</b>${l.device.person ? " · " + esc(pn("person", l.device.person)) : ""}</div>
          <div class="iline" title="${esc(doingWhy)}">doing · <b>${doing}</b> · last report ${l.state === "live" ? "now" : hhmm(l.lastAt)}</div>
          ${ikv([[l.tokens5m === null ? "—" : fmt(l.tokens5m), "5 min", "", "lanes.tokens5m"], [!cost ? "—" : cost.usd === null ? (cost.status === "none" ? "—" : "unpriced") : money(cost.usd) + (cost.status === "partial" ? "+" : ""), "est. $ · 24 h", cost && cost.usd === null && cost.status !== "none" ? "warn" : "", "lanes.costDay.usd"],
            [cls.fresh == null ? "—" : fmt(cls.fresh), "uncached input", "", "lanes.tokensDayByClass.fresh"], [cls.output == null ? "—" : fmt(cls.output), "output", "", "lanes.tokensDayByClass.output"],
            [l.agents.total ? `${l.agents.live} <span class="u">/ ${l.agents.total}</span>` : "0", "subagents", "", "lanes.agents"], [l.context?.latest == null ? "—" : fmt(l.context.latest), "context" + (l.context?.status === "bloated" ? " ↑" : ""), l.context?.status === "bloated" ? "warn" : "", "lanes.context.latest"]])}
          <div class="ihead">Last hour <span>${fmt(l.spark.reduce((a, b) => a + b, 0))} tokens</span></div>${isparkHtml({ spark: l.spark }, l.state !== "live")}
          ${res ? `<div class="ihead">Tools · 5 min <span>${res.ok} ok · ${res.error} error${activityFloor(l) ? "<em class=\"part\">+</em>" : ""}</span></div><div class="iquiet">${Object.entries(l.activity.calls || {}).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${c} ${TOOL_KIND[k] || k}`).join(" · ") || "no tool call"} · kinds and counts only${activityFloor(l) ? ` · <b>a floor</b>: ${esc(activityWhy(l).replace(/^./u, (c) => c.toLowerCase()))}` : ""}</div>`
            : activityState(l) !== "complete" ? `<div class="ihead">Tools · 5 min <span>${esc(COVERAGE_WORD[activityCoverageOf(l).reason] || "unknown")}</span></div><div class="iquiet">${esc(activityWhy(l))}${activityState(l) === "partial" ? "; its recent tools are unavailable, not idle" : "; the lane may well be busy"}.</div>` : ""}
          <div class="ihead" id="inspectContext">Context</div><div class="context-details">${contextHtml(l)}</div>
          ${(l.agentTree || []).length ? `<div class="ihead">Agents <span>${l.agentTree.length}</span></div>` + l.agentTree.map((agent, i) => `<div class="irow"><span class="nm"><b>${i === 0 ? "Orchestrator" : "↳ Subagent"}</b>${agent.firstAt ? `<em>${hhmm(agent.firstAt)}</em>` : ""}</span><span class="md">${esc(agent.modelLabel)}</span><span class="r">${agent.tokens == null ? "—" : fmt(agent.tokens)}</span><span class="r">${agent.tokens == null || !l.tokensDay ? "—" : pct(agent.tokens / l.tokensDay, 0)}</span></div>`).join("") : ""}`;
      }
    }
    $("inspectTitle").textContent = title;
    $("inspectBody").innerHTML = body;
    foot.hidden = !foot.innerHTML;
  }

  // ── ⌘K: the way to anywhere, from anywhere ────────────────────────────
  /* Everything reachable is one keystroke away from every view, and what is
     not reachable right now is listed too, struck through with the reason. */
  const pal = $("pal"), palq = $("palq"), palres = $("palres");
  let palSel = 0, palRows = [];
  const PERIODS = ["1h", "24h", "7d", "30d"];
  function palItems() {
    const groups = [];
    const now = serverNow();
    groups.push(["Views", [
      { name: "Console", run: () => show("console"), note: "1" },
      { name: "Team", run: () => show("team"), note: "2" },
      { name: "Projects", run: () => show("projects"), note: "3" },
    ]]);
    if (D) {
      groups.push(["Machines", D.devices.map((d) => ({ name: pn("machine", d.label) + (d.person ? " · " + pn("person", d.person) : ""), run: () => openInspect("machine", d.id, $("palBtn")),
        note: d.status === "reporting" ? "reporting" : statusText(d, now), dot: d.status === "reporting" ? (D.hub.demo ? "sim" : "live") : d.status === "silent" ? "warn" : "" }))]);
      groups.push(["People", D.people.map((p) => ({ name: pn("person", p.person), run: () => openInspect("person", p.person, $("palBtn")), note: `${p.reporting}/${p.devices.length} reporting` }))]);
      groups.push(["Lanes", D.lanes.filter((l) => laneVisible(l, now)).map((l) => ({ name: `${pn("project", l.project.name)}${l.branch ? " · " + pn("branch", l.branch) : ""}`, run: () => focusLane(l.key),
        note: `${l.state} · ${l.modelLabel}`, dot: l.state === "live" ? (D.hub.demo ? "sim" : "live") : "" }))]);
      if (projCache) groups.push(["Projects", projCache.projects.map((x) => ({ name: pn("project", x.name), run: () => openInspect("project", projectKeyOf(x), $("palBtn")), note: fmt(x.tokens) + " tokens" }))]);
    }
    const alerts = D ? liveAlerts().length : 0;
    groups.push(["Actions", [
      { name: "Add a machine", run: openAdd, note: D && D.hub.demo ? null : "join link", no: D && D.hub.demo ? "demo: no machine can join" : null },
      { name: present ? "Stop presenting" : "Present", run: () => setPresent(!present), note: "P" },
      { name: paused ? "Resume motion" : "Pause motion", run: () => $("motionBtn").click(), note: "strip" },
      { name: showUnavailable ? "Hide unavailable" : "Show unavailable", run: () => $("voidBtn").click(), note: "strip" },
      { name: "Alerts", run: () => openAlerts($("palBtn")), note: alerts ? plural(alerts, "alert") : null, no: alerts ? null : "no alert in the last hour" },
      { name: "Switch theme", run: () => $("themeBtn").click(), note: "T" },
      ...PERIODS.map((p) => ({ name: `Period · ${PERIOD_TEXT[p][0]}`, run: () => setPeriod(p), note: p === period ? "current" : "[ ]" })),
      { name: "Sign out", run: () => $("signOutBtn").click(), note: "" },
    ]]);
    return groups;
  }
  function palRender(q = "") {
    const t = q.trim().toLowerCase();
    palRows = []; let html = "";
    for (const [group, items] of palItems()) {
      const hits = items.filter((it) => !t || it.name.toLowerCase().includes(t));
      if (!hits.length) continue;
      html += `<div class="palg">${esc(group)}</div>`;
      for (const it of hits) {
        const i = palRows.push(it) - 1;
        html += `<div class="palr${it.no ? " no" : ""}" id="palr-${i}" data-i="${i}" role="option" aria-selected="false"><i class="${it.dot || ""}"></i><b>${esc(it.name)}</b><span>${esc(it.no || it.note || "")}</span></div>`;
      }
    }
    palres.innerHTML = html || `<div class="palg" role="option" id="palr-none" aria-selected="true">nothing matches</div>`;
    palSel = Math.min(palSel, Math.max(0, palRows.length - 1));
    palMark();
  }
  // The input is the combobox; the highlighted option is named to it, so a screen reader announces it as the arrows move.
  function palMark() {
    palres.querySelectorAll(".palr").forEach((r, i) => { r.classList.toggle("on", i === palSel); r.setAttribute("aria-selected", String(i === palSel)); });
    const on = palres.querySelectorAll(".palr")[palSel];
    if (on) { on.scrollIntoView({ block: "nearest" }); palq.setAttribute("aria-activedescendant", on.id); }
    else palq.setAttribute("aria-activedescendant", palRows.length ? "" : "palr-none");
  }
  function palOpen(open) {
    if (open && !pal.open) { opener = openerRef(document.activeElement && document.activeElement !== document.body ? document.activeElement : $("palBtn")); pal.showModal(); palq.value = ""; palSel = 0; palRender(); palq.focus(); palq.setAttribute("aria-expanded", "true"); }
    else if (!open && pal.open) { pal.close(); palq.setAttribute("aria-expanded", "false"); }
  }
  function palRun(it) {
    if (!it) return;
    if (it.no) { toast(it.no); return; }
    palOpen(false);
    it.run();
  }
  palq.addEventListener("input", (ev) => { palSel = 0; palRender(ev.target.value); });
  palq.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); palSel = Math.min(palSel + 1, palRows.length - 1); palMark(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); palSel = Math.max(palSel - 1, 0); palMark(); }
    else if (ev.key === "Enter") { ev.preventDefault(); palRun(palRows[palSel]); }
  });
  palres.addEventListener("click", (ev) => { const r = ev.target.closest(".palr"); if (r) palRun(palRows[Number(r.dataset.i)]); });
  $("palBtn").addEventListener("click", () => palOpen(true));

  /* Plain keys, and nothing fires while typing: 1–3 views, [ ] period, J/K the
     lanes, ↵ the focused lane's context, T theme, ? this list, Esc back out. */
  function moveLane(dir) {
    const box = view === "projects" ? $("pLanes") : $("cLanes");
    const keys = [...box.querySelectorAll(".lane")].map((r) => r.dataset.key).filter(Boolean);
    if (!keys.length) { if (view !== "console") { show("console"); moveLane(dir); } return; }
    const i = keys.indexOf(laneFocus);
    const next = i < 0 ? (dir > 0 ? 0 : keys.length - 1) : Math.max(0, Math.min(keys.length - 1, i + dir));
    if (view === "projects") { const row = projLaneRows.get(keys[next]); if (row) { laneFocus = keys[next]; row.scrollIntoView({ block: "nearest" }); row.focus({ preventScroll: true }); } return; }
    focusLane(keys[next]);
  }
  document.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") { ev.preventDefault(); palOpen(!pal.open); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.target.closest && ev.target.closest("input, textarea, select, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;   // Esc closes it natively; the rest waits
    if (ev.target.closest && ev.target.closest("[role='button'], button, a, summary") && (ev.key === "Enter" || ev.key === " ")) return;
    switch (ev.key) {
      case "1": show("console"); break;
      case "2": show("team"); break;
      case "3": show("projects"); break;
      case "[": case "]": { const i = PERIODS.indexOf(period); setPeriod(PERIODS[(i + (ev.key === "]" ? 1 : PERIODS.length - 1)) % PERIODS.length]); break; }
      case "j": case "J": case "ArrowDown": if (ev.key === "ArrowDown" && !(ev.target.closest && ev.target.closest(".lane"))) return; moveLane(1); break;
      case "k": case "K": case "ArrowUp": if (ev.key === "ArrowUp" && !(ev.target.closest && ev.target.closest(".lane"))) return; moveLane(-1); break;
      case "Enter": if (!laneFocus) return; focusLane(laneFocus, true); break;
      case "p": case "P": setPresent(!present); break;
      case "t": case "T": $("themeBtn").click(); break;
      case "?": toast("Keys: <kbd>⌘K</kbd> anywhere · <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> views · <kbd>[</kbd> <kbd>]</kbd> period · <kbd>J</kbd> <kbd>K</kbd> lanes · <kbd>↵</kbd> open · <kbd>P</kbd> present · <kbd>T</kbd> theme · <kbd>esc</kbd> back", true); break;
      case "Escape": for (const r of document.querySelectorAll(".lane.focused")) r.classList.remove("focused"); laneFocus = null; closeTrees(); break;
      default: return;
    }
    ev.preventDefault();
  });

  /* Provenance travels with the number: hover any figure for its source field
     and when it was read, in the viewer's zone. */
  document.addEventListener("mouseover", (ev) => {
    const el = ev.target.closest && ev.target.closest("[data-src]"); if (!el || !D) return;
    if (el.dataset.t === undefined) el.dataset.t = el.getAttribute("title") || "";
    const base = el.dataset.t.replace(/ · as of .*$/u, "");
    el.title = [base, el.dataset.src, asOf()].filter(Boolean).join(" · ");
  });

  /* The URL carries the view and whatever is open beside it, both ways: read at
     boot once the first reading is in, and again whenever it changes by hand. */
  function route() {
    // /team and /projects open on that view: the path is read once and folded into the hash, so the address stays one form
    const pathView = /^\/(team|projects)\/?$/u.exec(location.pathname);
    if (pathView && !location.hash) { try { history.replaceState(null, "", "/#" + pathView[1]); } catch { /* fine */ } }
    const parts = (location.hash || "").replace("#", "").split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    const [a, b, c] = parts;
    // one thing open beside the canvas at a time: whatever the address does not name closes first
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
    if (a === "lane") {
      const lane = D && D.lanes.find((l) => l.key === b);
      if (!lane) return;
      if (view !== "console") show("console");
      if (c === "context") showContext(lane, laneRows.get(b) || null);
      else if (c === "agents") { const row = laneRows.get(b) || coldRows.get(b); if (row) { focusLane(b); openTree(row, b, true); } }
      else focusLane(b);
      return;
    }
    const next = a === "team" || a === "projects" ? a : "console";
    if (next !== view) show(next);
    if (b === "add") openAdd();
    else if (b === "alerts") openAlerts();
    else if ((b === "machine" || b === "person" || b === "project" || b === "lane") && c) openInspect(b, idFromUrl(c));
  }
  window.addEventListener("hashchange", route);
  poll().then(startLoop);
})();
