import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizeInterop, formatInteropMetrics } from '../lib/analysis/index.js';
import { parseOtlpMetrics, parseGatewayMetrics, createInteropStore } from '../lib/interop/ingest.js';
import { readAdminKey, scrapeToken } from '../lib/hub/admin.js';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-console.mjs');
const time = () => String(BigInt(Date.now()) * 1_000_000n);
const point = (kind, tokens, extra = []) => ({ asInt: String(tokens), timeUnixNano: time(), attributes: [
  { key: 'type', value: { stringValue: kind } }, { key: 'model', value: { stringValue: 'claude-sonnet-5' } }, ...extra,
] });
const otlp = (points) => ({ resourceMetrics: [{ resource: { attributes: [
  { key: 'user.email', value: { stringValue: 'canary-private-email' } },
] }, scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: {
  aggregationTemporality: 1, dataPoints: points,
} }] }] }] });

test('shared core keeps sources separate and represents absent readings as unavailable', () => {
  const now = Date.now();
  const sample = [
    { source: 'otel', at: now, model: 'claude-sonnet-5', kind: 'input', tokens: 10, seriesHash: 'a' },
    { source: 'kong', at: now, model: 'claude-sonnet-5', kind: 'input', tokens: 100, seriesHash: 'b' },
    { source: 'kong', at: now, model: 'claude-sonnet-5', kind: 'cacheRead', tokens: 40, seriesHash: 'c' },
  ];
  const summary = summarizeInterop(sample, now);
  assert.equal(summary.otel.tokens.total, 10);
  assert.equal(summary.kong.tokens.total, 100, 'gateway cache is a subset of input');
  assert.equal(summary.litellm.available, false);
  assert.equal(summary.litellm.tokens, null);
  const text = formatInteropMetrics({ fresh: 7, output: 2, cacheRead: 5, cacheWrite: 1 }, summary);
  assert.match(text, /agent_console_transcript_tokens_last_24h\{kind="input"\} 7/u);
  assert.match(text, /agent_console_interop_tokens\{source="kong",kind="cacheRead"\} 40/u);
  assert.ok(!text.includes('claude-sonnet-5'));
});

test('raw OTLP and gateway labels are projected to counts, model ids, times and salted hashes', () => {
  const hash = () => 'a'.repeat(64);
  const samples = parseOtlpMetrics(otlp([point('input', 13, [
    { key: 'prompt', value: { stringValue: 'canary-private-prompt' } },
  ])]), Date.now(), hash);
  assert.equal(samples.length, 1);
  assert.deepEqual(Object.keys(samples[0]).sort(), ['at', 'kind', 'model', 'seriesHash', 'source', 'tokens']);
  assert.ok(!JSON.stringify(samples).includes('canary-private'));
  const gateway = parseGatewayMetrics('litellm',
    'litellm_input_tokens_metric_total{model="claude-sonnet-5",user_email="canary-private-email"} 27', Date.now(), hash);
  assert.equal(gateway[0].tokens, 27);
  assert.ok(!JSON.stringify(gateway).includes('canary-private'));
  const kong = parseGatewayMetrics('kong', 'ai_llm_tokens_total{ai_model="claude-sonnet-5",token_type="completion_tokens"} 19', Date.now(), hash);
  assert.equal(kong[0].kind, 'output');
  assert.deepEqual(parseGatewayMetrics('kong', 'ai_llm_tokens_total{ai_model="claude-sonnet-5",token_type="cache_read_input_tokens"} 19', Date.now(), hash), []);
  const cumulative = otlp([point('input', 4)]);
  cumulative.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality = 2;
  assert.deepEqual(parseOtlpMetrics(cumulative, Date.now(), hash), []);
});

test('the interop store keeps sources apart and holds only projected fields', () => {
  const store = createInteropStore();
  assert.equal(store.acceptOtlp(otlp([point('input', 13, [
    { key: 'repository.path', value: { stringValue: '/canary-private-path' } },
  ])])), 1);
  assert.equal(store.acceptGateway('kong',
    'ai_llm_tokens_total{ai_model="claude-sonnet-5",token_type="prompt_tokens",consumer="canary-private-consumer"} 90'), 1);
  const snapshot = store.snapshot();
  assert.ok(!JSON.stringify(snapshot).includes('canary-private'));
  assert.equal(snapshot.otel.tokens.total, 13);
  assert.equal(snapshot.kong.tokens.total, 90);
  assert.equal(snapshot.litellm.available, false);
});

// The scrape token: /metrics and the telemetry ingest take a bearer token
// derived from the console's key, shown by `metrics-token`. Nothing else gets
// in: not the sign-in cookie, not a wrong token, not the console's key itself.
// A new key makes a new token, and the old one stops working.
function startInteropHub(t, root) {
  const child = spawn(process.execPath, [bin, '--no-local', '--interop', '--json', '--port', '0', '--home', root,
    '--state-dir', path.join(root, 'state')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (!output.includes('\n')) return;
      clearInterval(timer);
      try { clearTimeout(deadline); resolve(JSON.parse(output.split('\n').find((line) => line.trim().startsWith('{'))).dashboard); } catch (error) { reject(error); }
    }, 25);
    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error(output || 'startup timeout')); }, 10_000);
    child.once('exit', (code) => { clearTimeout(deadline); clearInterval(timer); reject(new Error(`exited ${code}: ${output}`)); });
  });
  return { child, ready };
}

