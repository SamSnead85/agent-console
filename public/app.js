/*
 * AGENT CONSOLE — client.
 *
 * No framework or bundler. Browser requests stay on this loopback origin; the
 * server may perform read-only coordination refresh against configured origins.
 * Known credential forms are redacted before the payload reaches this client.
 */

"use strict";

const $ = (id) => document.getElementById(id);

const RAMP = [
  { key: "cr", css: "var(--m-cr)", label: "cache read", dark: true },
  { key: "in", css: "var(--m-in)", label: "input", dark: true },
  { key: "cw", css: "var(--m-cw)", label: "cache write", dark: false },
  { key: "out", css: "var(--m-out)", label: "output", dark: false },
];

const CONSOLE_HEADERS = Object.freeze({ "X-Agent-Console": "1" });

const state = {
  data: null,
  history: null,
  snapshotNow: null,
  period: load("period", "24h"),
  // The project the headline totals are scoped to, or "all". Persisted like the
  // period; a slug that no longer exists simply matches no bucket and the panel
  // reads zero for it, which is the truth rather than an error.
  project: load("project", "all"),
  projects: [],
  glossary: null,
  // Burn-rate display unit. tok/min is the native measurement (the series is
  // one-minute buckets); tok/s is the same measurement divided by 60 for
  // display. Persisted like the period; a stored garbage value falls back.
  burnUnit: FleetUnits.sanitizeBurnUnit(load("burnUnit", "min")),
  cursor: 0,
  expanded: new Set(),
  filter: "",
  filtering: false,
  showCold: load("showCold", false),
  drawers: {
    projects: load("drawer.projects", false),
    effort: load("drawer.effort", false),
    procs: load("drawer.procs", false),
    ship: load("drawer.ship", false),
    fleet: load("drawer.fleet", false),
  },
  // Pointer over the roster, or keyboard focus in it. Either one holds the ROW
  // ORDER still; neither one stops the rest of the page updating.
  hover: false,
  focused: false,
  heldOrder: null,
  previous: new Map(),
  pollMs: 10000,
};

/** True while the roster's order is pinned. */
function orderHeld() {
  return state.hover || state.focused;
}

/**
 * How many roster columns are actually rendered right now.
 *
 * The narrow-window rules drop whole columns with `display: none`, which
 * removes those <th>s from the table. A hardcoded colspan larger than the
 * remaining count then invents phantom columns, and under `table-layout: fixed`
 * the leftover width is split between the one flexible column and the phantoms:
 * expanding an agent tree collapsed the `doing` cell from 343px to 69px for
 * every row in the table.
 */
function columnCount() {
  const head = $("rosterhead");
  if (!head || !head.rows.length) return 15;
  let n = 0;
  for (const th of head.rows[0].cells) if (th.offsetWidth > 0) n += 1;
  return Math.max(1, n);
}

function load(key, fallback) {
  try {
    const current = localStorage.getItem("agent.console." + key);
    // One-way compatibility with the original internal console. The next save
    // writes only the public Muster namespace.
    const raw = current ?? localStorage.getItem("muster.console." + key) ??
      localStorage.getItem("fleet." + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem("agent.console." + key, JSON.stringify(value));
  } catch {
    /* private window, or site data blocked — the panel still works */
  }
}

// ------------------------------------------------------------------ format

function tokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(Math.round(v));
}

/** Bytes read on this pass — the incremental figure, not the file size. */
function bytes(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "GB";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "MB";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "kB";
  return v + "B";
}

function usd(n) {
  if (n === null || n === undefined) return "—";
  return "$" + Number(n).toFixed(2);
}

