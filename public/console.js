/*
 * The console screen.
 *
 * DATA. Everything on this page comes from /api/console, which the hub
 * computes from what machines actually reported (or, in demo mode, from a
 * synthetic fleet — and then every surface says DEMO). Nothing here invents a
 * figure: the page only formats, eases and draws what it was given.
 *
 * MOTION. One requestAnimationFrame loop drives every moving thing, and each
 * moves for a reason of its own, so nothing is in step with anything else:
 *   - the chart's time axis glides left with the real clock, and each point
 *     eases toward the value the hub reported for it;
 *   - the big figures ease toward the latest measured value (never beyond it);
 *   - a lane's spark changes only when that lane's own data does, and the
 *     machines report on their own jittered schedules.
 * Text redraws at most eight times a second. Pause motion stops the loop and
 * the polling — a held frame costs nothing and is what you want when somebody
 * asks what a number means. prefers-reduced-motion keeps every state change
 * and drops the travel.
 *
 * HONESTY. An unknown reading is drawn as a hatched void with its reason,
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
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TOOL = { "claude-code": "Claude Code", codex: "Codex" };
  const CLASS_LABEL = { cacheRead: "cache read", cacheWrite: "cache write", output: "output", fresh: "input" };
  const vendorMark = (vendor) => vendor
    ? `<svg aria-label="${vendor === "anthropic" ? "Anthropic" : "OpenAI"}" role="img"><use href="#mk-${vendor}"/></svg>`
    : `<i class="none" title="No vendor mark for this model"></i>`;

  // ── state ────────────────────────────────────────────────────────────
  let D = null;                 // the last payload
  let receivedAt = 0;           // performance.now() when it arrived
  let view = "console";
  let chartWindow = "24h";
  let perSecond = false;
  let paused = false;
  let showUnavailable = false;
  let teamPeriod = "day";
  let projPeriod = "24h";
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
    if (paused) return;
    try {
      const response = await fetch("/api/console", { headers: HEADERS, cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      D = await response.json();
      receivedAt = performance.now();
      offline = false;
      onData();
    } catch {
      if (!offline) toast("The console lost its connection to the hub. Retrying…");
      offline = true;
      document.body.classList.add("offline");
    } finally {
      if (!paused) pollTimer = setTimeout(poll, POLL_MS);
    }
  }

  function onData() {
    document.body.classList.remove("offline");
    document.body.dataset.demo = String(Boolean(D.hub.demo));
    $("ver").textContent = "v" + D.hub.version + (D.hub.demo ? " · demo" : "");
    const net = D.hub.listen.network;
    $("reach").classList.toggle("network", net);
    $("reachText").textContent = D.hub.demo ? "Synthetic fleet" : net ? "Accepting machines on this network" : "This machine only";
    $("reach").title = D.hub.demo ? "Demo mode: nothing is read and no machine can join."
      : net ? "Other machines can join at " + D.hub.urls.join(", ") + ". The console itself answers only here."
      : "Only this machine can reach this console. Start it with --listen 0.0.0.0 to add other computers.";
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    $("tabTeam").textContent = D.devices.length ? reporting + "/" + D.devices.length : "0";

    target.total = D.day.tokens.total;
    target.spend = D.day.cost.usd ?? 0;
    target.msgs = D.day.messages;
    target.burn = D.burn.tokensPerMinute;
    if (first || reducedMotion.matches) Object.assign(shown, target);
    first = false;

    paintHero();
    paintClasses();
    paintModels();
    paintLanes();
    paintMachines();
    setChartGoal();
    paintWeek();
    if (view === "team") paintTeam();
    watchJoin();
    if (reducedMotion.matches || paused) { paintText(); drawChart(); }
  }

  // ── hero ─────────────────────────────────────────────────────────────
  function paintHero() {
    const now = serverNow();
    $("heroWhen").textContent = new Date(now).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }) + " · " + hhmm(now);
    const live = D.lanes.filter((l) => l.state === "live").length;
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    const subagents = Math.max(0, D.day.sessions - D.laneCount);
    $("heroCounts").textContent = `${D.devices.length} machine${D.devices.length === 1 ? "" : "s"} · ${reporting} reporting · ` +
      `${D.laneCount} session${D.laneCount === 1 ? "" : "s"} today · ${live} live` + (subagents ? ` · ${subagents} subagent${subagents === 1 ? "" : "s"}` : "");
    $("heroScope").textContent = D.hub.demo ? "Demonstration fleet" : D.hub.listen.network ? "Hub · this network" : "Hub · this machine";
    $("liveDot").classList.toggle("on", reporting > 0 && !paused);
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

  // ── tokens · last 24 hours ──────────────────────────────────────────
  function paintClasses() {
    const t = D.day.tokens, sh = D.day.shares;
    const order = ["cacheRead", "cacheWrite", "output", "fresh"];
    $("cMix").innerHTML = t.total > 0
      ? order.map((k) => `<i class="${k}" style="flex-grow:${Math.max(t[k], 0)}" title="${CLASS_LABEL[k]} ${pct(sh[k])}"></i>`).join("")
      : "";
    $("cMix").setAttribute("aria-label", "Token composition: " + order.map((k) => `${CLASS_LABEL[k]} ${pct(sh[k])}`).join(", "));
    $("cClasses").innerHTML = order.map((k) =>
      `<span title="${esc(CLASS_LABEL[k])} — ${pct(sh[k], 2)} of all tokens${k === "cacheRead" ? `; ${pct(sh.cacheHitOnInput, 1)} of input tokens` : ""}${D.day.unknown[k] ? `; ${D.day.unknown[k]} messages did not report this class` : ""}"><i class="sw ${k}"></i><span>${CLASS_LABEL[k]}</span><b>${fmt(t[k])}</b><em class="pc">${pct(sh[k])}</em></span>`).join("");

    const silent = D.devices.filter((d) => d.status === "silent");
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    let prov;
    if (!D.devices.length) prov = "no machine has joined yet";
    else if (D.hub.demo) prov = `generated · ${D.devices.length} synthetic machines`;
    else prov = `reported by ${reporting} of ${D.devices.length} machine${D.devices.length === 1 ? "" : "s"}`;
    if (silent.length) prov += `<br><b>${esc(silent[0].label)} silent since ${hhmm(silent[0].lastContactAt)}</b>` + (silent.length > 1 ? ` and ${silent.length - 1} more` : "");
    const unknown = Math.max(...Object.values(D.day.unknown));
    if (unknown) prov += ` · ${unknown} message${unknown === 1 ? "" : "s"} missing a class — a floor, not a total`;
    $("cProv").innerHTML = prov;
    const flow = $("flowWrap");
    const empty = D.day.tokens.total === 0 && D.series["7d"].values.every((v) => v === 0);
    flow.classList.toggle("void", empty || (showUnavailable && D.devices.length === 0));
    $("voidReason").textContent = D.devices.length === 0
      ? "No machine is connected yet. Nothing is estimated in its place."
      : D.hub.local && D.hub.local.enabled && !D.hub.local.firstRunComplete
        ? "Reading this machine's transcripts for the first time…"
        : "No usage has been reported in the last seven days. Nothing is estimated in its place.";
  }

  // ── burn and models ───────────────────────────────────────────────────
  function paintModels() {
    const models = D.day.models.slice(0, 6);
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
      : `last ${D.burn.windowMinutes} min · ${reporting} of ${D.devices.length} machine${D.devices.length === 1 ? "" : "s"}` +
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
            <span class="sp" aria-hidden="true">${"<i></i>".repeat(20)}</span><span class="fm r"></span><span class="ag r"></span><span class="dv"></span>`;
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
      }
      for (const [key, row] of laneRows) if (!keep.has(key)) { row.remove(); laneRows.delete(key); }
    }
    const live = D.lanes.filter((l) => l.state === "live").length;
    const idle = D.lanes.filter((l) => l.state === "idle").length;
    const unavailable = D.lanes.filter((l) => l.state === "silent" || l.state === "revoked").length;
    const parts = [`${D.laneCount} session${D.laneCount === 1 ? "" : "s"} in 24 h`, `${live} live`, `${idle} idle`];
    if (unavailable) parts.push(`${unavailable} on silent machines${showUnavailable ? "" : " (hidden)"}`);
    const tail = D.hub.demo ? "DEMO · every figure here is generated" : "figures are what each machine reported · costs are list-price estimates";
    $("lFoot").innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join("") + `<span class="end">${esc(tail)}</span>`;
  }

  function fillLane(row, l, now) {
    const demo = D.hub.demo;
    row.className = "lane " + l.state + (demo ? " sim" : "");
    const word = l.state === "live" ? (demo ? "DEMO" : "LIVE") : l.state === "idle" ? "IDLE" : l.state === "revoked" ? "REMOVED" : "SILENT";
    row.querySelector(".st span").textContent = word;
    row.querySelector(".st").title = l.state === "live" ? "Reported within the last two minutes" + (demo ? " (generated)" : "")
      : l.state === "idle" ? "The machine is reporting; this session has not worked for a while"
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
    ag.textContent = l.agents.total ? `${l.agents.live}/${l.agents.total}` : "—";
    ag.title = l.agents.total ? `${l.agents.live} subagents worked in the last five minutes, of ${l.agents.total} today` : "No subagents";
    const dv = row.querySelector(".dv");
    const who = l.device.person ? ` · ${esc(l.device.person)}` : "";
    dv.innerHTML = `<b>${esc(l.device.label)}</b>${who} · ` + (l.state === "silent" || l.state === "revoked"
      ? `silent since ${hhmm(l.device.lastContactAt || l.lastAt)}`
      : l.state === "live" ? "now" : ago(l.lastAt + 60_000, now));
  }

  const vendorOf = (model) => /^claude-/.test(model) ? "anthropic" : /^(gpt-|codex-|o\d)/.test(model) ? "openai" : null;

  // ── machines on the console ─────────────────────────────────────────
  function statusText(d, now) {
    if (d.status === "reporting") return d.mode === "periodic" ? "Reporting hourly" : "Reporting · " + ago(d.lastContactAt, now);
    if (d.status === "silent") return `Silent since ${hhmm(d.lastContactAt)} · ${ago(d.lastContactAt, now)}`;
    if (d.status === "waiting") return "Joined — waiting for its first report";
    return "Removed " + (d.revokedAt ? hhmm(Date.parse(d.revokedAt)) : "");
  }
  function paintMachines() {
    const now = serverNow();
    const rows = D.devices.filter((d) => d.status !== "revoked" || showUnavailable);
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    $("machinesHint").textContent = D.devices.length
      ? `${reporting} of ${D.devices.length} reporting · share of the last 24 hours`
      : "none yet";
    $("machines").innerHTML = rows.map((d) => `<div class="mach ${d.status}">
        <div class="n"><b>${esc(d.label)}</b><em>${esc(d.person || "")}</em>${d.local ? '<span class="here">THIS MACHINE</span>' : ""}</div>
        <div class="s ${d.status === "reporting" ? "ok" : ""}">${esc(statusText(d, now))}</div>
        <div class="row"><span class="v">${fmt(d.day.tokens.total)}</span><span class="l">tokens · 24 h</span><span class="pc">${pct(d.day.shareOfWhole)}</span></div>
        <div class="bar" aria-hidden="true"><i style="width:${Math.round((d.day.shareOfWhole || 0) * 100)}%"></i></div>
      </div>`).join("");
  }

  // ── the chart ────────────────────────────────────────────────────────
  const W = 520, H = 100;
  function setChartGoal() {
    const s = D.series[chartWindow];
    const key = chartWindow + ":" + s.start;
    const goal = s.values.slice();
    // The newest step is still filling. Drawn raw it would dip at the right
    // edge every time; drawn as a rate over the part of it that has elapsed,
    // it says the same thing the other steps say.
    const elapsed = Math.max(0.25, Math.min(1, (D.now - (s.start + s.step * (goal.length - 1))) / s.step));
    goal[goal.length - 1] = goal[goal.length - 1] / elapsed;
    if (chart.key !== null && chart.key.split(":")[0] === chartWindow && chart.vals.length === goal.length) {
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
    const day = chartWindow === "7d" ? new Date(from).toLocaleDateString([], { weekday: "short" }) + " " : "";
    tip.innerHTML = `${day}${hhmm(from)}–${until} · <b>${fmt(s.values[i])}</b> tokens`;
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
    const empty = !D.devices.length && D.day.tokens.total === 0;
    $("cTotal").innerHTML = empty ? "—" : fmt(shown.total);
    const cost = D.day.cost;
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
    $("cRate").textContent = excludedAll ? "no machine reporting right now"
      : (perSecond ? fmt(perMin) + " per minute" : fmt(perMin / 60) + " per second") + " · " + money(D.burn.usdPerMinute * (perSecond ? 1 : 60)) + (perSecond ? "/min" : "/hour") + " est.";
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
    chartWindow = b.dataset.w;
    for (const x of $("winSeg").querySelectorAll("button")) { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); }
    $("axLeft").textContent = { "1h": "one hour ago", "24h": "24 hours ago", "7d": "seven days ago" }[chartWindow];
    chart.key = null;
    if (D) { setChartGoal(); drawChart(); }
  });
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
    document.body.classList.toggle("paused", paused);
    if (D) paintHero();
    if (!paused) { poll(); startLoop(); } else clearTimeout(pollTimer);
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
    teamPeriod = b.dataset.p;
    for (const x of $("periodSeg").querySelectorAll("button")) { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); }
    paintTeam();
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
    const P = teamPeriod;
    const whole = P === "day" ? D.day : null;
    const sum = (key) => D.devices.reduce((a, d) => a + d[P].tokens[key], 0);
    const total = sum("total");
    const cr = sum("cacheRead"), cw = sum("cacheWrite");
    const usd = D.devices.reduce((a, d) => a + (d[P].cost.usd || 0), 0);
    const partial = D.devices.some((d) => d[P].cost.status === "partial" || d[P].cost.status === "unpriced");
    const msgs = D.devices.reduce((a, d) => a + d[P].messages, 0);
    const reporting = D.devices.filter((d) => d.status === "reporting").length;
    const label = P === "day" ? "24 hours" : "7 days";
    $("teamTotals").innerHTML = [
      [fmt(total), "Tokens · " + label, `across ${D.devices.length} machine${D.devices.length === 1 ? "" : "s"}`],
      [money(usd), "Est. cost", partial ? "partial — some models unpriced" : "list-price estimate"],
      [pct(total ? cr / total : null), "Cache read", "share of all tokens"],
      [pct(total ? cw / total : null), "Cache write", "share of all tokens"],
      [msgs.toLocaleString("en-US"), "Messages", whole ? `${whole.sessions} sessions` : "reported events"],
      [`${reporting}<span class="u">/ ${D.devices.length}</span>`, "Machines reporting", D.people.length + " people"],
    ].map(([v, l, s]) => `<div><div class="v">${v}</div><div class="l">${esc(l)}</div><div class="s">${esc(s)}</div></div>`).join("");

    $("peopleTable").tBodies[0].innerHTML = D.people.length ? D.people.map((p) => {
      const a = p[P];
      return `<tr><td><b>${esc(p.person)}</b><span class="sub">${p.reporting} of ${p.devices.length} reporting</span></td>
        <td class="num">${p.devices.map((id) => esc((D.devices.find((d) => d.id === id) || {}).label || "")).join(", ")}</td>
        <td class="num r">${fmt(a.tokens.total)}</td><td>${shareBar(a.shareOfWhole)}</td>
        <td class="num r">${pct(a.shares.cacheRead)}</td><td class="num r">${pct(a.shares.cacheWrite)}</td>
        <td>${modelSplit(a.models)}</td><td class="num r">${costCell(a.cost)}</td></tr>`;
    }).join("") : `<tr><td colspan="8">Nobody yet — add a machine.</td></tr>`;

    $("machineTable").tBodies[0].innerHTML = D.devices.length ? D.devices.map((d) => {
      const a = d[P];
      const action = d.local ? `<span class="sub">this machine</span>`
        : d.status === "revoked" ? `<span class="sub">removed</span>`
        : `<button type="button" class="btn small danger" data-revoke="${esc(d.id)}" data-label="${esc(d.label)}">Remove</button>`;
      return `<tr><td><b>${esc(d.label)}</b><span class="sub">${d.local ? "the hub itself" : "joined " + new Date(d.createdAt).toLocaleDateString([], { day: "numeric", month: "short" }) + " · " + hhmm(Date.parse(d.createdAt)) + (d.joinedVia === "link" ? " by link" : "")}</span></td>
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
    projPeriod = b.dataset.p;
    for (const x of $("projSeg").querySelectorAll("button")) { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); }
    loadProjects();
  });
  async function loadProjects() {
    const body = $("projTable").tBodies[0];
    body.innerHTML = `<tr><td colspan="8">Reading this machine…</td></tr>`;
    try {
      const r = await fetch("/api/projects?period=" + projPeriod, { headers: HEADERS });
      const p = await r.json();
      if (!r.ok) throw new Error(p.reason || String(r.status));
      const t = p.totals;
      $("projTotals").innerHTML = [
        [fmt(p.tokens), "Tokens", p.demo ? "DEMO · generated" : "this machine's transcripts"],
        [String(p.projects.length), "Projects", `${p.withRepo} in a Git repository`],
        [t.commits.toLocaleString("en-US"), "Commits", "local Git history"],
        [`+${fmt(t.added)} <span class="u">−${fmt(t.removed)}</span>`, "Lines changed", "added / removed"],
        [t.prsMerged === null ? "—" : String(t.prsMerged), "PRs merged", t.prsMerged === null ? "not read — needs a Git remote" : "from merge commits"],
        [String(p.sessions), "Sessions", "Claude Code and Codex"],
      ].map(([v, l, s]) => `<div><div class="v">${v}</div><div class="l">${esc(l)}</div><div class="s">${esc(s)}</div></div>`).join("");
      body.innerHTML = p.projects.length ? p.projects.map((x) => `<tr>
        <td><b>${esc(x.name)}</b>${x.repo ? `<span class="sub">${esc(x.repo.name)}</span>` : `<span class="sub">not a Git repository</span>`}</td>
        <td class="num r">${fmt(x.tokens)}</td><td class="num r">${x.usd === null ? "—" : money(x.usd)}</td><td class="num r">${x.sessions}</td>
        <td class="num r">${x.repo ? x.repo.commits : "—"}</td>
        <td class="num r">${x.repo ? `+${x.repo.added.toLocaleString("en-US")} / −${x.repo.removed.toLocaleString("en-US")}` : "—"}</td>
        <td class="num r">${x.repo && x.repo.prsMerged !== null ? x.repo.prsMerged : "—"}</td>
        <td class="num">${esc((x.branches || []).slice(0, 3).join(", ") || "—")}</td></tr>`).join("")
        : `<tr><td colspan="8">No project on this machine has transcripts in this period.</td></tr>`;
      $("projNote").textContent = (p.demo ? "DEMO — synthetic projects and Git figures. " : "") +
        "Delivery evidence is what Git recorded, not a productivity score. Tokens measure usage, not value. None of this leaves this machine.";
    } catch (error) {
      body.innerHTML = `<tr><td colspan="8">This machine's projects could not be read: ${esc(error.message)}</td></tr>`;
    }
  }

  // ── add a machine ───────────────────────────────────────────────────
  const addDialog = $("addDialog");
  let pending = null;   // { id, link, npx }
  function step(name) {
    for (const s of addDialog.querySelectorAll(".step")) s.hidden = s.dataset.step !== name;
  }
  function openAdd() {
    step("form");
    $("addForm").reset();
    $("peopleList").innerHTML = (D ? D.people : []).map((p) => `<option value="${esc(p.person)}"></option>`).join("");
    $("loopbackWarn").hidden = !D || D.hub.listen.network || D.hub.demo;
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
    if (pending) { pending.link = null; pending.npx = null; }
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
      pending = { id: j.invitation.id, link: j.link, npx: j.npx };
      $("linkField").value = j.link;
      // The command is shown with the code masked; Copy puts the real one on the clipboard.
      $("cmdShown").textContent = j.npx.replace(j.code, "••••-••••");
      const who = [j.invitation.person, j.invitation.machine].filter(Boolean).join("'s ").replace(/'s$/, "") || "them";
      $("linkSay").innerHTML = j.demo
        ? "This is a demonstration console, so this link cannot actually be used. On a real console, the steps are exactly these."
        : j.network
          ? `Send the link to ${esc(who)} by any message. On their computer they open it and follow one step, or run the command below. They must be on the same network as this machine.`
          : `This console listens on this machine only, so the link works only here — for example for a second account on this computer. To add another computer, restart with <code>--listen 0.0.0.0</code>.`;
      $("linkExpiry").textContent = `Works once. Expires at ${hhmm(j.invitation.expiresAt)}.`;
      const status = $("joinStatus");
      status.className = "waiting";
      status.innerHTML = "<i></i>Waiting for the machine to join…";
      step("link");
      $("copyLink").focus();
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
  $("copyCmd").addEventListener("click", () => pending && pending.npx && copy(pending.npx, "Command copied."));
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
