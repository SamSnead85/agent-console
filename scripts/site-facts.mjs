#!/usr/bin/env node
// Turn the static page in site/ into a release-specific Pages artifact.
// A failed release lookup, checksum, or attestation stops deployment. Every
// install path the page offers is one that exists for this release: the
// standalone executables only when the release carries them under its
// SHA256SUMS (and the tag carries the installers), npm only when the registry
// serves the very file on the release, Homebrew only when the tap's formula
// names this version with the release's own checksums. Otherwise "coming".
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'SamSnead85/agent-console';
export const TAP = 'SamSnead85/homebrew-tap';
export const NPM_NAME = '@lockedinlabs/agent-console';
export const NATIVE_NAMES = [
  'agent-console-darwin-arm64', 'agent-console-darwin-x64',
  'agent-console-linux-arm64', 'agent-console-linux-x64', 'agent-console-win32-x64.exe',
];
export const BREW_ARCHIVES = [
  'agent-console-darwin-arm64.tar.gz', 'agent-console-darwin-x64.tar.gz',
  'agent-console-linux-arm64.tar.gz', 'agent-console-linux-x64.tar.gz',
];

const replace = (source, before, after) => {
  if (!source.includes(before)) throw new Error(`Site template is missing: ${before.slice(0, 70)}`);
  return source.replaceAll(before, after);
};
const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Three-letter months, as the page is drawn ("23 Sep 2026"); ICU's en-GB now says "Sept".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDate = (iso) => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const longDate = (iso) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));

/** SHA256SUMS as a map of file name to lower-case digest; malformed or repeated lines are refused. */
export function parseSums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?([^/\s]+)$/.exec(line);
    if (!match || sums.has(match[2])) throw new Error('Invalid or duplicate SHA256SUMS line');
    sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** The standalone executables this release really carries, each with its URL and checksum. */
export function nativeDownloads({ tag, assetNames, sums }) {
  return Object.fromEntries(NATIVE_NAMES.filter((name) => assetNames.has(name)).map((name) => {
    if (!sums.has(name)) throw new Error(`Missing release checksum for ${name}`);
    return [name, { url: `https://github.com/${REPO}/releases/download/${tag}/${name}`, sha256: sums.get(name) }];
  }));
}

/** True only when a formula names this version and exactly the release's archive checksums. */
export function formulaMatches(formula, version, sums) {
  if (typeof formula !== 'string') return false;
  // Homebrew reads the version from the URLs (checked below); an explicit
  // version line, if there is one, must agree with them.
  const named = /^\s*version\s+"([^"]+)"/m.exec(formula);
  if (named && named[1] !== version) return false;
  return BREW_ARCHIVES.every((file) => {
    const digest = sums.get(file);
    if (!digest) return false;
    const url = `https://github.com/${REPO}/releases/download/v${version}/${file}`;
    const at = formula.indexOf(`url "${url}"`);
    if (at < 0) return false;
    const next = /sha256\s+"([0-9a-f]{64})"/.exec(formula.slice(at));
    return Boolean(next) && next[1] === digest;
  });
}

function cmdRow(command, { osOnly, quiet } = {}) {
  const attr = osOnly ? ` data-os-only="${osOnly}"` : '';
  const text = escapeHtml(command);
  return `<div class="cmd${quiet ? ' quiet-cmd' : ''}"${attr}><svg class="pr" aria-hidden="true"><use href="#i-term"/></svg><code>${text}</code><button class="tb copy" type="button" data-copy="${text}"><svg aria-hidden="true"><use href="#i-copy"/></svg><span>Copy</span></button></div>`;
}

/**
 * The Windows one-line install. PowerShell has no &&, so the line runs in its
 * own scope with every error stopping it: the installer is downloaded to a new
 * temporary file (never a fixed name that an earlier download could have left),
 * checked to be there, told which release to install, run, and removed. A
 * failed download ends it before anything runs. docs/standalone-install.md
 * prints the same command for the main branch (no tag: the latest release).
 */
