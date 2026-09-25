#!/usr/bin/env node
// Render the tap formula only from a release's checked SHA256SUMS file.
import fs from 'node:fs';
import path from 'node:path';

const [tag, sumsPath, outputPath] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || !sumsPath || !outputPath) {
  console.error('Usage: node scripts/render-homebrew-formula.mjs vX.Y.Z SHA256SUMS OUTPUT.rb');
  process.exit(2);
}
const template = fs.readFileSync(new URL('../packaging/homebrew-tap/Formula/agent-console.rb.in', import.meta.url), 'utf8');
const sums = new Map();
for (const line of fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
  if (!line) continue;
  const match = /^([0-9a-fA-F]{64})\s+\*?([^/\s]+)$/.exec(line);
  if (!match || sums.has(match[2])) throw new Error('Invalid or repeated SHA256SUMS line');
  sums.set(match[2], match[1].toLowerCase());
}
let rendered = template.replaceAll('@VERSION@', tag.slice(1));
for (const [token, file] of [
  ['DARWIN_ARM64', 'agent-console-darwin-arm64.tar.gz'],
  ['DARWIN_X64', 'agent-console-darwin-x64.tar.gz'],
  ['LINUX_ARM64', 'agent-console-linux-arm64.tar.gz'],
  ['LINUX_X64', 'agent-console-linux-x64.tar.gz'],
]) {
  const digest = sums.get(file);
  if (!digest) throw new Error(`Missing SHA-256 for ${file}`);
  rendered = rendered.replaceAll(`@${token}_SHA@`, digest);
}
if (/@[A-Z0-9_]+@/.test(rendered)) throw new Error('Unrendered formula token');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, rendered);
