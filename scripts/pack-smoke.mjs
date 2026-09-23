#!/usr/bin/env node

/*
 * The release gate.
 *
 * Two jobs: prove the packed artifact actually installs and runs, and refuse
 * to package code whose redistribution nobody recorded. The second is not
 * ceremony — this console was recovered from a proprietary repository into an
 * MIT package, and until 2026-09-02 the only thing standing between that code
 * and a public registry was a paragraph in a markdown file that no tool read.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-pack-'));
const npmCli = process.env.npm_execpath;

function run(command, args, { cwd = root, env = {} } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.error || result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with ${result.status}`,
      result.stderr, result.stdout, result.error?.message,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
}

function runNpm(args, options) {
  if (npmCli) return run(process.execPath, [npmCli, ...args], options);
  if (process.platform === 'win32') {
    throw new Error('npm_execpath is unavailable; run this through `npm run smoke:pack` on Windows');
  }
  return run('npm', args, options);
}

/**
 * Refuse to package code whose redistribution is unrecorded.
 *
 * One exact sentence, so the check cannot pass on prose that merely discusses
 * the decision. The negative lookahead is not decoration: PROVENANCE.md has to
 * show the operator what to write, that template sits at the start of a line
 * like any other, and the first version of this check was satisfied by the
 * documentation of itself. A placeholder opens with `<`, a recorded decision
 * names who authorized it, so the two are told apart by the one character
 * that cannot appear in a real answer.
 */
function assertRedistributable(installedPackage) {
  const provenance = path.join(installedPackage, 'PROVENANCE.md');
  let text = '';
  try {
    text = fs.readFileSync(provenance, 'utf8');
  } catch {
    throw new Error(
      'This artifact has no PROVENANCE.md. This console is recovered code and\n' +
      'cannot be published without a recorded redistribution authorization.',
    );
  }
  if (!/^REDISTRIBUTION AUTHORIZED: (?!<)\S/mu.test(text)) {
    throw new Error([
      'Refusing to package this console.',
      '',
      'It was recovered from a private, all-rights-reserved repository, and its',
      'PROVENANCE.md does not record an authorization to redistribute it under',
      "this package's licence.",
      '',
      'expected: a line in PROVENANCE.md beginning "REDISTRIBUTION AUTHORIZED: "',
      '          naming who authorized it and when',
      'next:     have the owner record that decision before cutting a release',
    ].join('\n'));
  }
}

try {
  const npmCache = path.join(scratch, 'npm-cache');
  const packJson = runNpm(['pack', '--json', '--pack-destination', scratch], {
    env: { npm_config_cache: npmCache },
  });
  const packed = JSON.parse(packJson)[0];
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  const tarball = path.join(scratch, packed.filename);

  const prefix = path.join(scratch, 'install');
  runNpm(['install', '--prefix', prefix, '--ignore-scripts', tarball], {
    env: { npm_config_cache: npmCache },
  });

  const installed = path.join(prefix, 'node_modules', ...manifest.name.split('/'));
  assertRedistributable(installed);

  // The installed artifact must actually start, in demo mode so the smoke test
  // reads none of the operator's own transcripts.
  const bin = path.join(installed, 'bin', 'agent-console.mjs');
  const child = spawn(process.execPath, [bin, '--demo', '--json', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: scratch,
  });
  const closed = once(child, 'close');
  try {
    const metadata = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('installed console startup timed out')), 15_000);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      child.once('error', error => finish(error));
      child.once('exit', code => finish(new Error('installed console exited early: ' + code)));
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (!output.includes('\n')) return;
        try { finish(null, JSON.parse(output.split('\n')[0])); }
        catch (error) { finish(error); }
      });
    });
    assert.equal(metadata.ok, true);
    assert.ok(metadata.dashboard.port > 0);
    const base = metadata.dashboard.url;
    const page = await fetch(base, {signal: AbortSignal.timeout(10_000)});
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent Console/);
    const data = await fetch(base + '/api', {
      headers: {'X-Agent-Console': '1'}, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(data.status, 200);
    const snapshot = await data.json();
    assert.equal(snapshot.demo.synthetic, true);
    assert.ok(snapshot.rows.length > 0);
    const history = await fetch(base + '/api/history?period=24h', {
      headers: {'X-Agent-Console': '1'}, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(history.status, 200);
    assert.ok((await history.json()).totals.total > 0);
    // The v0.2 hub: the console's own view, and the join page another machine opens.
    const hub = await fetch(base + '/api/console', {
      headers: {'X-Agent-Console': '1'}, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(hub.status, 200);
    const view = await hub.json();
    assert.equal(view.hub.demo, true);
    assert.ok(view.devices.length > 1 && view.day.tokens.total > 0);
    const join = await fetch(base + '/join', {signal: AbortSignal.timeout(10_000)});
    assert.equal(join.status, 200);
    const tarball = await fetch(`${base}/agent-console-${manifest.version}.tgz`, {signal: AbortSignal.timeout(10_000)});
    assert.equal(tarball.status, 200);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }

  process.stdout.write(
    `packed, installed and started ${packed.filename} (${packed.size} bytes; ${packed.entryCount} files)\n`,
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
