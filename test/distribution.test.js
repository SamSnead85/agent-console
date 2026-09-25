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

import { formulaMatches, nativeDownloads, parseSums, renderSite, shortDate, windowsInstallCommand } from "../scripts/site-facts.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Windows checks the tree out with CRLF; the checks below read lines.
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/gu, "\n");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/* ── install.sh, run for real against a stand-in for curl ── */

const posixOnly = { skip: process.platform === "win32" ? "install.sh is for macOS and Linux" : false };

function installFixture({ corrupt = false, omitLine = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-install-"));
  const release = path.join(dir, "release");
  const bin = path.join(dir, "fake-bin");
  const dest = path.join(dir, "dest");
  fs.mkdirSync(release);
  fs.mkdirSync(bin);
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const asset = `agent-console-${platform}-${arch}`;
  const program = "#!/bin/sh\necho 'agent-console 9.9.9'\n";
  fs.writeFileSync(path.join(release, asset), corrupt ? program + "# changed\n" : program);
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
    env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dir, AGENT_CONSOLE_VERSION: "v9.9.9", AGENT_CONSOLE_INSTALL_DIR: dest },
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

test("install.ps1 compares Get-FileHash with SHA256SUMS before it copies anything into place", () => {
  const script = read("install.ps1");
  const hash = script.indexOf("Get-FileHash");
  const mismatch = script.indexOf("if ($actual -ne $expected) { throw");
  const copy = script.indexOf("Copy-Item");
  assert.ok(hash > 0 && mismatch > hash && copy > mismatch, "hash, then refusal, then copy");
  assert.doesNotMatch(script, /Start-Process|Invoke-Expression|iex\b|& \$binary/u, "never runs the download");
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
    assert.match(formula, /version "9\.9\.9"/u);
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
  assert.match(job("executables"), /needs: authorize/u);
  assert.match(job("image"), /needs: authorize/u);
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
  const temp = at("$f = Join-Path ([IO.Path]::GetTempPath()) ('agent-console-install-' + [Guid]::NewGuid().ToString('N') + '.ps1')");
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
