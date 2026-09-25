#!/usr/bin/env node
// Turn the approved static page into a release-specific Pages artifact.
// A failed release lookup, checksum, or attestation stops deployment.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = 'SamSnead85/agent-console';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(root, 'dist', 'site');
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const replace = (source, before, after) => {
  if (!source.includes(before)) throw new Error(`Site template is missing: ${before.slice(0, 70)}`);
  return source.replaceAll(before, after);
};
const shortDate = (iso) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
const longDate = (iso) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));

const release = JSON.parse(gh('release', 'view', '--repo', repo, '--json', 'tagName,publishedAt,assets'));
const tag = release.tagName;
if (!/^v\d+\.\d+\.\d+$/.test(tag) || !release.publishedAt) throw new Error('No usable published release');
const version = tag.slice(1);
const tgz = `lockedinlabs-agent-console-${version}.tgz`;
const assetNames = new Set(release.assets.map((asset) => asset.name));
if (!assetNames.has('SHA256SUMS') || !assetNames.has(tgz)) throw new Error('Release is missing its tarball or SHA256SUMS');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-site-'));
let digest;
let verification;
let sums;
try {
  gh('release', 'download', tag, '--repo', repo, '--dir', temp, '--pattern', 'SHA256SUMS', '--pattern', tgz);
  const lines = fs.readFileSync(path.join(temp, 'SHA256SUMS'), 'utf8').split(/\r?\n/);
  sums = new Map();
  for (const line of lines) {
    if (!line) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?([^/\s]+)$/.exec(line);
    if (!match || sums.has(match[2])) throw new Error('Invalid or duplicate SHA256SUMS line');
    sums.set(match[2], match[1].toLowerCase());
  }
  digest = sums.get(tgz);
  if (!digest) throw new Error('Tarball hash missing from SHA256SUMS');
  const actual = createHash('sha256').update(fs.readFileSync(path.join(temp, tgz))).digest('hex');
  if (actual !== digest) throw new Error('Release tarball does not match SHA256SUMS');
  const verified = JSON.parse(gh('attestation', 'verify', path.join(temp, tgz), '--repo', repo, '--format', 'json'));
  verification = verified.find((entry) => entry.verificationResult?.statement?.subject?.some((subject) => subject.name === tgz && subject.digest?.sha256 === digest));
  if (!verification) throw new Error('No verified attestation for the exact tarball hash');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

const cert = verification.verificationResult?.signature?.certificate;
const statement = verification.verificationResult?.statement;
const logged = verification.verificationResult?.verifiedTimestamps?.find((time) => time.type === 'Tlog');
if (cert?.githubWorkflowRepository !== repo || cert?.githubWorkflowRef !== `refs/tags/${tag}` ||
    cert?.githubWorkflowTrigger !== 'release' || cert?.runnerEnvironment !== 'github-hosted' ||
    statement?.predicateType !== 'https://slsa.dev/provenance/v1' || !logged?.timestamp) {
  throw new Error('Attestation facts do not match this release workflow');
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'site'), out, { recursive: true });
let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
html = replace(html, '0.2.1', version);
html = replace(html, `recorded from ${tag} with`, 'recorded from v0.2.1 with');
html = replace(html, '15e53aa80504c98ddda86f0772642d9a15a4547992ed3c29139731679e9c6aeb', digest);
html = replace(html, '15e53aa8…9c6aeb', `${digest.slice(0, 8)}…${digest.slice(-6)}`);
html = replace(html, 'Released 23 September 2026', `Released ${longDate(release.publishedAt)}`);
html = replace(html, `${tag} · 23 Sep 2026`, `${tag} · ${shortDate(release.publishedAt)}`);
html = replace(html, 'read on 24 Sep 2026', 'checked at build');
html = replace(html, '19644fed1f6f69c9496039dc63919104cd1bb1d4', cert.githubWorkflowSHA);
html = replace(html, '2026-09-22 22:36:49 −04:00', `${new Date(logged.timestamp).toISOString().slice(0, 19).replace('T', ' ')} UTC`);
html = replace(html, 'release · github-hosted', `${cert.githubWorkflowTrigger} · ${cert.runnerEnvironment}`);
html = replace(html, 'Every install path and figure on this page is real as of 24 Sep 2026:', 'Release facts on this page are checked at build:');

const prices = JSON.parse(fs.readFileSync(path.join(root, 'lib', 'collector', 'prices.json'), 'utf8'));
html = replace(html, 'prices checked 2026-09-20', `prices checked ${prices.inventoryCheckedOn}`);
const opus = prices.rows.find((row) => row.model === 'claude-opus-5-5');
html = replace(html, 'Opus 5.5 2026-09-22', `Opus 5.5 ${opus.verifiedOn}`);
const nativeNames = [
  'agent-console-darwin-arm64', 'agent-console-darwin-x64',
  'agent-console-linux-arm64', 'agent-console-linux-x64', 'agent-console-win32-x64.exe',
];
const native = Object.fromEntries(nativeNames.filter((name) => assetNames.has(name)).map((name) => {
  if (!sums.has(name)) throw new Error(`Missing release checksum for ${name}`);
  return [name, { url: `https://github.com/${repo}/releases/download/${tag}/${name}`, sha256: sums.get(name) }];
}));
html = replace(html, '</head>', `<script id="native-downloads" type="application/json">${JSON.stringify(native)}</script>\n</head>`);
fs.writeFileSync(path.join(out, 'index.html'), html);

let script = fs.readFileSync(path.join(out, 'assets', 'site.js'), 'utf8');
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
fs.writeFileSync(path.join(out, 'assets', 'site.js'), script);

// The approved page links to the release tarball until a native download
// exists. This build never invents a binary URL or a signature claim.
console.log(`Built site for ${tag}; tarball SHA-256 and attestation verified; ${assetNames.size} release assets.`);