function ago(t) {
  if (!t) return "—";
  const snapshotNow = Number(state.snapshotNow);
  const reference =
    Number.isFinite(snapshotNow) && snapshotNow > 0
      ? snapshotNow
      : Date.now();
  const s = Math.max(0, Math.floor((reference - t) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400)
    return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
  return Math.floor(s / 86400) + "d";
}

function esc(value) {
  return String(value === null || value === undefined ? "" : value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/** The server's redaction marks are shown, not hidden — they are the point. */
function escRedact(value) {
  return esc(value).replace(
    /‹redacted [^›]*›/g,
    (m) => '<span class="redacted">' + m + "</span>",
  );
}

function shortModel(m) {
  return String(m).replace(/^claude-/, "");
}

// ---------------------------------------------------------------- glossary

/**
 * Nothing on this screen may be unexplained.
 *
 * Two affordances, one source. Every element carrying `data-term` gets the
 * definition as a hover title AND becomes a target that opens the reference at
 * that entry — so the answer is available without leaving the number, and the
 * full derivation is one click away. The text is served by the server, built
 * against the constants that enforce each threshold, so the page never states a
 * number the code does not actually use.
 */
function glossaryEntry(id) {
  if (!state.glossary) return null;
  return state.glossary.entries.find((e) => e.id === id) || null;
}

function wireTerms() {
  for (const el of document.querySelectorAll("[data-term]")) {
    const entry = glossaryEntry(el.dataset.term);
    el.classList.add("term");
    if (!entry) continue;
    // Hover carries the short definition. The body — thresholds, worked
    // examples, the caveats — is in the reference, one click away.
    el.title =
      entry.term + " — " + entry.short + "\n\n(click for the full definition)";
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
  }
}

function renderGlossary(d) {
  if (!d.glossary) return;
  const same =
    state.glossary &&
    state.glossary.entries.length === d.glossary.entries.length &&
    state.glossary.entries[0].short === d.glossary.entries[0].short;
  state.glossary = d.glossary;
  if (same) return;
  const kinds = d.glossary.kinds || {};
  $("glossarybody").innerHTML =
    '<div class="gnote">' +
    esc(d.glossary.note) +
    "</div>" +
    d.glossary.entries
      .map(
        (e) =>
          '<div class="gentry" id="g-' +
          esc(e.id) +
          '"><div class="ghead"><b>' +
          esc(e.term) +
          '</b><span class="gkind k-' +
          esc(e.kind) +
          '" title="' +
          esc(kinds[e.kind] || "") +
          '">' +
          esc(e.kind) +
          '</span></div><div class="gshort">' +
          escRedact(e.short) +
          '</div><div class="gbody">' +
          escRedact(e.body).replace(/\n/g, "<br>") +
          "</div></div>",
      )
      .join("");
  wireTerms();
}

function openGlossary(id) {
  const dialog = $("helpdialog");
  showTab("terms");
  if (!dialog.open) dialog.showModal();
  if (!id) return;
  const target = $("g-" + id);
  if (!target) return;
  target.classList.add("hit");
  target.scrollIntoView({ block: "center" });
  setTimeout(() => target.classList.remove("hit"), 2000);
}

function showTab(name) {
  $("glossarybody").hidden = name !== "terms";
  $("helpbody").hidden = name !== "keys";
  for (const button of document.querySelectorAll(".dtab")) {
    button.classList.toggle("on", button.dataset.tab === name);
  }
}

// --------------------------------------------------------- progress strip

/**
 * The sparkline behind the percentage.
 *
 * Drawn in the same hand-rolled step-SVG language as the burn band and the
 * history chart — no library, no request off this origin. The y-axis is pinned
 * to 0–100 rather than fitted to the data, because a fitted axis turns a
 * two-point 79→80 into a dramatic climb, which is the opposite of what an
 * honest trend line is for.
 */
function progressSparkline(trend) {
  const w = 320;
  const hgt = 40;
  const pts = (trend && trend.points) || [];
  const y = (v) =>
    hgt - (Math.max(0, Math.min(100, v)) / 100) * (hgt - 3) - 1.5;
  if (pts.length === 1) {
    // One observation is a level, not a trend, and it is drawn as one.
    const only = y(pts[0].percent).toFixed(2);
    return (
      '<line x1="0" x2="' +
      w +
      '" y1="' +
      only +
      '" y2="' +
      only +
      '" stroke="var(--sig)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"></line>'
    );
  }
  if (pts.length < 2) return "";

  const step = w / (pts.length - 1);
  let line = "";
  pts.forEach((point, i) => {
    line +=
      (i === 0 ? "M " : " L ") +
      (i * step).toFixed(2) +
      " " +
      y(point.percent).toFixed(2);
  });
  const area = line + " L " + w.toFixed(2) + " " + hgt + " L 0 " + hgt + " Z";
  // A fall is drawn in the warning hue. A setback the operator has to squint
  // to notice is a setback the strip failed to report.
  const stroke = trend.tone === "down" ? "var(--st-warn)" : "var(--sig)";
  let path =
    '<path d="' +
    area +
    '" fill="' +
    stroke +
    '" fill-opacity="0.14"></path><path d="' +
    line +
    '" fill="none" stroke="' +
    stroke +
    '" stroke-width="1.25" vector-effect="non-scaling-stroke"></path>';
  if (trend.regressed && trend.peakPercent !== null) {
    const peakY = y(trend.peakPercent).toFixed(2);
    path +=
      '<line x1="0" x2="' +
      w +
      '" y1="' +
      peakY +
      '" y2="' +
      peakY +
      '" stroke="var(--st-warn)" stroke-width="1" stroke-dasharray="2 4" opacity="0.7" vector-effect="non-scaling-stroke"></line>';
  }
  return path;
}

/**
 * The full-width project-progress strip.
 *
 * Every decision about WHAT to say lives in public/progressview.js, which the
 * node suite imports directly; this function only turns that reading into
 * pixels. In particular the refusal — an absent or malformed record draws
 * nothing at all rather than a fabricated 0% — is made there and merely obeyed
 * here.
 */
function renderProgressTrend(d) {
  const strip = $("pstrip");
  const view = FleetProgress.progressView(d && d.progress, { now: Date.now() });
  if (!view.visible) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;

  // Keep the primary completion figure and its bar immediately scannable. The
  // glossary carries provenance without repeating it on every refresh.
  $("pspct").textContent = view.percentText;

  const bar = $("psbar");
  bar.setAttribute("aria-valuenow", String(view.percent));
  bar.setAttribute("aria-valuetext", view.percentText);
  $("psfill").style.width = (view.barFraction * 100).toFixed(2) + "%";

  // The peak marker only exists when the number has actually fallen. It is the
  // setback made visible on the bar itself, not only in the sparkline. The
  // tooltip states the fall and nothing else.
  const peak = $("pspeak");
  const trend = view.trend;
  if (trend && trend.regressed && trend.peakPercent !== null) {
    peak.hidden = false;
    peak.style.left = Math.max(0, Math.min(100, trend.peakPercent)) + "%";
    peak.title =
      "Peak of " +
      trend.peakPercent +
      "% · down " +
      Math.round(trend.regressedBy * 10) / 10 +
      " pts since";
  } else {
    peak.hidden = true;
  }

  // The summary, with the staleness warning ahead of it. Staleness is a
  // property of the progress record and of nothing else here: the trend beneath
  // it and the counters beside it are as current as the last scan either way.
  // It stays — "this number is 47 minutes old" is news, not a hedge.
  $("pssummary").innerHTML =
    (view.stale
      ? '<span class="warn" title="The orchestrator writes this file every merge round; a quiet half hour means this figure is history, not status.">▲ ' +
        esc(view.staleNote) +
        "</span> · "
      : "") +
    escRedact(view.summary) +
    (trend && trend.regressedText
      ? ' <span class="warn">· ' + esc(trend.regressedText) + "</span>"
      : "");
  $("pssummary").title =
    (view.stale ? view.staleNote + "\n\n" : "") + view.summary;

  $("progresssvg").innerHTML = progressSparkline(trend);
  const delta = $("psdelta");
  if (trend) {
    delta.textContent = trend.deltaText;
    delta.className = "psdelta " + trend.tone;
    delta.title =
      trend.count > 1
        ? (trend.delta >= 0 ? "Up " : "Down ") +
          Math.abs(Math.round(trend.delta * 10) / 10) +
          " points across " +
          trend.count +
          " observations.\n\n" +
          trend.note
        : trend.note;
  } else {
    delta.textContent = "no trend recorded yet";
    delta.className = "psdelta";
    delta.title = "";
  }

  // The git counters. They carry no MEASURED badge any more: that badge only
  // ever meant something in CONTRAST with the DECLARED one on the percentage,
  // and with that gone every number on this strip is measured. A label with no
  // alternative distinguishes nothing. The provenance is still in the glossary,
  // behind the strip's own label, where it costs no pixels.
  const code = (state.history && state.history.code) || null;
  const ct = (code && code.totals) || null;
  $("psmeasured").innerHTML = ct
    ? "<b>" +
      (ct.prsMerged || 0) +
      "</b> PRs merged · <b>" +
      (ct.commits || 0) +
      "</b> commits<br /><b>+" +
      (ct.added || 0).toLocaleString() +
      "</b>/<b>−" +
      (ct.removed || 0).toLocaleString() +
      '</b> lines <span class="dim">· ' +
      esc(
        (state.history && state.history.period && state.history.period.label) ||
          "",
      ) +
      "</span>"
    : '<span class="dim">git figures load with the history panel</span>';
}

// ------------------------------------------------------------------ master

function renderMaster(d) {
  const m = d.master;
  const el = $("master");
  el.className = "s-" + m.word;
  el.querySelector(".glyph").textContent = m.glyph;
  $("masterword").textContent = m.word;
  const cause = $("mastercause");
  cause.textContent = m.cause || "";
  // The one line the operator is meant to read from across a desk. It is also
  // the line most likely to be wider than its column, so the full text is
  // always available on hover rather than only when the window is wide.
  cause.title = m.cause || "";
  // Fleet size belongs in the headline and includes declared remote sessions,
  // not only sessions observable from this disk.
  const r = d.roster;
  $("mastertotals").innerHTML =
    '<span class="rostercount" data-term="roster">' +
    esc(r.headline) +
    "</span> · <b>" +
    esc(usd(d.header.costTotal)) +
    "</b> est today · <b>" +
    d.header.liveCount +
    "</b> live";
  const totals = $("mastertotals");
  const countEl = totals.querySelector(".rostercount");
  if (countEl)
    countEl.title = r.derivation + "\n\n(click for the full definition)";

  const chips = (m.secondary || []).map(
    (s) => '<span class="chip">' + esc(s) + "</span>",
  );
  // Idle capacity gets a chip of its own, in the warning hue, because it is the
  // condition with no motion to catch the eye.
  const deadheads = d.rows.filter((row) => row.deadhead);
  if (deadheads.length) {
    chips.unshift(
      '<span class="chip warn" title="' +
        esc(
          deadheads
            .map((row) => row.project + " — " + row.deadheadReason)
            .join("\n"),
        ) +
        '" data-term="DEADHEAD">◻ ' +
        deadheads.length +
        " deadhead" +
        (deadheads.length === 1 ? "" : "s") +
        "</span>",
    );
  }
  if (r.counts.sessions > r.counts.observed) {
    chips.push(
      '<span class="chip quiet">' +
        (r.counts.observed + " measured · " +
          (r.counts.sessions - r.counts.observed) + " remote") +
        "</span>",
    );
  }
  $("masterchips").innerHTML = chips.join("");
}

// ---------------------------------------------------------------- spectrum

function renderSpectrum(d) {
  const cost = d.header.cost;
  const tok = d.header.tokens;
  const costTotal = d.header.costTotal || 0;
  const tokTotal = d.header.total || 0;

  const costPct = (k) => (costTotal > 0 ? (100 * cost[k]) / costTotal : 0);
  const tokPct = (k) => (tokTotal > 0 ? (100 * tok[k]) / tokTotal : 0);

  $("spectrumtotal").textContent =
    usd(costTotal) + " est · " + tokens(tokTotal) + " tokens · " + d.meta.day;

  const barWidth = $("barA").clientWidth || 600;
  const wideEnough = (pct) => (pct / 100) * barWidth > 128;
  $("barA").innerHTML = RAMP.map((r) => {
    const pct = costPct(r.key);
    const wide = wideEnough(pct);
    return (
      '<div class="seg' +
      (r.dark ? " dark" : "") +
      '" style="width:' +
      pct.toFixed(3) +
      "%;background:" +
      r.css +
      '">' +
      (wide
        ? "<span>" +
          esc(r.label) +
          " · " +
          esc(usd(cost[r.key])) +
          " · " +
          pct.toFixed(1) +
          "%</span>"
        : "") +
      "</div>"
    );
  }).join("");

  $("barB").innerHTML = RAMP.map(
    (r) =>
      '<div class="seg" style="width:' +
      tokPct(r.key).toFixed(3) +
      "%;background:" +
      r.css +
      ';opacity:.85"></div>',
  ).join("");

  // Ribbons: the transform from token share to cost share, drawn as the shape
  // it is. Cache reads are most of the tokens and a minority of the dollars.
  let a = 0;
  let b = 0;
  const parts = [];
  for (const r of RAMP) {
    const aw = (costPct(r.key) / 100) * 1000;
    const bw = (tokPct(r.key) / 100) * 1000;
    parts.push(
      '<polygon points="' +
        a.toFixed(2) +
        ",0 " +
        (a + aw).toFixed(2) +
        ",0 " +
        (b + bw).toFixed(2) +
        ",20 " +
        b.toFixed(2) +
        ',20" fill="' +
        r.css +
        '" opacity="0.30"></polygon>',
    );
    a += aw;
    b += bw;
  }
  $("ribbons").innerHTML = parts.join("");

  // Only the classes too narrow to carry their own label inline appear here,
  // so the legend is a leader line for the slivers rather than a repeat.
  $("legend").innerHTML = RAMP.filter((r) => !wideEnough(costPct(r.key)))
    .map(
      (r) =>
        '<span><i style="background:' +
        r.css +
        '"></i>' +
        esc(r.label) +
        " · " +
        esc(usd(cost[r.key])) +
        " · " +
        tokens(tok[r.key]) +
        " · " +
        tokPct(r.key).toFixed(1) +
        "%</span>",
    )
    .join("");

  const widest = Math.max(1, ...d.header.models.map((m) => m.cost || 0));
  // An unpriced model sorts last (cost null) and the list is capped, so with
  // three or more priced models the word "unpriced" never rendered at all.
  // Unpriced models are pulled to the front of what is shown, and whatever is
  // still cut is counted rather than dropped in silence.
  const ordered = d.header.models
    .slice()
    .sort(
      (a, b) =>
        (a.cost === null ? 0 : 1) - (b.cost === null ? 0 : 1) ||
        (b.cost || 0) - (a.cost || 0) ||
        b.total - a.total,
    );
  const SHOWN = 3;
  const hidden = ordered.slice(SHOWN);
  const rows = ordered
    .slice(0, SHOWN)
    .map((m) => {
      const bar = m.costSplit
        ? RAMP.map(
            (r) =>
              '<div style="width:' +
              ((100 * m.costSplit[r.key]) / widest).toFixed(3) +
              "%;background:" +
              r.css +
              '"></div>',
          ).join("")
        : "";
      return (
        '<div class="modelrow"><span>' +
        esc(shortModel(m.model)) +
        '</span><span class="modelbar' +
        (m.costSplit ? "" : " hatch") +
        '">' +
        bar +
        '</span><span class="num">' +
        (m.cost === null ? "unpriced" : esc(usd(m.cost))) +
        "</span></div>"
      );
    })
    .join("");

  // Hatch means "instrument not available" and is deliberately a different
  // thing from zero: Codex tokens are exact but unpriced, and a machine with no
  // ~/.codex is out of service rather than idle.
  const codexRow = !d.codex.available
    ? '<div class="modelrow"><span>codex</span>' +
      '<span class="modelbar hatch"></span>' +
      '<span class="num dim">no data</span></div>'
    : d.codex.threadCount > 0
      ? '<div class="modelrow"><span>codex Σ</span><span class="modelbar hatch"></span>' +
        '<span class="num dim">no table</span></div>'
      : "";
  const hiddenCost = hidden.reduce((n, m) => n + (m.cost || 0), 0);
  const moreRow = hidden.length
    ? '<div class="modelrow"><span class="dim">+' +
      hidden.length +
      " more model" +
      (hidden.length === 1 ? "" : "s") +
      '</span><span class="modelbar"><div style="width:' +
      ((100 * hiddenCost) / widest).toFixed(3) +
      '%;background:var(--m-cw)"></div></span>' +
      '<span class="num dim">' +
      esc(usd(hiddenCost)) +
      "</span></div>"
    : "";
  $("modelrows").innerHTML = rows + moreRow + codexRow;
}

// -------------------------------------------------------------------- burn

/**
 * Swap which unit is the large one, from the `u` key or from a click.
 *
 * One function behind both, because a control that behaves differently
 * depending on how it was reached is a second control wearing the first one's
 * clothes. The choice persists exactly as it always did.
 */
function swapBurnUnit() {
  state.burnUnit = FleetUnits.nextBurnUnit(state.burnUnit);
  save("burnUnit", state.burnUnit);
  if (state.data) renderBurn(state.data);
}

function renderBurn(d) {
  const minutes = d.burn.minutes;
  const width = 600;
  const height = 72;
  const step = width / Math.max(1, minutes.length);
  const peak = Math.max(1, ...minutes.map((m) => m.t));
  const y = (v) => height - (v / peak) * (height - 2) - 1;

  let path = "M 0 " + height;
  minutes.forEach((m, i) => {
    const x0 = i * step;
    const x1 = (i + 1) * step;
    path += " L " + x0.toFixed(2) + " " + y(m.t).toFixed(2);
    path += " L " + x1.toFixed(2) + " " + y(m.t).toFixed(2);
  });
  path += " L " + width + " " + height + " Z";

  let top = "";
  minutes.forEach((m, i) => {
    const x0 = i * step;
    const x1 = (i + 1) * step;
    top +=
      (i === 0 ? "M " : " L ") +
      x0.toFixed(2) +
      " " +
      y(m.t).toFixed(2) +
      " L " +
      x1.toFixed(2) +
      " " +
      y(m.t).toFixed(2);
  });

  const medianY = y(d.burn.median).toFixed(2);
  $("burnsvg").innerHTML =
    '<path d="' +
    path +
    '" fill="var(--m-in)" fill-opacity="0.22"></path>' +
    '<path d="' +
    top +
    '" fill="none" stroke="var(--m-cw)" stroke-width="1" vector-effect="non-scaling-stroke"></path>' +
    '<line x1="0" x2="' +
    width +
    '" y1="' +
    medianY +
    '" y2="' +
    medianY +
    '" stroke="var(--rule)" stroke-width="1" vector-effect="non-scaling-stroke"></line>';

  // Both burn units stay visible. The keyboard shortcut and the visible control
  // only change which unit receives visual priority.
  //
  // Every figure in this section is the same per-minute measurement — the big
  // number, the second line, both dollar rates and the median all come from the
  // one pair, so they cannot drift into reading as different metrics. That fact
  // is explained ONCE, in the `burn-units` glossary entry behind the section
  // label; it is not repeated as a tooltip on every number.
  const rate = FleetUnits.burnPair(d.burn.tokensPerMinute, state.burnUnit);
  const costKnown = Number.isFinite(d.burn.costPerMinute);
  const cost = costKnown
    ? FleetUnits.burnPair(d.burn.costPerMinute, state.burnUnit)
    : null;
  const median = FleetUnits.burnPair(d.burn.median, state.burnUnit);
  const swapTo = "tok/" + rate.secondary.suffix;
  // The only hover text left on the control is what a click does — an
  // affordance, not an explanation.
  const swapTitle =
    "Click to make " + swapTo + " the large figure (or press u)";
  const swap = $("burnswap");
  swap.title = swapTitle;
  swap.setAttribute(
    "aria-label",
    "Burn rate, showing both units. Activate to make " +
      swapTo +
      " the large figure.",
  );
  $("burnswaphint").textContent = "click for " + swapTo;

  $("burnbig").textContent =
    tokens(rate.primary.value) + " tok/" + rate.primary.suffix;
  $("burnalt").textContent =
    tokens(rate.secondary.value) + " tok/" + rate.secondary.suffix;

  $("burncost").textContent = costKnown
    ? usd(cost.primary.value) + "/" + cost.primary.suffix + " est"
    : "cost unpriced · tokens exact";
  $("burnaltcost").textContent = costKnown
    ? usd(cost.secondary.value) + "/" + cost.secondary.suffix + " est"
    : "cost unpriced · tokens exact";

  $("burnmedian").textContent =
    "median " +
    tokens(median.primary.value) +
    "/" +
    median.primary.suffix +
    " · " +
    tokens(median.secondary.value) +
    "/" +
    median.secondary.suffix;
}

// ----------------------------------------------------------------- history

const PERIOD_ORDER = ["hour", "24h", "3d", "all"];

function whenShort(t) {
  if (!t) return "—";
  const d = new Date(t);
  return (
    d.getMonth() +
    1 +
    "/" +
    d.getDate() +
    " " +
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

/**
 * The headline. Totals here are PERIOD-scoped and labelled with the period —
 * this is the screen that answers "did the fleet really reset overnight?"
 * (it did not; the day view did).
 */
function renderHistory(h) {
  if (!h || !h.totals) return;
  const t = h.totals;
  $("periodtokens").textContent = tokens(t.total);
  $("periodtokens").title =
    t.total.toLocaleString() + " tokens · " + h.period.label;
  const warn =
    h.instrument && h.instrument.priceTableWarning
      ? ' · <span class="unpricedcell">' +
        esc(h.instrument.priceTableWarning) +
        "</span>"
      : "";
  $("periodcost").innerHTML =
    "<b>" +
    esc(usd(t.costTotal)) +
    "</b> est · <b>" +
    esc(h.period.label) +
    "</b>" +
    (t.unpriced
      ? ' · <span class="unpricedcell">+ unpriced model</span>'
      : "") +
    warn;
  $("periodclasses").innerHTML = RAMP.map(
    (r) =>
      '<span><i style="background:' +
      r.css +
      '"></i>' +
      esc(r.label) +
      " <b>" +
      tokens(t.tokens[r.key]) +
      "</b> · " +
      esc(usd(t.cost[r.key])) +
      "</span>",
  ).join("");

  const cov = h.coverage || {};
  const from = h.period.fromMs;
  $("periodcoverage").innerHTML =
    "<b>" +
    esc(h.period.label) +
    "</b> · " +
    (from
      ? esc(whenShort(from)) + " → now"
      : esc(cov.scopeNote || "everything recorded")) +
    " · <b>" +
    (h.scope ? escRedact(h.scope.label) + " only" : "all projects") +
    "</b> · source since " +
    esc(whenShort(cov.earliestMs)) +
    (cov.persistedFromMs
      ? " · snapshots since " + esc(whenShort(cov.persistedFromMs))
      : " · no snapshot file yet") +
    " · Σ codex excluded" +
    (h.scope && h.scope.unattributed
      ? ' · <span class="unpricedcell" title="' +
        esc(h.scope.note || "") +
        '">' +
        tokens(h.scope.unattributed) +
        " tokens unsplit</span>"
      : "") +
    (cov.flushError
      ? ' · <span class="unpricedcell">snapshot write failed</span>'
      : "");

  renderHistoryChart(h);

  const code = h.code || { totals: {}, repos: [] };
  const ct = code.totals || {};
  $("periodship").innerHTML =
    "shipped in period: <b>" +
    (ct.prsMerged || 0) +
    "</b> merged PRs · <b>" +
    (ct.commits || 0) +
    "</b> commits · <b>+" +
    (ct.added || 0).toLocaleString() +
    "</b> / <b>−" +
    (ct.removed || 0).toLocaleString() +
    "</b> lines" +
    (code.repos && code.repos.length
      ? ' · <span class="dim">' +
        code.repos
          .slice(0, 3)
          .map((r) => escRedact(r.name) + " +" + r.added + "/−" + r.removed)
          .join(" · ") +
        "</span>"
      : "");

  const maxSession = Math.max(1, ...(h.bySession || []).map((s) => s.total));
  $("periodsessions").innerHTML = (h.bySession || [])
    .slice(0, 6)
    .map(
      (s) =>
        '<div class="pminirow"><span title="' +
        esc(s.key) +
        '">' +
        escRedact(s.project) +
        (s.short ? ' <span class="dim">' + esc(s.short) + "</span>" : "") +
        '</span><span class="pminibar"><div style="width:' +
        ((100 * s.total) / maxSession).toFixed(1) +
        '%;background:var(--m-cw)"></div></span><span class="num">' +
        tokens(s.total) +
        "</span></div>",
    )
    .join("");

  const maxModel = Math.max(1, ...(h.byModel || []).map((m) => m.total));
  $("periodmodels").innerHTML = (h.byModel || [])
    .slice(0, 5)
    .map(
      (m) =>
        '<div class="pminirow"><span>' +
        esc(shortModel(m.model)) +
        '</span><span class="pminibar"><div style="width:' +
        ((100 * m.total) / maxModel).toFixed(1) +
        '%;background:var(--m-in)"></div></span><span class="num">' +
        tokens(m.total) +
        (m.cost === null ? " ?" : " · " + usd(m.cost)) +
        "</span></div>",
    )
    .join("");
}

/**
 * Stacked step area, cheapest class at the bottom, hand-rolled SVG — the same
 * discipline as the burn band: a step because buckets are discrete sums, and
 * no library because no request ever leaves this origin.
 */
function renderHistoryChart(h) {
  const series = h.series || [];
  const w = 720;
  const hgt = 108;
  $("chartspan").textContent = series.length
    ? whenShort(series[0].t) + " → " + whenShort(h.period.toMs)
    : "no data in this period";
  if (!series.length) {
    $("historysvg").innerHTML = "";
    return;
  }
  const step = w / series.length;
  const peak = Math.max(1, ...series.map((p) => p.total));
  const y = (v) => hgt - (v / peak) * (hgt - 4) - 1;

  // Cumulative boundaries per point, in RAMP order (cr, in, cw, out).
  const order = ["cr", "in", "cw", "out"];
  const lower = series.map(() => 0);
  const parts = [];
  for (const key of order) {
    const upper = series.map((p, i) => lower[i] + (p[key] || 0));
    let d = "";
    for (let i = 0; i < series.length; i += 1) {
      const x0 = (i * step).toFixed(2);
      const x1 = ((i + 1) * step).toFixed(2);
      const yy = y(upper[i]).toFixed(2);
      d +=
        (i === 0 ? "M " + x0 : " L " + x0) + " " + yy + " L " + x1 + " " + yy;
    }
    for (let i = series.length - 1; i >= 0; i -= 1) {
      const x0 = (i * step).toFixed(2);
      const x1 = ((i + 1) * step).toFixed(2);
      const yy = y(lower[i]).toFixed(2);
      d += " L " + x1 + " " + yy + " L " + x0 + " " + yy;
    }
    d += " Z";
    const ramp = RAMP.find((r) => r.key === key);
    parts.push(
      '<path d="' + d + '" fill="' + ramp.css + '" fill-opacity="0.85"></path>',
    );
    for (let i = 0; i < series.length; i += 1) lower[i] = upper[i];
  }
  $("historysvg").innerHTML = parts.join("");
}

/**
 * The coordination board — the ledger, on the face of the console.
 *
 * This is the one surface here that is not about this machine. The roster
 * above measures sessions on this disk; these rows are what the fleet
 * DECLARED through the CLI, from whatever machine each session runs on. It
 * used to be a footer drawer, folded away by default, which put the only
 * cross-machine evidence in the program behind a click while every host-local
 * panel was permanent chrome.
 *
 * Every decision about WHAT to say lives in public/boardview.js, which the
 * node suite imports directly; this function only turns that reading into
 * pixels. In particular the refusal — an unreadable ledger draws its reason
 * and no rows, never an empty board — is made there and merely obeyed here.
 */
function renderBoard(d) {
  const section = $("board");
  const view = FleetBoard.boardView(d && d.muster, { now: state.snapshotNow || Date.now() });
  if (!view.visible) {
    // A ledger that could not be read is news, not absence: the band stays,
    // carrying the reason. It disappears only when nothing asked for one.
    if (view.disabled) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    $("boardcount").textContent = "—";
    $("boardattention").textContent = "";
    $("boardsource").textContent = "";
    $("boardbody").innerHTML =
      '<div class="emptyline">' + escRedact(view.reason) + "</div>";
    $("boardflagged").hidden = true;
    return;
  }

  section.hidden = false;
  $("boardcount").textContent = view.headline;

  const attention = $("boardattention");
  attention.textContent = view.attention.length ? view.attention.join(" · ") : "";
  attention.hidden = view.attention.length === 0;

  $("boardsource").textContent =
    view.source +
    (view.protocolVersion ? " · protocol " + view.protocolVersion : "") +
    " · " +
    view.sessionCount +
    (view.sessionCount === 1 ? " session" : " sessions") +
    " on " +
    view.machineCount +
    (view.machineCount === 1 ? " machine" : " machines");

  $("boardbody").innerHTML = view.rows.length
    ? view.rows
        .map(
          (row) =>
            '<div class="boardrow t-' +
            esc(row.tone) +
            '"><span class="boardstate">' +
            esc(row.statusLabel) +
            '</span><span class="boardid" title="' +
            esc(row.title) +
            '"><b>' +
            escRedact(row.id) +
            '</b> <span class="dim">' +
            escRedact(row.title) +
            '</span></span><span class="boardholder">' +
            escRedact(row.holderLabel) +
            '</span><span class="boardfence mono-cell" title="' +
            esc(row.fenceTitle) +
            '">' +
            escRedact(row.fenceLabel) +
            '</span><span class="boardevidence mono-cell">' +
            escRedact(row.evidence) +
            '</span><span class="boardgate">' +
            escRedact(row.gate) +
            '</span><span class="boardage num dim">' +
            esc(row.ageText) +
            "</span></div>",
        )
        .join("")
    : '<div class="emptyline">no work packages on the ledger — `muster dispatch &lt;id&gt; --writes "&lt;globs&gt;"` creates one</div>';

  const flagged = $("boardflagged");
  if (!view.flagged.length) {
    flagged.hidden = true;
    flagged.innerHTML = "";
    return;
  }
  flagged.hidden = false;
  flagged.innerHTML = view.flagged
    .map(
      (message) =>
        '<div class="boardmessage"><span class="pend">' +
        esc(message.kind) +
        "</span> <b>" +
        escRedact(message.from) +
        " → " +
        escRedact(message.to) +
        "</b> · " +
        escRedact(message.body) +
        ' <span class="dim">· ' +
        esc(message.ageText) +
        " ago</span></div>",
    )
    .join("");
}

function renderFleet(d) {
  const f = d.fleet || { enabled: false };
  const summary = $("fleetsummary");
  const body = $("fleetbody");
  // Coordination state is the board's, above. This drawer is only the
  // optional hosted-forge panel: rendering the ledger in both places put two
  // readings of one ledger on one screen, which is the second source of truth
  // the rest of this product refuses.
  if (!f.enabled) {
    summary.textContent = "hosted-forge checks not included";
    body.innerHTML =
      '<div class="emptyline">Hosted-forge checks are not included in this local read-only build. Shared-ledger coordination state is on the board above.</div>';
    return;
  }
  if (!f.available) {
    summary.textContent =
      "hosted forge " + (f.loading ? "loading…" : "unavailable");
    body.innerHTML =
      '<div class="emptyline">' +
      escRedact(f.reason || "hosted-forge checks unavailable") +
      " · shared-ledger coordination state is on the board above</div>";
    return;
  }
  summary.textContent =
    (f.prs || []).length +
    " open PRs · forge ledger " +
    (f.latestCommentAt ? ago(f.latestCommentAt) + " ago" : "silent in window") +
    " · " +
    esc(f.repo || "");

  const checksHtml = (c) =>
    '<span class="ok">' +
    c.pass +
    '✓</span> <span class="bad">' +
    c.fail +
    '✗</span> <span class="pend">' +
    c.pending +
    "●</span>";

  body.innerHTML =
    '<div class="fleetblock"><span class="label">who is doing what · inferred from GitHub ledger-comment headers</span>' +
    ((f.assignments || [])
      .map(
        (a) =>
          '<div class="fleetline"><b>' +
          esc(a.identity) +
          "</b> · " +
          escRedact(a.doing) +
          ' <span class="dim">· ' +
          ago(a.at) +
          " ago</span></div>",
      )
      .join("") ||
      '<div class="fleetline dim">no self-declared headers in the last 48 h</div>') +
    "</div>" +
    '<div class="fleetblock"><span class="label">open PRs · checks</span>' +
    ((f.prs || [])
      .map(
        (p) =>
          '<div class="fleetline"><b>#' +
          esc(p.number) +
          "</b>" +
          (p.draft ? ' <span class="dim">draft</span>' : "") +
          " · " +
          escRedact(p.title) +
          ' <span class="dim">· ' +
          escRedact(p.branch) +
          "</span> · " +
          checksHtml(p.checks) +
          "</div>",
      )
      .join("") || '<div class="fleetline dim">no open PRs</div>') +
    "</div>" +
    '<div class="fleetblock"><span class="label">latest rulings &amp; handoffs</span>' +
    ((f.rulings && f.rulings.length ? f.rulings : f.recent || [])
      .map(
        (r) =>
          '<div class="fleetline">' +
          escRedact(r.text) +
          ' <span class="dim">· ' +
          ago(r.at) +
          " ago</span></div>",
      )
      .join("") ||
      '<div class="fleetline dim">no ledger comments in the last 48 h</div>') +
    "</div>" +
    '<div class="fleetblock"><span class="label">in flight · latest claims</span>' +
    ((f.inFlight || [])
      .map(
        (c) =>
          '<div class="fleetline">' +
          escRedact(c.text) +
          ' <span class="dim">· ' +
          ago(c.at) +
          " ago</span></div>",
      )
      .join("") ||
      '<div class="fleetline dim">no claims in the last 48 h</div>') +
    '</div><div class="fleetblock"><span class="label">' +
    esc(f.note || "") +
    (f.partial ? " · " + esc(f.partial) : "") +
    (f.stale ? " · refreshing…" : "") +
    "</span></div>";
}

/**
 * The remaining-work list, folded behind the strip's own disclosure.
 *
 * The list is detail, so it is not permanent chrome — but the TOGGLE is, and it
 * carries its own count ("8 remaining ▸"). The last build put that affordance
 * at the end of a clipped one-line summary, where it was cut off the right edge
 * and could not be found at all; a control nobody can see is a control that
 * does not exist.
 */
function renderProgress(d) {
  const rest = $("psrest");
  const view = FleetProgress.progressView(d && d.progress, { now: Date.now() });
  if (!view.visible || !view.remainingCount) {
    rest.hidden = true;
    rest.open = false;
    return;
  }
  rest.hidden = false;
  $("pstoggle").textContent = view.remainingLabel + " ▸";
  $("pstoggle").title =
    "The work the orchestrator still has open on this list.";
  $("progressremaining").innerHTML = view.remaining
    .map((item) => "<div>· " + escRedact(item) + "</div>")
    .join("");
}

// ---------------------------------------------------------------- projects

function renderProjects(h) {
  const p = h && h.projects;
  if (!p || !p.available) {
    $("projectssummary").textContent = "—";
    $("projectsbody").innerHTML =
      '<div class="emptyline">the project ledger arrives with the history panel</div>';
    return;
  }
  // Omit the roster's session count here. Repository coverage is the distinct
  // project-level fact that determines whether code metrics are available.
  $("projectssummary").textContent = FleetSessionRows.projectsSummary(
    p,
    (h.period && h.period.label) || "",
  );

  const peak = Math.max(1, ...p.projects.map((x) => x.tokens));
  $("projectsbody").innerHTML =
    '<div class="emptyline">' +
    escRedact(p.note) +
    "</div>" +
    '<table class="grid"><thead><tr><th>project</th><th class="num">tokens</th>' +
    '<th class="num">share</th><th class="num">live</th><th>branches</th>' +
    '<th>repository</th><th class="num">merged PRs</th><th class="num">commits</th>' +
    '<th class="num">lines</th><th></th></tr></thead><tbody>' +
    p.projects
      .map(
        (x) =>
          '<tr class="' +
          (x.selected ? "selectedproject" : "") +
          '"><td><b>' +
          escRedact(x.label) +
          "</b>" +
          (x.path
            ? ' <span class="dim mono-cell">' + escRedact(x.path) + "</span>"
            : "") +
          '</td><td class="num">' +
          tokens(x.tokens) +
          '</td><td class="num"><span class="pminibar" style="display:inline-flex;width:60px"><div style="width:' +
          ((100 * x.tokens) / peak).toFixed(1) +
          '%;background:var(--m-in)"></div></span></td><td class="num">' +
          (x.live || '<span class="dim">—</span>') +
          '</td><td class="mono-cell dim">' +
          (x.branches.length
            ? escRedact(x.branches.slice(0, 2).join(", ")) +
              (x.branches.length > 2 ? " +" + (x.branches.length - 2) : "")
            : "—") +
          "</td><td>" +
          (x.repo
            ? escRedact(x.repo.name) +
              (x.repo.sharedWith
                ? ' <span class="dim" title="This repository holds ' +
                  (x.repo.sharedWith + 1) +
                  ' transcript projects. Its figures belong to the repository and are not divided between them.">shared ×' +
                  (x.repo.sharedWith + 1) +
                  "</span>"
                : "")
            : '<span class="dim" title="No git repository contains this directory, so there are no code figures — which is different from having shipped nothing.">not a repo</span>') +
          '</td><td class="num">' +
          (x.repo ? x.repo.prsMerged : '<span class="dim">—</span>') +
          '</td><td class="num">' +
          (x.repo ? x.repo.commits : '<span class="dim">—</span>') +
          '</td><td class="num dim">' +
          (x.repo
            ? "+" +
              x.repo.added.toLocaleString() +
              "/−" +
              x.repo.removed.toLocaleString()
            : "—") +
          "</td><td>" +
          '<button class="pidlink" data-scope="' +
          esc(x.slug) +
          '">' +
          (x.selected ? "clear scope" : "scope to this") +
          "</button></td></tr>",
      )
      .join("") +
    "</tbody></table>";
}

// ------------------------------------------------------------------ effort

/** A ratio, or an em dash. Never Infinity, never a zero standing in for one. */
function ratio(value, suffix) {
  if (value === null || value === undefined || !isFinite(value)) {
    return '<span class="dim" title="Nothing to divide by in this period. Not all work produces a PR, and a blank is not a zero.">—</span>';
  }
  return tokens(value) + (suffix || "");
}

function renderEffort(h) {
  const a = h && h.attribution;
  if (!a) {
    $("effortsummary").textContent = "—";
    $("effortbody").innerHTML =
      '<div class="emptyline">attribution arrives with the history panel</div>';
    return;
  }
  const f = a.fleet;
  $("effortsummary").textContent =
    tokens(f.tokens) +
    " tokens · " +
    f.prsMerged +
    " merged PRs · " +
    // The ratio is null for TWO different reasons and they are not the same
    // statement. Printing "no PR merged" beside "81 merged PRs" made the
    // summary contradict itself on a machine that had simply spent no tokens.
    (f.tokensPerPr
      ? tokens(f.tokensPerPr) + " tok/PR"
      : f.prsMerged === 0
        ? "no PR merged"
        : "no tokens to divide") +
    " · " +
    esc((h.period && h.period.label) || "");

  $("effortbody").innerHTML =
    '<div class="fleetblock"><span class="label" data-term="attribution">the fleet, measured on both sides</span>' +
    '<div class="fleetline"><b>' +
    tokens(f.tokens) +
    "</b> tokens · <b>" +
    f.prsMerged +
    "</b> PRs merged · <b>" +
    f.commits +
    "</b> commits · <b>+" +
    f.added.toLocaleString() +
    "</b>/<b>−" +
    f.removed.toLocaleString() +
    "</b> lines · <b>" +
    ratio(f.tokensPerPr) +
    "</b> tokens per merged PR · <b>" +
    ratio(f.tokensPerKLine) +
    "</b> tokens per 1k lines</div></div>" +
    '<div class="fleetblock"><span class="label" data-term="authorship">by git author · code measured, tokens only where declared</span>' +
    '<table class="grid"><thead><tr><th>author</th><th class="num">commits</th>' +
    '<th class="num">merged PRs</th><th class="num">lines</th><th class="num">lines / PR</th>' +
    '<th class="num">tokens</th><th class="num">tok / PR</th><th>repositories</th></tr></thead><tbody>' +
    (a.authors.length
      ? a.authors
          .map(
            (x) =>
              "<tr><td><b>" +
              escRedact(x.name) +
              '</b></td><td class="num">' +
              x.commits +
              '</td><td class="num">' +
              x.prsMerged +
              '</td><td class="num dim">+' +
              x.added.toLocaleString() +
              "/−" +
              x.removed.toLocaleString() +
              '</td><td class="num">' +
              (x.linesPerPr === null
                ? '<span class="dim">—</span>'
                : Math.round(x.linesPerPr).toLocaleString()) +
              '</td><td class="num">' +
              (x.tokens === null
                ? '<span class="dim" title="No session declared this author, so no token spend is attributed to them. Assigning the fleet total to whoever committed would be a guess.">not attributed</span>'
                : tokens(x.tokens)) +
              '</td><td class="num">' +
              (x.tokens === null
                ? '<span class="dim">—</span>'
                : ratio(x.tokensPerPr)) +
              '</td><td class="dim">' +
              escRedact(x.repos.join(", ")) +
              "</td></tr>",
          )
          .join("")
      : '<tr><td colspan="8" class="emptyline">no commits in this period</td></tr>') +
    "</tbody></table></div>" +
    '<div class="fleetblock"><span class="label">by session · tokens measured, PRs opened from that session\'s own transcript</span>' +
    '<table class="grid"><thead><tr><th>session</th><th>project</th>' +
    '<th class="num">tokens</th><th class="num">PRs opened</th>' +
    '<th class="num">tok / PR opened</th><th>declared author</th></tr></thead><tbody>' +
    (a.sessions.length
      ? a.sessions
          .map(
            (s) =>
              '<tr><td class="mono-cell dim">' +
              esc(s.short) +
              "</td><td><b>" +
              escRedact(s.project || "—") +
              '</b></td><td class="num">' +
              tokens(s.tokens) +
              '</td><td class="num">' +
              (s.prsOpened || '<span class="dim">—</span>') +
              '</td><td class="num">' +
              ratio(s.tokensPerPrOpened) +
              '</td><td class="dim">' +
              (s.author ? escRedact(s.author) : "—") +
              "</td></tr>",
          )
          .join("")
      : '<tr><td colspan="6" class="emptyline">no session activity in this period</td></tr>') +
    "</tbody></table></div>" +
    '<div class="fleetblock"><span class="label">caveats</span>' +
    a.caveats
      .map((c) => '<div class="fleetline dim">· ' + escRedact(c) + "</div>")
      .join("") +
    (a.unattributedTokens
      ? '<div class="fleetline dim">· ' +
        tokens(a.unattributedTokens) +
        " tokens in this period belong to sessions that declared no author, and are reported here rather than assigned to one.</div>"
      : "") +
    "</div>";
  wireTerms();
}

// ------------------------------------------------------------------ roster

function matches(row, needle) {
  if (!needle) return true;
  const hay = [
    row.project,
    row.branch,
    row.short,
    row.vendor,
    row.name,
    row.last,
    (row.models || []).join(" "),
    row.path,
    // The table now carries sessions from other machines, so the machine name
    // has to be searchable or the filter cannot reach half the rows.
    row.machine,
    row.state,
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

/**
 * The one list the roster paints: every session, measured or declared.
 *
 * public/sessionrows.js owns the model and the ordering; this is the only
 * place the page reads it, so the cursor, the filter, the order hold and the
 * painted table can never be indexing into three different lists.
 */
function sessionRows(d) {
  if (!d) return [];
  return FleetSessionRows.buildSessionRows({
    rows: d.rows || [],
    roster: d.roster || null,
  });
}

function sparkSvg(values) {
  if (!values || !values.length) return "";
  const peak = Math.max(1, ...values);
  const w = 64;
  const h = 16;
  const bw = w / values.length;
  return (
    '<svg class="spark" viewBox="0 0 ' +
    w +
    " " +
    h +
    '" preserveAspectRatio="none">' +
    values
      .map((v, i) => {
        const bh = Math.max(v > 0 ? 1 : 0, (v / peak) * h);
        return (
          '<rect x="' +
          (i * bw).toFixed(2) +
          '" y="' +
          (h - bh).toFixed(2) +
          '" width="' +
          Math.max(0.6, bw - 0.4).toFixed(2) +
          '" height="' +
          bh.toFixed(2) +
          '" fill="var(--m-cw)" opacity="0.8"></rect>'
        );
      })
      .join("") +
    "</svg>"
  );
}

function cell(row, key, html, className) {
  const id = row.key + "|" + key;
  const previous = state.previous.get(id);
  // Only a value that actually moved gets the settle flash. A first sighting
  // does not count as a change, or the whole table would flash on load.
  const changed = previous !== undefined && previous !== html;
  state.previous.set(id, html);
  return (
    '<td class="c-' +
    key +
    " " +
    (className || "") +
    (changed ? " changed" : "") +
    '">' +
    html +
    "</td>"
  );
}

function fillCell(row, key, html, value, max, className) {
  const width = max > 0 ? Math.min(100, (100 * value) / max) : 0;
  return cell(
    row,
    key,
    '<span class="bg" style="width:' +
      width.toFixed(1) +
      '%"></span><span class="v">' +
      html +
      "</span>",
    "fill num " + (className || ""),
  );
}

function treeRow(row) {
  const agents = row.agents || [];
  if (!agents.length) {
    return (
      '<tr class="tree" data-tree="' +
      esc(row.key) +
      '"><td colspan="' +
      columnCount() +
      '"><div class="treewrap">' +
      (row.declared
        ? "no sub-agent tree — this session was declared, not scanned"
        : "no sub-agents recorded for this session") +
      factsBlock(row) +
      "</div></td></tr>"
    );
  }
  const lines = agents
    .slice(0, 24)
    .map((a, i) => {
      const last = i === agents.length - 1 || i === 23;
      const depth = a.depth || 1;
      const indent = "  ".repeat(Math.max(0, depth - 1));
      const meterMax = Math.max(1, agents[0].tokens);
      const filled = Math.round((8 * a.tokens) / meterMax);
      const meter = "▮".repeat(filled) + "▯".repeat(8 - filled);
      return (
        indent +
        (last ? "└─ " : "├─ ") +
        (a.live ? '<span class="live">●</span>' : "○") +
        " " +
        esc((a.type || "agent").padEnd(20).slice(0, 20)) +
        " d" +
        (a.depth === null ? "?" : a.depth) +
        "  " +
        meter +
        "  " +
        '<span class="tok">' +
        tokens(a.tokens).padStart(7) +
        "</span>  " +
        (a.cost === null ? "   Σ   " : usd(a.cost).padStart(8)) +
        "  " +
        (a.described
          ? escRedact(String(a.desc).slice(0, 90))
          : '<span class="guessed">~' +
            escRedact(String(a.desc).slice(0, 88)) +
            "</span>")
      );
    })
    .join("\n");
  const more =
    agents.length > 24 ? "\n   … " + (agents.length - 24) + " more" : "";
  return (
    '<tr class="tree" data-tree="' +
    esc(row.key) +
    '"><td colspan="' +
    columnCount() +
    '"><div class="treewrap">' +
    lines +
    more +
    factsBlock(row) +
    "</div></td></tr>"
  );
}

function factsBlock(row) {
  const bits = [];
  bits.push(
    "session <b>" +
      escRedact(row.short || row.id || "unknown") +
      " · " +
      esc(row.vendor || "unknown") +
      "</b>",
  );
  if (row.models && row.models.length)
    bits.push(
      "model <b>" + row.models.map((m) => esc(shortModel(m))).join(", ") + "</b>",
    );
  if (row.total !== null && row.total !== undefined) {
    bits.push(
      "usage <b>" +
        (row.cumulative ? "Σ " : "") +
        tokens(row.total) +
        " total</b>" +
        (row.hot === null || row.hot === undefined
          ? ""
          : " · <b>" + tokens(row.hot) + "</b> in 5m"),
    );
  }
  if (row.priced)
    bits.push("cost <b>" + usd(row.cost) + "</b> API-list estimate");
  else if (row.unpriced || row.cumulative)
    bits.push("cost <b>unpriced</b> · token count remains exact");
  if (row.last) bits.push("doing <b>" + escRedact(row.last) + "</b>");
  // Provenance first, on every row. It is the answer to "how do you know", and
  // it used to live in a separate drawer the reader had to cross-reference.
  if (row.machine)
    bits.push(
      "machine <b>" +
        escRedact(row.machine) +
        "</b>" +
        (row.remote ? " (not scannable from here)" : ""),
    );
  if (row.evidence && row.evidence.length)
    bits.push(
      "evidence <b>" +
        row.evidence.map((s) => esc(s)).join(" + ") +
        "</b>" +
        (row.joinedBy
          ? " · joined by <b>" +
            esc(row.joinedBy) +
            "</b>, so it is counted once"
          : ""),
    );
  if (row.stateReason)
    bits.push("state <b>" + escRedact(row.stateReason) + "</b>");
  if (row.lastMentionedAt)
    bits.push(
      "last mentioned on the shared ledger <b>" +
        ago(row.lastMentionedAt) +
        " ago</b> · " +
        escRedact(row.lastMentionedBasis || "matched by identity") +
        " — a mention, not a measurement",
    );
  // A declaration's own claim about itself, kept as a claim. It is never the
  // word in the state column, because nothing here measured it.
  if (row.declaredState)
    bits.push(
      "this session declares itself <b>" +
        esc(row.declaredState) +
        "</b> — a claim, not a measurement",
    );
  if (row.unmatchedLocal)
    bits.push(
      "<b>declared for this machine but not observed on its disk</b> — this disk is the authority for its own sessions, so the row is listed and not counted",
    );
  if (row.author) bits.push("author <b>" + escRedact(row.author) + "</b>");
  if (row.ledgerPackage)
    bits.push("holding <b>" + escRedact(row.ledgerPackage) + "</b>");
  if (row.path)
    bits.push(
      "path <b>" +
        escRedact(row.path) +
        (row.pathExact ? "" : " (approx)") +
        "</b>",
    );
  if (row.version) bits.push("cli <b>" + esc(row.version) + "</b>");
  if (row.startedAt) bits.push("started <b>" + ago(row.startedAt) + " ago</b>");
  if (row.responses)
    bits.push("responses <b>" + row.responses.toLocaleString() + "</b>");
  if (row.tok && row.tok.think)
    bits.push("thinking <b>" + tokens(row.tok.think) + "</b>");
  if (row.tok && row.tok.cw1h)
    bits.push(
      "1h cache writes <b>" +
        tokens(row.tok.cw1h) +
        "</b> (billed 2.0×, not 1.25×)",
    );
  if (row.retries) bits.push("api retries <b>" + row.retries + "</b>");
  if (row.errors && row.errors.length)
    bits.push(
      "errors <b>" +
        row.errors.map((e) => esc(e.name) + " ×" + e.count).join(", ") +
        "</b>",
    );
  if (row.contextPeak)
    bits.push(
      "context peak <b>" + tokens(row.contextPeak) + "</b> before compaction",
    );
  if (row.compactions && row.compactions.length) {
    const lost = row.compactions.reduce((n, c) => n + (c.durationMs || 0), 0);
    bits.push(
      "compactions <b>" +
        row.compactions.length +
        "</b> · <b>" +
        Math.round(lost / 1000) +
        "s</b> stalled",
    );
  }
  if (row.cacheMiss && row.cacheMiss.length)
    bits.push(
      "cache misses <b>" +
        row.cacheMiss
          .map((c) => esc(c.name) + " " + tokens(c.count))
          .join(", ") +
        "</b>",
    );
  if (row.tools && row.tools.length)
    bits.push(
      "tools <b>" +
        row.tools.map((t) => esc(t.name) + " ×" + t.count).join(", ") +
        "</b>",
    );
  if (row.serverTools && (row.serverTools.search || row.serverTools.fetch))
    bits.push(
      "server tools <b>" +
        row.serverTools.search +
        " search / " +
        row.serverTools.fetch +
        " fetch</b> (billed separately, not in this estimate)",
    );
  if (row.quota)
    bits.push(
      "quota <b>" +
        esc(row.quota.status || "?") +
        (row.quota.limitType ? " · " + esc(row.quota.limitType) : "") +
        (row.quota.resetsAt
          ? " · resets " + new Date(row.quota.resetsAt).toLocaleTimeString()
          : "") +
        "</b>",
    );
  if (row.rateLimits && row.rateLimits.usedPercent !== null)
    bits.push(
      "vendor quota <b>" +
        row.rateLimits.usedPercent +
        "%</b> of a " +
        Math.round((row.rateLimits.windowMinutes || 0) / 60) +
        "h window · plan <b>" +
        esc(row.rateLimits.planType || "?") +
        "</b>",
    );
  if (row.contextWindow)
    bits.push("context window <b>" + tokens(row.contextWindow) + "</b>");
  if (row.patches)
    bits.push(
      "patches <b>" +
        row.patches +
        "</b> · files touched <b>" +
        (row.filesTouched || []).length +
        "+</b>",
    );
  if (row.pid)
    bits.push("pid <b>" + row.pid + "</b>");
  else
    // State why local process telemetry is unavailable instead of implying a
    // zero or an instrumentation failure.
    bits.push(
      "<b>no local process join</b> — " +
        (row.declared
          ? "this session is declared from a machine this console cannot inspect"
          : row.vendor === "codex"
            ? "Codex thread telemetry does not expose a local pid"
            : "this session has no live pid record"),
    );
  if (row.cumulative)
    bits.push(
      "<b>Σ cumulative for the whole thread, not today — and never priced</b>",
    );
  return bits.length
    ? '<span class="facts">' + bits.join(" · ") + "</span>"
    : "";
}

/** "—" with a reason, for a column a declared row cannot honestly fill. */
function notMeasured(title) {
  return (
    '<span class="dim" title="' +
    esc(
      title || "Declared, not measured. This console cannot read that machine.",
    ) +
    '">—</span>'
  );
}

function renderRoster(d) {
  const needle = state.filter.trim().toLowerCase();
  const all = applyHeldOrder(sessionRows(d).filter((r) => matches(r, needle)));
  // Only a cold TRANSCRIPT folds. A declared session that has gone quiet is
  // still a member of the fleet somebody is running, and folding it away is
  // how the console came to show one row for a three-session fleet: dormancy
  // is a state word and an age, not a reason to disappear.
  const foldable = (r) => r.state === "COLD" && !r.declared;
  const cold = all.filter(foldable);
  const shown = state.showCold ? all : all.filter((r) => !foldable(r));

  const maxHot = Math.max(1, ...shown.map((r) => r.hot || 0));
  const maxCost = Math.max(0.01, ...shown.map((r) => r.cost || 0));

  if (!shown.length && !cold.length) {
    const roots = (d.meta.scan && d.meta.scan.roots) || {};
    $("rosterbody").innerHTML =
      '<tr><td colspan="' +
      columnCount() +
      '" class="emptyline">no sessions with activity today · watching ' +
      escRedact(roots.claude || "~/.claude/projects") +
      " and " +
      escRedact(roots.codex || "~/.codex/sessions") +
      " · scan " +
      d.meta.scan.ms +
      "ms</td></tr>";
    return;
  }

  let html = "";
  shown.forEach((row, index) => {
    const isCursor = index === state.cursor;
    html +=
      '<tr class="row s-' +
      row.state +
      (row.declared ? " declaredrow" : "") +
      (isCursor ? " cursor" : "") +
      '" data-key="' +
      esc(row.key) +
      '" data-index="' +
      index +
      '">';
    // A deadheading row is LIVE by the state machine and empty in fact. The
    // state cell says both, because either alone misleads. A declared row
    // carries its own reason: the word UNKNOWN is useless without the sentence
    // that says why nothing here could answer the question.
    html += cell(
      row,
      "state",
      '<span class="glyph">' +
        row.glyph +
        '</span> <span class="word"' +
        (row.stateReason ? ' title="' + esc(row.stateReason) + '"' : "") +
        ">" +
        row.state +
        "</span>" +
        (row.deadhead
          ? ' <span class="deadmark" title="' +
            esc(row.deadheadReason || "") +
            '">◻</span>'
          : "") +
        // Listed and deliberately not in the count. Without this the row is an
        // invitation to add it to the headline by hand and get a different
        // number from the one printed above it.
        (row.unmatchedLocal
          ? ' <span class="notcounted" title="Declared for this machine, but nothing on this machine\'s disk matches it. This disk is the authority for its own sessions, so the row is listed and left out of the count — it is probably a stale ledger entry, or one of the measured rows above under another name.">†</span>'
          : ""),
      "state",
    );
    // A remote session has no project on this disk, so the cell names the
    // machine instead of printing an empty bold nothing.
    html += cell(
      row,
      "project",
      (row.project
        ? "<b>" + escRedact(row.project) + "</b>"
        : '<span class="offmachine" title="This session runs on ' +
          esc(row.machine || "another machine") +
          ', which this console cannot scan.">' +
          escRedact(row.machine || "elsewhere") +
          "</span>") +
        (row.branch
          ? ' <span class="dim mono-cell">' + escRedact(row.branch) + "</span>"
          : ""),
    );
    // The tag goes FIRST. The id column truncates, and a marker that says "none
    // of this was measured" must not be the thing the ellipsis eats.
    html += cell(
      row,
      "id",
      (row.declared
        ? '<span class="src s-declared" title="' +
          esc(
            "Declared, not measured: " +
              (row.evidence || []).join(" + ") +
              ". Press space for the full evidence.",
          ) +
          '">decl</span>'
        : "") +
        '<span class="mono-cell" title="' +
        esc(String(row.id || row.short)) +
        '">' +
        esc(row.short) +
        "</span> " +
        '<span class="dim">' +
        esc(row.vendor) +
        "</span>",
    );
    html += cell(
      row,
      "model",
      '<span class="mono-cell dim">' +
        esc((row.models || []).map(shortModel).join(", ") || "—") +
        "</span>",
    );
    html += cell(row, "spark", sparkSvg(row.spark));
    // Null is "not reported", zero is a measurement. A declared row has never
    // reported zero tokens in the last five minutes; it has reported nothing.
    html +=
      row.hot === null
        ? cell(
            row,
            "hot",
            notMeasured("Not measured here — declared only."),
            "num",
          )
        : fillCell(
            row,
            "hot",
            row.hot ? tokens(row.hot) : '<span class="dim">—</span>',
            row.hot,
            maxHot,
          );
    // Σ marks a thread-cumulative figure. It belongs on every Codex quantity,
    // not only on the total: the four class columns are cumulative too, and a
    // Claude row beside them is scoped to today.
    const sigma = row.cumulative ? "Σ " : "";
    const klass = (key) =>
      row.tok
        ? sigma + tokens(row.tok[key])
        : notMeasured("Not measured here — declared only.");
    html += cell(row, "in", klass("in"), "num");
    html += cell(row, "out", klass("out"), "num");
    html += cell(row, "cw", klass("cw"), "num dim");
    html += cell(row, "cr", klass("cr"), "num dim");
    html += cell(
      row,
      "total",
      row.total === null || row.total === undefined
        ? notMeasured(
            "A declaration with no token figure. Not zero — not reported.",
          )
        : sigma + tokens(row.total),
      "num",
    );
    // Four distinct cases, and none of them is "$0.00": a priced row, a row
    // whose model has no rate line (which must never be shown as free), a Codex
    // row for which no price table is bundled at all, and a declared row whose
    // tokens were never measured here so no dollar can be derived.
    html += row.priced
      ? fillCell(row, "cost", usd(row.cost), row.cost || 0, maxCost)
      : row.declared
        ? cell(
            row,
            "cost",
            notMeasured(
              "No tokens were measured here, so no dollar can be derived.",
            ),
            "num",
          )
        : row.unpriced
          ? cell(
              row,
              "cost",
              '<span class="unpricedcell">' +
                (row.cost > 0 ? esc(usd(row.cost)) + " +?" : "unpriced") +
                "</span>",
              "num",
            )
          : cell(row, "cost", '<span class="dim">Σ no table</span>', "num");
    html += cell(
      row,
      "agents",
      row.agentCount
        ? '<span style="color:' +
            (row.swarm ? "var(--st-warn)" : "inherit") +
            '">' +
            row.agentLive +
            "/" +
            row.agentCount +
            "</span>"
        : '<span class="dim">—</span>',
      "num",
    );
    // The age beside the word, always. A state word with nothing behind it is
    // an assertion; a state word next to "1m" is a state word the reader can
    // check. For a declared row the freshest thing anyone knows is when it was
    // last MENTIONED on the shared ledger, and that is what is shown — labelled
    // as a mention, never as a measurement.
    const mentioned = row.declared && row.lastMentionedAt;
    html += cell(
      row,
      "last",
      '<span class="' +
        (mentioned ? "mentioned" : "dim") +
        '" title="' +
        esc(
          mentioned
            ? "Last mentioned on the shared ledger — " +
                (row.lastMentionedBasis || "matched by identity") +
                ". This is when the session last wrote, not a measurement of it."
            : "When this session last wrote to its transcript.",
        ) +
        '">' +
        ago(mentioned ? row.lastMentionedAt : row.lastTs) +
        (mentioned ? "*" : "") +
        "</span>",
      "num",
    );
    html += cell(
      row,
      "doing",
      '<span class="dim mono-cell">' + escRedact(row.last || "") + "</span>",
    );
    html += "</tr>";
    if (state.expanded.has(row.key)) html += treeRow(row);
  });

  if (!state.showCold && cold.length) {
    // Day-scoped and thread-cumulative figures are not addable. Folded into one
    // number, a single 1.5-billion-token Codex thread lifetime became 99.8% of
    // a line printed under a header stamped with today's date.
    const dayScoped = cold.filter((r) => !r.cumulative && r.total !== null);
    const cumulative = cold.filter((r) => r.cumulative);
    const coldTokens = dayScoped.reduce((n, r) => n + r.total, 0);
    const coldCost = dayScoped.reduce((n, r) => n + (r.cost || 0), 0);
    const cumulativeTokens = cumulative.reduce((n, r) => n + r.total, 0);
    html +=
      '<tr class="foldrow" data-fold="cold"><td colspan="' +
      columnCount() +
      '">+ ' +
      cold.length +
      " cold session" +
      (cold.length === 1 ? "" : "s") +
      (dayScoped.length
        ? " · " + tokens(coldTokens) + " tok today · " + usd(coldCost) + " est"
        : "") +
      (cumulative.length
        ? " · Σ " +
          tokens(cumulativeTokens) +
          " cumulative in " +
          cumulative.length +
          " codex thread" +
          (cumulative.length === 1 ? "" : "s")
        : "") +
      " ▸</td></tr>";
  }

  // The one line kept from the sessions drawer: the ARITHMETIC behind the
  // count. The drawer's headline restated the rows above it and is gone; this
  // says why the count is what it is, which no row can. It appears only when
  // there is something to derive.
  const footnote = FleetSessionRows.rosterFootnote(d.roster);
  const reconcile = FleetSessionRows.reconciliation(d.roster, shown.length);
  if (footnote || reconcile) {
    html +=
      '<tr class="rosterfoot"><td colspan="' +
      columnCount() +
      '">' +
      (reconcile ? "<b>" + escRedact(reconcile) + "</b> · " : "") +
      '<span class="term" data-term="roster">how this count is derived</span> · ' +
      escRedact(footnote || d.roster.derivation || "") +
      "</td></tr>";
  }
  $("rosterbody").innerHTML = html;
}

// ----------------------------------------------------------------- drawers

function renderDrawers(d) {
  $("procsummary").textContent =
    d.procs.length + " matched · read-only telemetry";
  $("procsbody").innerHTML =
    '<table class="grid"><thead><tr><th class="num">pid</th><th>vendor</th><th>role</th>' +
    '<th>session</th><th class="num">tokens today</th><th class="num">est $</th>' +
    '<th class="num">elapsed</th><th class="num">cpu</th><th class="num">rss</th>' +
    "<th>command</th></tr></thead><tbody>" +
    d.procs
      .map(
        (p) =>
          '<tr><td class="num mono-cell" style="color:var(--sig)">' +
          p.pid +
          "</td><td>" +
          esc(p.vendor) +
          '</td><td class="dim">' +
          esc(p.role) +
          "</td><td>" +
          (p.sessionName ? "<b>" + escRedact(p.sessionName) + "</b> " : "") +
          '<span class="dim mono-cell">' +
          esc((p.sessionId || "unmapped").slice(0, 8)) +
          '</span></td><td class="num">' +
          (p.tokens === null ? "—" : tokens(p.tokens)) +
          '</td><td class="num">' +
          (p.cost === null ? "—" : usd(p.cost)) +
          '</td><td class="num dim">' +
          esc(p.etime) +
          '</td><td class="num">' +
          p.cpu.toFixed(1) +
          '</td><td class="num dim">' +
          p.rssMb.toFixed(0) +
          'M</td><td class="mono-cell dim">' +
          escRedact(p.cmd) +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table>";

  const ship = d.ship || { repos: [], prs: [], commitCount: 0, prCount: 0 };
  // Every figure in this line is scoped to the same local day. The PR count was
  // not: it was every pr-link record the transcripts still held, so one sentence
  // carried two meanings of "today" and the number only ever climbed.
  const older = Math.max(0, (ship.prCountWindow || 0) - (ship.prCount || 0));
  $("shipsummary").textContent =
    (ship.commitCount || 0) +
    " commits · " +
    (ship.mergeCount || 0) +
    " merges · " +
    (ship.prCount || 0) +
    " PRs opened from this machine today" +
    (older ? " · " + older + " older in the transcript window" : "");
  $("shipbody").innerHTML =
    '<div class="emptyline">' +
    esc(ship.source || "") +
    "</div>" +
    '<table class="grid"><thead><tr><th>repository</th><th>branch</th>' +
    '<th class="num">commits</th><th class="num">merges</th><th>most recent</th></tr></thead><tbody>' +
    ship.repos
      .map(
        (r) =>
          "<tr><td><b>" +
          escRedact(r.name) +
          '</b></td><td class="mono-cell dim">' +
          escRedact(r.branch || "—") +
          '</td><td class="num">' +
          r.commits +
          '</td><td class="num">' +
          r.merges +
          '</td><td class="mono-cell dim">' +
          escRedact((r.recent[0] && r.recent[0].subject) || "—") +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table>" +
    (ship.prs.length
      ? '<table class="grid"><thead><tr><th class="num">pr</th><th>repository</th>' +
        '<th class="num">opened</th></tr></thead><tbody>' +
        ship.prs
          .map(
            (p) =>
              '<tr><td class="num" style="color:var(--sig)">#' +
              esc(p.number) +
              "</td><td>" +
              escRedact(p.repo || "—") +
              '</td><td class="num dim">' +
              ago(p.ts) +
              "</td></tr>",
          )
          .join("") +
        "</tbody></table>"
      : "");
}

// -------------------------------------------------------------- instrument

function renderInstrument(d) {
  const i = d.instrument;
  const bad =
    i.badLines > 0 ||
    d.header.unpriced ||
    d.meta.scan.error ||
    i.priceTableExpired;
  const el = $("instrument");
  el.className = bad ? "bad" : "";
  $("instrumenttext").textContent =
    "dedup " +
    i.dedupRatio.toFixed(2) +
    "× · " +
    (i.usageLines - i.responses).toLocaleString() +
    "/" +
    i.usageLines.toLocaleString() +
    " duplicate usage lines collapsed · widest id span " +
    i.dedupSpanMax +
    " · price table " +
    i.priceTableDate +
    " (" +
    i.priceTableSource +
    ")" +
    (i.priceTableExpired ? " · ▲ " + i.priceTableWarning : "") +
    " · cache write 1.25×/2.0×, read 0.10× · " +
    i.badLines +
    " unparsed · " +
    d.meta.scan.files +
    " files, " +
    bytes(d.meta.scan.bytesTotal) +
    " read in total / " +
    bytes(d.meta.scan.bytes) +
    " this pass, scan " +
    d.meta.scan.ms +
    "ms · " +
    (d.meta.scan.error || "no scan error") +
    " · " +
    d.meta.network;
}

function renderRail(d) {
  $("host").textContent = "· " + d.meta.host;
  $("stamp").textContent =
    "table " +
    d.instrument.priceTableDate +
    " · " +
    new Date(d.meta.now).toLocaleTimeString() +
    " · scan " +
    d.meta.scan.ms +
    "ms · " +
    Math.round(state.pollMs / 1000) +
    "s";
  const red = $("redcount");
  if (d.redaction && d.redaction.count > 0) {
    red.hidden = false;
    red.textContent = "▲ " + d.redaction.count + " redacted";
    red.title = Object.entries(d.redaction.kinds)
      .map(([k, n]) => k + " ×" + n)
      .join(", ");
  } else {
    red.hidden = true;
  }
  // The bundled table is only verified up to its expiry day. Past it the
  // dollars stay (there is nothing truer to compute from) and this warning
  // rides beside every one of them.
  const warn = $("pricewarn");
  if (d.instrument.priceTableExpired) {
    warn.hidden = false;
    warn.textContent = "▲ " + d.instrument.priceTableWarning;
    warn.title =
      "The bundled price table was last verified on " +
      d.instrument.priceTableExpiry +
      ". Rates may have changed since; treat every dollar as drift-prone until lib/prices.js is re-verified.";
  } else {
    warn.hidden = true;
  }
  $("latched").innerHTML = (d.events || [])
    .map(
      (e) =>
        '<button class="latch' +
        (e.kind === "DEAD" ? " dead" : "") +
        '" data-ack="' +
        e.id +
        '">▲ ' +
        escRedact(e.text) +
        " · " +
        new Date(e.at).toLocaleTimeString() +
        " ✕</button>",
    )
    .join("");
}

// ---------------------------------------------------------- acknowledgement

async function acknowledge(id) {
  const response = await fetch("/api/ack", {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...CONSOLE_HEADERS,
    },
    body: JSON.stringify({ id }),
  });
  return { status: response.status, body: await response.json() };
}

// ------------------------------------------------------------------- wiring

function visibleRows() {
  if (!state.data) return [];
  const needle = state.filter.trim().toLowerCase();
  // Use the painted row order so keyboard expansion targets the visible row.
  const all = applyHeldOrder(
    sessionRows(state.data).filter((r) => matches(r, needle)),
  );
  return state.showCold ? all : all.filter((r) => r.state !== "COLD");
}

function render(d) {
  state.data = d;
  state.snapshotNow = Number(d.meta && d.meta.now) || null;
  state.pollMs = d.meta.pollMs || 10000;
  if (typeof schedulePolling === "function") schedulePolling();
  // The glossary first: every other renderer may attach a definition to a
  // number, and a definition that is not loaded yet is a tooltip that says
  // nothing on the first paint.
  renderGlossary(d);
  renderRail(d);
  renderMaster(d);
  renderProgressTrend(d);
  renderSpectrum(d);
  renderBurn(d);
  renderRoster(d);
  renderBoard(d);
  renderDrawers(d);
  renderFleet(d);
  renderProgress(d);
  renderInstrument(d);
  wireTerms();
}

async function tick() {
  try {
    const [response, historyResponse] = await Promise.all([
      fetch("/api", { cache: "no-store", headers: CONSOLE_HEADERS }),
      fetch(
        "/api/history?period=" +
          encodeURIComponent(state.period) +
          "&project=" +
          encodeURIComponent(state.project),
        { cache: "no-store", headers: CONSOLE_HEADERS },
      ).catch(() => null),
    ]);
    const data = await response.json();
    // History renders before the main snapshot on each tick. Set the shared
    // display clock first so deterministic demo timestamps never age in place.
    state.snapshotNow = Number(data.meta && data.meta.now) || null;
    if (historyResponse && historyResponse.ok) {
      try {
        state.history = await historyResponse.json();
        renderHistory(state.history);
        renderProjectOptions(state.history);
        renderProjects(state.history);
        renderEffort(state.history);
      } catch {
        /* the main panel still renders; history refreshes next tick */
      }
    }
    if (data.error) {
      $("stamp").textContent = "scan error · " + data.error;
      return;
    }
    // Only the ROW ORDER is pinned while the pointer or the keyboard is in the
    // roster. Discarding the whole response instead froze the clock, the master
    // word, the burn band and the spend spectrum for as long as the pointer
    // rested anywhere in the largest region of the window — 12 polls fetched
    // and thrown away in 77 seconds, with the page silently showing stale
    // dollars. What must not move under the hand is the order, and that is what
    // is held.
    if (orderHeld()) {
      if (!state.heldOrder) {
        state.heldOrder = sessionRows(state.data).map((r) => r.key);
      }
      $("holdchip").hidden = false;
    } else {
      state.heldOrder = null;
      $("holdchip").hidden = true;
    }
    render(data);
  } catch (error) {
    $("stamp").textContent = "disconnected · " + error.message;
  }
}

/** Re-impose the order that was on screen when the hold started. */
function applyHeldOrder(rows) {
  if (!state.heldOrder) return rows;
  const rank = new Map(state.heldOrder.map((key, index) => [key, index]));
  return rows
    .slice()
    .sort(
      (a, b) =>
        (rank.has(a.key) ? rank.get(a.key) : Infinity) -
        (rank.has(b.key) ? rank.get(b.key) : Infinity),
    );
}

function setCursor(next) {
  const rows = visibleRows();
  if (!rows.length) return;
  state.cursor = Math.max(0, Math.min(rows.length - 1, next));
  // Focus is what arms the order hold, so moving the cursor pins the order the
  // cursor is indexing into.
  const roster = $("roster");
  if (document.activeElement !== roster) {
    try {
      roster.focus({ preventScroll: true });
    } catch {
      roster.focus();
    }
  }
  if (!state.heldOrder && state.data) {
    state.heldOrder = sessionRows(state.data).map((r) => r.key);
  }
  if (state.data) renderRoster(state.data);
  const el = document.querySelector("tr.cursor");
  if (el) el.scrollIntoView({ block: "nearest" });
}

function toggleDrawer(name) {
  state.drawers[name] = !state.drawers[name];
  save("drawer." + name, state.drawers[name]);
  applyDrawers();
}

const DRAWERS = ["projects", "effort", "procs", "ship", "fleet"];

function applyDrawers() {
  const labels = {
    projects: "projects",
    effort: "effort",
    procs: "processes",
    ship: "shipped today",
    fleet: "fleet",
  };
  for (const name of DRAWERS) {
    const body = $(name + "body");
    body.hidden = !state.drawers[name];
    const button = document.querySelector(
      'button[data-drawer="' + name + '"] span',
    );
    button.textContent = (state.drawers[name] ? "▾ " : "▸ ") + labels[name];
  }
}

document.addEventListener("keydown", (event) => {
  if (event.target === $("filter")) {
    if (event.key === "Escape" || event.key === "Enter") {
      $("filterwrap").classList.remove("on");
      $("filter").blur();
      if (event.key === "Escape") {
        state.filter = "";
        $("filter").value = "";
        if (state.data) renderRoster(state.data);
      }
    }
    return;
  }
  if (event.target === $("period") || event.target === $("project")) return;
  // A focused definition target owns Enter and space; the roster's own space
  // binding must not also fire and expand whatever row the cursor is on.
  if (event.target.closest && event.target.closest("[data-term]")) return;
  if (document.querySelector("dialog[open]")) return;
  const rows = visibleRows();
  switch (event.key) {
    case "j":
      setCursor(state.cursor + 1);
      break;
    case "k":
      setCursor(state.cursor - 1);
      break;
    case " ": {
      event.preventDefault();
      const row = rows[state.cursor];
      if (!row) break;
      if (state.expanded.has(row.key)) state.expanded.delete(row.key);
      else state.expanded.add(row.key);
      if (state.data) renderRoster(state.data);
      break;
    }
    case "g": {
      let best = 0;
      rows.forEach((r, i) => {
        if (r.hot > (rows[best] ? rows[best].hot : -1)) best = i;
      });
      setCursor(best);
      break;
    }
    case "/":
      event.preventDefault();
      $("filterwrap").classList.add("on");
      $("filter").focus();
      break;
    case "c":
      state.showCold = !state.showCold;
      save("showCold", state.showCold);
      if (state.data) renderRoster(state.data);
      break;
    case "p":
      toggleDrawer("procs");
      break;
    case "s":
      toggleDrawer("ship");
      break;
    case "f":
      toggleDrawer("fleet");
      break;
    case "o":
      toggleDrawer("projects");
      break;
    case "e":
      toggleDrawer("effort");
      break;
    case "n": {
      // Cycle through the projects that actually have activity, then back to
      // all. A scope you cannot leave with the same key is a trap.
      const order = ["all", ...state.projects];
      const next = order[(order.indexOf(state.project) + 1) % order.length];
      setProject(next);
      break;
    }
    case "t": {
      const next =
        PERIOD_ORDER[
          (PERIOD_ORDER.indexOf(state.period) + 1) % PERIOD_ORDER.length
        ];
      setPeriod(next);
      break;
    }
    case "u":
      swapBurnUnit();
      break;
    case "a":
      acknowledge("all").then(tick);
      break;
    case "Escape":
      $("roster").blur();
      break;
    case "?":
      openGlossary(null);
      break;
    default:
      break;
  }
});

$("filter").addEventListener("input", (event) => {
  state.filter = event.target.value;
  state.cursor = 0;
  if (state.data) renderRoster(state.data);
});

function setPeriod(period) {
  if (!PERIOD_ORDER.includes(period)) return;
  state.period = period;
  save("period", period);
  $("period").value = period;
  tick();
}

/**
 * Keep the selector in step with what is actually on disk.
 *
 * Rebuilt only when the option list has genuinely changed, because replacing
 * the <select>'s children on every ten-second poll would close it under the
 * pointer mid-choice.
 */
function renderProjectOptions(h) {
  const list = (h && h.projects && h.projects.projects) || [];
  const signature = list.map((p) => p.slug).join("\u0000");
  if (signature !== state.projects.join("\u0000")) {
    state.projects = list.map((p) => p.slug);
    const select = $("project");
    select.innerHTML =
      '<option value="all">all projects</option>' +
      list
        .map(
          (p) =>
            '<option value="' +
            esc(p.slug) +
            '">' +
            esc(p.label) +
            " · " +
            tokens(p.total) +
            "</option>",
        )
        .join("");
  }
  const select = $("project");
  // A stored slug with no activity in this period is kept as the selection
  // rather than silently reset — the scope survives changing the period.
  if (
    state.project !== "all" &&
    !state.projects.includes(state.project) &&
    !Array.from(select.options).some((o) => o.value === state.project)
  ) {
    select.insertAdjacentHTML(
      "beforeend",
      '<option value="' +
        esc(state.project) +
        '">' +
        esc(state.project) +
        " · nothing in this period</option>",
    );
  }
  select.value = state.project;
}

function setProject(slug) {
  state.project = slug || "all";
  save("project", state.project);
  $("project").value = state.project;
  tick();
}

$("period").value = PERIOD_ORDER.includes(state.period) ? state.period : "24h";
$("period").addEventListener("change", (event) => {
  setPeriod(event.target.value);
});
$("project").addEventListener("change", (event) => {
  setProject(event.target.value);
});

$("roster").addEventListener("mouseenter", () => {
  state.hover = true;
});
$("roster").addEventListener("mouseleave", () => {
  state.hover = false;
  release();
});

// Keyboard focus arms the ordering hold too. Without it, a poll can re-sort
// rows underneath j/k navigation. `setCursor` focuses the roster, so keyboard
// navigation pins the same order the pointer sees.
$("roster").addEventListener("focus", () => {
  state.focused = true;
  $("holdchip").hidden = false;
});
$("roster").addEventListener("blur", () => {
  state.focused = false;
  release();
});

function release() {
  if (orderHeld()) return;
  state.heldOrder = null;
  $("holdchip").hidden = true;
  if (state.data) renderRoster(state.data);
}

$("roster").addEventListener("click", (event) => {
  const fold = event.target.closest("[data-fold]");
  if (fold) {
    state.showCold = true;
    save("showCold", true);
    if (state.data) renderRoster(state.data);
    return;
  }
  const row = event.target.closest("tr.row");
  if (!row) return;
  state.cursor = Number(row.dataset.index);
  const key = row.dataset.key;
  if (state.expanded.has(key)) state.expanded.delete(key);
  else state.expanded.add(key);
  if (state.data) renderRoster(state.data);
});

$("foot").addEventListener("click", (event) => {
  const scope = event.target.closest("[data-scope]");
  if (scope) {
    setProject(
      scope.dataset.scope === state.project ? "all" : scope.dataset.scope,
    );
    return;
  }
  const drawer = event.target.closest("[data-drawer]");
  if (drawer) {
    toggleDrawer(drawer.dataset.drawer);
    return;
  }
});

// Any defined word on the screen is a way into the reference. One delegated
// listener, so a term rendered by any future panel is wired without being
// remembered.
document.addEventListener("click", (event) => {
  const term = event.target.closest("[data-term]");
  if (!term) return;
  if (event.target.closest("dialog")) return;
  event.preventDefault();
  openGlossary(term.dataset.term);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const term = event.target.closest && event.target.closest("[data-term]");
  if (!term || event.target.closest("dialog")) return;
  event.preventDefault();
  openGlossary(term.dataset.term);
});
// Keep the burn-unit action available through both the visible control and `u`.
$("burnswap").addEventListener("click", swapBurnUnit);

$("glossarykey").addEventListener("click", () => openGlossary(null));
for (const button of document.querySelectorAll(".dtab")) {
  button.addEventListener("click", () => showTab(button.dataset.tab));
}

$("latched").addEventListener("click", (event) => {
  const button = event.target.closest("[data-ack]");
  if (button) acknowledge(Number(button.dataset.ack)).then(tick);
});

$("helpclose").addEventListener("click", () => $("helpdialog").close());

applyDrawers();

// --poll-ms is documented in --help and in the README. It only ever changed a
// label: the interval was the literal 10000. The timer is re-armed whenever the
// server reports a different value, so the flag and the rail agree.
let pollTimer = null;
function schedulePolling() {
  const interval = Math.max(500, Number(state.pollMs) || 10000);
  if (pollTimer && pollTimer.interval === interval) return;
  if (pollTimer) clearInterval(pollTimer.id);
  pollTimer = { interval, id: setInterval(tick, interval) };
}

schedulePolling();
tick();

// A column drop at a new width changes how many columns a tree row must span.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.data) renderRoster(state.data);
  }, 120);
});

// Registering a worker is what makes Chrome and Edge offer "Install app".
// It caches nothing; see public/sw.js.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* installability is a convenience; the panel works without it */
  });
}
