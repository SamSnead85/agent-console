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
  const target = { total: 0, spend: 0, msgs: 0, burn: 0 };
  const shown = { total: 0, spend: 0, msgs: 0, burn: 0 };
  let first = true;
  let chart = { key: null, vals: [], goal: [], max: 1, goalMax: 1 };

  const serverNow = () => (D ? D.now + (performance.now() - receivedAt) : Date.now());

  // ── polling ──────────────────────────────────────────────────────────
  async function poll() {
    clearTimeout(pollTimer);
    try {
      const response = await fetch("/api/console", { headers: HEADERS, cache: "no-store" });
      if (response.status === 401) { signedOut(); return; }
      if (!response.ok) throw new Error(String(response.status));
      document.body.classList.remove("signed-out");
      $("signedOut").hidden = true;
      D = await response.json();
      receivedAt = performance.now();
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

    paintHero();
    paintClasses();
    paintModels();
    paintLanes();
    paintAlerts();
    paintInterop();
    paintMachines();
    setChartGoal();
    paintWeek();
    if (view === "team") paintTeam();
    watchJoin();
    if (reducedMotion.matches || paused) { paintText(); drawChart(); }
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

  // ── hero ─────────────────────────────────────────────────────────────
  function paintHero() {
    const now = serverNow();
    $("heroWhen").textContent = new Date(now).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }) + " · " + hhmm(now);
    const live = D.lanes.filter((l) => l.state === "live").length;
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    const catching = D.devices.filter((d) => d.status === "catching-up").length;
    $("heroCounts").textContent = `${plural(currentDevices().length, "machine")} · ${reporting} reporting · ` +
      (catching ? `${catching} catching up · ` : "") + sessionWords() + ` · ${live} live`;
    $("heroScope").textContent = D.hub.demo ? "Demonstration team" : D.hub.listen.network ? "Hub · this network" : "Hub · this machine";
    $("liveDot").classList.toggle("on", reporting > 0);
  }

  function paintWeek() {
    const s = D.series["7d"];
    const W = 1000, H = 120;
    const max = Math.max(...s.values, 1);
    const n = s.values.length;
    const pts = s.values.map((v, i) => [(i / (n - 1)) * W, H - 2 - (v / max) * (H - 10)]);
    const line = smooth(pts);
    $("heroWeekLine").setAttribute("d", line);
    $("heroWeekArea").setAttribute("d", line + `L${W} ${H}L0 ${H}Z`);
  }

  // The summary for the chosen period; a 0.2 hub sends only the day.
  const win = () => (D.windows && D.windows[period]) || D.day;
  const pw = (x) => (x.windows && x.windows[period]) || x.day;
  function paintPeriod() {
    const [label, short] = PERIOD_TEXT[period];
    const w = win();
    const since = period === "30d" && w.partial && w.since ? " · daily totals kept since " + new Date(w.since + "T00:00:00Z").toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" }) : "";
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
    $("cClasses").innerHTML = order.map((k) =>
      `<span title="${esc(CLASS_LABEL[k])} — ${pct(sh[k], 2)} of all tokens${k === "cacheRead" ? `; ${pct(sh.cacheHitOnInput, 1)} of input tokens` : ""}${k === "cacheWrite" && t.cacheWrite5m !== undefined ? `; 5-minute ${fmt(t.cacheWrite5m)} · 1-hour ${fmt(t.cacheWrite1h)} · lifetime not reported ${fmt(t.cacheWriteUnknownTtl)}` : ""}${k === "fresh" ? "; input the cache did not serve" : ""}${w.unknown[k] ? `; ${w.unknown[k]} records did not report this class` : ""}"><i class="sw ${k}"></i><span>${CLASS_LABEL[k]}</span><b>${fmt(t[k])}</b><em class="pc">${pct(sh[k])}</em></span>`).join("");

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
        <span class="mn" title="${esc(m.model)}">${vendorMark(m.vendor)}${esc(m.label)}</span>
        <span class="mbar" aria-hidden="true"><i style="width:${Math.max(1, Math.round((m.tokens / max) * 100))}%"></i></span>
        <span class="mv">${pct(m.share, 0)}</span>
        ${m.usd === null ? `<span class="mc unp" title="No verified list price for ${esc(m.model)}; left out of the dollar figure">UNPRICED</span>` : `<span class="mc">${money(m.usd)}</span>`}
      </div>`).join("")
      : `<div class="mrow"><span class="mn">no model has reported yet</span></div>`;
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
        if (!row) {
          row = document.createElement("div");
          row.className = "lane";
          row.innerHTML = `<span class="st"><i></i><span></span></span><span class="pr"><b></b><em></em></span><span class="md"></span>
            <span class="sp" aria-hidden="true">${"<i></i>".repeat(20)}</span><span class="fm r"></span><span class="ag r"><button type="button" aria-label="Show agent tree" aria-expanded="false"></button></span><span class="cx"><button type="button" aria-label="Session context details"></button></span><span class="dv"></span>`;
          row._tree = document.createElement("div");
          row._tree.className = "agent-tree";
          row._tree.hidden = true;
          row.querySelector(".ag button").addEventListener("click", () => {
            row._tree.hidden = !row._tree.hidden;
            row.querySelector(".ag button").setAttribute("aria-expanded", String(!row._tree.hidden));
            if (!row._tree.hidden && matchMedia('(max-width: 760px)').matches) {
              row.closest('.lanes').scrollLeft = 0;
              box.scrollLeft = 0;
            }
          });
          row.querySelector(".cx button").addEventListener("click", () => {
            const current = D?.lanes.find((item) => item.key === l.key);
            if (current) showContext(current);
          });
          laneRows.set(l.key, row);
        }
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
    const unavailable = D.lanes.filter((l) => l.state === "silent" || l.state === "revoked").length;
    const catching = D.lanes.filter((l) => l.state === "catching-up" || l.state === "reconnecting").length;
    const parts = [sessionWords(), `${live} live`, `${idle} idle`];
    if (catching) parts.push(`${catching} on machines still catching up${showUnavailable ? "" : " (hidden)"}`);
    if (unavailable) parts.push(`${unavailable} on silent machines${showUnavailable ? "" : " (hidden)"}`);
    const tail = D.hub.demo ? "DEMO · every figure here is generated" : "figures are what each machine reported · costs are list-price estimates";
    $("lFoot").innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join("") + `<span class="end">${esc(tail)}</span>`;
  }

  function fillLane(row, l, now) {
    const demo = D.hub.demo;
    row.className = "lane " + l.state + (demo ? " sim" : "");
    const word = l.state === "live" ? (demo ? "DEMO" : "LIVE") : l.state === "idle" ? "IDLE" : l.state === "revoked" ? "REMOVED"
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
    const ag = row.querySelector(".ag");
    const agButton = ag.querySelector("button");
    agButton.textContent = l.agents.total ? `${l.agents.live}/${l.agents.total}` : "—";
    agButton.disabled = !l.agents.total;
    agButton.title = l.agents.total ? `${l.agents.live} subagents worked in the last five minutes, of ${l.agents.total} today. Open the agent tree.` : "No subagents";
    row._tree.innerHTML = (l.agentTree || []).map((agent, index) => `<div class="agent-node" style="--depth:${Math.min(agent.depth, 8)}"><span>${index === 0 ? 'Orchestrator' : '↳ Subagent'}</span><span class="agent-model">${vendorMark(vendorOf(agent.model))}${esc(agent.modelLabel)}</span><span>${agent.tokens == null ? 'Tokens unavailable' : fmt(agent.tokens) + ' tokens · 24 h'}</span><span>${observedSpan(agent.durationMinutes)}${agent.outcome === 'unknown' ? '' : ` · ${esc(agent.outcome)}`}</span></div>`).join('');
    const cx = row.querySelector(".cx");
    cx.classList.toggle("bloated", l.context?.status === "bloated");
    cx.querySelector("button").textContent = l.context?.latest === null || l.context?.latest === undefined
      ? "—" : fmt(l.context.latest) + (l.context.status === "bloated" ? " ↑" : "");
    cx.title = l.context?.latest === null ? "Context unavailable: input classes were not reported" : "Latest reported input tokens per API response. Open for history and cache signals.";
    const dv = row.querySelector(".dv");
    const who = l.device.person ? ` · ${esc(l.device.person)}` : "";
    dv.innerHTML = `<b>${esc(l.device.label)}</b>${who} · ` + (l.state === "catching-up" ? "catching up"
      : l.state === "reconnecting" ? "reconnecting"
      : l.state === "silent" || l.state === "revoked"
      ? `silent since ${hhmm(l.device.lastContactAt || l.lastAt)}`
      : l.state === "live" ? "now" : ago(l.lastAt + 60_000, now));
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

  function paintAlerts() {
    const alerts = (D.alerts || []).slice(0, 3);
    $("alertPanel").hidden = alerts.length === 0;
    const labels = { loop: "Repeated tool call", spike: "Burn spike", stall: "Spending without progress" };
    $("alertRows").innerHTML = alerts.map((a) => {
      const lane = (D.lanes || []).find((item) => item.key === a.laneHash?.slice(0, 16));
      const project = lane?.project?.name || (a.projectHash ? `project ${a.projectHash.slice(0, 6)}` : "Demo session");
      return `<div class="alert-row"><b>${labels[a.kind] || "Alert"} · ${esc(project)}</b>` +
      `<span>${a.kind === "loop" ? `Same tool and arguments ${fmt(a.tokens)} times` :
        a.kind === "spike" ? `${fmt(a.tokens)} tokens in one response, above this session's baseline` :
          `${fmt(a.tokens)} tokens since the last observed tool success`}</span><br><time>${hhmm(a.at)}${D.hub.demo ? " · DEMO" : ""}</time></div>`;
    }).join("");
  }

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
    $("machinesHint").textContent = D.devices.length
      ? `${reporting} of ${currentDevices().length} reporting · share of the last 24 hours`
      : "none yet";
    $("machines").innerHTML = rows.map((d) => `<div class="mach ${d.status}">
        <div class="n"><b>${esc(d.label)}</b><em>${esc(d.person || "")}</em>${d.local ? '<span class="here">THIS MACHINE</span>' : ""}</div>
        <div class="s ${d.status === "reporting" ? "ok" : ""}">${esc(statusText(d, now))}</div>
        <div class="row"><span class="v">${fmt(pw(d).tokens.total)}</span><span class="l">tokens · ${PERIOD_TEXT[period][1]}</span><span class="pc">${pct(pw(d).shareOfWhole)}</span></div>
        <div class="bar" aria-hidden="true"><i style="width:${Math.round((pw(d).shareOfWhole || 0) * 100)}%"></i></div>
      </div>`).join("");
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
    if (chart.key !== null && chart.key.split(":")[0] === period && chart.vals.length === goal.length) {
      // same window, the frame advanced by whole steps: shift what is on screen
      const shift = Math.round((s.start - Number(chart.key.split(":")[1])) / s.step);
      if (shift > 0) chart.vals = chart.vals.slice(shift).concat(goal.slice(-shift));
    } else {
      chart.vals = goal.slice();
      chart.max = Math.max(...goal, 1) * 1.12;
    }
    chart.key = key;
    chart.goal = goal;
    chart.goalMax = Math.max(...goal, 1) * 1.12;
    chart.series = s;
    // No travel without the loop: a paused or reduced-motion chart shows the reading as it is.
    if (paused || reducedMotion.matches) { chart.vals = goal.slice(); chart.max = chart.goalMax; }
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
    const pts = chart.vals.map((v, i) => {
      const t = s.start + (i + 0.5) * s.step;
      return [((t - left) / span) * W, H - 2 - (Math.max(0, v) / chart.max) * (H - 8)];
    });
    const lastX = Math.min(W, ((Math.min(now, s.start + s.step * chart.vals.length) - left) / span) * W);
    pts.push([lastX, pts[pts.length - 1][1]]);
    const line = smooth(pts);
    $("cLine").setAttribute("d", line);
    $("cArea").setAttribute("d", line + `L${lastX.toFixed(1)} ${H}L${pts[0][0].toFixed(1)} ${H}Z`);
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
    tip.innerHTML = period === "30d"
      ? `${new Date(from).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })} (UTC)${i === s.values.length - 1 ? " · so far" : ""} · <b>${fmt(s.values[i])}</b> tokens`
      : `${day}${hhmm(from)}–${until} · <b>${fmt(s.values[i])}</b> tokens`;
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
    $("cSpend").textContent = cost.status === "none" ? "no spend yet"
      : cost.status === "unpriced" ? "no priced model"
      : money(shown.spend) + (cost.status === "partial" ? " est. · partial" : " est.");
    $("cSpend").title = cost.status === "partial"
      ? `${fmt(cost.unpricedTokens)} tokens from ${cost.unpricedModels.join(", ")} have no verified list price and are not in this figure`
      : "Standard API list prices, applied on this machine. Not an invoice.";
    $("cMsgs").textContent = Math.round(shown.msgs).toLocaleString("en-US");
    const perMin = shown.burn;
    const excludedAll = D.devices.length > 0 && D.burn.reporting === 0;
    $("cBurn").innerHTML = excludedAll ? "—" : perSecond
      ? `${fmt(perMin / 60)}<span class="u">tok/s</span>` : `${fmt(perMin)}<span class="u">tok/min</span>`;
    const bc = D.burn.cost || { status: "estimated", unpricedModels: [] };
    const per = perSecond ? "/min" : "/hour";
    const dollars = D.burn.usdPerMinute === null
      ? "—" + per + " · unpriced"
      : money(D.burn.usdPerMinute * (perSecond ? 1 : 60)) + per + (bc.status === "partial" ? " est. · partial" : " est.");
    $("cRate").textContent = excludedAll ? "no machine reporting right now"
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
      chart.max += (chart.goalMax - chart.max) * k;
    }
    drawChart();
    textAcc += dt;
    if (textAcc >= 0.125) { textAcc = 0; paintText(); }
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
  $("voidBtn").addEventListener("click", (ev) => {
    showUnavailable = !showUnavailable;
    const b = ev.currentTarget;
    b.setAttribute("aria-pressed", String(showUnavailable));
    b.textContent = showUnavailable ? "Hide unavailable" : "Show unavailable";
    if (D) { paintLanes(); paintMachines(); paintClasses(); }
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
    const label = PERIOD_TEXT[period][1];
    $("teamTotals").innerHTML = [
      [fmt(total), "Tokens · " + label, "across " + plural(D.devices.length, "machine") + (current < D.devices.length ? `, ${D.devices.length - current} since removed` : "")],
      // Every model unpriced is "no priced model", never $0.00.
      [cost.status === "unpriced" ? "—" : cost.status === "none" ? money(0) : money(cost.usd), "Est. cost",
        cost.status === "unpriced" ? "no priced model" : cost.status === "partial" ? "partial — some models unpriced" : "list-price estimate"],
      [pct(total ? cr / total : null), "Cache read", "share of all tokens"],
      [pct(total ? cw / total : null), "Cache write", "share of all tokens"],
      // A session is a top-level session everywhere; outside the last 24 h the
      // count kept per period includes subagents, and says so.
      [msgs.toLocaleString("en-US"), "Messages", period === "24h" ? sessionWords()
        : whole.sessions === null ? "sessions not kept past the minute detail"
        : plural(whole.sessions, "session or subagent", "sessions and subagents")],
      [`${reporting}<span class="u">/ ${current}</span>`, "Machines reporting", plural(D.people.length, "person", "people") + (D.devices.some((d) => d.status === "catching-up") ? " · some still catching up" : "")],
    ].map(([v, l, s]) => `<div><div class="v">${v}</div><div class="l">${esc(l)}</div><div class="s">${esc(s)}</div></div>`).join("");

    $("peopleTable").tBodies[0].innerHTML = D.people.length ? D.people.map((p) => {
      const a = of(p);
      return `<tr><td><b>${esc(p.person)}</b><span class="sub">${p.reporting} of ${p.devices.length} reporting</span></td>
        <td class="num">${p.devices.map((id) => esc((D.devices.find((d) => d.id === id) || {}).label || "")).join(", ")}</td>
        <td class="num r">${fmt(a.tokens.total)}</td><td>${shareBar(a.shareOfWhole)}</td>
        <td class="num r">${pct(a.shares.cacheRead)}</td><td class="num r">${pct(a.shares.cacheWrite)}</td>
        <td>${modelSplit(a.models)}</td><td class="num r">${costCell(a.cost)}</td></tr>`;
    }).join("") : `<tr><td colspan="8">Nobody yet — add a machine.</td></tr>`;

    $("machineTable").tBodies[0].innerHTML = D.devices.length ? D.devices.map((d) => {
      const a = of(d);
      const action = d.local ? `<span class="sub">this machine</span>`
        : d.status === "revoked" ? `<span class="sub">removed</span>`
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

    $("invites").innerHTML = D.invitations.length ? D.invitations.map((i) => {
      const who = [i.person, i.machine].filter(Boolean).map(esc).join(" · ") || "Unnamed";
      const joined = i.state === "joined" ? D.devices.find((d) => d.id === i.deviceId) : null;
      return `<div class="invite"><span class="k ${i.state}">${i.state === "open" ? "Waiting" : "Joined"}</span>
        <span class="w">${who}${joined ? ` <em>→ ${esc(joined.label)}</em>` : ""}</span>
        <span class="t">${i.state === "open" ? "expires " + hhmm(i.expiresAt) : "joined " + hhmm(Date.parse(i.usedAt))}</span>
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