function metricsToken(root, extra = []) {
  const run = spawnSync(process.execPath, [bin, 'metrics-token', '--state-dir', path.join(root, 'state'), ...extra], { encoding: 'utf8' });
  return run;
}

const gatewayBody = { kong: 'ai_llm_tokens_total{ai_model="claude-sonnet-5",token_type="prompt_tokens"} 90',
  litellm: 'litellm_input_tokens_metric_total{model="claude-sonnet-5"} 27' };

async function interopAnswers(base, auth, cookie) {
  const scrape = await fetch(base + '/metrics', { headers: { ...auth, ...(cookie ? { cookie } : {}) } });
  const scraped = await scrape.text();
  const otel = await fetch(base + '/v1/metrics', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-agent-console-interop': '1', ...auth,
  }, body: JSON.stringify(otlp([point('input', 13)])) });
  const gateways = [];
  for (const gateway of ['kong', 'litellm']) {
    gateways.push((await fetch(base + '/ingest/gateway/' + gateway, { method: 'POST', headers: {
      'content-type': 'text/plain', 'x-agent-console-interop': '1', ...auth,
    }, body: gatewayBody[gateway] })).status);
  }
  return { scrape: scrape.status, scraped, otel: otel.status, gateways };
}

test('with --interop, /metrics and the telemetry ingest take only the scrape token that metrics-token prints', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-interop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = startInteropHub(t, root);
  const meta = await first.ready;
  const base = meta.url;
  const key = fs.readFileSync(path.join(root, 'state', 'admin.key'), 'utf8').trim();
  const login = await fetch(meta.signIn, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  // The CLI prints the token: an HMAC under the key, never the key.
  const printed = metricsToken(root);
  assert.equal(printed.status, 0, printed.stderr);
  const token = scrapeToken(readAdminKey(path.join(root, 'state')));
  assert.equal(token, crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update('agent-console/metrics/v1').digest('base64url'));
  assert.ok(printed.stdout.includes(token));
  assert.ok(!printed.stdout.includes(key), 'metrics-token printed the console key');
  const json = metricsToken(root, ['--json']);
  assert.equal(JSON.parse(json.stdout).token, token);
  assert.notEqual(token, key);

  // Refused: no credential, the cookie alone, a wrong token, a wrong scheme, the console key itself.
  for (const authorization of [undefined, 'Bearer incorrect', `Bearer ${'A'.repeat(43)}`, `Basic ${token}`, `Bearer ${token}x`, `Bearer ${key}`]) {
    const auth = authorization ? { authorization } : {};
    const answers = await interopAnswers(base, auth, cookie);
    assert.equal(answers.scrape, 401, `/metrics with ${authorization || 'no credential'}`);
    assert.ok(!answers.scraped.includes('agent_console_'));
    assert.equal(answers.otel, 401);
    assert.deepEqual(answers.gateways, [401, 401]);
  }
  let data = await (await fetch(base + '/api/console', { headers: { 'x-agent-console': '1', cookie } })).json();
  assert.equal(data.interop.otel.available, false, 'nothing was accepted');

  // Accepted with the token; the local-telemetry header is still required for ingest.
  const auth = { authorization: `Bearer ${token}` };
  const noHeader = await fetch(base + '/v1/metrics', { method: 'POST', headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(otlp([point('input', 13)])) });
  assert.equal(noHeader.status, 403);
  const answers = await interopAnswers(base, auth);
  assert.equal(answers.otel, 200);
  assert.deepEqual(answers.gateways, [200, 200]);
  assert.equal(answers.scrape, 200);
  const again = await (await fetch(base + '/metrics', { headers: auth })).text();
  assert.match(again, /agent_console_interop_tokens\{source="otel",kind="input"\} 13/u);
  assert.match(again, /agent_console_interop_tokens\{source="kong",kind="input"\} 90/u);
  data = await (await fetch(base + '/api/console', { headers: { 'x-agent-console': '1', cookie } })).json();
  assert.equal(data.interop.otel.available, true);

  // Only on the console's own loopback listener, never the reporting port.
  const report = await fetch(`http://127.0.0.1:${meta.reportPort}/metrics`, { headers: auth });
  assert.equal(report.status, 404);

  // A new key: the old token stops working and metrics-token prints the new one.
  first.child.kill('SIGKILL');
  await new Promise((resolve) => first.child.once('exit', resolve));
  fs.writeFileSync(path.join(root, 'state', 'admin.key'), crypto.randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
  const second = await startInteropHub(t, root).ready;
  assert.equal((await fetch(second.url + '/metrics', { headers: auth })).status, 401, 'the old token outlived its key');
  const rotated = JSON.parse(metricsToken(root, ['--json']).stdout).token;
  assert.notEqual(rotated, token);
  assert.equal((await fetch(second.url + '/metrics', { headers: { authorization: `Bearer ${rotated}` } })).status, 200);
});

test('metrics-token needs a console key and says so; a demonstration prints its token at start', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-interop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const none = metricsToken(root);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no console key/u);
  const demo = spawnSync(process.execPath, [bin, 'metrics-token', '--demo'], { encoding: 'utf8' });
  assert.equal(demo.status, 2);
});
