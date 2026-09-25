#!/usr/bin/env node

/*
 * The release gate: pack the package, install the tarball into a scratch
 * prefix, start the installed copy in demo mode (so it reads none of this
 * machine's transcripts) and check that it serves the console, signs a
 * browser in, and serves the join page on its reporting port. It also refuses
 * to pack a copy without its licence, notices and provenance statement.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { suite as sourceSuite } from '../test/conformance/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-pack-'));
const npmCli = process.env.npm_execpath;

function run(command, args, { cwd = root, env = {} } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.error || result.status !== 0) {
    throw new Error([`${command} ${args.join(' ')} failed with ${result.status}`, result.stderr, result.stdout, result.error?.message].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
}

function runNpm(args, options) {
  if (npmCli) return run(process.execPath, [npmCli, ...args], options);
  if (process.platform === 'win32') throw new Error('npm_execpath is unavailable; run this through `npm run smoke:pack` on Windows');
  return run('npm', args, options);
}

/** The licence, the third-party notices and the provenance statement travel with every copy. */
function assertLicensed(installed) {
  const read = (name) => { try { return fs.readFileSync(path.join(installed, name), 'utf8'); } catch { return ''; } };
  assert.match(read('LICENSE'), /MIT License[\s\S]*LockedIn Labs/u, 'the packed copy has no MIT licence naming LockedIn Labs');
  assert.match(read('THIRD_PARTY_NOTICES.md'), /SIL Open Font License/u, 'the packed copy has no third-party notices');
  assert.match(read('PROVENANCE.md'), /^Released under the MIT licence by LockedIn Labs/mu, 'the packed copy has no provenance statement');
}

try {
  const npmCache = path.join(scratch, 'npm-cache');
  const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', scratch], { env: { npm_config_cache: npmCache } }))[0];
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  const tarball = path.join(scratch, packed.filename);

  const prefix = path.join(scratch, 'install');
  runNpm(['install', '--prefix', prefix, '--ignore-scripts', tarball], { env: { npm_config_cache: npmCache } });
  const installed = path.join(prefix, 'node_modules', ...manifest.name.split('/'));
  assertLicensed(installed);
  assert.match(run(process.execPath, ['--input-type=module', '-e',
    "import { ANALYSIS_VERSION, contextHealth } from '@lockedinlabs/agent-console/analysis'; console.log(ANALYSIS_VERSION, contextHealth([], null).status)"],
    { cwd: prefix }), /^1 unknown$/u, 'packed analysis subpath is unavailable');
  assert.equal(run(process.execPath, ['--input-type=module', '-e',
    "import { suite } from '@lockedinlabs/agent-console/conformance'; console.log(suite)"],
    { cwd: prefix }).trim(), sourceSuite, 'packed conformance subpath is unavailable or not this tree\'s suite');

  const bin = path.join(installed, 'bin', 'agent-console.mjs');
  const child = spawn(process.execPath, [bin, '--demo', '--json', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: scratch });
  const closed = once(child, 'close');
  try {
    const meta = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('installed console startup timed out')), 15_000);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      child.once('error', (error) => finish(error));
      child.once('exit', (code) => finish(new Error('installed console exited early: ' + code)));
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (!output.includes('\n')) return;
        try { finish(null, JSON.parse(output.split('\n')[0]).dashboard); } catch (error) { finish(error); }
      });
    });
    const timeout = () => AbortSignal.timeout(10_000);
    const page = await fetch(meta.url, { signal: timeout() });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent Console/u);
    const login = await fetch(meta.signIn, { redirect: 'manual', signal: timeout() });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const view = await fetch(meta.url + '/api/console', { headers: { 'X-Agent-Console': '1', cookie }, signal: timeout() });
    assert.equal(view.status, 200);
    const data = await view.json();
    assert.equal(data.hub.demo, true);
    assert.ok(data.devices.length > 1 && data.day.tokens.total > 0);
    const join = await fetch(`http://127.0.0.1:${meta.reportPort}/join`, { signal: timeout() });
    assert.equal(join.status, 200);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
  process.stdout.write(`packed, installed and started ${packed.filename} (${packed.size} bytes; ${packed.entryCount} files)\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