export function windowsInstallCommand(url, tag) {
  // Whatever AGENT_CONSOLE_VERSION this window had is put back afterwards.
  const keep = tag ? '$v = $env:AGENT_CONSOLE_VERSION; ' : '';
  const pin = tag ? `$env:AGENT_CONSOLE_VERSION = '${tag}'; ` : '';
  const unpin = tag ? '; $env:AGENT_CONSOLE_VERSION = $v' : '';
  return "& { $ErrorActionPreference = 'Stop'; "
    + "$f = Join-Path ([IO.Path]::GetTempPath()) ('agent-console-install-' + [Guid]::NewGuid().ToString('N') + '.ps1'); "
    + keep
    + `try { Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile $f; `
    + "if (-not (Test-Path -LiteralPath $f) -or (Get-Item -LiteralPath $f).Length -eq 0) { throw 'The installer did not download. Nothing was run.' }; "
    + pin
    + "powershell -NoProfile -ExecutionPolicy Bypass -File $f; "
    + "if ($LASTEXITCODE -ne 0) { throw 'The installer stopped without installing.' } "
    + `} finally { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue${unpin} } }`;
}

function standaloneBlock(tag) {
  const raw = `https://raw.githubusercontent.com/${REPO}/${tag}`;
  return `<div class="way">
                <div class="k"><b>Standalone executable</b><span>one file with Node.js inside, for a computer without Node. The installer fetches the file for this computer and the release's <code>SHA256SUMS</code>, and installs nothing unless the SHA-256 matches. <span data-os-only="mac linux">It installs to <code>~/.local/bin</code>.</span><span data-os-only="win">It installs to <code>AppData\\Local\\Programs\\AgentConsole</code> for your user only.</span> Unsigned files say so on the release page.</span></div>
                ${cmdRow(`curl -fsSLO ${raw}/install.sh && AGENT_CONSOLE_VERSION=${tag} sh ./install.sh`, { osOnly: 'mac linux' })}
                ${cmdRow(windowsInstallCommand(`${raw}/install.ps1`, tag), { osOnly: 'win' })}
                <div class="fine">Or use the <b>Download</b> button on the overview for the file itself, and <a href="#/verify">verify it</a> before you run it.</div>
              </div>`;
}

const STANDALONE_COMING = `<div class="way coming">
                <div class="k"><b>Standalone executable <span class="chip" data-tone="quiet">coming</span></b><span>One file per system with Node.js inside, for a computer without Node. This release does not carry them yet; the release that does gets an installer that checks the file against <code>SHA256SUMS</code> before it puts it in place.</span></div>
              </div>`;

function registriesBlock({ npm, brew, version }) {
  const rows = [];
  rows.push(npm
    ? `<div class="way">
                <div class="k"><b>npm</b><span>the same file as the release, served by the registry with its provenance. Node 22 or newer.</span></div>
                ${cmdRow(`npx --yes ${NPM_NAME}@${version} --open`)}
              </div>`
    : `<div class="way coming">
                <div class="k"><b>npm <span class="chip" data-tone="quiet">coming</span></b><span>The package is not on the npm registry for this release yet. Until it is, the release link above is the install, and it is the one CI tests.</span></div>
              </div>`);
  rows.push(brew
    ? `<div class="way">
                <div class="k"><b>Homebrew</b><span>the standalone executable for macOS or Linux, checked by Homebrew against the release's SHA-256.</span></div>
                ${cmdRow(`brew install ${TAP.replace('/homebrew-', '/')}/agent-console`)}
              </div>`
    : `<div class="way coming">
                <div class="k"><b>Homebrew <span class="chip" data-tone="quiet">coming</span></b><span>There is no Homebrew formula for this release yet.</span></div>
              </div>`);
  return rows.join('\n              ');
}

function swapFact(html, name, block) {
  const start = `<!-- fact:${name} -->`;
  const end = `<!-- /fact:${name} -->`;
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a < 0 || b < a) throw new Error(`Site template is missing the ${name} fact`);
  return html.slice(0, a) + block + html.slice(b + end.length);
}

