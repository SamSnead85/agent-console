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
 * console that served this page. It starts with a short check for `node -e`
 * (VERIFY, the same text as VERIFY_AND_RUN in lib/invocation.js) that runs
 * nothing until the file's SHA-256 matches the release's SHA256SUMS. The page
 * carries the whole command, check included (its text is the command with the
 * code masked); the check is folded on screen until "Show the check" opens it,
 * and Copy gives exactly what is shown except the join code. The check's
 * SHA-256 is published in the README and on each release page for comparison.
 * The reporter then checks the console's certificate against the fingerprint in
 * the link before it sends anything. This page itself arrives over plain HTTP,
 * so the console's owner can also send the command straight from the console
 * (SECURITY.md, "The join page").
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const REPO = "https://github.com/SamSnead85/agent-console";
  const FRAGMENT = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
  const SAFE_LINK = /^https?:\/\/(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?\/join#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
  const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
  const VERIFY = "const[u,...a]=process.argv.slice(1),p=require(`path`),n=p.basename(u),g=x=>fetch(x).then(r=>{if(!r.ok)throw Error(x+` answered `+r.status);return r.arrayBuffer()}).then(Buffer.from);(async()=>{if(!/^https:[/][/]github[.]com[/][A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+[/]releases[/]download[/]v[0-9.]+[/][A-Za-z0-9_.-]+[.]tgz(?![^])/.test(u))throw Error(`not a release file: `+u);const t=String(await g(p.posix.dirname(u)+`/SHA256SUMS`)).split(/[^0-9A-Za-z._-]+/),b=await g(u),h=require(`crypto`).createHash(`sha256`).update(b).digest(`hex`);if(h!==t[t.indexOf(n)-1])throw Error(n+` does not match the release SHA256SUMS; nothing was run`);const f=require(`fs`),d=p.join(require(`os`).homedir(),`.agent-console`,`releases`),k=p.join(d,n),w=process.platform==`win32`,q=String.fromCharCode(34);f.mkdirSync(d,{recursive:true});f.writeFileSync(k,b);console.error(n+` matches the release SHA256SUMS: `+h);const r=require(`child_process`).spawnSync(w?[`npx`,`--yes`,`file:`+k,...a].map(x=>q+x+q).join(` `):`npx`,w?[]:[`--yes`,`file:`+k,...a],{stdio:`inherit`,shell:w,env:{...process.env,AGENT_CONSOLE_PACKAGE:k}});process.exit(r.status??1)})().catch(e=>{console.error(String(e.message));process.exit(1)})";

  const parts = FRAGMENT.exec((location.hash || "").slice(1));
  const code = parts ? parts[1] : null;
  const rebuilt = parts ? location.origin + location.pathname + "#" + code + "." + parts[2] : null;
  const link = rebuilt && SAFE_LINK.test(rebuilt) ? rebuilt : null;
  const valid = link !== null;
  let command = null;
  let restart = null;

  // The command on screen: its text is the whole command; the check between the first two quotes is folded
  // behind "Show the check" so the eye lands on the file it fetches and the link it joins.
  const text = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function showCommand(el, shown) {
    el.textContent = shown;
    if (typeof el.innerHTML !== "string") return;
    const at = shown.indexOf("' ", "node -e '".length);
    if (!shown.startsWith("node -e '") || at < 0) return;
    const check = shown.slice("node -e '".length, at);
    el.innerHTML = `node -e '<span class="chk-fold" aria-hidden="true">…</span><span class="chk">${text(check)}</span>'${text(shown.slice(at + 1))}`;
  }

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
    const run = `node -e '${VERIFY}' ${asset}`;
    restart = `${run} report`;
    showCommand($("restart"), restart);
    $("restartBtn").disabled = false;
    if (valid) {
      command = `${run} join '${link}'`;
      showCommand($("cmd"), command.replace(code, "••••••••"));
    }
    // The DEMO stamp renders only when the console says it is a demonstration; a real console never shows it.
    if (info.demo) { $("demoStamp").hidden = false; $("demoNote").hidden = false; }
  }).catch(() => { $("status").textContent = "That console is not answering right now. Check you are on the same network, then reload."; });

  $("checkBtn").addEventListener("click", () => {
    const open = $("cmd").classList ? $("cmd").classList.toggle("open") : false;
    if ($("restart").classList) $("restart").classList.toggle("open", open);
    $("checkBtn").setAttribute("aria-pressed", String(open));
    $("checkBtn").textContent = open ? "Fold the check" : "Show the check";
  });

  // Not a secure context on a local network address, so the Clipboard API is
  // usually absent; a hidden text area and the copy command still work.
  const copy = async (text) => {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
    if (!ok) {
      const area = $("clip");
      area.value = text;
      area.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      area.value = "";
    }
    return ok;
  };
  $("copyBtn").addEventListener("click", async () => {
    if (!command) return;
    const ok = await copy(command);
    $("status").textContent = ok ? "Copied. Paste it into the terminal and press Return." : "Copying is blocked here. Ask whoever sent the link for the command instead.";
    $("copyBtn").textContent = ok ? "Copied" : "Copy";
  });
  $("restartBtn").addEventListener("click", async () => {
    if (!restart) return;
    const ok = await copy(restart);
    $("status").textContent = ok ? "Copied the command that starts reporting again." : "Copying is blocked here. Select the command and copy it by hand.";
    $("restartBtn").textContent = ok ? "Copied" : "Copy";
  });

  // The theme toggle, as the console has it; the choice is kept in this browser.
  const root = document.documentElement;
  const currentTheme = () => (root && root.getAttribute("data-theme")) || (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const labelTheme = () => { const next = currentTheme() === "dark" ? "Light" : "Dark"; $("themeBtn").textContent = next; $("themeBtn").setAttribute("aria-label", "Switch to the " + next.toLowerCase() + " theme"); };
  $("themeBtn").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    if (root) root.setAttribute("data-theme", next);
    try { localStorage.setItem("agent-console-theme", next); } catch { /* not kept */ }
    labelTheme();
  });
  if (root) labelTheme();
})();
