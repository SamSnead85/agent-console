/* Agent Console download page · behaviour. No network, no dependencies, no telemetry.
   Router (#/section), keyboard model, theme, OS detection, copy, hotspots, the cache-break calculator. */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const SPACES = ["overview", "install", "see", "cache", "privacy", "verify", "policy", "enterprise"];
  const app = $("#app"), toast = $("#toast"), sheet = $("#sheet"), scrim = $("#scrim");
  const phone = () => matchMedia("(max-width: 899px)").matches;

  /* ── theme: graphite by default, light authored; one preference, ll-theme ── */
  function theme() { return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"; }
  function setTheme(t, say) {
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.style.colorScheme = t;
    try { localStorage.setItem("ll-theme", t); } catch (e) { /* per-viewer convenience only */ }
    $("#themeBtn use").setAttribute("href", t === "light" ? "#i-moon" : "#i-sun");
    $("#themeBtn").setAttribute("aria-label", t === "light" ? "Switch to graphite" : "Switch to light");
    $("#themeBtn2").textContent = t === "light" ? "Light" : "Graphite";
    $$("img.shot").forEach((img) => { const want = t === "dark" && matchMedia("(prefers-reduced-motion: reduce)").matches && img.dataset.darkStatic ? img.dataset.darkStatic : img.dataset[t]; if (want && img.getAttribute("src") !== want) img.setAttribute("src", want); });
    if (say) note(t === "light" ? "Light" : "Graphite");
  }
  $("#themeBtn").addEventListener("click", () => setTheme(theme() === "light" ? "dark" : "light", true));
  $("#themeBtn2").addEventListener("click", () => setTheme(theme() === "light" ? "dark" : "light", true));
  setTheme(theme(), false);
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => setTheme(theme(), false));

  /* ── router: one space on at a time; the URL carries it; back and forward work ── */
  let current = null;
  function show(name, push) {
    if (!SPACES.includes(name)) name = "overview";
    if (name === current) return;
    current = name;
    $$(".space").forEach((s) => s.setAttribute("data-on", s.dataset.space === name ? "yes" : "no"));
    $$("#rail a[data-space]").forEach((a) => { if (a.dataset.space === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    document.title = (name === "overview" ? "Agent Console" : $(`.space[data-space="${name}"]`).getAttribute("aria-label") + " · Agent Console") + " · LockedIn Labs";
    const hash = "#/" + name;
    if (push && location.hash !== hash) history.pushState({ space: name }, "", hash);
    if (phone()) { const el = $(`.space[data-space="${name}"]`); if (name === "overview") scrollTo(0, 0); else if (el) el.scrollIntoView({ block: "start" }); }
    else { $$(".space[data-on='yes'] .pane-b").forEach((b) => { b.scrollTop = 0; }); }
  }
  function fromHash() { const m = location.hash.match(/^#\/?([a-z]+)/); return m ? m[1] : "overview"; }
  addEventListener("popstate", () => show(fromHash(), false));
  addEventListener("hashchange", () => show(fromHash(), false));
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#/"]'); if (!a) return;
    e.preventDefault(); show(a.getAttribute("href").slice(2), true);
  });
  show(fromHash(), false);
  // on a phone every section is drawn; the rail rows only scroll
  function phoneMode() { if (phone()) $$(".space").forEach((s) => s.setAttribute("data-on", "yes")); else show(current, false), $$(".space").forEach((s) => s.setAttribute("data-on", s.dataset.space === current ? "yes" : "no")); }
  matchMedia("(max-width: 899px)").addEventListener("change", phoneMode); phoneMode();

  /* ── keyboard: plain keys only; nothing fires while typing ── */
  function typing(e) { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable); }
  function openSheet(open) { sheet.setAttribute("data-open", open ? "yes" : "no"); scrim.setAttribute("data-open", open ? "yes" : "no"); }
  scrim.addEventListener("click", () => openSheet(false));
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
    const i = SPACES.indexOf(current);
    if (e.key === "Escape") { openSheet(false); return; }
    if (e.key === "?") { openSheet(sheet.getAttribute("data-open") !== "yes"); e.preventDefault(); return; }
    if (/^[1-8]$/.test(e.key)) { show(SPACES[+e.key - 1], true); e.preventDefault(); return; }
    if (e.key === "]" || e.key === "j" || e.key === "J" || e.key === "ArrowRight") { show(SPACES[Math.min(SPACES.length - 1, i + 1)], true); e.preventDefault(); return; }
    if (e.key === "[" || e.key === "k" || e.key === "K" || e.key === "ArrowLeft") { show(SPACES[Math.max(0, i - 1)], true); e.preventDefault(); return; }
    if (e.key === "t" || e.key === "T") { setTheme(theme() === "light" ? "dark" : "light", true); return; }
  });

  /* ── toast ── */
  let toastT = 0;
  function note(text) { toast.textContent = text; toast.setAttribute("data-open", "yes"); clearTimeout(toastT); toastT = setTimeout(() => toast.setAttribute("data-open", "no"), 1600); }

  /* ── the operating system: detected once, changeable everywhere ── */
  function detectOS() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    const ua = navigator.userAgent || "";
    if (/Mac/i.test(p) && !/iPhone|iPad/i.test(ua)) return "mac";
    if (/Win/i.test(p)) return "win";
    if (/Linux|X11|CrOS/i.test(p) && !/Android/i.test(ua)) return "linux";
    return null; // unknown (a phone, a tablet): say "your OS" and show the shell-neutral lines
  }
  const OS_NAME = { mac: "macOS", win: "Windows", linux: "Linux" };
  let os = null;
  function setOS(next) {
    os = next;
    $$("[data-os]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.os === os ? "true" : "false"));
    $$("[data-os-only]").forEach((el) => { const list = el.dataset.osOnly.split(/\s+/); const on = os ? list.includes(os) : list.includes("mac"); el.setAttribute("data-os-on", on ? "yes" : "no"); });
    $("#osName").textContent = os ? OS_NAME[os] : "your OS";
  }
  $$("[data-os]").forEach((b) => b.addEventListener("click", () => setOS(b.dataset.os)));
  setOS(detectOS());

  /* Native downloads appear only when the verified release includes them. */
  const native = JSON.parse($("#native-downloads")?.textContent || "{}");
  const download = $("#osBtn");
  const picker = document.createElement("dialog");
  picker.className = "download-picker";
  document.body.appendChild(picker);
  download.addEventListener("click", (e) => {
    const platform = os === "mac" ? "darwin" : os === "win" ? "win32" : os;
    const choices = Object.entries(native).filter(([name]) => !platform || name.startsWith(`agent-console-${platform}-`));
    if (!choices.length) return; // older releases have only the Node tarball
    e.preventDefault();
    if (choices.length === 1) { location.href = choices[0][1].url; return; }
    picker.replaceChildren();
    const title = document.createElement("h2"); title.textContent = "Choose your processor"; picker.appendChild(title);
    const sub = document.createElement("p"); sub.textContent = "Check your computer's About screen if you are unsure."; picker.appendChild(sub);
    choices.forEach(([name, item]) => {
      const a = document.createElement("a"); a.className = "tb"; a.href = item.url;
      const system = name.includes("darwin") ? "macOS" : name.includes("linux") ? "Linux" : "Windows";
      const cpu = name.includes("arm64") ? (system === "macOS" ? "Apple silicon" : "ARM64") : "Intel / x64";
      a.textContent = `${system} · ${cpu}`; picker.appendChild(a);
      const hash = document.createElement("code"); hash.textContent = `SHA-256 ${item.sha256}`; picker.appendChild(hash);
    });
    const verify = document.createElement("a"); verify.href = "#/verify"; verify.textContent = "How to verify a download";
    verify.addEventListener("click", () => picker.close()); picker.appendChild(verify);
    const close = document.createElement("button"); close.className = "tb"; close.type = "button"; close.textContent = "Close";
    close.addEventListener("click", () => picker.close()); picker.appendChild(close);
    picker.showModal();
  });

  /* ── copy: the clipboard when the page has it; a selection when it does not ── */
  function copyFallback(text) { const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; } ta.remove(); return ok; }
  $$(".copy[data-copy]").forEach((b) => {
    const label = $("span", b);
    b.addEventListener("click", async () => {
      const text = b.dataset.copy; let ok = false;
      try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch (e) { ok = false; }
      if (!ok) ok = copyFallback(text);
      if (ok) { b.setAttribute("data-done", "yes"); if (label) label.textContent = "Copied"; note("Copied to the clipboard"); setTimeout(() => { b.removeAttribute("data-done"); if (label) label.textContent = "Copy"; }, 1600); }
      else { const code = b.parentElement && b.parentElement.querySelector("code"); if (code) { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } note("Select the line and copy it"); }
    });
  });

  /* ── hotspots: a reading and its place on the screen light together ── */
  function lit(key, on) { $$(`[data-hot="${key}"]`).forEach((el) => { if (on) el.setAttribute("data-lit", "yes"); else el.removeAttribute("data-lit"); }); }
  $$("[data-hot]").forEach((el) => {
    const k = el.dataset.hot;
    el.addEventListener("mouseenter", () => lit(k, true)); el.addEventListener("mouseleave", () => lit(k, false));
    el.addEventListener("focus", () => lit(k, true)); el.addEventListener("blur", () => lit(k, false));
    el.addEventListener("click", () => { const held = el.getAttribute("data-held") === "yes"; $$("[data-hot]").forEach((o) => { o.removeAttribute("data-held"); o.removeAttribute("data-lit"); }); if (!held) { $$(`[data-hot="${k}"]`).forEach((o) => { o.setAttribute("data-held", "yes"); o.setAttribute("data-lit", "yes"); }); const row = $(`.read[data-hot="${k}"]`); if (row && el.classList.contains("hot")) row.scrollIntoView({ block: "nearest" }); } });
  });

  /* ── the cache-break calculator: the console's own dated price table, list price, labelled ── */
  // usdPerMillion from lib/collector/prices.json (inventory checked 2026-09-20; Opus 5.5 from Anthropic's page, 2026-09-22)
  const PRICES = {
    "claude-opus-5-5": { name: "Claude Opus 5.5", vendor: "anthropic", fresh: 4, cw5m: 5, cr: 0.2 },
    "claude-sonnet-5": { name: "Claude Sonnet 5", vendor: "anthropic", fresh: 2, cw5m: 2.5, cr: 0.2 },
    "claude-fable-5-1": { name: "Claude Fable 5.1", vendor: "anthropic", fresh: 10, cw5m: 12.5, cr: 0.25 },
    "claude-haiku-4-5-20251001": { name: "Claude Haiku 4.5", vendor: "anthropic", fresh: 1, cw5m: 1.25, cr: 0.1 },
    "gpt-5.5": { name: "GPT-5.5", vendor: "openai", fresh: 5, cr: 0.5 },
    "gpt-6-astra": { name: "GPT-6 Astra", vendor: "openai", fresh: 10, cr: 1 },
  };
  const usd = (v, d) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const money2 = (v) => usd(v, 2);
  const writeRate = (m) => (m.vendor === "anthropic" ? m.cw5m : m.fresh); // what a rewritten prefix is billed at
  function calc() {
    const id = $("#calcModel").value, m = PRICES[id], prefix = +$("#calcPrefix").value, breaks = +$("#calcBreaks").value;
    const write = writeRate(m);
    const perBreak = prefix * (write - m.cr) / 1e6;               // extra over the read that would have served it
    $("#calcTable").innerHTML = Object.entries(PRICES).map(([k, p]) => {
      const w = writeRate(p), extra = prefix * (w - p.cr) / 1e6;
      return `<tr data-on="${k === id ? "yes" : "no"}"><td>${p.name}</td><td class="r">${money2(prefix * w / 1e6)}</td><td class="r">${money2(prefix * p.cr / 1e6)}</td><td class="r"><b>${money2(extra)}</b></td><td class="r">${money2(extra * breaks)}</td></tr>`;
    }).join("");
    $("#calcPrefixOut").textContent = prefix.toLocaleString("en-US") + " tokens";
    $("#calcBreaksOut").textContent = String(breaks);
    $("#calcBreak").textContent = money2(perBreak);
    $("#calcDay").textContent = money2(perBreak * breaks);
    $("#calcWeek").textContent = usd(perBreak * breaks * 5, 0);
    $("#calcWhy").textContent = prefix.toLocaleString("en-US") + " × (" + money2(write) + (m.vendor === "anthropic" ? " write − " : " input − ") + money2(m.cr) + (m.vendor === "anthropic" ? " read" : " cached") + ") per M";
    $("#calcBasis").textContent = m.vendor === "anthropic"
      ? "Anthropic bills a 5-minute cache write at 1.25× the input rate and a read at a tenth of it or less; the figure is the write minus the read that would have served the same prefix."
      : "OpenAI caches automatically with no write premium; a miss simply bills the prefix as input, so the figure is the input rate minus the cached rate.";
  }
  ["#calcModel", "#calcPrefix", "#calcBreaks"].forEach((s) => $(s).addEventListener("input", calc));
  calc();
})();
