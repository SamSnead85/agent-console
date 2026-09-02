/*
 * <agent-console-panel> — the console, small enough to put in someone else's page.
 *
 * One file, no build step, no framework, no dependency. Drop the script into a
 * command center, write the tag, and a compact instrument appears: today's
 * spend, live sessions, burn, and the projects the money went to.
 *
 * Three decisions worth stating, because each one is a refusal:
 *
 *  1. **Shadow DOM, always.** A panel that inherits the host page's CSS looks
 *     different in every product it lands in, and a panel that leaks its own
 *     CSS breaks the page it was invited into. The shadow root ends both.
 *     Everything a host is allowed to restyle is a documented custom property,
 *     which pierces the boundary by design.
 *
 *  2. **It renders what it was given, or it says what went wrong.** There is no
 *     state in which this shows a plausible zero. A console that is not running
 *     says so; an origin that was never allowlisted says THAT, specifically,
 *     because it is the mistake every first-time embedder makes and "failed to
 *     fetch" sends them looking in the wrong place for an hour.
 *
 *  3. **It never writes.** The console exposes an acknowledge route; this panel
 *     does not call it. An embedded widget that can mutate the thing it
 *     observes is a surface nobody audited.
 *
 * Usage:
 *   <script src="http://127.0.0.1:6787/panel.js"></script>
 *   <agent-console-panel src="http://127.0.0.1:6787"></agent-console-panel>
 *
 * The console must be started with that page's origin allowed:
 *   agent-console --embed http://localhost:3000
 */

"use strict";

