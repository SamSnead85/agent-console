/*
 * The join page. It runs on the teammate's computer, from a link sent from the
 * console: http://<console>:<port>/join#<code>.<fingerprint>. The fragment
 * never leaves the browser, so the code reaches nothing but this page. On
 * screen the code stays masked.
 *
 * The page hands out a command to paste into a terminal, so nothing it cannot
 * vouch for goes into it. The whole fragment must be exactly a code and a
 * fingerprint; the link in the command is rebuilt from the page's own origin
 * and path and those two checked parts (never location.href, which would bring
 * a query string or anything else along); every character of it must come from
 * a short list that no shell gives a meaning to; and it goes in single quotes,
 * which sh, bash, zsh, fish and PowerShell all take literally.
 *
 * The command installs Agent Console from its GitHub release, never from the
 * console that served this page, and the reporter then checks the console's
 * certificate against the fingerprint in the link before it sends anything.
 * This page itself arrives over plain HTTP, so the console's owner can also
 * send the command straight from the console (SECURITY.md, "The join page").
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const REPO = "https://github.com/SamSnead85/agent-console";
  const FRAGMENT = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
  const SAFE_LINK = /^https?:\/\/(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?\/join#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
  const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;

  const parts = FRAGMENT.exec((location.hash || "").slice(1));
  const code = parts ? parts[1] : null;
  const rebuilt = parts ? location.origin + location.pathname + "#" + code + "." + parts[2] : null;
  const link = rebuilt && SAFE_LINK.test(rebuilt) ? rebuilt : null;
  const valid = link !== null;
  let command = null;

  $("hubName").textContent = location.host;
  if (!valid) {
    $("noCode").hidden = false;
    $("cmd").textContent = "—";
    $("copyBtn").disabled = true;
  }

  fetch("/api/join/info").then((r) => r.json()).then((info) => {
    const version = String(info.version || "");
    if (!VERSION.test(version)) throw new Error("unexpected version");
    const asset = `${REPO}/releases/download/v${version}/lockedinlabs-agent-console-${version}.tgz`;
    $("ver").textContent = "v" + version;
    for (const el of document.querySelectorAll(".verv")) el.textContent = version;
    $("releasePage").href = `${REPO}/releases/tag/v${version}`;
    for (const el of document.querySelectorAll(".restart")) el.textContent = `npx --yes ${asset} report`;
    if (valid) {
      command = `npx --yes ${asset} join '${link}'`;
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
