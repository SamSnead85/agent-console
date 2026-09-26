/*
 * Distribution: the installers install nothing that does not match the
 * release's SHA256SUMS, the Homebrew formula is rendered only from those
 * checksums, the team hub image says how it is checked, and the download page
 * offers only install paths that exist for its release.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { signingNotes } from "../scripts/release-signing-notes.mjs";
import { formulaMatches, macSignedFromLabels, nativeDownloads, parseSums, renderSite, shortDate, windowsInstallCommand } from "../scripts/site-facts.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Windows checks the tree out with CRLF; the checks below read lines.
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/gu, "\n");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/* ── install.sh, run for real against a stand-in for curl ── */

const posixOnly = { skip: process.platform === "win32" ? "install.sh is for macOS and Linux" : false };

/**
 * A release on disk, a curl that serves it, and optionally stand-ins for
 * uname, getconf and ldd (to be a Linux machine of a given C library), a
 * login shell, and PATH entries of the user's own.
 */
function installFixture({ corrupt = false, omitLine = false, omitAsset = false, linux = null, shell = "/bin/zsh", onPath = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-install-"));
  const release = path.join(dir, "release");
  const bin = path.join(dir, "fake-bin");
  const dest = path.join(dir, "dest");
  fs.mkdirSync(release);
  fs.mkdirSync(bin);
  const platform = linux ? "linux" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = linux ? "x64" : process.arch === "arm64" ? "arm64" : "x64";
  const asset = `agent-console-${platform}-${arch}`;
  const program = "#!/bin/sh\necho 'agent-console 9.9.9'\n";
  if (!omitAsset) fs.writeFileSync(path.join(release, asset), corrupt ? program + "# changed\n" : program);
  if (linux) {
    const tool = (name, body) => fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
    tool("uname", 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac');
    tool("getconf", linux.glibc ? `echo 'glibc ${linux.glibc}'` : "exit 1");
    tool("ldd", linux.musl ? "echo 'musl libc (x86_64)' >&2; exit 1" : "echo 'ldd (GNU libc) 2.31'");
  }
  const lines = [`${"0".repeat(64)}  lockedinlabs-agent-console-9.9.9.tgz`];
  if (!omitLine) lines.push(`${sha256(program)}  ${asset}`);
  fs.writeFileSync(path.join(release, "SHA256SUMS"), lines.join("\n") + "\n");
  // curl: serve the release file named by the URL's last segment into -o.
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in https://github.com/SamSnead85/agent-console/releases/download/v9.9.9/*) ;; *) exit 22 ;; esac
cp "${release}/\${url##*/}" "$out"
`, { mode: 0o755 });
  const run = () => spawnSync("sh", [path.join(ROOT, "install.sh")], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin${onPath ? `:${dest}` : ""}`, HOME: dir, SHELL: shell, AGENT_CONSOLE_VERSION: "v9.9.9", AGENT_CONSOLE_INSTALL_DIR: dest },
  });
  return { dir, dest, run };
}

