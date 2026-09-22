/*
 * The join page. It runs on the teammate's computer, from a link the console's
 * owner sent. The code is in the link's #fragment, which a browser never sends
 * to a server, so it reaches nothing but this page — and this page only puts it
 * into the one command the teammate copies. On screen it stays masked.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CODE = /^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/;
  const raw = decodeURIComponent((location.hash || "").slice(1)).toUpperCase().replace(/\s/g, "");
  const code = CODE.test(raw) ? raw : /^[2-9A-HJKMNP-TV-Z]{8}$/.test(raw) ? raw.slice(0, 4) + "-" + raw.slice(4) : null;
  const base = location.origin;
  let tarball = `${base}/agent-console.tgz`;
  let command = code ? `npx --yes ${tarball} join ${base} ${code}` : null;

  $("hubName").textContent = location.host;
  for (const el of document.querySelectorAll(".hubv")) el.textContent = base;
  if (!code) {
    $("noCode").hidden = false;
    $("cmd").textContent = "—";
    $("copyBtn").disabled = true;
  } else {
    $("cmd").textContent = command.replace(code, "••••-••••");
  }

  fetch("/api/join/info").then((r) => r.json()).then((info) => {
    $("ver").textContent = "v" + info.version;
    // the versioned name, so npx never runs a copy cached from an older hub
    tarball = `${base}/agent-console-${info.version}.tgz`;
    if (code) {
      command = `npx --yes ${tarball} join ${base} ${code}`;
      $("cmd").textContent = command.replace(code, "••••-••••");
    }
    for (const el of document.querySelectorAll(".tgzv")) el.textContent = tarball;
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
    $("status").textContent = ok ? "Copied. Paste it into the terminal and press Return." : "Copying is blocked here. Type the command instead — ask for the code if you need it.";
    $("copyBtn").textContent = ok ? "Copied" : "Copy";
  });
})();
