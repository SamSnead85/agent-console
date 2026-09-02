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
import { spawnSync } from 'node:child_process';
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
 * names a person, so the two are told apart by the one character that cannot
 * appear in a real answer.
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
  const started = spawnSync(process.execPath, [bin, '--demo', '--json', '--port', '0'], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.match(started.stdout || '', /"ok":true/u, 'the installed console did not start');

  process.stdout.write(
    `packed, installed and started ${packed.filename} (${packed.size} bytes; ${packed.entryCount} files)\n`,
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
