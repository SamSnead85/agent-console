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
  const sparkBars = (spark, hot, cls = "sp") => {
    const top = Math.max(...spark, 1);
    return `<span class="${cls}" aria-hidden="true">${spark.map((v, k) => `<i style="height:${(v > 0 ? 9 + (v / top) * 91 : 5).toFixed(0)}%"${hot && k === spark.length - 1 && v > 0 ? ' class="hot"' : ""}></i>`).join("")}</span>`;
  };
  // One ramp of the accent for a stacked-by-thing series: the four class steps, then the quiet ground for the rest.
  const RAMP = ["var(--c-output)", "var(--c-cachewrite)", "var(--c-input)", "var(--c-cacheread)"];
  const rampAt = (i) => RAMP[i] || "var(--spark-idle)";
  /* A stacked bar series: one bar per three-minute step, one band per key, the
     biggest at the bottom. Drawn from the lanes' own sparks, so it is the hub's
     reading regrouped, never a figure the page invented. */
  function drawStacked(svgId, wrapId, reasonId, legendId, groups, nameOf) {
    const svg = $(svgId), wrap = $(wrapId);
    const rows = [...groups.entries()].map(([key, g]) => ({ key, ...g, total: g.spark.reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total);
    const shown = rows.slice(0, 4);
    const rest = rows.slice(4);
    if (rest.length) shown.push({ key: "__rest", total: rest.reduce((a, r) => a + r.total, 0), live: rest.reduce((a, r) => a + r.live, 0), n: rest.length,
      spark: rest.reduce((acc, r) => acc.map((v, i) => v + r.spark[i]), new Array(SPARK_N).fill(0)) });
    const all = rows.reduce((a, r) => a + r.total, 0);
    wrap.classList.toggle("void", all <= 0);
    if (all <= 0) { $(reasonId).textContent = rows.length ? "Nothing reported in the last hour. Nothing is estimated in its place." : "No session has reported. Nothing is estimated in its place."; svg.innerHTML = ""; $(legendId).innerHTML = ""; return; }
    const W = 520, H = 100, bw = W / SPARK_N;
    const totals = new Array(SPARK_N).fill(0);
    for (const r of shown) for (let i = 0; i < SPARK_N; i += 1) totals[i] += r.spark[i];
    const max = Math.max(...totals, 1) * 1.05;
    const base = new Array(SPARK_N).fill(0);
    let out = "";
    for (let r = 0; r < shown.length; r += 1) {
      const row = shown[r];
      for (let i = 0; i < SPARK_N; i += 1) {
        const v = row.spark[i];
        if (v <= 0) continue;
        const h = (v / max) * (H - 4);
        const y = H - 2 - base[i] - h;
        out += `<rect x="${(i * bw + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${rampAt(r)}" rx="1"><title>${esc(row.key === "__rest" ? `${row.n} more` : nameOf(row.key))} · ${fmt(v)} tokens</title></rect>`;
        base[i] += h;
      }
    }
    svg.innerHTML = out;
    $(legendId).innerHTML = shown.map((r, i) => `<span title="${esc(r.key === "__rest" ? `${r.n} more` : nameOf(r.key))} · ${fmt(r.total)} tokens in the last hour · ${r.live} live"><i class="sw k" style="background:${rampAt(i)}"></i>${esc(r.key === "__rest" ? `${r.n} more` : nameOf(r.key))} <b>${fmt(r.total)}</b>${r.live ? `<em>${r.live} live</em>` : ""}</span>`).join("");
    return all;
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
  const inspect = { open: false, kind: null, id: null };   // what the inspector beside the canvas shows
  let projCache = null;         // the last /api/projects answer, for the Projects band and its inspector
  let pollTimer = null;
  let offline = false;
  let scanMs = null;            // how long the last /api/console answer took
  const target = { total: 0, spend: 0, msgs: 0, burn: 0 };
  const shown = { total: 0, spend: 0, msgs: 0, burn: 0 };
  let first = true;
  const CLASSES = ["cacheRead", "cacheWrite", "output", "fresh"];   // quietest to loudest: the stack's order, bottom up
  let chart = { key: null, vals: [], goal: [], max: 1, goalMax: 1, cls: null, clsGoal: null };

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
    $("reach").title = D.hub.demo ? "Demo mode: nothing is read and no machine can join."
      : net ? "Other machines can join at " + D.hub.urls.join(", ") + ". The console itself answers only here."
      : "Only this machine can reach this console. Start it with --listen 0.0.0.0 to add other computers.";
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    const current = currentDevices().length;
    $("tabTeam").textContent = current ? reporting + "/" + current : "0";
    const liveNow = D.lanes.filter((l) => l.state === "live").length;
    $("tabLive").textContent = liveNow ? liveNow + " live" : "";
    $("clockZone").textContent = zoneName();
    $("teamHeadCount").textContent = `times ${zoneName()}`;

    const w = win();
    target.total = w.tokens.total;
    target.spend = w.cost.usd ?? 0;
    target.msgs = w.messages;
    target.burn = D.burn.tokensPerMinute;
    if (first || reducedMotion.matches || paused) Object.assign(shown, target);
    first = false;

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
    loadFold();
    if (view === "team") paintTeam();
    if (view === "projects") paintProjectsLive();
    if (inspect.open) paintInspect();
    watchJoin();
    if (reducedMotion.matches || paused) { paintText(); drawChart(); }
    paintClock();
    fitRegions();
  }

  function paintInterop() {
    const data = D.interop || {};
    const sources = [['otel', 'Claude Code OpenTelemetry · 24 h'], ['kong', 'Kong · cumulative'], ['litellm', 'LiteLLM · cumulative']];
    $('interopPanel').hidden = !D.hub.demo && !D.hub.interop;
    $('interopRows').innerHTML = sources.map(([key, label]) => {
      const item = data[key];
      return `<div class="interop-row"><span>${label}</span><b>${item?.available ? fmt(item.tokens.total) + ' tokens' : 'No reading yet'}</b>${item?.available ? `<small>${hhmm(item.receivedAt)}${D.hub.demo ? ' · DEMO' : ''}</small>` : ''}</div>`;
    }).join('');
  }

  // ── words used the same way on every view ────────────────────────────
  /* A machine removed from the console, or one that left, is not counted
     among "the machines": it is shown only when Show unavailable is on. */
  const currentDevices = () => D.devices.filter((d) => d.status !== "revoked");
  const plural = (n, one, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  /* A session is one top-level Claude Code or Codex session; its subagents are
     counted apart, as subagents, never as more sessions. */
  const sessionWords = () => {
    const subagents = Math.max(0, D.day.sessions - D.laneCount);
    return plural(D.laneCount, "session") + " in the last 24 h" + (subagents ? " · " + plural(subagents, "subagent") : "");
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
    $("liveCount").textContent = live ? plural(live, "live session") : "no live session";
    $("liveCap").title = live ? "Sessions that reported within the last two minutes" : "No session has reported in the last two minutes";
    // One line states the scope: machines reporting, sessions in the last 24 h, live now, subagents.
    const subagents = Math.max(0, D.day.sessions - D.laneCount);
    $("machineCount").textContent = D.devices.length
      ? `${reporting} of ${currentDevices().length} reporting · ${plural(D.laneCount, "session")} · ${plural(subagents, "subagent")}` + (catching ? ` · ${catching} catching up` : "")
      : "no machine has joined yet";
    $("machineCount").title = D.devices.length ? sessionWords() + " · a session is one top-level Claude Code or Codex session; its subagents are counted apart" : "";
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

  /* The week, as data: seven days in two-hour steps, today's steps lit. */
  function paintWeek() {
    const s = D.series["7d"];
    const n = s.values.length, W = 84, H = 20;
    const max = Math.max(...s.values, 1);
    const dayStart = new Date(D.now); dayStart.setHours(0, 0, 0, 0);
    $("weekBars").innerHTML = s.values.map((v, i) => {
      const h = v > 0 ? Math.max(1, (v / max) * (H - 1)) : 0.6;
      const today = s.start + i * s.step >= dayStart.getTime();
      return `<rect x="${((i / n) * W).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${(W / n * 0.72).toFixed(2)}" height="${h.toFixed(2)}"${today ? ' class="today"' : ""}/>`;
    }).join("");
    const week = (D.windows && D.windows["7d"]) || null;
    $("weekTotal").textContent = week ? fmt(week.tokens.total) : "—";
    $("weekTotal").title = week ? `${fmt(week.tokens.total)} tokens in the last 7 days · ${week.cost.usd === null ? "no priced model" : money(week.cost.usd) + " est."}` : "";
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
    $("cCap").textContent = "Tokens · " + label + since;
    $("cCap").title = period === "30d" ? "The last 30 calendar days in UTC, today included, from the daily totals the console keeps after its minute-by-minute detail."
      : "The whole minutes of the " + label + ", ending with the current one. The chart's bars add up to this figure.";
    $("cModelCap").textContent = "by model · " + short;
  }

  // ── tokens for the period ────────────────────────────────────────────
  function paintClasses() {
    paintPeriod();
    const w = win();
    const t = w.tokens, sh = w.shares;
    const order = ["cacheRead", "cacheWrite", "output", "fresh"];
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
    else if (D.hub.demo) parts.push("generated", `${D.devices.length} synthetic machines`);
    else parts.push(`reported by ${reporting} of ${plural(current, "machine")}`);
    if (silent.length) { parts.push(`<b>${silent.length} silent</b>`); why.push(silent.map((d) => `${d.label} silent since ${hhmm(d.lastContactAt)}`).join("; ")); }
    const catching = D.devices.filter((d) => d.status === "catching-up");
    if (catching.length) { parts.push(`<b>${catching.length} catching up</b>`); why.push(catching.map((d) => `${d.label} ${catchUpText(d)} — incomplete until it has sent everything`).join("; ")); }
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
  function modelRows(models, boxId, allModels) {
    const open = moreOpen.has(boxId);
    const shown = open ? allModels : allModels.slice(0, MODELS_SHOWN);
    const max = Math.max(...allModels.map((m) => m.tokens), 1);
    return shown.map((m) => `<div class="mrow">
        <span class="mn" title="${esc(m.model)} · ${fmt(m.tokens)} tokens · ${pct(m.share)} of the period · ${asOf()}" data-src="windows.models.tokens">${vendorMark(m.vendor)}<span class="txt">${esc(m.label)}</span></span><span class="ms">${demoStamp()}</span>
        <span class="mbar" aria-hidden="true"><i style="width:${Math.max(1, Math.round((m.tokens / max) * 100))}%"></i></span>
        <span class="mv" data-src="windows.models.share">${pct(m.share, 0)}</span>
        ${m.usd === null ? `<span class="mc unp" title="No verified list price for ${esc(m.model)}; left out of the dollar figure">unpriced</span>` : `<span class="mc" data-internal data-src="windows.models.usd" title="List-price estimate · ${asOf()}">${money(m.usd)}</span>`}
      </div>`).join("") + (allModels.length > MODELS_SHOWN ? `<button type="button" class="more" data-more="${boxId}">${open ? "fewer" : `${allModels.length - MODELS_SHOWN} more`}</button>` : "");
  }
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-more]"); if (!b) return;
    if (moreOpen.has(b.dataset.more)) moreOpen.delete(b.dataset.more); else moreOpen.add(b.dataset.more);
    if (D) { paintModels(); paintSpectrum(); if (inspect.open) paintInspect(); if (view === "projects") loadProjects(); }
  });
  function paintModels() {
    const models = win().models;
    $("cModels").innerHTML = models.length ? modelRows(models, "cModels", models)
      : `<div class="mrow"><span class="mn"><span class="none-text">no model has reported yet</span></span></div>`;
    const ex = D.burn.excluded;
    const reporting = D.burn.reporting;
    // The machines left out of the burn are counted here and named on hover; the chart's gap names them on the screen.
    $("cBurnNote").innerHTML = D.devices.length === 0 ? "no machine yet"
      : `average of the last ${D.burn.windowMinutes} min · ${reporting} of ${plural(currentDevices().length, "machine")}` +
        (ex.length ? ` · <b>${ex.length} left out</b>` : "");
    $("cBurnNote").title = ex.length ? `${ex.map((d) => d.label).join(", ")} left out of the burn because what ${ex.length === 1 ? "it is" : "they are"} doing right now is unknown` : "";
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
    const live = D.lanes.filter((l) => l.state === "live").length;
    const idle = D.lanes.filter((l) => l.state === "idle").length;
    const silent = D.lanes.filter((l) => l.state === "silent").length;
    const gone = D.lanes.filter((l) => l.state === "revoked").length;
    const catching = D.lanes.filter((l) => l.state === "catching-up" || l.state === "reconnecting").length;
    // Idle lanes that have not worked for an hour are hidden too: say how many.
    const quiet = showUnavailable ? 0 : D.lanes.filter((l) => l.state === "idle" && !laneVisible(l, now)).length;
    const parts = [sessionWords(), `${live} live`, `${idle} idle` + (quiet ? ` (${quiet} of them idle for more than an hour, hidden)` : "")];
    if (catching) parts.push(`${catching} on machines still catching up${showUnavailable ? "" : " (hidden)"}`);
    if (silent) parts.push(`${silent} on silent machines${showUnavailable ? "" : " (hidden)"}`);
    if (gone) parts.push(`${gone} on machines that left or were removed${showUnavailable ? "" : " (hidden)"}`);
    const tail = D.hub.demo ? "DEMO · every figure here is generated" : "figures are what each machine reported · costs are list-price estimates";
    $("lFoot").innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join("") + `<span class="end">${esc(tail)}</span>`;
  }

  /* A lane's row: state, project and branch, model, the last hour drawn, then
     the numbers that cost money — five minutes, uncached input, output, the
     day, its estimate — the agents, the context, the machine and when it last
     reported. The same row serves the lanes above and the cold ones below. */
  function makeLaneRow(l) {
    const row = document.createElement("div");
    row.className = "lane";
    row.innerHTML = `<span class="st"><i></i><span></span><span class="stamp sm" title="Generated: nothing was read from any machine">DEMO</span></span><span class="pr"><b></b><em></em></span><span class="md"></span>
      <span class="sp" aria-hidden="true">${"<i></i>".repeat(20)}</span><span class="fm r" data-src="lanes.tokens5m"></span>
      <span class="nums"><span class="num in r" data-l="in" data-src="lanes.tokensDayByClass.fresh"></span><span class="num out r" data-l="out" data-src="lanes.tokensDayByClass.output"></span><span class="num tot r" data-l="24 h" data-src="lanes.tokensDay"></span><span class="num usd r" data-l="est." data-src="lanes.costDay.usd" data-internal></span></span>
      <span class="ag r"><button type="button" aria-expanded="false"><span class="l">agents</span><span class="v"></span></button></span>
      <span class="cx r"><button type="button"><span class="l">context</span><span class="v"></span></button></span><span class="dv"></span><span class="la r" data-src="lanes.lastAt"></span>`;
    row._tree = document.createElement("div");
    row._tree.className = "agent-tree";
    row._tree.hidden = true;
    row.querySelector(".ag button").addEventListener("click", () => {
      row._tree.hidden = !row._tree.hidden;
      row.querySelector(".ag button").setAttribute("aria-expanded", String(!row._tree.hidden));
      if (!row._tree.hidden && matchMedia('(max-width: 760px)').matches) {
        row.closest('.lanes, .fold').scrollLeft = 0;
        row.parentElement.scrollLeft = 0;
      }
    });
    row.querySelector(".cx button").addEventListener("click", () => {
      const current = D?.lanes.find((item) => item.key === l.key);
      if (current) showContext(current);
    });
    return row;
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
    b.textContent = l.project.name;
    b.className = l.project.source === "hash" ? "hash" : "";
    b.title = l.project.source === "hash" ? "That machine did not name this project; only a salted hash reached the hub"
      : l.project.source === "label" ? "A label chosen on that machine" : "Named from this machine's own disk; never sent anywhere";
    row.querySelector(".pr em").textContent = l.branch || TOOL[l.tool] || l.tool;
    row.querySelector(".md").innerHTML = vendorMark(vendorOf(l.model)) + esc(l.modelLabel);
    row.querySelector(".md").title = l.model;
    // Normalised to the lane's own hour — the shape is the information; the
    // absolute level is the five-minute figure beside it.
    const bars = row.querySelectorAll(".sp i");
    const top = Math.max(...l.spark, 1);
    bars.forEach((bar, k) => {
      const v = l.spark[k] || 0;
      bar.style.height = (v > 0 ? 9 + (v / top) * 91 : 5).toFixed(0) + "%";
      bar.classList.toggle("hot", k === bars.length - 1 && v > 0 && l.state === "live");
    });
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
    agButton.setAttribute("aria-label", l.agents.total ? `Agents ${l.agents.live} of ${l.agents.total} live, ${l.project.name}: show tree` : `No subagents, ${l.project.name}`);
    // Each agent against the lane's day: a share bar, its tokens in mono, the observed span on hover, one phrase for an unknown outcome.
    const laneTotal = Math.max(l.tokensDay || 0, 1);
    row._tree.innerHTML = (l.agentTree || []).map((agent, index) => `<div class="agent-node" style="--depth:${Math.min(agent.depth, 8)}" title="${esc(observedSpan(agent.durationMinutes))}"><span>${index === 0 ? 'Orchestrator' : '↳ Subagent'}</span><span class="agent-model">${vendorMark(vendorOf(agent.model))}${esc(agent.modelLabel)}</span><span class="abar">${agent.tokens == null ? '<span>tokens unavailable</span>' : `<i><b style="width:${Math.min(100, Math.round((agent.tokens / laneTotal) * 100))}%"></b></i><span>${fmt(agent.tokens)}</span>`}</span><span>${agent.tokens == null ? '—' : pct(agent.tokens / laneTotal, 0) + ' of lane'}</span><span>${agent.outcome === 'unknown' ? 'outcome unknown · no result recorded' : esc(agent.outcome)}</span></div>`).join('');
    const cx = row.querySelector(".cx");
    cx.classList.toggle("bloated", l.context?.status === "bloated");
    cx.querySelector("button .v").textContent = l.context?.latest === null || l.context?.latest === undefined
      ? "—" : fmt(l.context.latest) + (l.context.status === "bloated" ? " ↑" : "");
    cx.title = l.context?.latest === null ? "Context unavailable: input classes were not reported" : "Latest reported input tokens per API response. Open for history and cache signals.";
    cx.querySelector("button").setAttribute("aria-label", (l.context?.latest === null || l.context?.latest === undefined
      ? "Context unavailable" : `Context ${fmt(l.context.latest)}${l.context.status === "bloated" ? ", growing" : ""}`) + `, ${l.project.name}: details`);
    // The machine and its person may be cut short; the time never is — it has its own cell.
    // The machine only; its person on hover, so the cell never cuts a name short.
    const dv = row.querySelector(".dv");
    dv.innerHTML = `<b>${esc(l.device.label)}</b>`;
    dv.title = `${l.device.label}${l.device.person ? " · " + l.device.person : ""}`;
    const la = row.querySelector(".la");
    la.textContent = l.state === "catching-up" ? "catching up" : l.state === "reconnecting" ? "reconnecting"
      : l.state === "silent" || l.state === "revoked" ? `since ${hhmm(l.device.lastContactAt || l.lastAt)}`
      : l.state === "live" ? "now" : ago(l.lastAt + 60_000, now).replace(" ago", "");
    la.title = l.state === "silent" || l.state === "revoked" ? "The machine's last report" : "When this session last reported · " + hhmm(l.lastAt);
  }

  function showContext(lane) {
    const c = lane.context;
    $("contextTitle").textContent = "Context · " + lane.project.name;
    const samples = c?.samples || [];
    const breaks = c?.breaks || [];
    // The responses drawn as bars, latest lit; a cache signal is a tick under the bar it followed; the extra write cost summed once.
    const top = Math.max(...samples.map((s) => s.tokens), 1);
    const breakAt = new Set(breaks.map((b) => b.at));
    const extra = breaks.reduce((a, b) => a + (b.estimatedExtraUsd || 0), 0);
    const unpricedBreaks = breaks.filter((b) => b.estimatedExtraUsd == null).length;
    const kind = (b) => b.kind === "idle-gap" ? `idle gap past cache lifetime (${b.gapMinutes} min)` : b.kind === "lifetime-unknown" ? `cache lifetime unknown (${b.gapMinutes} min gap)` : "possible prefix rewrite";
    $("contextDetails").innerHTML = `<p>${c?.latest == null ? "No complete input reading is available." :
      `Latest response carried <b>${fmt(c.latest)} input tokens</b>. ${c.growth == null ? "Growth needs two readings." :
        `That is ${c.growth.toFixed(1)}× the first retained reading.`} ${c.status === "bloated" ? "This session is flagged for context weight." : ""}`}</p>` +
      (samples.length ? `<div class="cbars" role="img" aria-label="${samples.length} recent responses, input tokens each">${samples.map((s, i) => `<i class="${i === samples.length - 1 ? "last" : ""}${breakAt.has(s.at) ? " brk" : ""}" style="height:${Math.max(4, Math.round((s.tokens / top) * 100))}%" title="${hhmm(s.at)} · ${fmt(s.tokens)} input tokens${breakAt.has(s.at) ? " · cache signal" : ""}"></i>`).join("")}</div><div class="cax"><span>${hhmm(samples[0].at)}</span><span>peak ${fmt(top)}</span><span>${hhmm(samples[samples.length - 1].at)}</span></div>` : "") +
      `<p>Cache signals · <b>${breaks.length ? breaks.length + " recent" : "none in retained readings"}</b>${breaks.length ? ` · extra write cost ${extra > 0 && extra < 0.005 ? "&lt; $0.01" : money(extra)} est.${unpricedBreaks ? ` · ${unpricedBreaks} unpriced` : ""}` : ""}</p>` +
      (breaks.length ? `<ol>${breaks.map((b) => `<li>${hhmm(b.at)} · ${kind(b)}</li>`).join("")}</ol>` : "") +
      `<p class="iquiet">Inferred from token counts and minute timestamps; they cannot prove the cause of a cache write. Extra cost compares observed writes with a hypothetical cache read at offline list prices (table v${esc(c?.priceTable?.version ?? "?")}, checked ${esc(c?.priceTable?.checkedOn ?? "unknown")}).</p>`;
    openSheet($("contextDialog"), `lane/${lane.key}/context`);
  }

  const ALERT_LABEL = { loop: "Repeated tool call", spike: "Burn spike", stall: "Spending without progress" };
  const alertCause = (a) => a.kind === "loop" ? `Same tool and arguments ${fmt(a.tokens)} times`
    : a.kind === "spike" ? `${fmt(a.tokens)} tokens in one response, above this session's baseline`
    : `${fmt(a.tokens)} tokens since the last observed tool success`;
  const alertLane = (a) => (D.lanes || []).find((item) => item.key === a.laneHash?.slice(0, 16)) || null;
  const alertWho = (a) => alertLane(a)?.project?.name || (a.projectHash ? `project ${a.projectHash.slice(0, 6)}` : D.hub.demo ? "Demo session" : "Session");
  const ALERT_SHOWN = 6;
  let alertsOpen = false;   // "N more" opens the whole list; it stays open until the page reloads
  function paintAlerts() {
    const all = D.alerts || [];   // newest first, as the hub lists them
    $("alertPanel").hidden = all.length === 0;
    // The rail carries the count, the panel the words; the two always agree.
    const chip = $("alertChip");
    chip.hidden = !all.length;
    chip.innerHTML = `<span aria-hidden="true">▲</span> ${plural(all.length, "alert")}`;
    chip.title = (D.hub.demo ? "Generated alerts. " : "Live alerts on this machine in the last hour. ") + "Open the panel.";
    const shown = alertsOpen ? all : all.slice(0, ALERT_SHOWN);
    $("alertShown").textContent = (shown.length < all.length ? `${shown.length} of ${all.length} shown · ` : "") + "this machine · last hour";
    const more = $("alertMore");
    more.hidden = all.length <= ALERT_SHOWN;
    more.textContent = alertsOpen ? "Show fewer" : `${all.length - ALERT_SHOWN} more`;
    $("alertRows").innerHTML = shown.map((a) => `<div class="alert-row" ${alertLane(a) ? `data-lane="${esc(alertLane(a).key)}" tabindex="0" role="button"` : ""}><span class="sev" aria-hidden="true">▲</span><b>${ALERT_LABEL[a.kind] || "Alert"}</b>` +
      `<span class="who">${esc(alertWho(a))}</span><span class="cause">${alertCause(a)}</span><time>${hhmm(a.at)}${D.hub.demo ? " · DEMO" : ""}</time></div>`).join("");
  }
  $("alertMore").addEventListener("click", () => { alertsOpen = !alertsOpen; if (D) paintAlerts(); });

  // ── attention: the one thing that needs it ───────────────────────────
  /* Ranked: a burn spike, then spending without progress, then a loop, then
     an unpriced model in the estimate, then a silent machine. Quiet when
     nothing needs it — the panel never invents an alarm. */
  function paintAttention() {
    const box = $("attention");
    const w = win();
    const alerts = D.alerts || [];
    const order = { spike: 0, stall: 1, loop: 2 };
    const top = alerts.slice().sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3) || b.at - a.at)[0] || null;
    const silent = D.devices.filter((d) => d.status === "silent");
    const catching = D.devices.filter((d) => d.status === "catching-up" || d.status === "reconnecting");
    const unpriced = w.cost.status === "partial" || w.cost.status === "unpriced" ? w.cost.unpricedModels : [];
    let head, line, foot, hot = true;
    if (top) {
      const lane = alertLane(top);
      head = ALERT_LABEL[top.kind] || "Alert";
      line = `${esc(alertWho(top))}${lane?.branch ? ` <em>${esc(lane.branch)}</em>` : ""}${lane ? ` · <em>${esc(lane.modelLabel)}</em>` : ""} · ${alertCause(top)}`;
      foot = `<time>${hhmm(top.at)}</time>${D.hub.demo ? " · DEMO" : ""}` + (lane ? `<button class="linkbtn" type="button" data-lane="${esc(lane.key)}">Open lane →</button>` : "");
    } else if (unpriced.length) {
      head = "Unpriced model in use";
      line = `<em>${esc(unpriced.join(", "))}</em> · ${fmt(w.cost.unpricedTokens)} tokens with no verified list price`;
      foot = w.cost.status === "unpriced" ? "The estimate shows no dollar figure until a priced model reports." : "Left out of the estimate, which is therefore a floor.";
    } else if (silent.length) {
      head = plural(silent.length, "machine") + " silent";
      line = `<em>${esc(silent.map((d) => d.label).join(", "))}</em> · silent since ${hhmm(silent[0].lastContactAt)}`;
      foot = "What it has done since is unknown; the chart is incomplete from then.";
    } else if (catching.length) {
      head = plural(catching.length, "machine") + " catching up";
      line = `<em>${esc(catching.map((d) => d.label).join(", "))}</em> · ${esc(catchUpText(catching[0]))}`;
      foot = "Its figures are incomplete until the backlog is in.";
      hot = false;
    } else {
      head = D.devices.length ? "Nothing needs attention" : "No machine yet";
      line = D.devices.length ? "No alert in the last hour, every model priced, every machine reporting." : "Add a machine, or run the console where Claude Code or Codex transcripts are.";
      foot = "";
      hot = false;
    }
    box.classList.toggle("hot", hot);
    $("attnHead").textContent = head;
    $("attnLine").innerHTML = line;
    $("attnLine").title = $("attnLine").textContent;
    $("attnFoot").innerHTML = foot;
    const stat = [`<b>${alerts.length}</b> ${alerts.length === 1 ? "alert" : "alerts"} · last hour`];
    if (unpriced.length) stat.push(`<span class="tag" title="${esc(unpriced.join(", "))}">${unpriced.length} unpriced</span>`);
    if (silent.length && top) stat.push(`<b>${silent.length}</b> silent`);
    if (catching.length && (top || unpriced.length || silent.length)) stat.push(`<b>${catching.length}</b> catching up`);
    $("attnStat").innerHTML = stat.join(" · ");
    // Every current alert as a compact row, newest first, each the door to its lane; the pane does the list's work.
    const rows = alerts.slice().sort((a, b) => b.at - a.at).filter((a) => a !== top).slice(0, 4);
    $("attnList").innerHTML = rows.map((a) => {
      const lane = alertLane(a);
      return `<div class="arow" ${lane ? `data-lane="${esc(lane.key)}" tabindex="0" role="button"` : ""} title="${esc(alertCause(a))}"><span class="sev" aria-hidden="true"></span><b>${ALERT_LABEL[a.kind] || "Alert"}</b><em>${esc(alertWho(a))}</em><time>${hhmm(a.at)}${D.hub.demo ? " · DEMO" : ""}</time></div>`;
    }).join("") + (alerts.length > rows.length + (top ? 1 : 0) ? `<button type="button" class="more" data-alerts>${alerts.length - rows.length - (top ? 1 : 0)} more</button>` : "");
  }
  function focusLane(key, open = false) {
    const row = laneRows.get(key) || coldRows.get(key);
    if (!row) return false;
    if (coldRows.has(key)) $("foldCold").open = true;
    if (view !== "console") show("console");
    row.scrollIntoView({ behavior: reducedMotion.matches || paused ? "auto" : "smooth", block: "center" });
    for (const r of document.querySelectorAll(".lane.focused")) r.classList.remove("focused");
    row.classList.add("focused");
    laneFocus = key;
    if (open) { const lane = D.lanes.find((l) => l.key === key); if (lane) showContext(lane); }
    return true;
  }
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-alerts]")) { openAlerts(); return; }
    const go = ev.target.closest("[data-lane]"); if (!go) return;
    if (go.closest("dialog")) go.closest("dialog").close();
    focusLane(go.dataset.lane);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const door = ev.target.closest && ev.target.closest("[role='button'][data-lane], [role='button'][data-inspect]");
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
      const W = 520, TOP = [2, 22], BOT = [38, 58];
      let x1 = 0, x2 = 0, parts = [];
      const cost = CLASSES.map((k) => [k, byClass[k] / usd]).concat(byClass.unsplitUsd > 0 ? [["unsplit", byClass.unsplitUsd / usd]] : []);
      const tok = CLASSES.map((k) => [k, t[k] / total]);
      const seg = (k, x, wdt, y) => `<rect class="${k}" x="${x.toFixed(1)}" y="${y[0]}" width="${Math.max(0, wdt).toFixed(1)}" height="${y[1] - y[0]}"/>`;
      let out = "";
      const topX = {}, botX = {};
      for (const [k, share] of cost) { const wdt = share * W; out += seg(k, x1, wdt, TOP); topX[k] = [x1, x1 + wdt]; x1 += wdt; }
      for (const [k, share] of tok) { const wdt = share * W; out += seg(k, x2, wdt, BOT); botX[k] = [x2, x2 + wdt]; x2 += wdt; }
      for (const k of CLASSES) {
        const a = topX[k], b = botX[k];
        if (!a || !b) continue;
        parts.push(`<polygon class="${k} band" points="${a[0].toFixed(1)},${TOP[1]} ${a[1].toFixed(1)},${TOP[1]} ${b[1].toFixed(1)},${BOT[0]} ${b[0].toFixed(1)},${BOT[0]}"/>`);
      }
      svg.innerHTML = parts.join("") + out + `<rect class="edge" x="0" y="${TOP[0]}" width="${W}" height="${TOP[1] - TOP[0]}"/><rect class="edge" x="0" y="${BOT[0]}" width="${W}" height="${BOT[1] - BOT[0]}"/>`;
      svg.setAttribute("aria-label", "Cost share over token share: " + CLASSES.map((k) => `${CLASS_LABEL[k]} ${pct(byClass[k] / usd, 0)} of cost, ${pct(t[k] / total, 0)} of tokens`).join("; "));
      $("specLegend").innerHTML = CLASSES.map((k) => `<span title="${esc(CLASS_LABEL[k])}: ${money(byClass[k])} · ${pct(byClass[k] / usd)} of the estimate · ${pct(t[k] / total)} of tokens"><i class="sw ${k}"></i>${CLASS_LABEL[k]} <b>${pct(byClass[k] / usd, 0)}</b><em>/ ${pct(t[k] / total, 0)}</em></span>`).join("");
    }
    // Per model: its share of the money over its share of the tokens; an unpriced model is hatched and named; the rest opens in place.
    const open = moreOpen.has("specModels");
    const models = open ? w.models : w.models.slice(0, MODELS_SHOWN);
    const usdAll = w.cost.usd || 0;
    $("specModels").innerHTML = models.map((m) => `<div class="srow" title="${esc(m.model)}: ${pct(m.share)} of tokens · ${m.usd === null ? "unpriced" : money(m.usd) + (usdAll ? " · " + pct(m.usd / usdAll) + " of the estimate" : "")} · ${asOf()}" data-src="windows.models">
        <span class="mn"><span class="txt">${esc(m.label)}</span></span>
        <span class="sbars${m.usd === null ? " unp" : ""}" aria-hidden="true"><i><b style="width:${m.usd === null ? 100 : Math.round((usdAll ? m.usd / usdAll : 0) * 100)}%"></b></i><i><b style="width:${Math.round(m.share * 100)}%"></b></i></span>
        ${m.usd === null ? `<span class="sc void">unpriced</span>` : `<span class="sc" data-internal>${money(m.usd)}</span>`}
      </div>`).join("") + (w.models.length > MODELS_SHOWN ? `<button type="button" class="more" data-more="specModels">${open ? "fewer" : `${w.models.length - MODELS_SHOWN} more`}</button>` : "");
  }

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
      return;
    }
    const vals = s.values.slice();
    const n = vals.length, W = 520, H = 44;
    const elapsed = Math.max(0.25, Math.min(1, (D.now - (s.start + s.step * (n - 1))) / s.step));
    vals[n - 1] = vals[n - 1] / elapsed;
    const whole = vals.slice(0, -1).filter((v) => v > 0).sort((a, b) => a - b);
    const middle = Math.floor(whole.length / 2);
    const median = whole.length ? (whole[middle] + whole[Math.ceil(whole.length / 2) - 1]) / 2 : null;
    const max = Math.max(...vals, 1);
    const bw = W / n;
    const silentX = D.silentSince && D.silentSince > s.start ? ((D.silentSince - s.start) / (s.step * n)) * W : null;
    svg.innerHTML = vals.map((v, i) => {
      const h = v > 0 ? Math.max(1, (v / max) * (H - 2)) : 0.8;
      const dim = silentX !== null && i * bw >= silentX;
      return `<rect x="${(i * bw).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}"${i === n - 1 ? ' class="now"' : dim ? ' class="dim"' : ""}/>`;
    }).join("") + (median > 0 ? `<line x1="0" x2="${W}" y1="${(H - (median / max) * (H - 2)).toFixed(1)}" y2="${(H - (median / max) * (H - 2)).toFixed(1)}"/>` : "");
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
    $("coldSum").innerHTML = showUnavailable ? "shown above · Show unavailable is on"
      : cold.length ? `<b>${cold.length}</b> ${cold.length === 1 ? "session" : "sessions"} idle for more than an hour or on an unavailable machine<span class="sep">·</span><b>${fmt(coldTokens)}</b> tokens · 24 h`
        + (D.laneCount > D.lanes.length ? `<span class="sep">·</span>${D.laneCount - D.lanes.length} more not sent by the hub` : "")
      : "none · every session of the day is above";
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
    const w = win();
    $("projSum").innerHTML = `${stamp}<b>${p.projects.length}</b> ${p.projects.length === 1 ? "project" : "projects"}<span class="sep">·</span><b>${p.withRepo}</b> in a Git repository<span class="sep">·</span>this machine · ${esc(label)}`;
    $("foldProjBody").innerHTML = p.projects.length ? `<table class="grid"><thead><tr><th scope="col">Project</th><th scope="col" class="r">Tokens</th><th scope="col" class="r">Est. cost</th><th scope="col" class="r">Sessions</th><th scope="col" class="r">Commits</th><th scope="col" class="r">Lines + / −</th><th scope="col" class="r">Spend / commit</th><th scope="col">Branches</th></tr></thead><tbody>`
      + p.projects.map((x) => `<tr><td><b>${esc(x.name)}</b>${x.repo ? "" : `<span class="sub">not a Git repository</span>`}</td>
        <td class="num r">${fmt(x.tokens)}</td><td class="num r">${x.usd === null ? "—" : money(x.usd)}</td><td class="num r">${x.sessions === null ? "—" : x.sessions}</td>
        <td class="num r">${x.repo ? x.repo.commits : "—"}</td><td class="num r">${x.repo ? `+${fmt(x.repo.added)} / −${fmt(x.repo.removed)}` : "—"}</td>
        <td class="num r">${x.costPerOutcome.perCommitUsd === null ? "—" : money(x.costPerOutcome.perCommitUsd) + " est."}</td>
        <td class="num">${esc((x.branches || []).slice(0, 3).join(", ") || "—")}</td></tr>`).join("") + `</tbody></table><div class="note">This machine only. Spend per commit is spend in the window of the work, not attribution. <button class="linkbtn" type="button" data-go="projects">Projects view →</button></div>`
      : `<div class="note">No project on this machine has transcripts in this period.</div>`;
    $("effortSum").innerHTML = `${stamp}<b>${fmt(w.tokens.total)}</b> tokens<span class="sep">·</span><b>${w.cost.usd === null ? "—" : money(w.cost.usd)}</b> est.<span class="sep">·</span><b>${t.commits.toLocaleString("en-US")}</b> ${t.commits === 1 ? "commit" : "commits"} on this machine<span class="sep">·</span>${esc(label)}`;
    $("foldEffortBody").innerHTML = `<table class="grid"><thead><tr><th scope="col">Effort · ${esc(label)}</th><th scope="col" class="r">Every machine</th><th scope="col" class="r">This machine's Git</th></tr></thead><tbody>
      <tr><td>Tokens</td><td class="num r">${fmt(w.tokens.total)}</td><td class="num r">${fmt(p.tokens)}<span class="sub">this machine's transcripts</span></td></tr>
      <tr><td>Estimate</td><td class="num r">${w.cost.usd === null ? "—" : money(w.cost.usd) + (w.cost.status === "partial" ? " · partial" : "")}</td><td class="num r">—<span class="sub">see each project's matched spend / commit above</span></td></tr>
      <tr><td>Messages</td><td class="num r">${w.messages.toLocaleString("en-US")}</td><td class="num r">${p.sessions === null ? "—" : plural(p.sessions, "session")}</td></tr>
      <tr><td>Commits</td><td class="num r">—</td><td class="num r">${t.commits.toLocaleString("en-US")}${p.author === true ? `<span class="sub">yours, by this machine's Git email</span>` : p.author === false ? `<span class="sub">every author — no Git email set here</span>` : ""}</td></tr>
      </tbody></table><div class="note">Tokens measure usage, not value; this is not a productivity score. Git figures are this machine's local history only.</div>`;
    $("shipSum").innerHTML = `${stamp}<b>${t.commits.toLocaleString("en-US")}</b> ${t.commits === 1 ? "commit" : "commits"}<span class="sep">·</span><b>${t.prsMerged === null ? "—" : t.prsMerged}</b> referencing #N<span class="sep">·</span><b>+${fmt(t.added)}</b> / <b>−${fmt(t.removed)}</b> lines<span class="sep">·</span>this machine · ${esc(label)}`;
    const shipped = p.projects.filter((x) => x.repo);
    $("foldShipBody").innerHTML = shipped.length ? `<table class="grid"><thead><tr><th scope="col">Repository</th><th scope="col" class="r">Commits</th><th scope="col" class="r">Lines + / −</th><th scope="col" class="r" title="Commits whose subject ends (#N) or merges a pull request; #N may name an issue">Referencing #N</th><th scope="col" class="r">Default merges</th><th scope="col" class="r">Spend / default merge</th></tr></thead><tbody>`
      + shipped.map((x) => `<tr><td><b>${esc(x.repo.name)}</b><span class="sub">${esc(x.name)}</span></td><td class="num r">${x.repo.commits}</td><td class="num r">+${fmt(x.repo.added)} / −${fmt(x.repo.removed)}</td>
        <td class="num r">${x.repo.prsMerged === null ? "—" : x.repo.prsMerged}</td><td class="num r">${x.costPerOutcome.defaultMerges === null ? "—" : x.costPerOutcome.defaultMerges}</td>
        <td class="num r">${x.costPerOutcome.perDefaultMergeUsd === null ? "—" : money(x.costPerOutcome.perDefaultMergeUsd) + " est."}</td></tr>`).join("")
      + `</tbody></table><div class="note">What Git recorded on this machine in the period; a dash means no eligible count, verified price or local default-branch ref.</div>`
      : `<div class="note">No project on this machine is in a Git repository${p.projects.length ? "" : ", or none has transcripts in this period"}.</div>`;
  }

  // ── scrollable regions are announced only when they scroll ───────────
  function fitRegions() {
    for (const el of document.querySelectorAll(".tablewrap, .lanescroll")) {
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
    $("machinesHint").textContent = D.devices.length ? `${reporting} of ${currentDevices().length} reporting` + (goneShare > 0 ? ` · ${pct(goneShare)} left or removed` : "") : "none yet";
    $("machinesHint").title = D.devices.length ? `share of the ${PERIOD_TEXT[period][0]}` + (goneShare > 0 ? `; ${pct(goneShare)} of it from machines that left or were removed, hidden unless Show unavailable is on` : "") : "";
    $("cMachineCap").textContent = "by machine · " + PERIOD_TEXT[period][1];
    $("cMachines").innerHTML = machineRows(rows, now);
  }
  /* One row per machine, biggest first: its state as a ring or a lit dot, name, person, share, tokens, estimate.
     A silent machine keeps its name in warn and says when it stopped on hover — never a zero. The row is the
     door to the machine's inspector. Shared by the Console and Team bands. */
  function machineRows(rows, now, withPerson = false) {
    const sorted = rows.slice().sort((a, b) => pw(b).tokens.total - pw(a).tokens.total);
    return sorted.length ? sorted.map((d) => {
      const a = pw(d);
      return `<div class="xrow door ${d.status}" title="${esc(d.label)}${d.person ? " · " + esc(d.person) : ""} · ${esc(statusText(d, now))} · open" data-inspect="machine:${esc(d.id)}" tabindex="0" role="button">
        <span class="xn"><i aria-hidden="true"></i><b>${esc(d.label)}</b>${withPerson && d.person ? `<em>${esc(d.person)}</em>` : ""}${d.local ? '<span class="here">HERE</span>' : ""}</span>
        <span class="xp" data-src="devices.windows.shareOfWhole" title="${pct(a.shareOfWhole)} of the ${esc(PERIOD_TEXT[period][0])} · ${asOf()}">${pct(a.shareOfWhole, 0)}</span>
        <span class="xv" data-src="devices.windows.tokens.total" title="${fmt(a.tokens.total)} tokens · ${esc(PERIOD_TEXT[period][1])} · ${asOf()}">${fmt(a.tokens.total)}</span>
        ${a.cost.status === "none" ? `<span class="xc">—</span>` : a.cost.status === "unpriced" ? `<span class="xc void" title="No verified list price for what this machine ran">unpriced</span>` : `<span class="xc" data-internal data-src="devices.windows.cost.usd">${money(a.cost.usd)}${a.cost.status === "partial" ? "+" : ""}</span>`}
      </div>`;
    }).join("") : `<div class="xrow"><span class="xn"><em>no machine has joined yet</em></span></div>`;
  }

  // ── the chart ────────────────────────────────────────────────────────
  const W = 520, H = 100;
  function setChartGoal() {
    const s = D.series[period];
    const key = period + ":" + s.start;
    const goal = s.values.slice();
    // The newest step is still filling. Drawn raw it would dip at the right
    // edge every time; drawn as a rate over the part of it that has elapsed,
    // it says the same thing the other steps say.
    const elapsed = Math.max(0.25, Math.min(1, (D.now - (s.start + s.step * (goal.length - 1))) / s.step));
    goal[goal.length - 1] = goal[goal.length - 1] / elapsed;
    // The four classes, each a series of its own, stacked quietest first; a
    // hub that sends no split (0.2) draws the total alone.
    const clsGoal = s.classes ? Object.fromEntries(CLASSES.map((k) => {
      const v = s.classes[k].slice();
      v[v.length - 1] = v[v.length - 1] / elapsed;
      return [k, v];
    })) : null;
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
      chart.max = Math.max(...goal, 1) * 1.12;
    }
    chart.key = key;
    chart.goal = goal;
    chart.clsGoal = clsGoal;
    chart.goalMax = Math.max(...goal, 1) * 1.12;
    chart.series = s;
    // The legend under the axis: each class, its tokens and its dollars for the period, the same figures as the tokens panel.
    const w = win();
    const byClass = w.cost.byClass || null;
    $("cLegend").innerHTML = CLASSES.slice().reverse().map((k) => `<span title="${esc(CLASS_LABEL[k])} · ${pct(w.shares[k])} of tokens"><i class="sw ${k}"></i>${CLASS_LABEL[k]} <b>${fmt(w.tokens[k])}</b>${byClass ? `<em>${money(byClass[k])}</em>` : w.cost.status === "unpriced" ? `<em title="no verified list price">unpriced</em>` : ""}</span>`).join("");
    $("cFlow").setAttribute("aria-label", "Tokens over time, stacked by class: " + CLASSES.map((k) => `${CLASS_LABEL[k]} ${fmt(w.tokens[k])}`).join(", "));
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
    const until = i === s.values.length - 1 ? "now" : hhmm(from + s.step);
    const day = period === "7d" ? new Date(from).toLocaleDateString([], { weekday: "short" }) + " " : "";
    const split = s.classes ? `<small>${CLASSES.slice().reverse().map((k) => `${CLASS_LABEL[k].replace("uncached ", "")} ${fmt(s.classes[k][i])}`).join(" · ")}</small>` : "";
    tip.innerHTML = (period === "30d"
      ? `${new Date(from).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })} (UTC)${i === s.values.length - 1 ? " · so far" : ""} · <b>${fmt(s.values[i])}</b> tokens`
      : `${day}${hhmm(from)}–${until} · <b>${fmt(s.values[i])}</b> tokens`) + split;
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
    $("cRate").textContent = none ? "no machine has reported yet" : excludedAll ? "no machine reporting right now"
      : (perSecond ? fmt(perMin) + " per minute" : fmt(perMin / 60) + " per second") + " · " + dollars;
    const names = bc.unpricedModels.join(", ");
    const has = bc.unpricedModels.length === 1 ? "has" : "have";
    $("cRate").title = bc.status === "unpriced" ? `${names} ${has} no verified list price, so no dollar rate is shown`
      : bc.status === "partial" ? `${names} ${has} no verified list price; ${fmt(bc.unpricedTokensPerMinute)} tok/min are not in this figure`
      : "Standard API list prices. Not an invoice.";
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
  $("unitBtn").addEventListener("click", (ev) => {
    perSecond = !perSecond;
    ev.currentTarget.textContent = (perSecond ? "per second" : "per minute") + " ⇄";
    paintText();
  });
  $("motionBtn").addEventListener("click", (ev) => {
    paused = !paused;
    const b = ev.currentTarget;
    b.setAttribute("aria-pressed", String(paused));
    b.textContent = paused ? "Resume motion" : "Pause motion";
    b.title = paused ? "Figures still update; they change without moving" : "Stop the animation; figures keep updating";
    document.body.classList.toggle("paused", paused);
    // Polling carries on either way: only the travel stops.
    if (paused && D) { Object.assign(shown, target); setChartGoal(); paintText(); drawChart(); }
    if (!paused) startLoop();
  });
  function openAlerts() { if (D && (D.alerts || []).length) openSheet($("alertPanel"), view + "/alerts"); else toast("No alert in the last hour."); }
  $("alertChip").addEventListener("click", openAlerts);
  $("voidBtn").addEventListener("click", (ev) => {
    showUnavailable = !showUnavailable;
    const b = ev.currentTarget;
    b.setAttribute("aria-pressed", String(showUnavailable));
    b.textContent = showUnavailable ? "Hide unavailable" : "Show unavailable";
    if (D) { paintLanes(); paintMachines(); paintClasses(); loadFold(); }
  });

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
  function openSheet(dialog, hash) {
    if (!dialog.open) dialog.showModal();
    setHash(hash);
    dialog.addEventListener("close", () => setHash(view === "console" ? "" : view), { once: true });
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
       <span class="names">${models.slice(0, 2).map((m) => `<b>${esc(m.label)}</b> ${pct(m.share, 0)}`).join(" · ")}${models.length > 2 ? ` · +${models.length - 2}` : ""}</span></span>`
    : `<span class="names">—</span>`;
  const costCell = (c) => c.status === "none" ? "—" : c.status === "unpriced" ? "unpriced" : money(c.usd) + (c.status === "partial" ? "+" : "");
  const costTitle = (c) => c.status === "none" ? "Nothing to price yet" : c.status === "unpriced" ? "No verified list price for what ran here" : c.status === "partial" ? "List-price estimate; some records are unpriced, so this is a floor" : "List-price estimate. Not an invoice.";
  const deviceOf = (id) => D.devices.find((d) => d.id === id) || null;
  const deviceKey = (l) => l.device.id;
  const personOfDevice = (id) => (deviceOf(id) || {}).person || "Unassigned";

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
    $("tCap").textContent = "Tokens · " + PERIOD_TEXT[period][0];
    $("tTotal").textContent = none ? "—" : fmt(total);
    $("tTotal").title = none ? "No machine has reported yet" : `${fmt(total)} tokens across ${plural(D.devices.length, "machine")} · ${asOf()}`;
    // Every model unpriced is "no priced model", never $0.00.
    $("tSpend").textContent = none ? "no reading yet" : cost.status === "unpriced" ? "no priced model" : cost.status === "none" ? "no spend yet" : money(cost.usd) + (cost.status === "partial" ? " est. · partial" : " est.");
    $("tSpend").title = costTitle(cost);
    $("tMsgs").textContent = none ? "—" : msgs.toLocaleString("en-US");
    const gone = D.devices.filter((d) => d.status === "revoked");
    $("tProv").innerHTML = none ? "no machine has joined yet"
      : (D.hub.demo ? "generated · " : "") + `${reporting} of ${current} reporting` + (silent.length ? ` · <b>${silent.length} silent</b>` : "") + (gone.length ? ` · ${gone.length} left or removed` : "");
    $("tProv").title = silent.length ? silent.map((d) => `${d.label} silent since ${hhmm(d.lastContactAt)} · not counted since`).join("; ") : "";
    // A session is a top-level session everywhere; outside the last 24 h the
    // count kept per period includes subagents, and says so.
    const sessions = none ? "—" : period === "24h" ? sessionWords()
      : whole.sessions === null ? "sessions not kept past the minute detail"
      : plural(whole.sessions, "session or subagent", "sessions and subagents");
    const kv = [
      [`${reporting}<span class="u">/ ${current}</span>`, "reporting", plural(D.people.length, "person", "people"), "devices.status"],
      [pct(total ? cr / total : null), "cache read", "of all tokens", "windows.shares.cacheRead"],
      [pct(total ? cw / total : null), "cache write", "of all tokens", "windows.shares.cacheWrite"],
      [none ? "—" : String(D.laneCount), "sessions", none ? "no machine yet" : period === "24h" ? plural(Math.max(0, D.day.sessions - D.laneCount), "subagent") : sessions.replace(/^[\d,]+ /u, ""), "laneCount"],
    ];
    $("teamTotals").innerHTML = kv.map(([v, l, s, src]) => `<div><div class="v" data-src="${src}" title="${esc(l)} · ${asOf()}">${v}</div><div class="l">${esc(l)}</div><div class="s">${esc(s)}</div></div>`).join("");
    // The last hour stacked by machine, from the lanes' own sparks.
    const byDevice = sparksBy(deviceKey);
    const hourTotal = drawStacked("tFlow", "tFlowWrap", "tFlowReason", "tLegend", byDevice, (id) => (deviceOf(id) || { label: "Unknown machine" }).label);
    $("tFlowCap").innerHTML = hourTotal ? `<b>${fmt(hourTotal)}</b> tokens · ${D.lanes.filter((l) => l.state === "live").length} live` : "—";
    $("tMachineCap").textContent = "by machine · " + label;
    $("tPeopleCap").textContent = "by person · " + label;
    const rows = D.devices.filter((d) => d.status !== "revoked" || showUnavailable);
    $("tMachines").innerHTML = machineRows(rows, now, true);
    const people = D.people.slice().sort((a, b) => of(b).tokens.total - of(a).tokens.total);
    $("tPeople").innerHTML = people.length ? people.map((p) => {
      const a = of(p);
      return `<div class="xrow door" data-inspect="person:${esc(p.person)}" tabindex="0" role="button" title="${esc(p.person)} · ${p.reporting} of ${p.devices.length} reporting · open">
        <span class="xn"><b>${esc(p.person)}</b><em>${p.devices.map((id) => esc((deviceOf(id) || {}).label || "")).join(", ")}</em></span>
        <span class="xp" data-src="people.windows.shareOfWhole">${pct(a.shareOfWhole, 0)}</span>
        <span class="xv" data-src="people.windows.tokens.total">${fmt(a.tokens.total)}</span>
        <span class="xc${a.cost.status === "unpriced" ? " void" : ""}" data-internal data-src="people.windows.cost.usd" title="${esc(costTitle(a.cost))}">${costCell(a.cost)}</span>
      </div>`;
    }).join("") : `<div class="xrow"><span class="xn"><em>nobody yet</em></span></div>`;

    const byPerson = sparksBy((l) => personOfDevice(l.device.id));
    $("peopleCount").textContent = `${plural(D.people.length, "person", "people")} · ${label}`;
    $("peopleTable").tBodies[0].innerHTML = D.people.length ? people.map((p) => {
      const a = of(p);
      const s = byPerson.get(p.person);
      return `<tr class="door" data-inspect="person:${esc(p.person)}">
        <td class="k1"><button type="button" class="rowbtn" data-inspect="person:${esc(p.person)}" title="Open ${esc(p.person)}">${esc(p.person)}</button>${demoStamp()}</td>
        <td>${p.devices.map((id) => esc((deviceOf(id) || {}).label || "")).join(", ")}<em class="q">${p.reporting} of ${p.devices.length} reporting</em></td>
        <td>${s ? sparkBars(s.spark, s.live > 0) : `<span class="sp none">—</span>`}</td>
        <td class="num r" data-src="people.windows.tokens.total">${fmt(a.tokens.total)}</td><td class="k2">${shareBar(a.shareOfWhole, "people.windows.shareOfWhole")}</td>
        <td class="num r" data-src="people.windows.shares.cacheRead">${pct(a.shares.cacheRead)}</td><td class="num r" data-src="people.windows.shares.cacheWrite">${pct(a.shares.cacheWrite)}</td>
        <td>${modelSplit(a.models)}</td><td class="num r" data-internal data-src="people.windows.cost.usd" title="${esc(costTitle(a.cost))}">${costCell(a.cost)}</td></tr>`;
    }).join("") : `<tr><td colspan="9">Nobody yet — add a machine.</td></tr>`;

    const devices = D.devices.slice().sort((a, b) => of(b).tokens.total - of(a).tokens.total);
    $("machineCountHead").textContent = `${plural(current, "machine")} · ${reporting} reporting` + (silent.length ? ` · ${silent.length} silent` : "") + (gone.length ? ` · ${gone.length} left or removed` : "");
    $("machineTable").tBodies[0].innerHTML = D.devices.length ? devices.map((d) => {
      const a = of(d);
      const s = byDevice.get(d.id);
      const action = d.local ? `<span class="sub">this machine</span>`
        : d.status === "revoked" ? `<span class="sub">${d.leftAt ? "left" : "removed"}</span>`
        : `<button type="button" class="btn small danger" data-revoke="${esc(d.id)}" data-label="${esc(d.label)}">Remove</button>`;
      // The dropped-record note stays beside the machine; the joined line is on hover and in the inspector.
      const lost = d.coverage && d.coverage.dropped ? `<span class="sub"><b title="${esc(d.coverage.reasons.map((r) => r.count + " × " + r.label).join("; "))}">${d.coverage.dropped} not counted</b></span>` : "";
      const joined = d.local ? "the hub itself" : "joined " + new Date(d.createdAt).toLocaleDateString([], { day: "numeric", month: "short" }) + " · " + hhmm(Date.parse(d.createdAt)) + (d.joinedVia === "link" ? " by link" : "");
      return `<tr class="door ${d.status}" data-inspect="machine:${esc(d.id)}" title="${esc(d.label)} · ${esc(joined)}">
        <td class="k1"><button type="button" class="rowbtn" data-inspect="machine:${esc(d.id)}" title="Open ${esc(d.label)} · ${esc(joined)}">${esc(d.label)}</button>${demoStamp()}<span class="sub joined">${d.local ? "the hub itself" : "joined " + new Date(d.createdAt).toLocaleDateString([], { day: "numeric", month: "short" }) + " · " + hhmm(Date.parse(d.createdAt)) + (d.joinedVia === "link" ? " by link" : "")}</span>${lost}</td>
        <td>${esc(d.person || "—")}</td>
        <td><span class="status ${d.status}"><i></i>${esc(statusText(d, now))}</span></td>
        <td>${s ? sparkBars(s.spark, s.live > 0 && d.status === "reporting") : `<span class="sp none">—</span>`}</td>
        <td class="num r" data-src="devices.windows.tokens.total">${fmt(a.tokens.total)}</td><td class="k2">${shareBar(a.shareOfWhole, "devices.windows.shareOfWhole")}</td>
        <td class="num r" data-src="devices.windows.shares.cacheRead">${pct(a.shares.cacheRead)}</td><td class="num r" data-src="devices.windows.shares.cacheWrite">${pct(a.shares.cacheWrite)}</td>
        <td>${modelSplit(a.models)}</td><td class="num r" data-internal data-src="devices.windows.cost.usd" title="${esc(costTitle(a.cost))}">${costCell(a.cost)}</td><td class="r">${action}</td></tr>`;
    }).join("") : `<tr><td colspan="11">No machine yet.</td></tr>`;

    const open = D.invitations.filter((i) => i.state === "open");
    $("inviteCount").textContent = D.invitations.length ? `${open.length} waiting` + (open.length ? ` · expires ${hhmm(Math.min(...open.map((i) => i.expiresAt)))}` : "") + ` · ${D.invitations.length - open.length} joined · 7 days` : "none · 7 days";
    $("invites").innerHTML = D.invitations.length ? D.invitations.map((i) => {
      const who = [i.person, i.machine].filter(Boolean).map(esc).join(" · ") || "Unnamed";
      const joined = i.state === "joined" ? D.devices.find((d) => d.id === i.deviceId) : null;
      return `<div class="invite"><span class="k ${i.state}">${i.state === "open" ? "Waiting" : "Joined"}</span>
        <span class="w">${who}${joined ? ` <em>→ ${esc(joined.label)}</em>` : ""}</span>
        <span class="t">${i.state === "open" ? "expires " : "joined "}<b>${hhmm(i.state === "open" ? i.expiresAt : Date.parse(i.usedAt))}</b></span>
        ${i.state === "open" ? `<button type="button" class="btn small" data-cancel="${esc(i.id)}">Cancel link</button>` : "<span></span>"}</div>`;
    }).join("") : `<div class="none">No join link in the last seven days.</div>`;
  }

  document.addEventListener("click", async (ev) => {
    const cancel = ev.target.closest("[data-cancel]");
    if (cancel) {
      await fetch(`/api/invitations/${cancel.dataset.cancel}/cancel`, { method: "POST", headers: HEADERS });
      toast("That join link no longer works.");
      poll();
      return;
    }
    const revoke = ev.target.closest("[data-revoke]");
    if (revoke) {
      const dialog = $("revokeDialog");
      $("revokeSay").textContent = `“${revoke.dataset.label}” will stop being accepted at once. What it already reported stays on the console, marked as removed. To bring it back, send a new join link.`;
      $("revokeGo").onclick = async () => {
        const r = await fetch(`/api/devices/${revoke.dataset.revoke}/revoke`, { method: "POST", headers: HEADERS });
        dialog.close();
        toast(r.ok ? `${revoke.dataset.label} was removed.` : "It could not be removed.");
        poll();
      };
      dialog.showModal();
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
  const projectKey = (l) => l.project.name;
  /* The parts of the Projects view that come from the console payload — live
     sessions and the last hour — repaint with every poll; the Git figures come
     from /api/projects once a minute. */
  function paintProjectsLive() {
    if (!D) return;
    const by = sparksBy(projectKey, localLanes());
    const hourTotal = drawStacked("pFlow", "pFlowWrap", "pFlowReason", "pLegend", by, (name) => name);
    $("pFlowCap").innerHTML = hourTotal ? `<b>${fmt(hourTotal)}</b> tokens · ${localLanes().filter((l) => l.state === "live").length} live` : "—";
    for (const cell of document.querySelectorAll("#projTable [data-live]")) {
      const s = by.get(cell.dataset.live);
      const live = s ? s.live : 0;
      cell.innerHTML = `<span class="live-dot${live ? " on" : ""}${D.hub.demo ? " sim" : ""}" title="${live ? plural(live, "session") + " reported within the last two minutes" : "No session reported within the last two minutes"}"><i></i>${live || "—"}</span>`;
    }
  }
  async function loadProjects() {
    const body = $("projTable").tBodies[0];
    if (!projCache) body.innerHTML = `<tr><td colspan="13">Reading this machine…</td></tr>`;
    try {
      const r = await fetch("/api/projects?period=" + period, { headers: HEADERS });
      const p = await r.json();
      if (!r.ok) throw new Error(p.reason || String(r.status));
      projCache = p;
      const t = p.totals;
      const label = PERIOD_TEXT[period][1];
      const usd = p.projects.some((x) => x.usd !== null) ? p.projects.reduce((a, x) => a + (x.usd || 0), 0) : null;
      const unpriced = p.projects.filter((x) => x.usd === null && x.tokens > 0).length;
      $("pCap").textContent = `Tokens · ${PERIOD_TEXT[period][0]}`;
      $("pTotal").textContent = fmt(p.tokens);
      $("pTotal").title = `${fmt(p.tokens)} tokens in this machine's transcripts · ${label} · ${asOf()}`;
      $("pSpend").textContent = usd === null ? "no priced model" : money(usd) + (unpriced ? " est. · partial" : " est.");
      $("pSpend").title = unpriced ? `${unpriced} ${unpriced === 1 ? "project has" : "projects have"} no verified list price and are not in this figure` : "List-price estimate. Not an invoice.";
      $("pSessions").textContent = p.sessions === null ? "—" : String(p.sessions);
      $("pProv").innerHTML = (p.demo ? "generated · " : "this machine's transcripts and Git · ") + (p.author === true ? "commits by this machine's Git email" : p.author === false ? "every author — no Git email set here" : "local Git history");
      $("pProv").title = p.author === false ? "No Git email (user.email) is set in one of these repositories, so its Git figures count every author. None of this leaves this machine." : "Read from this machine only. None of this leaves this machine.";
      $("pKv").innerHTML = [
        [String(p.projects.length), "projects", `${p.withRepo} in Git`, "projects.length"],
        [t.commits.toLocaleString("en-US"), "commits", "local Git · " + label, "projects.totals.commits"],
        [`+${fmt(t.added)}<span class="u">−${fmt(t.removed)}</span>`, "lines", "added / removed", "projects.totals.added"],
        [t.prsMerged === null ? "—" : String(t.prsMerged), "PR-linked commits", t.prsMerged === null ? "needs a remote" : "(#N) or PR merge", "projects.totals.prsMerged", "Commits referencing #N: a subject ending (#N) or a pull-request merge; #N may name an issue rather than a merged pull request"],
      ].map(([v, l, s, src, why]) => `<div><div class="v" data-src="${src}" title="${esc(why || l + " · " + s)} · ${asOf()}">${v}</div><div class="l">${esc(l)}</div><div class="s">${esc(s)}</div></div>`).join("");
      // Share of tokens per project, sorted, top five and "n more"; spend per commit as bars against the costliest.
      const ranked = p.projects.slice().sort((a, b) => b.tokens - a.tokens);
      const max = Math.max(...ranked.map((x) => x.tokens), 1);
      const open = moreOpen.has("pShare");
      const shown = open ? ranked : ranked.slice(0, MODELS_SHOWN);
      $("pShareCap").textContent = "tokens by project · " + label;
      $("pShare").innerHTML = shown.map((x) => `<div class="mrow door" data-inspect="project:${esc(x.name)}" tabindex="0" role="button" title="${esc(x.name)} · ${fmt(x.tokens)} tokens · ${pct(p.tokens ? x.tokens / p.tokens : null)} of this machine · open">
          <span class="mn"><span class="txt">${esc(x.name)}</span></span><span class="ms">${demoStamp()}</span>
          <span class="mbar" aria-hidden="true"><i style="width:${Math.max(1, Math.round((x.tokens / max) * 100))}%"></i></span>
          <span class="mv" data-src="projects.tokens">${pct(p.tokens ? x.tokens / p.tokens : null, 0)}</span>
          ${x.usd === null ? `<span class="mc unp" title="No verified list price for what ran here">unpriced</span>` : `<span class="mc" data-internal data-src="projects.usd">${money(x.usd)}</span>`}
        </div>`).join("") + (ranked.length > MODELS_SHOWN ? `<button type="button" class="more" data-more="pShare">${open ? "fewer" : `${ranked.length - MODELS_SHOWN} more`}</button>` : "")
        || `<div class="mrow"><span class="mn"><span class="none-text">no project has transcripts in this period</span></span></div>`;
      const priced = ranked.filter((x) => x.costPerOutcome.perCommitUsd !== null).sort((a, b) => b.costPerOutcome.perCommitUsd - a.costPerOutcome.perCommitUsd);
      const pmax = Math.max(...priced.map((x) => x.costPerOutcome.perCommitUsd), 0.01);
      $("pSpendRows").innerHTML = priced.length ? priced.slice(0, MODELS_SHOWN).map((x) => `<div class="mrow door" data-inspect="project:${esc(x.name)}" tabindex="0" role="button" title="${esc(x.name)} · spend in the window of the work per local commit — not attribution · open">
          <span class="mn"><span class="txt">${esc(x.name)}</span></span><span class="ms"></span>
          <span class="mbar" aria-hidden="true"><i style="width:${Math.max(1, Math.round((x.costPerOutcome.perCommitUsd / pmax) * 100))}%"></i></span>
          <span class="mv" data-src="projects.repo.commits">${x.repo ? x.repo.commits : "—"}</span>
          <span class="mc" data-internal data-src="projects.costPerOutcome.perCommitUsd">${money(x.costPerOutcome.perCommitUsd)}</span>
        </div>`).join("") : `<div class="xrow"><span class="xn"><em>${ranked.some((x) => x.repo) ? "no priced commit in this period" : "no project here is in a Git repository"}</em></span></div>`;
      $("pEffortHint").textContent = "spend in the window of the work, not attribution";
      $("pEffortHint").title = "Tokens measure usage, not value; this is not a productivity score.";

      $("projTableCount").textContent = `${plural(p.projects.length, "project")} · ${p.withRepo} in Git · ${label}`;
      body.innerHTML = p.projects.length ? ranked.map((x) => `<tr class="door" data-inspect="project:${esc(x.name)}">
        <td class="k1"><button type="button" class="rowbtn" data-inspect="project:${esc(x.name)}" title="Open ${esc(x.name)}">${esc(x.name)}</button>${demoStamp()}${x.repo ? (x.repo.name !== x.name ? `<span class="sub">${esc(x.repo.name)}</span>` : "") : `<span class="sub"><b>not a Git repository</b></span>`}</td>
        <td data-live="${esc(x.name)}"><span class="live-dot"><i></i>—</span></td>
        <td class="num r" data-src="projects.tokens">${fmt(x.tokens)}</td><td class="k2">${shareBar(p.tokens ? x.tokens / p.tokens : null, "projects.tokens")}</td>
        <td class="num r" data-internal data-src="projects.usd" title="${x.usd === null ? "No verified list price for what ran here" : "List-price estimate. Not an invoice."}">${x.usd === null ? "unpriced" : money(x.usd) + " est."}</td>
        <td class="num r" data-src="projects.sessions">${x.sessions === null ? "—" : x.sessions}</td>
        <td class="num r" data-src="projects.repo.commits">${x.repo ? x.repo.commits : "—"}</td>
        <td class="num r" data-src="projects.repo.added">${x.repo ? `+${x.repo.added.toLocaleString("en-US")} / −${x.repo.removed.toLocaleString("en-US")}` : "—"}</td>
        <td class="num r" data-src="projects.repo.prsMerged">${x.repo && x.repo.prsMerged !== null ? x.repo.prsMerged : "—"}</td>
        <td class="num r" data-src="projects.costPerOutcome.defaultMerges">${x.costPerOutcome.defaultMerges === null ? "—" : x.costPerOutcome.defaultMerges}</td>
        <td class="num r" data-internal data-src="projects.costPerOutcome.perCommitUsd" title="Spend in the work window per local commit, not attribution">${x.costPerOutcome.perCommitUsd === null ? "—" : money(x.costPerOutcome.perCommitUsd) + " est."}</td>
        <td class="num r" data-internal data-src="projects.costPerOutcome.perDefaultMergeUsd" title="Spend in the work window per local default-branch integration, not attribution">${x.costPerOutcome.perDefaultMergeUsd === null ? "—" : money(x.costPerOutcome.perDefaultMergeUsd) + " est."}</td>
        <td class="num">${esc((x.branches || []).slice(0, 3).join(", ") || "—")}</td></tr>`).join("")
        : `<tr><td colspan="13">No project on this machine has transcripts in this period.</td></tr>`;
      paintProjectsLive();

      // Effort: the fleet on one side, this machine's Git on the other — never divided into each other.
      const w = win();
      $("projEffortCount").textContent = `every machine · this machine's Git · ${label}`;
      $("projEffort").innerHTML = `<table class="grid"><thead><tr><th scope="col">Effort · ${esc(label)}</th><th scope="col" class="r">Every machine</th><th scope="col" class="r">This machine's Git</th></tr></thead><tbody>
        <tr><td class="k1">Tokens</td><td class="num r k2" data-src="windows.tokens.total">${fmt(w.tokens.total)}</td><td class="num r k2" data-src="projects.tokens">${fmt(p.tokens)}</td></tr>
        <tr><td class="k1">Estimate</td><td class="num r k2" data-internal data-src="windows.cost.usd">${w.cost.usd === null ? "—" : money(w.cost.usd) + (w.cost.status === "partial" ? " · partial" : "")}</td><td class="num r k2" title="See each project's spend per commit above">—</td></tr>
        <tr><td class="k1">Messages</td><td class="num r k2" data-src="windows.messages">${w.messages.toLocaleString("en-US")}</td><td class="num r k2" data-src="projects.sessions">${p.sessions === null ? "—" : plural(p.sessions, "session")}</td></tr>
        <tr><td class="k1">Commits</td><td class="num r k2">—</td><td class="num r k2" data-src="projects.totals.commits">${t.commits.toLocaleString("en-US")}</td></tr>
        </tbody></table>`;
      const shipped = p.projects.filter((x) => x.repo);
      $("projShipCount").textContent = `${plural(t.commits, "commit")} · ${t.prsMerged === null ? "—" : t.prsMerged} PR-linked · +${fmt(t.added)} / −${fmt(t.removed)} lines · ${label}`;
      $("projShip").innerHTML = shipped.length ? `<table class="grid"><thead><tr><th scope="col">Repository</th><th scope="col" class="r">Commits</th><th scope="col" class="r">Lines + / −</th><th scope="col" class="r" title="Commits whose subject ends (#N) or merges a pull request; #N may name an issue">PR-linked</th><th scope="col" class="r" title="Local default-branch integration commits">Merges</th><th scope="col" class="r" title="Spend in the window of the work per local default-branch integration, not attribution">$ / merge</th></tr></thead><tbody>`
        + shipped.map((x) => `<tr class="door" data-inspect="project:${esc(x.name)}"><td class="k1"><button type="button" class="rowbtn" data-inspect="project:${esc(x.name)}" title="Open ${esc(x.name)}">${esc(x.repo.name)}</button>${x.repo.name !== x.name ? `<span class="sub">${esc(x.name)}</span>` : ""}</td><td class="num r k2">${x.repo.commits} commits</td><td class="num r">+${fmt(x.repo.added)} / −${fmt(x.repo.removed)}</td>
          <td class="num r">${x.repo.prsMerged === null ? "—" : x.repo.prsMerged}</td><td class="num r">${x.costPerOutcome.defaultMerges === null ? "—" : x.costPerOutcome.defaultMerges}</td>
          <td class="num r" data-internal>${x.costPerOutcome.perDefaultMergeUsd === null ? "—" : money(x.costPerOutcome.perDefaultMergeUsd) + " est."}</td></tr>`).join("")
        + `</tbody></table>`
        : `<div class="voidpanel"><b>No Git evidence</b>No project on this machine is in a Git repository${p.projects.length ? "" : ", or none has transcripts in this period"}. Nothing is estimated in its place.</div>`;
      if (inspect.open && inspect.kind === "project") paintInspect();
    } catch (error) {
      body.innerHTML = `<tr><td colspan="13">This machine's projects could not be read: ${esc(error.message)}</td></tr>`;
    }
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
    $("peopleList").innerHTML = (D ? D.people : []).map((p) => `<option value="${esc(p.person)}"></option>`).join("");
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
      const who = [j.invitation.person, j.invitation.machine].filter(Boolean).join("'s ").replace(/'s$/, "") || "them";
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
      status.innerHTML = `<i></i>Joined at ${hhmm(Date.parse(inv.usedAt))} — ${esc(device ? device.label : "the machine")}${device && device.person ? " (" + esc(device.person) + ")" : ""} is reporting.`;
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
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); });
    for (const c of d.querySelectorAll("[data-close]")) if (d.id !== "addDialog") c.addEventListener("click", () => d.close());
  }

  // ── the inspector: a machine, a person or a project, opened beside the canvas by its row ──
  /* Everything in it is the payload regrouped — the machine's own lanes, its
     sparks summed, its models, its join record — never a figure the page made
     up. Esc closes it; the URL carries it while it is open. */
  const inspectDialog = $("inspectDialog");
  function openInspect(kind, id) {
    inspect.open = true; inspect.kind = kind; inspect.id = id;
    paintInspect();
    openSheet(inspectDialog, `${view}/${kind}/${encodeURIComponent(id)}`);
  }
  inspectDialog.addEventListener("close", () => { inspect.open = false; });
  document.addEventListener("click", (ev) => {
    const door = ev.target.closest("[data-inspect]"); if (!door) return;
    const other = ev.target.closest("button, a");
    if (other && !other.hasAttribute("data-inspect")) return;   // Remove and Cancel keep their own job
    const [kind, ...rest] = door.dataset.inspect.split(":");
    openInspect(kind, rest.join(":"));
  });
  const ikv = (cells) => `<div class="ikv">${cells.map(([v, l, cls, src]) => `<div><div class="v${cls ? " " + cls : ""}"${src ? ` data-src="${src}"` : ""}>${v}</div><div class="l">${esc(l)}</div></div>`).join("")}</div>`;
  const isparkHtml = (s, dim) => s
    ? `<div class="ispark${dim ? " dim" : ""}" role="img" aria-label="Tokens in the last hour, three-minute steps">${(() => { const top = Math.max(...s.spark, 1); return s.spark.map((v, k) => `<i style="height:${(v > 0 ? 9 + (v / top) * 91 : 5).toFixed(0)}%"${!dim && k === s.spark.length - 1 && v > 0 ? ' class="hot"' : ""}></i>`).join(""); })()}</div>`
    : `<div class="iquiet">No session in the last 24 hours.</div>`;
  const stateWord = (s) => s === "live" ? "LIVE" : s === "idle" ? "IDLE" : s === "revoked" ? "REMOVED" : s === "catching-up" ? "CATCHING UP" : s === "reconnecting" ? "RECONNECTING" : "SILENT";
  const laneList = (lanes, cap = "24 h") => lanes.length
    ? `<div class="ihead">Sessions <span>${lanes.length} · ${esc(cap)}</span></div>` + lanes.slice(0, 12).map((l) => `<div class="irow" data-lane="${esc(l.key)}" tabindex="0" role="button" title="Open the lane · ${esc(l.project.name)}${l.branch ? " · " + esc(l.branch) : ""}"><span class="nm"><b>${esc(l.project.name)}</b>${l.branch ? `<em>${esc(l.branch)}</em>` : ""}</span><span>${esc(l.modelLabel)}</span><span class="r" data-src="lanes.tokensDay">${l.tokensDay == null ? "—" : fmt(l.tokensDay)}</span><span class="st ${l.state}">${stateWord(l.state)}</span></div>`).join("")
      + (lanes.length > 12 ? `<div class="iquiet">${lanes.length - 12} more in the lanes</div>` : "")
    : `<div class="iquiet">No session in the last 24 hours.</div>`;
  const modelList = (models, cap) => models.length ? `<div class="ihead">Models <span>${esc(cap)}</span></div>` + modelRows(models, "inspect", models) : "";
  function paintInspect() {
    if (!D || !inspect.open) return;
    const now = serverNow();
    const cap = PERIOD_TEXT[period][1];
    const foot = $("inspectFoot");
    let title = "—", body = "";
    foot.innerHTML = `<button type="button" class="btn" data-close>Close</button>`;
    if (inspect.kind === "machine") {
      const d = D.devices.find((x) => x.id === inspect.id);
      if (!d) { title = "Machine"; body = `<div class="iquiet">This machine is no longer on the console.</div>`; }
      else {
        const a = pw(d);
        const s = sparksBy(deviceKey).get(d.id);
        title = d.label;
        const lost = d.coverage && d.coverage.dropped ? d.coverage.dropped : 0;
        body = `<div class="ihero"><span class="big" data-src="devices.windows.tokens.total">${fmt(a.tokens.total)}</span><span class="u">tokens · ${esc(cap)}</span></div>
          <div class="iline"><span class="status ${d.status}"><i></i>${esc(statusText(d, now))}</span>${d.person ? ` · <b>${esc(d.person)}</b>` : ""}${d.local ? " · this machine" : ""}</div>
          ${ikv([[pct(a.shareOfWhole, 0), "share of every machine", "", "devices.windows.shareOfWhole"], [costCell(a.cost), "est.", a.cost.status === "unpriced" ? "warn" : "", "devices.windows.cost.usd"],
            [pct(a.shares.cacheRead), "cache read", "", "devices.windows.shares.cacheRead"], [pct(a.shares.cacheWrite), "cache write", "", "devices.windows.shares.cacheWrite"],
            [a.messages.toLocaleString("en-US"), "messages", "", "devices.windows.messages"], [String(lost), "not counted", lost ? "warn" : "", "devices.coverage.dropped"]])}
          <div class="ihead">Last hour <span>${s ? fmt(s.spark.reduce((x, y) => x + y, 0)) + " tokens" : "—"}</span></div>${isparkHtml(s, d.status !== "reporting")}
          ${modelList(a.models, cap)}
          ${laneList(D.lanes.filter((l) => l.device.id === d.id))}
          <div class="iquiet">${d.local ? "The hub itself." : `Joined ${new Date(d.createdAt).toLocaleDateString([], { day: "numeric", month: "short" })} · ${hhmm(Date.parse(d.createdAt))}${d.joinedVia === "link" ? " by link" : ""}.`}${lost ? ` <b>${lost} not counted</b>: ${esc(d.coverage.reasons.map((r) => r.count + " × " + r.label).join("; "))}.` : ""}</div>`;
        if (!d.local && d.status !== "revoked") foot.innerHTML = `<button type="button" class="btn danger" data-revoke="${esc(d.id)}" data-label="${esc(d.label)}">Remove</button>` + foot.innerHTML;
      }
    } else if (inspect.kind === "person") {
      const p = D.people.find((x) => x.person === inspect.id);
      if (!p) { title = "Person"; body = `<div class="iquiet">Nobody by that name is on the console.</div>`; }
      else {
        const a = pw(p);
        const s = sparksBy((l) => personOfDevice(l.device.id)).get(p.person);
        title = p.person;
        body = `<div class="ihero"><span class="big" data-src="people.windows.tokens.total">${fmt(a.tokens.total)}</span><span class="u">tokens · ${esc(cap)}</span></div>
          <div class="iline">${p.reporting} of ${plural(p.devices.length, "machine")} reporting · <b>${p.devices.map((id) => esc((deviceOf(id) || {}).label || "")).join(", ")}</b></div>
          ${ikv([[pct(a.shareOfWhole, 0), "share of every machine", "", "people.windows.shareOfWhole"], [costCell(a.cost), "est.", a.cost.status === "unpriced" ? "warn" : "", "people.windows.cost.usd"],
            [pct(a.shares.cacheRead), "cache read", "", "people.windows.shares.cacheRead"], [pct(a.shares.cacheWrite), "cache write", "", "people.windows.shares.cacheWrite"],
            [a.messages.toLocaleString("en-US"), "messages", "", "people.windows.messages"], [plural(p.devices.length, "machine"), "machines"]])}
          <div class="ihead">Last hour <span>${s ? fmt(s.spark.reduce((x, y) => x + y, 0)) + " tokens" : "—"}</span></div>${isparkHtml(s, p.reporting === 0)}
          ${modelList(a.models, cap)}
          <div class="ihead">Machines <span>${p.devices.length}</span></div>
          ${p.devices.map((id) => deviceOf(id)).filter(Boolean).map((d) => `<div class="irow" data-inspect="machine:${esc(d.id)}" tabindex="0" role="button" title="Open ${esc(d.label)}"><b>${esc(d.label)}</b><span class="status ${d.status}"><i></i>${esc(statusText(d, now))}</span><span class="r" data-src="devices.windows.tokens.total">${fmt(pw(d).tokens.total)}</span><span class="r">${pct(pw(d).shareOfWhole, 0)}</span></div>`).join("")}
          ${laneList(D.lanes.filter((l) => p.devices.includes(l.device.id)))}`;
      }
    } else if (inspect.kind === "project") {
      const x = projCache && projCache.projects.find((y) => y.name === inspect.id);
      const lanes = localLanes().filter((l) => l.project.name === inspect.id);
      const s = sparksBy(projectKey, lanes).get(inspect.id);
      title = inspect.id;
      if (!x) body = `<div class="iquiet">${projCache ? "This project has no transcripts in this period." : "Reading this machine…"}</div>` + laneList(lanes);
      else {
        const c = x.costPerOutcome;
        body = `<div class="ihero"><span class="big" data-src="projects.tokens">${fmt(x.tokens)}</span><span class="u">tokens · ${esc(cap)} · this machine</span>${demoStamp()}</div>
          <div class="iline">${x.repo ? `<b>${esc(x.repo.name)}</b> · ${plural(x.repo.commits, "commit")}` : "<b>not a Git repository</b>"}${x.branches && x.branches.length ? ` · ${x.branches.map(esc).join(", ")}` : ""}</div>
          ${ikv([[x.usd === null ? "unpriced" : money(x.usd), "est.", x.usd === null ? "warn" : "", "projects.usd"], [x.sessions === null ? "—" : String(x.sessions), "sessions", "", "projects.sessions"],
            [x.repo ? `+${fmt(x.repo.added)} <span class="u">−${fmt(x.repo.removed)}</span>` : "—", "lines", "", "projects.repo.added"], [x.repo && x.repo.prsMerged !== null ? String(x.repo.prsMerged) : "—", "PR-linked commits", "", "projects.repo.prsMerged"],
            [c.perCommitUsd === null ? "—" : money(c.perCommitUsd), "$ / commit · est.", "", "projects.costPerOutcome.perCommitUsd"], [c.perDefaultMergeUsd === null ? "—" : money(c.perDefaultMergeUsd), `$ / merge · est.${c.defaultMerges === null ? "" : " · " + c.defaultMerges}`, "", "projects.costPerOutcome.perDefaultMergeUsd"]])}
          <div class="ihead">Last hour <span>${s ? fmt(s.spark.reduce((a, b) => a + b, 0)) + " tokens" : "—"}</span></div>${isparkHtml(s, false)}
          ${laneList(lanes)}
          <div class="iquiet">Spend per outcome is spend in the window of the work, not attribution. Tokens measure usage, not value. None of this leaves this machine.</div>`;
      }
    }
    $("inspectTitle").textContent = title;
    $("inspectBody").innerHTML = body;
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
      groups.push(["Machines", D.devices.map((d) => ({ name: d.label + (d.person ? " · " + d.person : ""), run: () => openInspect("machine", d.id),
        note: d.status === "reporting" ? "reporting" : statusText(d, now), dot: d.status === "reporting" ? (D.hub.demo ? "sim" : "live") : d.status === "silent" ? "warn" : "" }))]);
      groups.push(["People", D.people.map((p) => ({ name: p.person, run: () => openInspect("person", p.person), note: `${p.reporting}/${p.devices.length} reporting` }))]);
      groups.push(["Lanes", D.lanes.filter((l) => laneVisible(l, now)).map((l) => ({ name: `${l.project.name}${l.branch ? " · " + l.branch : ""}`, run: () => focusLane(l.key),
        note: `${l.state} · ${l.modelLabel}`, dot: l.state === "live" ? (D.hub.demo ? "sim" : "live") : "" }))]);
      if (projCache) groups.push(["Projects", projCache.projects.map((x) => ({ name: x.name, run: () => openInspect("project", x.name), note: fmt(x.tokens) + " tokens" }))]);
    }
    const alerts = D ? (D.alerts || []).length : 0;
    groups.push(["Actions", [
      { name: "Add a machine", run: openAdd, note: D && D.hub.demo ? null : "join link", no: D && D.hub.demo ? "demo: no machine can join" : null },
      { name: paused ? "Resume motion" : "Pause motion", run: () => $("motionBtn").click(), note: "strip" },
      { name: showUnavailable ? "Hide unavailable" : "Show unavailable", run: () => $("voidBtn").click(), note: "strip" },
      { name: "Alerts", run: openAlerts, note: alerts ? plural(alerts, "alert") : null, no: alerts ? null : "no alert in the last hour" },
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
        html += `<div class="palr${it.no ? " no" : ""}" data-i="${i}" role="option" aria-selected="false"><i class="${it.dot || ""}"></i><b>${esc(it.name)}</b><span>${esc(it.no || it.note || "")}</span></div>`;
      }
    }
    palres.innerHTML = html || `<div class="palg">nothing matches</div>`;
    palSel = Math.min(palSel, Math.max(0, palRows.length - 1));
    palMark();
  }
  function palMark() {
    palres.querySelectorAll(".palr").forEach((r, i) => { r.classList.toggle("on", i === palSel); r.setAttribute("aria-selected", String(i === palSel)); });
    palres.querySelectorAll(".palr")[palSel]?.scrollIntoView({ block: "nearest" });
  }
  function palOpen(open) {
    if (open && !pal.open) { pal.showModal(); palq.value = ""; palSel = 0; palRender(); palq.focus(); }
    else if (!open && pal.open) pal.close();
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
    const keys = [...$("cLanes").querySelectorAll(".lane")].map((r) => [...laneRows.entries()].find(([, row]) => row === r)?.[0]).filter(Boolean);
    if (!keys.length) return;
    const i = keys.indexOf(laneFocus);
    const next = i < 0 ? (dir > 0 ? 0 : keys.length - 1) : Math.max(0, Math.min(keys.length - 1, i + dir));
    if (view !== "console") show("console");
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
      case "j": case "J": moveLane(1); break;
      case "k": case "K": moveLane(-1); break;
      case "Enter": if (!laneFocus) return; focusLane(laneFocus, true); break;
      case "t": case "T": $("themeBtn").click(); break;
      case "?": toast("Keys: <kbd>⌘K</kbd> anywhere · <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> views · <kbd>[</kbd> <kbd>]</kbd> period · <kbd>J</kbd> <kbd>K</kbd> lanes · <kbd>↵</kbd> context · <kbd>T</kbd> theme · <kbd>esc</kbd> back", true); break;
      case "Escape": for (const r of document.querySelectorAll(".lane.focused")) r.classList.remove("focused"); laneFocus = null; break;
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

  const initial = (location.hash || "").replace("#", "").split("/")[0];
  if (initial === "team" || initial === "projects") show(initial);
  poll().then(startLoop);
})();
