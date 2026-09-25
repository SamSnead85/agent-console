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

  // ── state ────────────────────────────────────────────────────────────
  let D = null;                 // the last payload
  let receivedAt = 0;           // performance.now() when it arrived
  let view = "console";
  let period = "24h";
  let perSecond = false;
  let paused = false;
  let showUnavailable = false;
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
    $("scope").textContent = D.hub.demo ? "synthetic team" : D.hub.listen.network ? "hub · this network" : "hub · this machine";
    $("liveDot").classList.toggle("on", live > 0);
    $("liveCount").textContent = live ? plural(live, "live session") : "no live session";
    $("liveCap").title = live ? "Sessions that reported within the last two minutes" : "No session has reported in the last two minutes";
    $("machineCount").textContent = D.devices.length
      ? `${plural(currentDevices().length, "machine")} · ${reporting} reporting` + (catching ? ` · ${catching} catching up` : "")
      : "no machine has joined yet";
    $("machineCount").title = D.devices.length ? sessionWords() : "";
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
      $("clockDate").textContent = new Date(now).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
      const age = Math.max(0, Math.round((performance.now() - receivedAt) / 1000));
      $("scanNote").textContent = offline ? "connection lost · retrying" : `refreshed ${age}s ago · scan ${scanMs ?? "—"}ms`;
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
    let prov;
    if (!D.devices.length) prov = "no machine has joined yet";
    else if (D.hub.demo) prov = `generated · ${D.devices.length} synthetic machines`;
    else prov = `reported by ${reporting} of ${plural(current, "machine")}`;
    if (silent.length) prov += `<br><b>${esc(silent[0].label)} silent since ${hhmm(silent[0].lastContactAt)}</b>` + (silent.length > 1 ? ` and ${silent.length - 1} more` : "");
    const catching = D.devices.filter((d) => d.status === "catching-up");
    if (catching.length) prov += `<br><b>${esc(catching[0].label)} ${esc(catchUpText(catching[0]))}</b>` + (catching.length > 1 ? ` and ${catching.length - 1} more` : "") + " — incomplete until it has sent everything";
    const unknown = Math.max(...Object.values(w.unknown));
    if (unknown) prov += ` · ${unknown} record${unknown === 1 ? "" : "s"} missing a class — a floor, not a total`;
    // What could not be counted is said here, never left out quietly.
    const cov = D.coverage;
    if (cov && cov.dropped) prov += `<br><b title="${esc(cov.reasons.map((r) => r.count + " × " + r.label).join("; "))}">${cov.dropped.toLocaleString("en-US")} transcript record${cov.dropped === 1 ? "" : "s"} could not be counted</b> — ${esc(cov.reasons.slice(0, 2).map((r) => r.label).join(", "))}${cov.reasons.length > 2 ? " and more" : ""}`;
    $("cProv").innerHTML = prov;
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
  function paintModels() {
    const models = win().models.slice(0, 6);
    const max = Math.max(...models.map((m) => m.tokens), 1);
    $("cModels").innerHTML = models.length ? models.map((m) => `<div class="mrow">
        <span class="mn" title="${esc(m.model)}">${vendorMark(m.vendor)}<span class="txt">${esc(m.label)}</span></span>
        <span class="mbar" aria-hidden="true"><i style="width:${Math.max(1, Math.round((m.tokens / max) * 100))}%"></i></span>
        <span class="mv">${pct(m.share, 0)}</span>
        ${m.usd === null ? `<span class="mc unp" title="No verified list price for ${esc(m.model)}; left out of the dollar figure">UNPRICED</span>` : `<span class="mc">${money(m.usd)}</span>`}
      </div>`).join("")
      : `<div class="mrow"><span class="mn"><span class="none-text">no model has reported yet</span></span></div>`;
    const ex = D.burn.excluded;
    const reporting = D.burn.reporting;
    $("cBurnNote").innerHTML = D.devices.length === 0 ? "no machine yet"
      : `average of the last ${D.burn.windowMinutes} min · ${reporting} of ${plural(currentDevices().length, "machine")}` +
        (ex.length ? ` · <b>${esc(ex.map((d) => d.label).join(", "))} left out</b>` : "");
    $("cBurnNote").title = ex.length ? "Left out of the burn because what they are doing right now is unknown." : "";
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
    row.innerHTML = `<span class="st"><i></i><span></span></span><span class="pr"><b></b><em></em></span><span class="md"></span>
      <span class="sp" aria-hidden="true">${"<i></i>".repeat(20)}</span><span class="fm r"></span>
      <span class="nums"><span class="num in r" data-l="in"></span><span class="num out r" data-l="out"></span><span class="num tot r" data-l="24 h"></span><span class="num usd r" data-l="est."></span></span>
      <span class="ag r"><button type="button" aria-expanded="false"><span class="l">agents</span><span class="v"></span></button></span>
      <span class="cx r"><button type="button"><span class="l">context</span><span class="v"></span></button></span><span class="dv"></span><span class="la r"></span>`;
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

  function fillLane(row, l, now) {
    const demo = D.hub.demo;
    row.className = "lane " + l.state + (demo ? " sim" : "");
    // The state column says the state; DEMO is a stamp on the strip, the row's
    // cobalt edge and the footer, never a substitute for the state word.
    const word = l.state === "live" ? "LIVE" : l.state === "idle" ? "IDLE" : l.state === "revoked" ? "REMOVED"
      : l.state === "catching-up" ? "CATCHING UP" : l.state === "reconnecting" ? "RECONNECTING" : "SILENT";
    row.querySelector(".st span").textContent = word;
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
    const cls = l.tokensDayByClass || null;
    const numCell = (name, value, title) => {
      const el = row.querySelector(".num." + name);
      el.classList.toggle("void", value === null);
      el.textContent = value === null ? "—" : fmt(value);
      el.title = title;
    };
    numCell("in", cls ? cls.fresh : null, cls ? `${fmt(cls.fresh)} uncached input tokens today · cache read ${fmt(cls.cacheRead)} · cache write ${fmt(cls.cacheWrite)}` : "No reading: this hub does not split a lane's day by class");
    numCell("out", cls ? cls.output : null, cls ? `${fmt(cls.output)} output tokens today` : "No reading: this hub does not split a lane's day by class");
    numCell("tot", l.tokensDay ?? null, `${fmt(l.tokensDay)} tokens in the last 24 h, subagents included`);
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
    row._tree.innerHTML = (l.agentTree || []).map((agent, index) => `<div class="agent-node" style="--depth:${Math.min(agent.depth, 8)}"><span>${index === 0 ? 'Orchestrator' : '↳ Subagent'}</span><span class="agent-model">${vendorMark(vendorOf(agent.model))}${esc(agent.modelLabel)}</span><span>${agent.tokens == null ? 'Tokens unavailable' : fmt(agent.tokens) + ' tokens · 24 h'}</span><span>${observedSpan(agent.durationMinutes)} · ${agent.outcome === 'unknown' ? 'outcome unknown · no result recorded' : esc(agent.outcome)}</span></div>`).join('');
    const cx = row.querySelector(".cx");
    cx.classList.toggle("bloated", l.context?.status === "bloated");
    cx.querySelector("button .v").textContent = l.context?.latest === null || l.context?.latest === undefined
      ? "—" : fmt(l.context.latest) + (l.context.status === "bloated" ? " ↑" : "");
    cx.title = l.context?.latest === null ? "Context unavailable: input classes were not reported" : "Latest reported input tokens per API response. Open for history and cache signals.";
    cx.querySelector("button").setAttribute("aria-label", (l.context?.latest === null || l.context?.latest === undefined
      ? "Context unavailable" : `Context ${fmt(l.context.latest)}${l.context.status === "bloated" ? ", growing" : ""}`) + `, ${l.project.name}: details`);
    // The machine and its person may be cut short; the time never is — it has its own cell.
    const dv = row.querySelector(".dv");
    dv.innerHTML = `<b>${esc(l.device.label)}</b>${l.device.person ? ` · ${esc(l.device.person)}` : ""}`;
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
    $("contextDetails").innerHTML = `<p>${c?.latest == null ? "No complete input reading is available." :
      `Latest response carried <b>${fmt(c.latest)} input tokens</b>. ${c.growth == null ? "Growth needs two readings." :
        `That is ${c.growth.toFixed(1)}× the first retained reading.`} ${c.status === "bloated" ? "This session is flagged for context weight." : ""}`}</p>` +
      (samples.length ? `<p>Recent responses · input tokens</p><ol>${samples.map((s) => `<li>${hhmm(s.at)} · ${fmt(s.tokens)}</li>`).join("")}</ol>` : "") +
      `<p>Cache signals · ${breaks.length ? breaks.length + " recent" : "none in retained readings"}</p>` +
      (breaks.length ? `<ol>${breaks.map((b) => `<li>${hhmm(b.at)} · ${b.kind === "idle-gap" ?
        `idle gap past cache lifetime (${b.gapMinutes} min)` : b.kind === "lifetime-unknown" ?
          `cache lifetime unknown (${b.gapMinutes} min gap)` : "possible prefix rewrite"} · extra write cost ${b.estimatedExtraUsd == null ?
          "unpriced" : b.estimatedExtraUsd > 0 && b.estimatedExtraUsd < 0.005 ? "&lt; $0.01 est." : money(b.estimatedExtraUsd) + " est."}</li>`).join("")}</ol>` : "") +
      `<p>Signals are inferred from token counts and minute timestamps; they cannot prove the cause of a cache write. Extra cost compares observed writes with a hypothetical cache read at offline list prices (table v${esc(c?.priceTable?.version ?? "?")}, checked ${esc(c?.priceTable?.checkedOn ?? "unknown")}).</p>`;
    $("contextDialog").showModal();
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
    chip.innerHTML = `<span aria-hidden="true">▲</span> ${plural(all.length, "alert")}${D.hub.demo ? " · DEMO" : ""}`;
    chip.title = (D.hub.demo ? "Generated alerts. " : "Live alerts on this machine in the last hour. ") + "Open the panel.";
    const shown = alertsOpen ? all : all.slice(0, ALERT_SHOWN);
    $("alertShown").textContent = (shown.length < all.length ? `${shown.length} of ${all.length} shown · ` : "") + "this machine · last hour";
    const more = $("alertMore");
    more.hidden = all.length <= ALERT_SHOWN;
    more.textContent = alertsOpen ? "Show fewer" : `${all.length - ALERT_SHOWN} more`;
    $("alertRows").innerHTML = shown.map((a) => `<div class="alert-row"><span class="sev" aria-hidden="true">▲</span><b>${ALERT_LABEL[a.kind] || "Alert"}</b>` +
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
  }
  document.addEventListener("click", (ev) => {
    const go = ev.target.closest("[data-lane]"); if (!go) return;
    const row = laneRows.get(go.dataset.lane) || coldRows.get(go.dataset.lane);
    if (!row) return;
    row.scrollIntoView({ behavior: reducedMotion.matches || paused ? "auto" : "smooth", block: "center" });
    row.classList.add("focused");
    setTimeout(() => row.classList.remove("focused"), 2600);
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
    // Per model: its share of the money over its share of the tokens; an unpriced model is hatched and named.
    const models = w.models.slice(0, 5);
    const usdAll = w.cost.usd || 0;
    $("specModels").innerHTML = models.map((m) => `<div class="srow" title="${esc(m.model)}: ${pct(m.share)} of tokens · ${m.usd === null ? "unpriced" : money(m.usd) + (usdAll ? " · " + pct(m.usd / usdAll) + " of the estimate" : "")}">
        <span class="mn"><span class="txt">${esc(m.label)}</span></span>
        <span class="sbars${m.usd === null ? " unp" : ""}" aria-hidden="true"><i><b style="width:${m.usd === null ? 100 : Math.round((usdAll ? m.usd / usdAll : 0) * 100)}%"></b></i><i><b style="width:${Math.round(m.share * 100)}%"></b></i></span>
        ${m.usd === null ? `<span class="sc void">unpriced</span>` : `<span class="sc">${money(m.usd)}</span>`}
      </div>`).join("");
  }

  // ── burn: the last sixty minutes drawn ────────────────────────────────
  /* One bar per minute from the hour series, every machine; the newest minute
     is drawn as a rate over the part of it that has elapsed. The dashed rule
     is the median of the whole minutes. */
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
    const median = whole.length ? whole[Math.floor(whole.length / 2)] : 0;
    const max = Math.max(...vals, 1);
    const bw = W / n;
    const silentX = D.silentSince && D.silentSince > s.start ? ((D.silentSince - s.start) / (s.step * n)) * W : null;
    svg.innerHTML = vals.map((v, i) => {
      const h = v > 0 ? Math.max(1, (v / max) * (H - 2)) : 0.8;
      const dim = silentX !== null && i * bw >= silentX;
      return `<rect x="${(i * bw).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}"${i === n - 1 ? ' class="now"' : dim ? ' class="dim"' : ""}/>`;
    }).join("") + (median > 0 ? `<line x1="0" x2="${W}" y1="${(H - (median / max) * (H - 2)).toFixed(1)}" y2="${(H - (median / max) * (H - 2)).toFixed(1)}"/>` : "");
    $("burnMedian").innerHTML = median > 0 ? `median <b>${fmt(median)}</b>/min` : "no whole minute yet";
    $("burnMedian").title = "Median tokens per minute over the whole minutes of the last hour, every reporting machine";
    svg.setAttribute("aria-label", `Tokens per minute over the last 60 minutes; median ${fmt(median)} per minute`);
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
      : cold.length ? `<b>${cold.length}</b> ${cold.length === 1 ? "session" : "sessions"} idle for more than an hour or on an unavailable machine<span class="sep">·</span><b>${fmt(coldTokens)}</b> tokens today`
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
    const spend = t.commits > 0 && w.cost.usd !== null ? w.cost.usd / t.commits : null;
    $("effortSum").innerHTML = `${stamp}<b>${fmt(w.tokens.total)}</b> tokens<span class="sep">·</span><b>${w.cost.usd === null ? "—" : money(w.cost.usd)}</b> est.<span class="sep">·</span><b>${t.commits.toLocaleString("en-US")}</b> ${t.commits === 1 ? "commit" : "commits"} on this machine<span class="sep">·</span>${esc(label)}`;
    $("foldEffortBody").innerHTML = `<table class="grid"><thead><tr><th scope="col">Effort · ${esc(label)}</th><th scope="col" class="r">Every machine</th><th scope="col" class="r">This machine's Git</th></tr></thead><tbody>
      <tr><td>Tokens</td><td class="num r">${fmt(w.tokens.total)}</td><td class="num r">${fmt(p.tokens)}<span class="sub">this machine's transcripts</span></td></tr>
      <tr><td>Estimate</td><td class="num r">${w.cost.usd === null ? "—" : money(w.cost.usd) + (w.cost.status === "partial" ? " · partial" : "")}</td><td class="num r">${spend === null ? "—" : money(spend) + " per commit"}</td></tr>
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
    $("machinesHint").textContent = D.devices.length
      ? `${reporting} of ${currentDevices().length} reporting · share of the ${PERIOD_TEXT[period][0]}`
        + (goneShare > 0 ? ` · ${pct(goneShare)} from machines that left or were removed` : "")
      : "none yet";
    $("cMachineCap").textContent = "by machine · " + PERIOD_TEXT[period][1];
    // One row per machine: name, person, its state as a dot, tokens, share, estimate.
    // A machine that is not reporting says so on its own line, never as a zero.
    $("cMachines").innerHTML = rows.length ? rows.map((d) => {
      const a = pw(d);
      const off = d.status !== "reporting";
      return `<div class="xrow ${d.status}" title="${esc(statusText(d, now))}">
        <span class="xn"><i aria-hidden="true"></i><b>${esc(d.label)}</b>${d.person ? `<em>${esc(d.person)}</em>` : ""}${d.local ? '<span class="here">HERE</span>' : ""}</span>
        <span class="xp" title="${pct(a.shareOfWhole)} of the ${esc(PERIOD_TEXT[period][0])}">${pct(a.shareOfWhole, 0)}</span>
        <span class="xv" title="${fmt(a.tokens.total)} tokens · ${esc(PERIOD_TEXT[period][1])}">${fmt(a.tokens.total)}</span>
        ${a.cost.status === "none" ? `<span class="xc">—</span>` : a.cost.status === "unpriced" ? `<span class="xc void" title="No verified list price for what this machine ran">unpriced</span>` : `<span class="xc">${money(a.cost.usd)}${a.cost.status === "partial" ? "+" : ""}</span>`}
        ${off ? `<span class="xs">${esc(statusText(d, now))}</span>` : ""}
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
  $("alertChip").addEventListener("click", () => $("alertPanel").scrollIntoView({ behavior: reducedMotion.matches || paused ? "auto" : "smooth", block: "start" }));
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
    if (next === "team" && D) paintTeam();
    if (next === "projects") loadProjects();
    try { history.replaceState(null, "", next === "console" ? "/" : "#" + next); } catch { /* fine */ }
  }
  $("tabs").addEventListener("click", (ev) => { const t = ev.target.closest(".tab"); if (t) show(t.dataset.view); });
  document.addEventListener("click", (ev) => { const g = ev.target.closest("[data-go]"); if (g) show(g.dataset.go); });

  // ── team ─────────────────────────────────────────────────────────────
  $("periodSeg").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-p]"); if (!b) return;
    setPeriod(b.dataset.p);
  });
  const shareBar = (x) => `<span class="sharebar"><i><b style="width:${Math.round((x || 0) * 100)}%"></b></i><span>${pct(x)}</span></span>`;
  const modelSplit = (models) => models.length
    ? `<span class="models"><span class="split">${models.map((m) => `<i style="flex-grow:${m.tokens}" title="${esc(m.model)} ${pct(m.share)}"></i>`).join("")}</span>
       <span class="names">${models.slice(0, 3).map((m) => `<b>${esc(m.label)}</b> ${pct(m.share, 0)}`).join(" · ")}</span></span>`
    : `<span class="names">—</span>`;
  const costCell = (c) => c.status === "none" ? "—" : c.status === "unpriced" ? "unpriced" : money(c.usd) + (c.status === "partial" ? `<span class="sub">partial</span>` : "");
  /* On a phone a table becomes stacked rows, each cell under its own label:
     the label is the column's header, carried on the cell so CSS can draw it. */
  function labelCells(tableId) {
    const table = $(tableId);
    const heads = [...table.tHead.rows[0].cells].map((th) => th.textContent.trim());
    for (const row of table.tBodies[0].rows) [...row.cells].forEach((td, i) => { td.dataset.label = td.colSpan > 1 ? "" : heads[i] || ""; });
  }

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
    const current = currentDevices().length;
    const none = D.devices.length === 0;   // nothing has reported: unknown, never 0
    const label = PERIOD_TEXT[period][1];
    $("teamTotals").innerHTML = [
      [none ? "—" : fmt(total), "Tokens · " + label, none ? "no machine yet" : "across " + plural(D.devices.length, "machine") + (() => {
        const gone = D.devices.filter((d) => d.status === "revoked");
        const left = gone.filter((d) => d.leftAt).length, removed = gone.length - left;
        return [left ? `, ${left} since left` : "", removed ? `, ${removed} since removed` : ""].join("");
      })()],
      // Every model unpriced is "no priced model", never $0.00.
      [none || cost.status === "unpriced" ? "—" : cost.status === "none" ? money(0) : money(cost.usd), "Est. cost",
        none ? "no machine yet" : cost.status === "unpriced" ? "no priced model" : cost.status === "partial" ? "partial — some models unpriced" : "list-price estimate"],
      [pct(total ? cr / total : null), "Cache read", "share of all tokens"],
      [pct(total ? cw / total : null), "Cache write", "share of all tokens"],
      // A session is a top-level session everywhere; outside the last 24 h the
      // count kept per period includes subagents, and says so.
      [none ? "—" : msgs.toLocaleString("en-US"), "Messages", none ? "no machine yet" : period === "24h" ? sessionWords()
        : whole.sessions === null ? "sessions not kept past the minute detail"
        : plural(whole.sessions, "session or subagent", "sessions and subagents")],
      [`${reporting}<span class="u">/ ${current}</span>`, "Machines reporting", plural(D.people.length, "person", "people") + (D.devices.some((d) => d.status === "catching-up") ? " · some still catching up" : "")],
    ].map(([v, l, s]) => `<div><div class="v">${v}</div><div class="l">${esc(l)}</div><div class="s">${esc(s)}</div></div>`).join("");

    $("peopleTable").tBodies[0].innerHTML = D.people.length ? D.people.map((p) => {
      const a = of(p);
      return `<tr><td><b>${esc(p.person)}</b><span class="sub">${p.reporting} of ${p.devices.length} reporting</span></td>
        <td>${p.devices.map((id) => esc((D.devices.find((d) => d.id === id) || {}).label || "")).join(", ")}</td>
        <td class="num r">${fmt(a.tokens.total)}</td><td>${shareBar(a.shareOfWhole)}</td>
        <td class="num r">${pct(a.shares.cacheRead)}</td><td class="num r">${pct(a.shares.cacheWrite)}</td>
        <td>${modelSplit(a.models)}</td><td class="num r">${costCell(a.cost)}</td></tr>`;
    }).join("") : `<tr><td colspan="8">Nobody yet — add a machine.</td></tr>`;

    $("machineTable").tBodies[0].innerHTML = D.devices.length ? D.devices.map((d) => {
      const a = of(d);
      const action = d.local ? `<span class="sub">this machine</span>`
        : d.status === "revoked" ? `<span class="sub">${d.leftAt ? "left" : "removed"}</span>`
        : `<button type="button" class="btn small danger" data-revoke="${esc(d.id)}" data-label="${esc(d.label)}">Remove</button>`;
      // On its own line, so the machine column stays narrow enough for the row's action at 1440 wide.
      const lost = d.coverage && d.coverage.dropped ? `<span class="sub"><b title="${esc(d.coverage.reasons.map((r) => r.count + " × " + r.label).join("; "))}">${d.coverage.dropped} not counted</b></span>` : "";
      return `<tr><td><b>${esc(d.label)}</b><span class="sub">${d.local ? "the hub itself" : "joined " + new Date(d.createdAt).toLocaleDateString([], { day: "numeric", month: "short" }) + " · " + hhmm(Date.parse(d.createdAt)) + (d.joinedVia === "link" ? " by link" : "")}</span>${lost}</td>
        <td>${esc(d.person || "—")}</td>
        <td><span class="status ${d.status}"><i></i>${esc(statusText(d, now))}</span></td>
        <td class="num r">${fmt(a.tokens.total)}</td><td>${shareBar(a.shareOfWhole)}</td>
        <td class="num r">${pct(a.shares.cacheRead)}</td><td class="num r">${pct(a.shares.cacheWrite)}</td>
        <td>${modelSplit(a.models)}</td><td class="num r">${costCell(a.cost)}</td><td class="r">${action}</td></tr>`;
    }).join("") : `<tr><td colspan="10">No machine yet.</td></tr>`;
    labelCells("peopleTable");
    labelCells("machineTable");

    $("invites").innerHTML = D.invitations.length ? D.invitations.map((i) => {
      const who = [i.person, i.machine].filter(Boolean).map(esc).join(" · ") || "Unnamed";
      const joined = i.state === "joined" ? D.devices.find((d) => d.id === i.deviceId) : null;
      return `<div class="invite"><span class="k ${i.state}">${i.state === "open" ? "Waiting" : "Joined"}</span>
        <span class="w">${who}${joined ? ` <em>→ ${esc(joined.label)}</em>` : ""}</span>
        <span class="t">${i.state === "open" ? "expires " : "joined "}<b>${hhmm(i.state === "open" ? i.expiresAt : Date.parse(i.usedAt))}</b></span>
        ${i.state === "open" ? `<button type="button" class="btn small" data-cancel="${esc(i.id)}">Cancel link</button>` : "<span></span>"}</div>`;
    }).join("") : `<div class="none">No join links in the last seven days.</div>`;
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
  $("projSeg").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-p]"); if (!b) return;
    setPeriod(b.dataset.p);
  });
  async function loadProjects() {
    const body = $("projTable").tBodies[0];
    body.innerHTML = `<tr><td colspan="11">Reading this machine…</td></tr>`;
    try {
      const r = await fetch("/api/projects?period=" + period, { headers: HEADERS });
      const p = await r.json();
      if (!r.ok) throw new Error(p.reason || String(r.status));
      const t = p.totals;
      $("projTotals").innerHTML = [
        [fmt(p.tokens), "Tokens", p.demo ? "DEMO · generated" : "this machine's transcripts"],
        [String(p.projects.length), "Projects", `${p.withRepo} in a Git repository`],
        [t.commits.toLocaleString("en-US"), "Commits", p.author === true ? "yours, by this machine's Git email" : p.author === false ? "every author — no Git email set here" : "local Git history"],
        [`+${fmt(t.added)} <span class="u">−${fmt(t.removed)}</span>`, "Lines changed", "added / removed"],
        [t.prsMerged === null ? "—" : String(t.prsMerged), "Commits referencing #N", t.prsMerged === null ? "not read — needs a Git remote" : "subjects ending (#N) or merging a pull request"],
        [p.sessions === null ? "—" : String(p.sessions), "Sessions", p.sessions === null ? "not kept past the minute detail" : "Claude Code and Codex"],
      ].map(([v, l, s]) => `<div><div class="v">${v}</div><div class="l">${esc(l)}</div><div class="s">${esc(s)}</div></div>`).join("");
      body.innerHTML = p.projects.length ? p.projects.map((x) => `<tr>
        <td><b>${esc(x.name)}</b>${x.repo ? `<span class="sub">${esc(x.repo.name)}</span>` : `<span class="sub">not a Git repository</span>`}</td>
        <td class="num r">${fmt(x.tokens)}</td><td class="num r">${x.usd === null ? "—" : money(x.usd)}</td><td class="num r">${x.sessions === null ? "—" : x.sessions}</td>
        <td class="num r">${x.repo ? x.repo.commits : "—"}</td>
        <td class="num r">${x.repo ? `+${x.repo.added.toLocaleString("en-US")} / −${x.repo.removed.toLocaleString("en-US")}` : "—"}</td>
        <td class="num r">${x.repo && x.repo.prsMerged !== null ? x.repo.prsMerged : "—"}</td>
        <td class="num r">${x.costPerOutcome.defaultMerges === null ? "—" : x.costPerOutcome.defaultMerges}</td>
        <td class="num r" title="Spend in the work window per local commit, not attribution">${x.costPerOutcome.perCommitUsd === null ? "—" : money(x.costPerOutcome.perCommitUsd) + " est."}</td>
        <td class="num r" title="Spend in the work window per local default-branch integration, not attribution">${x.costPerOutcome.perDefaultMergeUsd === null ? "—" : money(x.costPerOutcome.perDefaultMergeUsd) + " est."}</td>
        <td class="num">${esc((x.branches || []).slice(0, 3).join(", ") || "—")}</td></tr>`).join("")
        : `<tr><td colspan="11">No project on this machine has transcripts in this period.</td></tr>`;
      labelCells("projTable");
      $("projNote").textContent = (p.demo ? "DEMO — synthetic projects and Git figures. " : "") +
        (p.author === true ? "Git figures count only commits authored with this machine's Git email (user.email). " : p.author === false ? "No Git email (user.email) is set in one of these repositories, so its Git figures count every author. " : "") +
        "A commit referencing #N is a subject ending (#N) or a pull-request merge; it may name an issue rather than a merged pull request. " +
        "Spend per outcome is spend in the window of the work, not attribution. This is not a productivity score. Tokens measure usage, not value. Default merges count local default-branch integration commits. A dash means no eligible count, verified price or local default-branch ref. None of this leaves this machine.";
    } catch (error) {
      body.innerHTML = `<tr><td colspan="11">This machine's projects could not be read: ${esc(error.message)}</td></tr>`;
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
    addDialog.showModal();
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
  function toast(message) {
    const t = $("toast");
    t.textContent = message;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 4200);
  }
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); });
    for (const c of d.querySelectorAll("[data-close]")) if (d.id !== "addDialog") c.addEventListener("click", () => d.close());
  }

  const initial = (location.hash || "").replace("#", "");
  if (initial === "team" || initial === "projects") show(initial);
  poll().then(startLoop);
})();