(function () {
  const TAG = "agent-console-panel";
  if (customElements.get(TAG)) return;

  const DEFAULT_POLL_MS = 15000;
  const MIN_POLL_MS = 2000;

  const CSS = `
    :host {
      /* Every one of these is a documented knob. A host restyles the panel by
         setting them; nothing else about this element is public API. */
      --ac-bg: #0e1319;
      --ac-fg: #eaf0f6;
      --ac-mute: #8695a6;
      --ac-rule: #232b35;
      --ac-accent: #5aa9ff;
      --ac-live: #3fd07a;
      --ac-warn: #f0b429;
      --ac-bad: #ff6b6b;
      --ac-radius: 0px;
      --ac-font: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
      --ac-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

      display: block;
      background: var(--ac-bg);
      color: var(--ac-fg);
      border: 1px solid var(--ac-rule);
      border-radius: var(--ac-radius);
      font-family: var(--ac-font);
      font-size: 12.5px;
      line-height: 1.45;
      font-variant-numeric: tabular-nums;
      overflow: hidden;
      container-type: inline-size;
    }
    :host([hidden]) { display: none; }

    .head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--ac-rule);
    }
    .name {
      font-family: var(--ac-mono);
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--ac-mute);
    }
    .stamp { font-family: var(--ac-mono); font-size: 10px; color: var(--ac-mute); }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
      gap: 1px;
      background: var(--ac-rule);
    }
    .cell { background: var(--ac-bg); padding: 10px 12px 11px; min-width: 0; }
    .label {
      font-family: var(--ac-mono);
      font-size: 9.5px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--ac-mute);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .value {
      font-size: 21px;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-top: 3px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sub { font-family: var(--ac-mono); font-size: 10px; color: var(--ac-mute); margin-top: 2px; }
    .live { color: var(--ac-live); }
    .warn { color: var(--ac-warn); }
    .bad { color: var(--ac-bad); }

    .rows { border-top: 1px solid var(--ac-rule); }
    .row {
      display: grid;
      grid-template-columns: 8px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 5px 12px;
      font-family: var(--ac-mono);
      font-size: 11px;
    }
    .row + .row { border-top: 1px solid color-mix(in srgb, var(--ac-rule) 55%, transparent); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ac-mute); }
    .dot.on { background: var(--ac-live); }
    .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ac-fg); }
    .num { color: var(--ac-mute); white-space: nowrap; }

    .note {
      padding: 12px;
      font-family: var(--ac-mono);
      font-size: 11px;
      line-height: 1.6;
      color: var(--ac-mute);
    }
    .note b { color: var(--ac-fg); font-weight: 600; }
    .note code {
      color: var(--ac-accent);
      background: color-mix(in srgb, var(--ac-accent) 12%, transparent);
      padding: 0 4px;
      display: inline-block;
    }
    .note.bad b { color: var(--ac-bad); }

    @container (max-width: 320px) {
      .grid { grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); }
      .value { font-size: 18px; }
    }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  `;

  function num(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
    return String(Math.round(v));
  }

  function usd(n) {
    return n === null || n === undefined ? "—" : "$" + Number(n).toFixed(2);
  }

  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(
      /[&<>"']/gu,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  class AgentConsolePanel extends HTMLElement {
    static get observedAttributes() {
      return ["src", "poll", "rows"];
    }

    constructor() {
      super();
      this._root = this.attachShadow({ mode: "open" });
      this._timer = null;
      this._aborter = null;
      this._style = document.createElement("style");
      this._style.textContent = CSS;
      this._body = document.createElement("div");
      this._root.append(this._style, this._body);
    }

    get src() {
      // Same-origin by default: served from the console itself, the panel
      // needs no configuration at all.
      const raw = this.getAttribute("src");
      if (!raw) return "";
      return raw.replace(/\/+$/u, "");
    }

    get pollMs() {
      const raw = Number(this.getAttribute("poll"));
      if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_POLL_MS;
      // A panel in someone else's dashboard must not be able to hammer the
      // console because an attribute said 1.
      return Math.max(MIN_POLL_MS, raw);
    }

    get rowLimit() {
      const raw = Number(this.getAttribute("rows"));
      if (!Number.isFinite(raw) || raw < 0) return 5;
      return Math.min(25, Math.floor(raw));
    }

    connectedCallback() {
      if (!this.hasAttribute("role")) this.setAttribute("role", "region");
      if (!this.hasAttribute("aria-label")) {
        this.setAttribute("aria-label", "AI coding session usage");
      }
      this._renderNote("connecting…");
      this._start();
    }

    disconnectedCallback() {
      this._stop();
    }

    attributeChangedCallback(name, before, after) {
      if (before === after || !this.isConnected) return;
      this._stop();
      this._start();
    }

    _start() {
      void this._tick();
      this._timer = setInterval(() => void this._tick(), this.pollMs);
    }

    _stop() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      if (this._aborter) this._aborter.abort();
      this._aborter = null;
    }

    async _tick() {
      if (this._aborter) this._aborter.abort();
      const aborter = new AbortController();
      this._aborter = aborter;
      try {
        const response = await fetch(this.src + "/api", {
          cache: "no-store",
          signal: aborter.signal,
          headers: { "X-Agent-Console": "1" },
        });
        if (!response.ok) {
          this._renderNote(
            `the console answered <b>${esc(response.status)}</b>`,
            true,
          );
          return;
        }
        this._render(await response.json());
        this.dispatchEvent(new CustomEvent("agent-console-update"));
      } catch (error) {
        if (aborter.signal.aborted) return;
        // A blocked cross-origin read and a console that is not running are
        // both TypeErrors here, and the browser deliberately will not say
        // which. Naming both beats naming neither: the allowlist is the
        // mistake every first-time embedder makes.
        this._renderNote(
          this.src && this.src !== window.location.origin
            ? `no answer from <b>${esc(this.src)}</b>. Either it is not ` +
                `running, or this page's origin is not allowed — start it ` +
                `with <code>agent-console --embed ${esc(window.location.origin)}</code>`
            : "the console is not running — start it with <code>agent-console</code>",
          true,
        );
      }
    }

    _renderNote(html, bad) {
      this._body.innerHTML =
        '<div class="note' + (bad ? " bad" : "") + '">' + html + "</div>";
    }

    _render(d) {
      const header = d.header || {};
      const roster = d.roster || {};
      const counts = roster.counts || {};
      const rows = Array.isArray(d.rows) ? d.rows : [];
      const burn = d.burn || {};

      /* A row marked `cumulative` carries a counter for the whole life of its
         thread, not for today. Codex writes those. Summing them beside
         day-scoped Claude totals produces a number that is not wrong by a
         little: measured here, 118 cumulative rows totalled 109.9 BILLION
         against a real day of 579 million, so the panel would have reported
         roughly 190x the truth and called it "today". The console's own
         header excludes them for exactly this reason; the panel follows it,
         and says how many it left out rather than hiding the exclusion. */
      const dayScoped = rows.filter((r) => !r.cumulative);
      const excluded = rows.length - dayScoped.length;

      const byProject = new Map();
      for (const row of dayScoped) {
        const key = row.project || "unattributed";
        byProject.set(key, (byProject.get(key) || 0) + (Number(row.total) || 0));
      }
      const top = [...byProject.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, this.rowLimit);

      /* Liveness is the roster's verdict, not a state string matched here.
         There are four states and two of them are live; re-deriving that in a
         panel is how the two answers drift apart. */
      const liveCount = Number.isFinite(Number(counts.live))
        ? Number(counts.live)
        : dayScoped.filter((r) => r.state === "LIVE" || r.state === "RUN").length;
      const liveProjects = new Set(
        dayScoped
          .filter((r) => r.state === "LIVE" || r.state === "RUN")
          .map((r) => r.project),
      );

      const machines = Number(counts.machines);
      const cells = [
        {
          label: "tokens today",
          value: num(header.total),
          sub:
            header.costTotal === undefined
              ? ""
              : usd(header.costTotal) + " est",
        },
        {
          label: "live now",
          value: String(liveCount),
          cls: liveCount ? "live" : "",
          sub: (counts.sessions ?? dayScoped.length) + " sessions",
        },
        {
          label: "burn",
          value:
            burn.tokensPerMinute === undefined || burn.tokensPerMinute === null
              ? "—"
              : num(burn.tokensPerMinute) + "/m",
          sub: "last 60 min",
        },
        {
          label: "projects",
          value: String(byProject.size),
          sub: Number.isFinite(machines)
            ? machines + (machines === 1 ? " machine" : " machines")
            : "",
        },
      ];

      const grid = cells
        .map(
          (c) =>
            '<div class="cell"><div class="label">' +
            esc(c.label) +
            '</div><div class="value ' +
            (c.cls || "") +
            '">' +
            esc(c.value) +
            "</div>" +
            (c.sub ? '<div class="sub">' + esc(c.sub) + "</div>" : "") +
            "</div>",
        )
        .join("");

      const list = top
        .map(
          ([project, total]) =>
            '<div class="row"><span class="dot' +
            (liveProjects.has(project) ? " on" : "") +
            '"></span><span class="who">' +
            esc(project) +
            '</span><span class="num">' +
            esc(num(total)) +
            "</span></div>",
        )
        .join("");

      const stamp = d.meta && d.meta.now ? new Date(d.meta.now) : null;
      this._body.innerHTML =
        '<div class="head"><span class="name">' +
        esc(d.brand || "agent console") +
        '</span><span class="stamp">' +
        (stamp
          ? esc(
              stamp.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              }),
            )
          : "—") +
        "</span></div>" +
        '<div class="grid">' +
        grid +
        "</div>" +
        (list ? '<div class="rows">' + list + "</div>" : "") +
        // The exclusion is stated. A quietly narrower number is the same
        // failure as a fabricated one, only harder to notice.
        (excluded
          ? '<div class="note">' +
            esc(excluded) +
            " cumulative " +
            (excluded === 1 ? "thread" : "threads") +
            " excluded: those counters cover a whole thread, not today" +
            "</div>"
          : "");
    }
  }

  customElements.define(TAG, AgentConsolePanel);
})();
