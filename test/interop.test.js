import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizeInterop, formatInteropMetrics } from '../lib/analysis/index.js';
import { parseOtlpMetrics, parseGatewayMetrics } from '../lib/interop/ingest.js';

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

test('opt-in local receiver accepts only projected metric fields and keeps them off the report protocol', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-interop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [bin, '--no-local', '--interop', '--json', '--port', '0', '--home', root,
    '--state-dir', path.join(root, 'state')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const meta = await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (!output.includes('\n')) return;
      clearInterval(timer);
      try { clearTimeout(deadline); resolve(JSON.parse(output.split('\n').find((line) => line.trim().startsWith('{'))).dashboard); } catch (error) { reject(error); }
    }, 25);
    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error(output || 'startup timeout')); }, 10_000);
    child.once('exit', (code) => { clearTimeout(deadline); clearInterval(timer); reject(new Error(`exited ${code}: ${output}`)); });
  });
  const base = meta.url;
  const key = fs.readFileSync(path.join(root, 'state', 'admin.key'), 'utf8').trim();
  const authorization = { authorization: `Bearer ${key}` };
  const login = await fetch(meta.signIn, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const denied = await fetch(base + '/v1/metrics', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(otlp([point('input', 13)])) });
  assert.equal(denied.status, 403);
  const deniedWithoutKey = await fetch(base + '/v1/metrics', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-agent-console-interop': '1',
  }, body: JSON.stringify(otlp([point('input', 13)])) });
  assert.equal(deniedWithoutKey.status, 403);
  assert.equal((await fetch(base + '/metrics')).status, 403);
  assert.equal((await fetch(base + '/metrics', { headers: { authorization: 'Bearer incorrect' } })).status, 403);
  const accepted = await fetch(base + '/v1/metrics', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-agent-console-interop': '1', ...authorization,
  }, body: JSON.stringify(otlp([point('input', 13, [
    { key: 'repository.path', value: { stringValue: '/canary-private-path' } },
  ])])) });
  assert.equal(accepted.status, 200);
  const gateway = await fetch(base + '/ingest/gateway/kong', { method: 'POST', headers: {
    'content-type': 'text/plain', 'x-agent-console-interop': '1', ...authorization,
  }, body: 'ai_llm_tokens_total{ai_model="claude-sonnet-5",token_type="prompt_tokens",consumer="canary-private-consumer"} 90' });
  assert.equal(gateway.status, 200);
  const view = await fetch(base + '/api/console', { headers: { 'x-agent-console': '1', cookie } });
  const shown = await view.text();
  assert.ok(!shown.includes('canary-private'));
  const data = JSON.parse(shown);
  assert.equal(data.interop.otel.tokens.total, 13);
  assert.equal(data.interop.kong.tokens.total, 90);
  const metrics = await (await fetch(base + '/metrics', { headers: authorization })).text();
  assert.match(metrics, /agent_console_interop_tokens\{source="otel",kind="input"\} 13/u);
  assert.ok(!metrics.includes('canary-private') && !metrics.includes('claude-sonnet-5'));
  const report = await fetch(`http://127.0.0.1:${meta.reportPort}/metrics`);
  assert.equal(report.status, 404);
});