/** Pure: the page and script for these release facts. */
export function renderSite({ html, script, tag, publishedAt, digest, cert, logged, prices, native, npm, brew, installers }) {
  const version = tag.slice(1);
  // The template carries v0.3.0's facts, so read as it stands it points at a real release.
  html = replace(html, '0.3.0', version);
  html = replace(html, 'c6377c1c6c2c349ce45b91381c762b127ed305892d7567a53f5eb0bf84fef4f3', digest);
  html = replace(html, 'c6377c1c…fef4f3', `${digest.slice(0, 8)}…${digest.slice(-6)}`);
  html = replace(html, 'Released 25 September 2026', `Released ${longDate(publishedAt)}`);
  html = replace(html, `${tag} · 25 Sep 2026`, `${tag} · ${shortDate(publishedAt)}`);
  html = replace(html, 'read on 25 Sep 2026', 'checked at build');
  html = replace(html, '7958926233aca73d7afeef5fa7edd59326cec231', cert.githubWorkflowSHA);
  html = replace(html, '2026-09-25 18:35:51 UTC', `${new Date(logged.timestamp).toISOString().slice(0, 19).replace('T', ' ')} UTC`);
  html = replace(html, 'release · github-hosted', `${cert.githubWorkflowTrigger} · ${cert.runnerEnvironment}`);
  html = replace(html, 'prices checked 2026-09-20', `prices checked ${prices.inventoryCheckedOn}`);
  const opus = prices.rows.find((row) => row.model === 'claude-opus-5-5');
  html = replace(html, 'Opus 5.5 2026-09-22', `Opus 5.5 ${opus.verifiedOn}`);

  const standalone = installers && Object.keys(native).length > 0;
  if (standalone) {
    html = swapFact(html, 'standalone', standaloneBlock(tag));
    html = replace(html, '<h2>Three ways in</h2>', '<h2>Four ways in</h2>');
    html = replace(html, 'one package for every operating system; Node 22 or newer runs it', 'the package runs on Node 22 or newer; the standalone executable needs nothing');
  } else {
    html = swapFact(html, 'standalone', STANDALONE_COMING);
  }
  html = npm || brew
    ? swapFact(html, 'registries', registriesBlock({ npm, brew, version }))
    : swapFact(html, 'registries', html.slice(html.indexOf('<!-- fact:registries -->') + '<!-- fact:registries -->'.length, html.indexOf('<!-- /fact:registries -->')).trim());
  // The Download button offers only files that exist; with none, it stays the package.
  html = replace(html, '</head>', `<script id="native-downloads" type="application/json">${JSON.stringify(standalone ? native : {})}</script>\n</head>`);

  const wanted = [
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-sonnet-5', 'Claude Sonnet 5'],
    ['claude-fable-5-1', 'Claude Fable 5.1'],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ['gpt-5.5', 'GPT-5.5'],
    ['gpt-6-astra', 'GPT-6 Astra'],
  ];
  const table = Object.fromEntries(wanted.map(([id, name]) => {
    const row = prices.rows.find((entry) => entry.model === id && entry.status === 'verified');
    if (!row || row.usdPerMillion.fresh == null || row.usdPerMillion.cacheRead == null ||
        (id.startsWith('claude-') && row.usdPerMillion.cacheWrite5m == null)) throw new Error(`Unpriced site model: ${id}`);
    return [id, { name, vendor: id.startsWith('claude-') ? 'anthropic' : 'openai', fresh: row.usdPerMillion.fresh,
      ...(id.startsWith('claude-') ? { cw5m: row.usdPerMillion.cacheWrite5m } : {}), cr: row.usdPerMillion.cacheRead }];
  }));
  const start = script.indexOf('  const PRICES = {');
  const end = script.indexOf('\n  };', start);
  if (start < 0 || end < 0) throw new Error('Site calculator template changed');
  script = script.slice(0, start) + `  const PRICES = ${JSON.stringify(table, null, 2)};` + script.slice(end + 5);
  return { html, script, standalone };
}

/* ── reading the facts: every source must answer, or the build fails ── */

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
/** A GitHub API read where "not found" is an answer (null) and anything else is a failure. */
function ghMaybe(endpoint) {
  try { return JSON.parse(gh('api', endpoint)); } catch (error) {
    if (/HTTP 404/.test(String(error.stderr || error.message))) return null;
    throw new Error(`GitHub API read failed for ${endpoint}`);
  }
}

