#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// npm delegates scripts to the platform shell, and Windows cmd.exe passes a
// `test/*.test.js` glob through literally on Node 18 and 20. Enumerating in
// Node makes `npm test` mean the same thing on every supported runtime and
// keeps helpers out of the test set.
const files = readdirSync(new URL('../test/', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => new URL(`../test/${entry.name}`, import.meta.url))
  .sort((a, b) => a.pathname.localeCompare(b.pathname));

if (files.length === 0) {
  process.stderr.write('agent-console: no test/*.test.js files found\n');
  process.exit(1);
}

const requested = process.env.AGENT_CONSOLE_TEST_CONCURRENCY ?? '4';
if (!/^\d+$/.test(requested) || Number(requested) < 1) {
  process.stderr.write('agent-console: AGENT_CONSOLE_TEST_CONCURRENCY must be a positive integer\n');
  process.exit(2);
}
const [major, minor] = process.versions.node.split('.').map(Number);
const supportsConcurrency = major > 18 || (major === 18 && minor >= 19);

const args = ['--test'];
if (supportsConcurrency) args.push(`--test-concurrency=${requested}`);
args.push(...files.map(fileURLToPath));

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
