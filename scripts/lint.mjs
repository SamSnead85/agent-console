#!/usr/bin/env node

/**
 * `npm run lint`: the zero-dependency lint gate. Every JavaScript file the
 * package ships or tests with must parse (`node --check`), and every JSON file
 * it ships, documents or uses as a fixture must be valid JSON. No third-party
 * linter: the package has no dependencies and its checks keep it that way.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['bin', 'lib', 'public', 'scripts', 'test', 'bench', 'docs', 'fixtures'];
const FILES = ['server.js', 'package.json'];
const SKIP = new Set(['node_modules', '.git']);

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

const files = [];
for (const d of DIRS) walk(path.join(root, d), files);
for (const f of FILES) {
  const full = path.join(root, f);
  try { if (statSync(full).isFile()) files.push(full); } catch { /* optional */ }
}

const failures = [];
let checked = 0;
for (const file of files.sort()) {
  const rel = path.relative(root, file);
  if (/\.(?:m?js|cjs)$/u.test(file)) {
    checked += 1;
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) failures.push(`${rel}\n${(r.stderr || r.stdout || '').trim()}`);
  } else if (file.endsWith('.json')) {
    checked += 1;
    try { JSON.parse(readFileSync(file, 'utf8')); } catch (error) { failures.push(`${rel}: ${error.message}`); }
  }
}

if (failures.length) {
  process.stderr.write(`agent-console lint: ${failures.length} of ${checked} files failed\n\n${failures.join('\n\n')}\n`);
  process.exit(1);
}
process.stdout.write(`agent-console lint: ${checked} files parse\n`);