test("install.sh installs the executable only after its SHA-256 matches SHA256SUMS", posixOnly, () => {
  const { dir, dest, run } = installFixture();
  try {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const installed = path.join(dest, "agent-console");
    assert.equal(fs.statSync(installed).mode & 0o111, 0o111);
    assert.equal(spawnSync(installed, [], { encoding: "utf8" }).stdout, "agent-console 9.9.9\n");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("install.sh refuses a download that does not match, and installs nothing", posixOnly, () => {
  const { dir, dest, run } = installFixture({ corrupt: true });
  try {
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256 mismatch\. Nothing was installed\./u);
    assert.equal(fs.existsSync(path.join(dest, "agent-console")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("install.sh refuses a release whose SHA256SUMS does not list the file", posixOnly, () => {
  const { dir, dest, run } = installFixture({ omitLine: true });
  try {
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum is missing or invalid/u);
    assert.equal(fs.existsSync(dest), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("install.sh gives the exact line that puts its folder on PATH, for the shell in use", posixOnly, () => {
  const expected = [
    ["/bin/zsh", null, `echo 'export PATH="$HOME/dest:$PATH"' >> ~/.zshrc`],
    ["/bin/bash", { glibc: "2.31" }, `echo 'export PATH="$HOME/dest:$PATH"' >> ~/.bashrc`],
    ["/usr/bin/fish", null, "fish_add_path "],
    ["/bin/ksh", null, `echo 'export PATH="$HOME/dest:$PATH"' >> ~/.profile`],
  ];
  if (process.platform === "darwin") expected.push(["/bin/bash", null, `echo 'export PATH="$HOME/dest:$PATH"' >> ~/.bash_profile`]);
  for (const [shell, linux, line] of expected) {
    const { dir, dest, run } = installFixture({ shell, linux });
    try {
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Installed v9\.9\.9 to .*\/dest\/agent-console\n/u);
      assert.ok(result.stdout.includes(`Start it:  ${dest}/agent-console --open\n`), result.stdout);
      assert.ok(result.stdout.includes(`is not on your PATH. To run it as just agent-console, run:\n  ${line}`), `${shell}:\n${result.stdout}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const { dir, run } = installFixture({ onPath: true });
  try {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\nStart it: {2}agent-console --open\n$/u);
    assert.doesNotMatch(result.stdout, /not on your PATH/u);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("install.sh refuses a Linux its executable cannot run, and names the npx line instead", posixOnly, () => {
  for (const [linux, named] of [[{ musl: true }, "musl libc"], [{ glibc: "2.17" }, "glibc 2.17"]]) {
    const { dir, dest, run } = installFixture({ linux });
    try {
      const result = run();
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(`This Linux has ${named}; the Agent Console executable needs glibc 2.28 or newer. Nothing was installed.`), result.stderr);
      assert.ok(result.stderr.includes("npx --yes https://github.com/SamSnead85/agent-console/releases/download/v9.9.9/lockedinlabs-agent-console-9.9.9.tgz --open"));
      assert.equal(fs.existsSync(dest), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const { dir, run } = installFixture({ linux: { glibc: "2.28" } });
  try {
    assert.equal(run().status, 0, "glibc 2.28 is enough");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("install.sh says what to set behind a proxy when a download fails", posixOnly, () => {
  const { dir, dest, run } = installFixture({ omitAsset: true });
  try {
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^Could not download https:\/\/github\.com\/\S+\/agent-console-\S+\. Nothing was installed\.\nBehind a proxy\? Set HTTPS_PROXY=/mu);
    assert.match(result.stderr, /CURL_CA_BUNDLE/u);
    assert.equal(fs.existsSync(dest), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("install.ps1 compares Get-FileHash with SHA256SUMS before it copies anything into place", () => {
  const script = read("install.ps1");
  const hash = script.indexOf("Get-FileHash");
  const mismatch = script.indexOf("if ($actual -ne $expected) { throw");
  const copy = script.indexOf("Copy-Item");
  assert.ok(hash > 0 && mismatch > hash && copy > mismatch, "hash, then refusal, then copy");
  assert.doesNotMatch(script, /Start-Process|Invoke-Expression|iex\b|& \$binary/u, "never runs the download");
});

test("install.ps1 downloads quickly in Windows PowerShell 5.1, over TLS 1.2, without the GitHub API", () => {
  const script = read("install.ps1");
  const first = script.indexOf("Invoke-WebRequest");
  const before = (text) => { const i = script.indexOf(text); return i > 0 && i < first; };
  assert.ok(before("$ProgressPreference = 'SilentlyContinue'"), "no progress bar before the first download");
  assert.ok(before("[Net.ServicePointManager]::SecurityProtocol -bor 3072"), "TLS 1.2 before the first download");
  assert.doesNotMatch(script, /api\.github\.com|Invoke-RestMethod/u, "no API, so no rate limit");
  assert.match(script, /Invoke-WebRequest -UseBasicParsing -Method Head -Uri "https:\/\/github\.com\/\$repo\/releases\/latest"/u);
  for (const call of script.match(/Invoke-WebRequest[^\n]*/gu)) assert.match(call, /-UseBasicParsing/u, call);
});

test("install.ps1 puts its folder on the user's PATH, keeping %VARIABLES%, unless told not to", () => {
  const script = read("install.ps1");
  const copy = script.indexOf("Copy-Item");
  const registry = script.indexOf("[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)");
  assert.ok(copy > 0 && registry > copy, "PATH only after the checked file is in place");
  assert.match(script, /GetValue\('Path', '', \[Microsoft\.Win32\.RegistryValueOptions\]::DoNotExpandEnvironmentNames\)/u);
  assert.match(script, /SetValue\('Path', [^\n]*\[Microsoft\.Win32\.RegistryValueKind\]::ExpandString\)/u);
  assert.match(script, /\$env:AGENT_CONSOLE_NO_MODIFY_PATH -ne '1'/u);
  assert.match(script, /SendMessageTimeout\(\[IntPtr\] 0xffff, 0x1A,[^\n]*'Environment'/u, "tells Windows the environment changed");
  assert.doesNotMatch(script, /SetEnvironmentVariable\('Path'[^\n]*'User'\)/u, "that would flatten %VARIABLES% in the user's PATH");
  // Windows 11 on Arm runs the x64 executable; Windows 10 on Arm is refused with the npx line.
  assert.match(script, /if \(\[Environment\]::OSVersion\.Version\.Build -lt 22000\) \{\s+throw "[^"]*npx\.cmd --yes \$package --open"/u);
});

test("every shell script is checked out with LF endings, even on Windows", () => {
  const attributes = read(".gitattributes");
  assert.match(attributes, /^\*\.sh text eol=lf$/mu);
  // Every script with a shell #! line is a .sh file, so the rule reaches it.
  const tracked = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  if (tracked.status !== 0) return; // not a git checkout (an unpacked tarball): nothing to hold
  for (const file of tracked.stdout.split("\n").filter(Boolean)) {
    let head = "";
    try { head = fs.readFileSync(path.join(ROOT, file), "utf8").slice(0, 32); } catch { continue; }
    if (/^#!\s*\/(?:usr\/)?bin\/(?:env\s+)?(?:ba|z|da)?sh\b/u.test(head)) assert.match(file, /\.sh$/u, `${file} is a shell script without .sh`);
  }
});

/* ── Homebrew formula ── */

const ARCHIVES = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].map((t) => `agent-console-${t}.tar.gz`);

test("the Homebrew formula is rendered from the release's SHA256SUMS, and a missing archive is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-brew-"));
  try {
    const digests = ARCHIVES.map((_, i) => String(i + 1).repeat(64));
    const sums = path.join(dir, "SHA256SUMS");
    fs.writeFileSync(sums, ARCHIVES.map((name, i) => `${digests[i]}  ${name}`).join("\n") + "\n");
    const out = path.join(dir, "agent-console.rb");
    const ok = spawnSync(process.execPath, [path.join(ROOT, "scripts", "render-homebrew-formula.mjs"), "v9.9.9", sums, out], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    const formula = fs.readFileSync(out, "utf8");
    // Homebrew reads the version from the release URLs; a version line is redundant (brew audit --strict).
    assert.doesNotMatch(formula, /^\s*version /mu);
    assert.equal((formula.match(/releases\/download\/v9\.9\.9\//gu) || []).length, 4);
    for (const d of digests) assert.ok(formula.includes(`sha256 "${d}"`));
    assert.doesNotMatch(formula, /@[A-Z0-9_]+@/u);
    assert.equal(formulaMatches(formula, "9.9.9", parseSums(fs.readFileSync(sums, "utf8"))), true);

    fs.writeFileSync(sums, ARCHIVES.slice(1).map((name, i) => `${digests[i + 1]}  ${name}`).join("\n") + "\n");
    const missing = spawnSync(process.execPath, [path.join(ROOT, "scripts", "render-homebrew-formula.mjs"), "v9.9.9", sums, path.join(dir, "no.rb")], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.equal(fs.existsSync(path.join(dir, "no.rb")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a formula for another version, or with a checksum that differs from the release, does not count as published", () => {
  const sums = new Map(ARCHIVES.map((name, i) => [name, String(i + 1).repeat(64)]));
  const formula = (version, first) => `version "${version}"\n` + ARCHIVES.map((name, i) =>
    `url "https://github.com/SamSnead85/agent-console/releases/download/v${version}/${name}"\nsha256 "${i === 0 ? first : sums.get(name)}"`).join("\n");
  assert.equal(formulaMatches(formula("9.9.9", sums.get(ARCHIVES[0])), "9.9.9", sums), true);
  assert.equal(formulaMatches(formula("9.9.8", sums.get(ARCHIVES[0])), "9.9.9", sums), false);
  assert.equal(formulaMatches(formula("9.9.9", "f".repeat(64)), "9.9.9", sums), false);
  assert.equal(formulaMatches(null, "9.9.9", sums), false);
});

/* ── the team hub image ── */

test("the hub image runs unprivileged, keeps its reporting port and checks its own health", () => {
  const docker = read("Dockerfile");
  assert.match(docker, /^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/mu, "digest-pinned base");
  assert.match(docker, /^USER node$/mu);
  assert.match(docker, /^ENV AGENT_CONSOLE_REPORT_PORT=6788$/mu);
  assert.match(docker, /^HEALTHCHECK .*\/join/msu);
  // The licence and the third-party notices travel inside the image, and the build context lets them in.
  assert.match(docker, /^COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES\.md \.\/$/mu);
  const ignored = read(".dockerignore").split("\n");
  assert.ok(!ignored.includes("LICENSE") && ignored.indexOf("!THIRD_PARTY_NOTICES.md") > ignored.indexOf("*.md"), ".dockerignore keeps both");
  const workflow = read(".github/workflows/ghcr.yml");
  assert.match(workflow, /docker\/setup-qemu-action@[0-9a-f]{40}/u, "arm64 is emulated on the amd64 runner");
  assert.match(workflow, /docker\/setup-buildx-action@[0-9a-f]{40}/u);
  assert.match(workflow, /docker-smoke\.mjs/u, "the image is started before anything is pushed");
  assert.match(workflow, /attest-build-provenance@[0-9a-f]{40}[\s\S]*subject-digest/u, "the pushed digest is attested");
  assert.doesNotMatch(workflow, /:latest\b/u, "never a floating tag");
});

/* ── release workflow: #26's acceptance first, distribution after ── */

test("the release authorizes its source before building anything, and publishes to npm only the accepted file", () => {
  const release = read(".github/workflows/release.yml");
  const job = (name) => {
    const at = release.indexOf(`\n  ${name}:\n`);
    assert.ok(at > 0, `job ${name}`);
    const next = release.slice(at + 1).search(/\n {2}[a-z-]+:\n/u);
    return next < 0 ? release.slice(at) : release.slice(at, at + 1 + next);
  };
  assert.match(job("authorize"), /release-source-check\.mjs/u);
  assert.match(job("executables"), /needs: \[authorize, signing\]/u);
  assert.match(job("image"), /needs: \[authorize, signing\]/u);
  assert.match(job("asset"), /needs\.authorize\.result == 'success'/u);
  assert.match(job("asset"), /release-source-check\.mjs/u, "the job that packs checks its own checkout");
  assert.match(job("acceptance"), /readme-install\.mjs --expected-version/u);
  assert.match(job("executable-acceptance"), /install\.sh/u);
  assert.match(job("executable-acceptance"), /install\.ps1/u);
  assert.match(job("npm"), /needs: acceptance/u);
  const npm = read(".github/workflows/npm-publish.yml");
  assert.match(npm, /workflow_call/u);
  assert.doesNotMatch(npm, /\n {2}push:/u, "a tag push alone never publishes");
  assert.match(npm, /gh attestation verify/u);
  assert.match(npm, /npm publish "\.\/\$FILE" --provenance/u);
});

/* ── the download page ── */

const FACTS = {
  html: read("site/index.html"),
  script: read("site/assets/site.js"),
  tag: "v9.9.9",
  publishedAt: "2026-10-01T12:00:00Z",
  digest: "a".repeat(64),
  cert: { githubWorkflowSHA: "b".repeat(40), githubWorkflowTrigger: "release", runnerEnvironment: "github-hosted" },
  logged: { timestamp: "2026-10-01T12:05:00Z" },
  prices: JSON.parse(read("lib/collector/prices.json")),
  native: {},
  installers: false,
  npm: false,
  brew: false,
};
/** Every command the page's Copy buttons copy, as copied. */
const copied = (html) => [...html.matchAll(/data-copy="([^"]*)"/gu)].map((m) => m[1]
  .replace(/&quot;/gu, '"').replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&"));
const nativeScript = (html) => JSON.parse(/<script id="native-downloads" type="application\/json">(.*?)<\/script>/u.exec(html)[1]);

test("the download page marks the executables, npm and Homebrew coming until the release really has them", () => {
  const { html, standalone } = renderSite(FACTS);
  assert.equal(standalone, false);
  assert.doesNotMatch(html, /fact:/u, "no template markers ship");
  assert.match(html, /Standalone executable <span class="chip" data-tone="quiet">coming<\/span>/u);
  assert.match(html, /npm and Homebrew <span class="chip" data-tone="quiet">coming<\/span>/u);
  assert.match(html, /<h2>Three ways in<\/h2>/u);
  assert.deepEqual(nativeScript(html), {});
  assert.doesNotMatch(html, /install\.sh|brew install|npx --yes @lockedinlabs/u, "no install path that does not exist");
  assert.match(html, /releases\/download\/v9\.9\.9\/lockedinlabs-agent-console-9\.9\.9\.tgz/u);
  assert.match(html, /v9\.9\.9 · 1 Oct 2026/u);
  assert.equal(shortDate("2026-09-23T01:00:00Z"), "23 Sep 2026", "three-letter months whatever the ICU");
});

test("a release that carries the executables gets them on the Download button and a tag-pinned installer", () => {
  const sums = parseSums(["agent-console-darwin-arm64", "agent-console-win32-x64.exe"].map((n, i) => `${String(i + 3).repeat(64)}  ${n}`).join("\n"));
  const native = nativeDownloads({ tag: "v9.9.9", assetNames: new Set(["agent-console-darwin-arm64", "agent-console-win32-x64.exe", "SHA256SUMS"]), sums });
  const { html, standalone } = renderSite({ ...FACTS, native, installers: true });
  assert.equal(standalone, true);
  assert.match(html, /<h2>Four ways in<\/h2>/u);
  // Both installers are told the checked tag: without it they install whatever "latest" is.
  assert.ok(copied(html).includes("curl -fsSLO https://raw.githubusercontent.com/SamSnead85/agent-console/v9.9.9/install.sh && AGENT_CONSOLE_VERSION=v9.9.9 sh ./install.sh"));
  const windows = copied(html).find((command) => command.includes("install.ps1"));
  assert.equal(windows, windowsInstallCommand("https://raw.githubusercontent.com/SamSnead85/agent-console/v9.9.9/install.ps1", "v9.9.9"));
  assert.ok(windows.includes("$env:AGENT_CONSOLE_VERSION = 'v9.9.9'"));
  assert.deepEqual(Object.keys(nativeScript(html)), ["agent-console-darwin-arm64", "agent-console-win32-x64.exe"]);
  assert.equal(nativeScript(html)["agent-console-darwin-arm64"].sha256, "3".repeat(64));
  // Executables without the installers in the tag: nothing is offered.
  const noInstallers = renderSite({ ...FACTS, native, installers: false });
  assert.equal(noInstallers.standalone, false);
  assert.deepEqual(nativeScript(noInstallers.html), {});
});

test("npm and Homebrew each go live on their own, and an executable missing from SHA256SUMS fails the build", () => {
  const npmOnly = renderSite({ ...FACTS, npm: true }).html;
  // The version the registry was checked for, not whatever its latest tag is.
  assert.ok(copied(npmOnly).includes("npx --yes @lockedinlabs/agent-console@9.9.9 --open"));
  assert.doesNotMatch(npmOnly, /@lockedinlabs\/agent-console --open/u);
  assert.match(npmOnly, /Homebrew <span class="chip" data-tone="quiet">coming<\/span>/u);
  const brewOnly = renderSite({ ...FACTS, brew: true }).html;
  assert.match(brewOnly, /brew install SamSnead85\/tap\/agent-console/u);
  assert.match(brewOnly, /npm <span class="chip" data-tone="quiet">coming<\/span>/u);
  assert.throws(() => nativeDownloads({ tag: "v9.9.9", assetNames: new Set(["agent-console-linux-x64"]), sums: new Map() }), /Missing release checksum/u);
  assert.throws(() => parseSums(`${"a".repeat(64)}  x\n${"b".repeat(64)}  x\n`), /duplicate/u);
});

test("the download page calls the macOS executables signed only when the release's labels say so", () => {
  const label = (name, signing) => ({ name, label: `${name} · x${signing ? `, ${signing}` : ""}` });
  const signed = ["agent-console-darwin-arm64", "agent-console-darwin-arm64.tar.gz", "agent-console-darwin-x64", "agent-console-darwin-x64.tar.gz"]
    .map((name) => label(name, "signed and notarized"));
  assert.equal(macSignedFromLabels([...signed, label("agent-console-win32-x64.exe", "unsigned"), label("agent-console-linux-x64", "")]), true);
  assert.equal(macSignedFromLabels([...signed.slice(1), label("agent-console-darwin-arm64", "unsigned")]), false, "one unsigned file is enough to say nothing");
  assert.equal(macSignedFromLabels([]), false);
  const native = nativeDownloads({ tag: "v9.9.9", assetNames: new Set(["agent-console-darwin-arm64"]), sums: parseSums(`${"3".repeat(64)}  agent-console-darwin-arm64\n`) });
  const yes = renderSite({ ...FACTS, native, installers: true, macSigned: true }).html;
  assert.match(yes, /On macOS it is signed with an Apple Developer ID and notarized by Apple; on Windows it is not code-signed/u);
  const no = renderSite({ ...FACTS, native, installers: true }).html;
  assert.doesNotMatch(no, /notarized/u);
  assert.match(no, /Unsigned files say so on the release page\./u);
});

test("the copied macOS and Linux command installs the page's release even when a newer one is latest", posixOnly, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-site-pin-"));
  try {
    const release = path.join(dir, "release");
    const bin = path.join(dir, "fake-bin");
    const dest = path.join(dir, "dest");
    const cwd = path.join(dir, "cwd");
    for (const d of [bin, cwd]) fs.mkdirSync(d);
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const asset = `agent-console-${platform}-${arch}`;
    for (const version of ["9.9.9", "9.9.10"]) {
      const program = `#!/bin/sh\necho 'agent-console ${version}'\n`;
      fs.mkdirSync(path.join(release, "v" + version), { recursive: true });
      fs.writeFileSync(path.join(release, "v" + version, asset), program);
      fs.writeFileSync(path.join(release, "v" + version, "SHA256SUMS"), `${sha256(program)}  ${asset}\n`);
    }
    fs.copyFileSync(path.join(ROOT, "install.sh"), path.join(release, "install.sh"));
    // curl: the tag's installer for -O, v9.9.10 as "latest", and release files for -o. Nothing else.
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh
out=""; url=""; remote=""; write=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) write="$2"; shift 2 ;;
    -*O*) remote=1; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://raw.githubusercontent.com/SamSnead85/agent-console/v9.9.9/install.sh) [ -n "$remote" ] && cp "${release}/install.sh" ./install.sh ;;
  https://github.com/SamSnead85/agent-console/releases/latest) printf '%s' https://github.com/SamSnead85/agent-console/releases/tag/v9.9.10 ;;
  https://github.com/SamSnead85/agent-console/releases/download/v9.9.9/*|https://github.com/SamSnead85/agent-console/releases/download/v9.9.10/*)
    rest=\${url#https://github.com/SamSnead85/agent-console/releases/download/}; cp "${release}/\${rest%%/*}/\${url##*/}" "$out" ;;
  *) exit 22 ;;
esac
`, { mode: 0o755 });
    const sums = parseSums(`${"3".repeat(64)}  agent-console-darwin-arm64\n`);
    const native = nativeDownloads({ tag: "v9.9.9", assetNames: new Set(["agent-console-darwin-arm64"]), sums });
    const { html } = renderSite({ ...FACTS, native, installers: true });
    const command = copied(html).find((c) => c.includes("install.sh"));
    const result = spawnSync("sh", ["-c", command], {
      cwd, encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dir, AGENT_CONSOLE_INSTALL_DIR: dest },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Installed v9\.9\.9 to /u);
    assert.equal(spawnSync(path.join(dest, "agent-console"), [], { encoding: "utf8" }).stdout, "agent-console 9.9.9\n");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the copied Windows command downloads to a new temporary file, stops on any failure, and only then runs it", () => {
  const url = "https://raw.githubusercontent.com/SamSnead85/agent-console/v9.9.9/install.ps1";
  const command = windowsInstallCommand(url, "v9.9.9");
  const at = (text) => { const i = command.indexOf(text); assert.ok(i >= 0, `missing: ${text}`); return i; };
  // Its own scope, so the stop-on-error preference does not outlive the command.
  assert.ok(command.startsWith("& { $ErrorActionPreference = 'Stop'; ") && command.endsWith(" }"));
  const quick = at("$ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; ");
  const temp = at("$f = Join-Path ([IO.Path]::GetTempPath()) ('agent-console-install-' + [Guid]::NewGuid().ToString('N') + '.ps1')");
  assert.ok(quick < temp);
  const download = at(`Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile $f`);
  const check = at("if (-not (Test-Path -LiteralPath $f) -or (Get-Item -LiteralPath $f).Length -eq 0) { throw");
  const version = at("$env:AGENT_CONSOLE_VERSION = 'v9.9.9'");
  const run = at("powershell -NoProfile -ExecutionPolicy Bypass -File $f");
  const exit = at("if ($LASTEXITCODE -ne 0) { throw");
  const cleanup = at("finally { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue");
  assert.ok(temp < download && download < check && check < version && version < run && run < exit && exit < cleanup, "temp, download, check, pin, run, exit code, clean up");
  assert.ok(at("try {") < download, "the download is inside the try");
  // Nothing runs a file that could have been there before: no fixed name, no ';' straight into the run.
  assert.doesNotMatch(command, /-OutFile install\.ps1|\.\\install\.ps1|install\.ps1; powershell/u);
  assert.equal(windowsInstallCommand(url, null).includes("AGENT_CONSOLE_VERSION"), false, "no tag, no pin");
  // The documented one-line form is the same command.
  assert.ok(read("docs/standalone-install.md").includes(windowsInstallCommand("https://raw.githubusercontent.com/SamSnead85/agent-console/main/install.ps1", null)));
  assert.doesNotMatch(read("docs/standalone-install.md"), /install\.ps1; powershell/u);
});

/* ── signing: macOS signed and notarized or no release; the notes say what each platform carries ── */

const APPLE_SECRETS = ["MACOS_CERT_P12_BASE64", "MACOS_CERT_P12_PASSWORD", "APPLE_API_KEY_P8_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];

test("a release stops before building anything when an Apple signing secret is missing", () => {
  const release = read(".github/workflows/release.yml");
  const signing = release.slice(release.indexOf("\n  signing:\n"), release.indexOf("\n  executables:\n"));
  for (const name of APPLE_SECRETS) assert.ok(signing.includes(`secrets.${name}`), `signing checks ${name}`);
  assert.match(signing, /::error::[^\n]*missing[\s\S]*exit 1/u);
  assert.match(release, /uses: \.\/\.github\/workflows\/binaries\.yml\n {4}with:\n {6}ref: .*\n {6}release: true/u);
  assert.match(release, /needs: \[authorize, signing, executables\]\n {4}if: .*needs\.signing\.result == 'success'/u, "nothing is attached without signing");
  assert.match(release, /release-signing-notes\.mjs labels/u);
  assert.match(release, /if: runner\.os == 'macOS'\n[\s\S]*node packaging\/sea\/notarized\.mjs "\$RUNNER_TEMP\/agent-console-bin\/agent-console"/u, "the published macOS file is checked with Gatekeeper");
  for (const old of ["APPLE_DEVELOPER_ID_P12", "APPLE_NOTARY_KEY_P8"]) assert.doesNotMatch(release + read(".github/workflows/binaries.yml"), new RegExp(old, "u"));
});

test("the executables workflow signs a release's macOS files or fails, and never labels an unsigned file signed", () => {
  const binaries = read(".github/workflows/binaries.yml");
  for (const name of APPLE_SECRETS) assert.ok(binaries.includes(`secrets.${name}`), name);
  assert.match(binaries, /SIGN_MAC: \$\{\{ inputs\.release == true && startsWith\(matrix\.target, 'darwin-'\) \}\}/u);
  assert.match(binaries, /Require the Apple signing secrets for a release[\s\S]*::error::[\s\S]*exit 1/u);
  assert.match(binaries, /AGENT_CONSOLE_REQUIRE_SIGNING: \$\{\{ env\.SIGN_MAC == 'true' && '1' \|\| '' \}\}/u);
  const build = read("packaging/sea/build.mjs");
  assert.match(build, /AGENT_CONSOLE_REQUIRE_SIGNING === "1"\) fail/u);
  const sign = build.slice(build.indexOf("function signMac"), build.indexOf("function codesignInfo"));
  const at = (text) => { const i = sign.indexOf(text); assert.ok(i >= 0, `signMac: ${text}`); return i; };
  assert.ok(at('"--options", "runtime", "--timestamp"') < at('"notarytool", "submit"'));
  assert.ok(at('"notarytool", "submit"') < at("ticketContents") && at("ticketContents") < at("await waitUntilNotarized(file"));
  assert.ok(at("await waitUntilNotarized(file") < at('return "signed and notarized"'), "labelled signed only after Gatekeeper accepts it");
  const check = read("packaging/sea/notarized.mjs");
  assert.match(check, /"spctl", \["--assess", "--type", "install", "-vv", probe\]/u);
  assert.match(check, /source=Notarized Developer ID/u);
  const entitlements = read("packaging/sea/entitlements.plist");
  assert.deepEqual([...entitlements.matchAll(/<key>([^<]+)<\/key>/gu)].map((m) => m[1]),
    ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"]);
});

test("the release notes say, per platform, exactly what the build labels say", () => {
  const notes = signingNotes([
    "agent-console-darwin-arm64 · macOS, Apple silicon executable, signed and notarized\n",
    "agent-console-darwin-arm64.tar.gz · macOS, Apple silicon archive, signed and notarized\n",
    "agent-console-darwin-x64 · macOS, Intel executable, unsigned\n",
    "agent-console-linux-x64 · Linux, x64 executable\n",
    "agent-console-win32-x64.exe · Windows, x64 executable, unsigned\n",
  ]);
  assert.match(notes, /^### Signing, per platform$/mu);
  assert.match(notes, /\*\*macOS, Apple silicon\*\*[^\n]*\*\*signed\*\*[^\n]*\*\*notarized\*\*/u);
  assert.match(notes, /\*\*macOS, Intel\*\*[^\n]*\*\*not signed or notarized\*\*/u, "an unsigned file is never called signed");
  assert.match(notes, /\*\*Windows, x64\*\*[^\n]*\*\*not code-signed\*\*[^\n]*install\.ps1/u);
  assert.match(notes, /\*\*Linux, arm64\*\*: no executable in this release\./u);
});

test("the npm job fails, visibly, when the release cannot be published to npm", () => {
  const npm = read(".github/workflows/npm-publish.yml");
  assert.match(npm, /if \[ -z "\$NODE_AUTH_TOKEN" \]; then\n\s+echo "::error::[^"]*NOT published[^"]*"\n\s+exit 1/u);
  assert.doesNotMatch(npm, /::warning::|ready=false|steps\.token\.outputs/u, "never a green run that published nothing");
});

test("the tap is updated only from archives that match SHA256SUMS and carry this repository's attestation", posixOnly, () => {
  const script = read("scripts/update-homebrew-tap.sh");
  const at = (text) => { const i = script.indexOf(text); assert.ok(i >= 0, text); return i; };
  assert.ok(at("does not match SHA256SUMS") < at("gh attestation verify") && at("gh attestation verify") < at('node "$here/scripts/render-homebrew-formula.mjs"'));
  assert.ok(at('if [ "$push" = "--push" ]') > at("git -C \"$tap\" commit"), "pushes only when asked, after committing");
  const usage = spawnSync("sh", [path.join(ROOT, "scripts", "update-homebrew-tap.sh"), "latest", "/nonexistent"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
});

test("the README's Install section lists every way in, in order, pinned to this version", () => {
  const readme = read("README.md");
  const { version } = JSON.parse(read("package.json"));
  const install = readme.slice(readme.indexOf("\n## Install\n"), readme.indexOf("\n## Start here\n"));
  const order = ["**No install, from the release**", "**npm**", "**Homebrew**", "**Standalone executable**", "**Docker**", "**From source**"].map((t) => install.indexOf(t));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), "npx, npm, Homebrew, executables, Docker, source");
  assert.ok(install.includes("npm install -g @lockedinlabs/agent-console"));
  assert.ok(install.includes("brew install SamSnead85/tap/agent-console"));
  assert.match(install, /signed with an Apple\s+Developer ID and notarized/u);
  assert.match(install, /Windows \(x64; not code-signed\)[\s\S]*install\.ps1/u);
  for (const [, tag] of readme.matchAll(/ghcr\.io\/samsnead85\/agent-console:v([0-9][^\s`]*)/gu)) assert.equal(tag, version, "the Docker tag is this version");
  assert.match(install, /ghcr\.io\/samsnead85\/agent-console:v/u);
});

test("the README gives Windows PowerShell lines its default policy runs, and says the executable is unsigned", () => {
  const readme = read("README.md");
  const { version } = JSON.parse(read("package.json"));
  const url = `https://github.com/SamSnead85/agent-console/releases/download/v${version}/lockedinlabs-agent-console-${version}.tgz`;
  const install = readme.slice(readme.indexOf("\n## Install\n"), readme.indexOf("\n## Start here\n"));
  const start = readme.slice(readme.indexOf("\n## Start here\n"), readme.indexOf("\n### Add another computer\n"));
  // npx.ps1 and npm.ps1 are what plain npx and npm resolve to in PowerShell; the Restricted policy refuses them.
  for (const part of [install, start]) assert.ok(part.includes(`npx.cmd --yes ${url} --open`), "npx.cmd line");
  assert.ok(install.includes("npm.cmd install -g"));
  assert.ok(install.includes("powershell -NoProfile -ExecutionPolicy Bypass -File .\\install.ps1"));
  assert.match(install, /\*\*On Windows\*\* the executable is not code-signed/u);
  assert.match(install, /NODE_USE_ENV_PROXY=1[\s\S]*NODE_EXTRA_CA_CERTS/u, "the join check behind a proxy");
  assert.match(readme, /\n## Uninstall\n[\s\S]*\(docs\/uninstall\.md\)/u);
});

test("the README names exactly the environment variables the code reads", () => {
  const readme = read("README.md");
  const options = readme.slice(readme.indexOf("\n## Options\n"), readme.indexOf("\n## Upgrading a hub\n"));
  const names = (text) => new Set([...text.matchAll(/\bAGENT_CONSOLE_[A-Z0-9_]*[A-Z0-9]\b/gu)].map((m) => m[0]));
  const files = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(path.join(dir, d.name)) : /\.(?:m?js|cjs)$/u.test(d.name) ? [path.join(dir, d.name)] : []);
  const code = [...files("lib"), ...files("bin"), "server.js"].map((f) => read(f)).join("\n");
  const read_ = new Set([...code.matchAll(/env\??\.(AGENT_CONSOLE_[A-Z0-9_]+)/gu)].map((m) => m[1]));
  for (const name of read_) assert.ok(options.includes("`" + name + "`"), `README Options does not name ${name}, which the code reads`);
  // Anything the README names anywhere is read by the program, its installers or its executable.
  const everything = code + read("install.sh") + read("install.ps1") + read("packaging/sea/main.cjs");
  for (const name of names(readme)) assert.ok(everything.includes(name), `README names ${name}, which nothing reads`);
  assert.doesNotMatch(readme, /Environment equivalents use/u);
  // Where Claude Code and Codex history is found: the README says what the collector does.
  const collector = read("lib/collector/collector.js");
  const readsHomes = /env\??\.CODEX_HOME/u.test(collector) || /env\??\.CLAUDE_CONFIG_DIR/u.test(collector);
  assert.equal(options.includes("`CODEX_HOME` are not read to find\ntranscripts"), !readsHomes, "README and collector disagree about CLAUDE_CONFIG_DIR / CODEX_HOME");
});

test("the uninstall guide names every file, folder and background item Agent Console creates", () => {
  const guide = read("docs/uninstall.md");
  const main = read("packaging/sea/main.cjs");
  // The standalone executable's cache, per system, as main.cjs computes it.
  assert.match(main, /path\.join\(home, "Library", "Caches", "agent-console"\)/u);
  assert.match(main, /path\.join\(home, "\.cache"\)[\s\S]*"agent-console"/u);
  assert.match(main, /"agent-console", "Cache"/u);
  for (const place of [
    "~/.agent-console", "hub/", "reporter/", "releases/", "policy/",
    "~/Library/Caches/agent-console/", "~/.cache/agent-console/", "%LOCALAPPDATA%\\agent-console\\", "AGENT_CONSOLE_CACHE_DIR",
    "_npx", "agent-console leave", "agent-console policy remove",
    "launchctl bootout gui/$(id -u)/ai.lockedinlabs.agent-console.reporter", "~/Library/LaunchAgents/ai.lockedinlabs.agent-console.reporter.plist",
    "systemctl --user disable --now agent-console-reporter", "Unregister-ScheduledTask -TaskName \"Agent Console reporter\"",
    "npm uninstall -g @lockedinlabs/agent-console", "brew uninstall agent-console", "~/.local/bin/agent-console",
    "Programs\\AgentConsole", "DoNotExpandEnvironmentNames", "docker volume rm agent-console-state", "--state-dir",
  ]) assert.ok(guide.includes(place), `uninstall.md does not mention ${place}`);
  // The background recipes' own names and paths are the ones the guide removes.
  const background = read("docs/BACKGROUND.md");
  for (const name of ["ai.lockedinlabs.agent-console.reporter", "agent-console-reporter.service", "Agent Console reporter", "Library/Logs/agent-console-reporter.log"]) {
    assert.ok(background.includes(name) && guide.includes(name.replace("/Users/you/", "~/")), name);
  }
});

test("the background recipes restart a failed reporter and leave alone one that stopped for a reason", posixOnly, () => {
  const background = read("docs/BACKGROUND.md");
  const plist = /```xml\n([\s\S]*?)```/u.exec(background)[1];
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key><true\/>/u, "KeepAlive true restarts even a stop on request");
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>\s*<\/dict>/u);
  assert.match(plist, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>/u, "npx and the npm command need node on PATH");
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>60<\/integer>/u);
  assert.match(background, /^RestartPreventExitStatus=2 3 4$/mu);
  assert.match(background, /New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries/u);
  // Run the plist's own program around a stand-in reporter that exits with each code.
  const program = /<string>-c<\/string>\s*<string>([\s\S]*?)<\/string>/u.exec(plist)[1].replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-launchd-"));
  try {
    const reporter = path.join(dir, "reporter");
    fs.writeFileSync(reporter, "#!/bin/sh\nexit \"$1\"\n", { mode: 0o755 });
    const exits = [0, 1, 2, 3, 4, 5].map((code) => spawnSync("/bin/sh", ["-c", program, reporter, String(code)]).status);
    assert.deepEqual(exits, [0, 1, 0, 0, 0, 5], "launchd restarts only on a non-zero exit: 1 and 5 come back, 0, 2, 3 and 4 do not");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
