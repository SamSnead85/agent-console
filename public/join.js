/*
 * The join page. It runs on the teammate's computer, from a link sent from the
 * console: http://<console>:<port>/join#<code>.<fingerprint>. The fragment
 * never leaves the browser, so the code reaches nothing but this page, and
 * this page only puts the whole link into the one command the teammate copies.
 * On screen the code stays masked.
 *
 * The command installs Agent Console from its GitHub release, never from the
 * console that served this page, and the reporter then checks the console's
 * certificate against the fingerprint in the link before it sends anything.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const REPO = "https://github.com/SamSnead85/agent-console";
  const [code, fingerprint] = decodeURIComponent((location.hash || "").slice(1)).split(".");
  const valid = /^[A-Za-z0-9_-]{22}$/.test(code || "") && /^[A-Za-z0-9_-]{43}$/.test(fingerprint || "");
  const link = location.href;
  let command = null;

  $("hubName").textContent = location.host;
  if (!valid) {
    $("noCode").hidden = false;
    $("cmd").textContent = "—";
    $("copyBtn").disabled = true;
  }

  fetch("/api/join/info").then((r) => r.json()).then((info) => {
    const version = String(info.version || "").replace(/[^0-9.]/g, "");
    const asset = `${REPO}/releases/download/v${version}/lockedinlabs-agent-console-${version}.tgz`;
    $("ver").textContent = "v" + version;
    for (const el of document.querySelectorAll(".verv")) el.textContent = version;
    $("releasePage").href = `${REPO}/releases/tag/v${version}`;
    for (const el of document.querySelectorAll(".restart")) el.textContent = `npx --yes ${asset} report`;
    if (valid) {
      command = `npx --yes ${asset} join "${link}"`;
      $("cmd").textContent = command.replace(code, "••••••••");
    }
    if (info.demo) { $("demoStamp").hidden = false; $("demoNote").hidden = false; }
  }).catch(() => { $("status").textContent = "That console is not answering right now. Check you are on the same network, then reload."; });

  // Not a secure context on a local network address, so the Clipboard API is
  // usually absent; a hidden text area and the copy command still work.
  $("copyBtn").addEventListener("click", async () => {
    if (!command) return;
    let ok = false;
    try { await navigator.clipboard.writeText(command); ok = true; } catch { /* fall through */ }
    if (!ok) {
      const area = $("clip");
      area.value = command;
      area.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      area.value = "";
    }
    $("status").textContent = ok ? "Copied. Paste it into the terminal and press Return." : "Copying is blocked here. Ask whoever sent the link for the command instead.";
    $("copyBtn").textContent = ok ? "Copied" : "Copy";
  });
})();