async function npmServes(version, sha1) {
  const response = await fetch(`https://registry.npmjs.org/${NPM_NAME.replace('/', '%2f')}`, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`npm registry answered ${response.status}`);
  const doc = await response.json();
  const shasum = doc?.versions?.[version]?.dist?.shasum;
  if (!shasum) return false;
  if (shasum !== sha1) throw new Error(`npm serves ${NPM_NAME}@${version} with different bytes from the release`);
  return true;
}

async function gather() {
  const release = JSON.parse(gh('release', 'view', '--repo', REPO, '--json', 'tagName,publishedAt,assets'));
  const tag = release.tagName;
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !release.publishedAt) throw new Error('No usable published release');
  const version = tag.slice(1);
  const tgz = `lockedinlabs-agent-console-${version}.tgz`;
  const assetNames = new Set(release.assets.map((asset) => asset.name));
  if (!assetNames.has('SHA256SUMS') || !assetNames.has(tgz)) throw new Error('Release is missing its tarball or SHA256SUMS');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-site-'));
  let digest, verification, sums, sha1;
  try {
    gh('release', 'download', tag, '--repo', REPO, '--dir', temp, '--pattern', 'SHA256SUMS', '--pattern', tgz);
    sums = parseSums(fs.readFileSync(path.join(temp, 'SHA256SUMS'), 'utf8'));
    digest = sums.get(tgz);
    if (!digest) throw new Error('Tarball hash missing from SHA256SUMS');
    const bytes = fs.readFileSync(path.join(temp, tgz));
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Release tarball does not match SHA256SUMS');
    sha1 = createHash('sha1').update(bytes).digest('hex');
    const verified = JSON.parse(gh('attestation', 'verify', path.join(temp, tgz), '--repo', REPO, '--format', 'json'));
    verification = verified.find((entry) => entry.verificationResult?.statement?.subject?.some((subject) => subject.name === tgz && subject.digest?.sha256 === digest));
    if (!verification) throw new Error('No verified attestation for the exact tarball hash');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const cert = verification.verificationResult?.signature?.certificate;
  const statement = verification.verificationResult?.statement;
  const logged = verification.verificationResult?.verifiedTimestamps?.find((time) => time.type === 'Tlog');
  if (cert?.githubWorkflowRepository !== REPO || cert?.githubWorkflowRef !== `refs/tags/${tag}` ||
      cert?.githubWorkflowTrigger !== 'release' || cert?.runnerEnvironment !== 'github-hosted' ||
      statement?.predicateType !== 'https://slsa.dev/provenance/v1' || !logged?.timestamp) {
    throw new Error('Attestation facts do not match this release workflow');
  }

  const native = nativeDownloads({ tag, assetNames, sums });
  const installers = Object.keys(native).length > 0
    && Boolean(ghMaybe(`repos/${REPO}/contents/install.sh?ref=${tag}`))
    && Boolean(ghMaybe(`repos/${REPO}/contents/install.ps1?ref=${tag}`));
  const npm = await npmServes(version, sha1);
  const formulaDoc = ghMaybe(`repos/${TAP}/contents/Formula/agent-console.rb`);
  const brew = formulaMatches(formulaDoc?.content ? Buffer.from(formulaDoc.content, 'base64').toString('utf8') : null, version, sums);
  return { tag, publishedAt: release.publishedAt, digest, cert, logged, native, installers, npm, brew, assetCount: assetNames.size };
}

async function main() {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const out = path.join(root, 'dist', 'site');
  const facts = await gather();
  const prices = JSON.parse(fs.readFileSync(path.join(root, 'lib', 'collector', 'prices.json'), 'utf8'));
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'site'), out, { recursive: true });
  const { html, script, standalone } = renderSite({
    ...facts, prices,
    html: fs.readFileSync(path.join(out, 'index.html'), 'utf8'),
    script: fs.readFileSync(path.join(out, 'assets', 'site.js'), 'utf8'),
  });
  fs.writeFileSync(path.join(out, 'index.html'), html);
  fs.writeFileSync(path.join(out, 'assets', 'site.js'), script);
  console.log(`Built site for ${facts.tag}; tarball SHA-256 and attestation verified; ${facts.assetCount} release assets; ` +
    `standalone ${standalone ? 'live' : 'coming'}, npm ${facts.npm ? 'live' : 'coming'}, Homebrew ${facts.brew ? 'live' : 'coming'}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
