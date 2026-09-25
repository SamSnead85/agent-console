import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { runOnce, projectRecord, identityHasher, argumentsFor, coverageState, summarize } from '../lib/collector/collector.js';

const prices = { v: 1, currency: 'USD', rows: [] };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-synthetic-'));
  // Remove only the temporary directory created by this synthetic test.
  t.after(() => fs.rm(root, { recursive: true }));
  const source = path.join(root, 'logs');
  await fs.mkdir(source);
  const directory = path.join(root, 'state');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'enrollment.json'), JSON.stringify({ v:1, organizationId:'synthetic-org',
    device:{id:'device-a',label:'Workstation'},orgSalt:Buffer.alloc(32,7).toString('base64url') }), {mode:0o600});
  return { root, source, filename: path.join(source, 'synthetic.jsonl'), directory,
    roots: [{ tool: 'claude-code', directory: source }], prices };
}
function usage(id, counters = {}) {
  return JSON.stringify({ type: 'assistant', uuid: `line-${id}`, sessionId: 'synthetic-session', cwd: '/SENTINEL_PRIVATE_PATH',
    timestamp: new Date().toISOString(), isSidechain: false,
    message: { id, model: 'unknown-model-test', content: 'SENTINEL_PRIVATE_PROMPT é',
      command: 'SENTINEL_PRIVATE_COMMAND', usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 3, cache_read_input_tokens: 7, ...counters } } });
}
function output() {
  let value = '';
  return { stream: new Writable({ write(chunk, _, done) { value += chunk.toString(); done(); } }), value: () => value };
}
test('cursor restarts emit only new records; partial multibyte lines wait for completion', async t => {
  const data = await fixture(t), first = output();
  await fs.writeFile(data.filename, usage('one')+'\n');
  await runOnce({ ...data, stdout: first.stream });
  const records = first.value().trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].fresh, 10);
  const second = output();
  await runOnce({ ...data, stdout: second.stream });
  assert.equal(second.value(), '');
  const partial = usage('two');
  await fs.appendFile(data.filename, partial.slice(0, 80));
  await runOnce({ ...data, stdout: second.stream });
  assert.equal(second.value(), '');
  await fs.appendFile(data.filename, partial.slice(80)+'\n');
  await runOnce({ ...data, stdout: second.stream });
  const next = JSON.parse(second.value());
  assert.notEqual(next.id, records[0].id);
  assert.equal(next.sessionHash, records[0].sessionHash);
});

test('redaction covers emitted records and persistent parser/cursor state', async t => {
  const data = await fixture(t), out = output();
  await fs.writeFile(data.filename, usage('one')+'\n');
  await runOnce({ ...data, stdout: out.stream });
  const text = out.value() + await fs.readFile(path.join(data.directory, 'cursor-v2.json'), 'utf8') + await fs.readFile(path.join(data.directory, 'records-v2.ndjson'), 'utf8');
  assert.doesNotMatch(text, /SENTINEL_PRIVATE|synthetic\.jsonl/);
  assert.doesNotMatch(out.value(), /synthetic-session/);
  const record = JSON.parse(out.value());
  assert.deepEqual(Object.keys(record).sort(), ['id','tool','model','sessionHash','parentSessionHash','isSubagent','projectHash','engagement','at','fresh','output','cacheWrite','cacheRead','cacheWrite5m','cacheWrite1h','ttl','reportingDevice','executionOrigin','observed','measurement','continuation','tier'].sort());
  assert.equal(record.continuation, false);
  assert.equal(record.engagement, null);
  assert.equal(record.observed, true);
  assert.equal(new Date(record.at).getUTCSeconds(), 0);
  if (process.platform !== 'win32') {   // Windows has no POSIX modes
    assert.equal((await fs.stat(path.join(data.directory, 'enrollment.json'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(data.directory, 'cursor-v2.json'))).mode & 0o777, 0o600);
  }
});
test('summary does not consume a delivery cursor; repeated IDs are deduplicated in totals', async t => {
  const data = await fixture(t), out = output();
  await fs.writeFile(data.filename, usage('one')+'\n');
  const summary = await runOnce({ ...data, summary: true });
  assert.equal(summary.records, 1);
  assert.equal(summary.tokens.fresh.observed, 10);
  assert.equal(summary.pricing.total, null);
  await runOnce({ ...data, stdout: out.stream });
  assert.equal(JSON.parse(out.value()).output, 4);
  await fs.appendFile(path.join(data.directory, 'records-v2.ndjson'), out.value());
  const again = await runOnce({ ...data, summary: true });
  assert.equal(again.records, 1);
  assert.equal(again.tokens.output.observed, 4);
});
test('engagement labels are exclusively local, keyed by salted project hash', async t => {
  const data = await fixture(t), out = output();
  await fs.writeFile(data.filename, usage('one')+'\n');
  await runOnce({ ...data, stdout: out.stream });
  const record = JSON.parse(out.value());
  await fs.writeFile(path.join(data.directory, 'labels.json'), JSON.stringify({ [record.projectHash]: 'engagement-example' }));
  await fs.appendFile(data.filename, usage('two')+'\n');
  const second = output(); await runOnce({ ...data, stdout: second.stream });
  assert.equal(JSON.parse(second.value()).engagement, 'engagement-example');
});
test('truncation or rewritten prefix starts a new source generation', async t => {
  const data = await fixture(t), out = output();
  await fs.writeFile(data.filename, usage('one')+'\n');
  await runOnce({ ...data, stdout: out.stream });
  await fs.writeFile(data.filename, usage('replacement-longer-message-id')+'\n');
  const next = output(); await runOnce({ ...data, stdout: next.stream });
  assert.notEqual(JSON.parse(next.value()).id, JSON.parse(out.value()).id);
});
test('projection strips arbitrary extra fields and does not invent unknown classes', () => {
  const h = identityHasher(Buffer.alloc(32, 1));
  const record = projectRecord({ id: h('a','b'), tool:'codex', model:'SENTINEL PATH', sessionHash:h('s','b'), parentSessionHash:null,
    isSubagent:false, reportingDevice:'device-a', executionOrigin:'unknown', ttl:'unknown', projectHash:h('p','b'), at:new Date().toISOString(), fresh:2, output:4, cacheRead:1,
    prompt:'SENTINEL_PROMPT', command:'SENTINEL_COMMAND' });
  assert.equal(record.cacheWrite, null);
  assert.equal(record.model, 'unknown');
  assert.doesNotMatch(JSON.stringify(record), /SENTINEL/);
});
test('unsupported flags cannot carry a device token, and conflicting modes fail', () => {
  assert.throws(() => argumentsFor(['--token','synthetic-token']));
  assert.throws(() => argumentsFor(['--once','--watch']));
  assert.throws(() => argumentsFor(['--post','https://example.invalid','--out','example.ndjson']));
  assert.deepEqual(argumentsFor(['--once']), { once:true });
});
test('an incomplete crash tail is repaired before new metadata is appended', async t => {
  const data = await fixture(t), out = output();
  await fs.writeFile(data.filename, usage('one')+'\n');
  await runOnce({ ...data, stdout: out.stream });
  await fs.appendFile(path.join(data.directory, 'records-v2.ndjson'), '{"id":"unfinished');
  await fs.appendFile(data.filename, usage('two')+'\n');
  const next = output(); await runOnce({ ...data, stdout: next.stream });
  assert.equal(JSON.parse(next.value()).output, 4);
  assert.equal((await runOnce({ ...data, summary: true })).records, 2);
});
test('a failed output callback leaves the sink cursor retryable', async t => {
  const data = await fixture(t);
  await fs.writeFile(data.filename, usage('one')+'\n');
  const failed = new Writable({ write(_chunk, _encoding, callback) { setTimeout(() => callback(new Error('synthetic sink failure')), 5); } });
  await assert.rejects(runOnce({ ...data, stdout: failed }));
  const next = output(); await runOnce({ ...data, stdout: next.stream });
  assert.equal(JSON.parse(next.value()).fresh, 10);
});
test('output can never modify transcript sources or collector internal state', async t => {
  const data = await fixture(t);
  await fs.writeFile(data.filename, usage('one')+'\n');
  await assert.rejects(runOnce({ ...data, out: data.filename }));
  await assert.rejects(runOnce({ ...data, out: path.join(data.directory, 'records-v2.ndjson') }));
});
test('portable records require server enrollment; unenrolled summary emits only aggregates', async t => {
  const data = await fixture(t);
  await fs.unlink(path.join(data.directory, 'enrollment.json'));
  await fs.writeFile(data.filename, usage('one')+'\n');
  await assert.rejects(runOnce({ ...data, stdout: output().stream }), { code:'enrollment_required' });
  const summary = await runOnce({ ...data, summary:true });
  assert.equal(summary.enrolled, false);
  assert.equal(summary.records, 1);
  assert.equal(summary.freshness.mode, 'periodic');
  assert.equal(summary.freshness.lastSyncedAt, null);
  assert.equal(summary.tokens.output.observed, 4);
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-session|sessionHash|projectHash|SENTINEL/);
  assert.deepEqual(await fs.readdir(data.directory), []);
});
test('copies at different source locations share portable IDs and do not inflate totals', async t => {
  const data = await fixture(t), out = output();
  await fs.writeFile(data.filename, usage('one')+'\n');
  await fs.copyFile(data.filename, path.join(data.source, 'copied.jsonl'));
  await runOnce({ ...data, stdout:out.stream });
  assert.equal(out.value().trim().split('\n').length, 1);
  const summary = await runOnce({ ...data, summary:true });
  assert.equal(summary.records, 1);
  assert.equal(summary.tokens.fresh.observed, 10);
  assert.equal(summary.enrolled, true);
});
test('all four observation freshness states are explicit', () => {
  const now = new Date('2026-09-20T18:00:00Z');
  assert.equal(coverageState(null,now),'neverReported');
  assert.equal(coverageState('2026-09-20T17:56:00Z',now),'active');
  assert.equal(coverageState('2026-09-20T16:00:00Z',now),'reportedToday');
  assert.equal(coverageState('2026-09-19T17:56:00Z',now),'stale');
  assert.deepEqual(argumentsFor(['--sync-now']), {'sync-now':true});
});
test('an enrollment change cannot mix organizations or devices into an old cursor', async t => {
  const data=await fixture(t);
  await fs.writeFile(data.filename,usage('one')+'\n');
  await runOnce({...data,summary:true});
  const file=path.join(data.directory,'enrollment.json');
  const bundle=JSON.parse(await fs.readFile(file,'utf8'));
  bundle.organizationId='another-org';
  await fs.writeFile(file,JSON.stringify(bundle));
  await assert.rejects(runOnce({...data,summary:true}));
});
test('first writer wins before day filtering, including unenrolled preview freshness', async t => {
  const data = await fixture(t);
  const first = JSON.parse(usage('one'));
  first.timestamp = '2026-09-19T12:00:00Z';
  const later = structuredClone(first);
  later.timestamp = '2026-09-20T12:00:00Z';
  later.message.usage.output_tokens = 99;
  await fs.writeFile(data.filename, JSON.stringify(first)+'\n');
  await fs.writeFile(path.join(data.source, 'z-conflict.jsonl'), JSON.stringify(later)+'\n');
  const now = new Date('2026-09-20T18:00:00Z');
  await runOnce({ ...data, summary:true, now });
  const saved = await summarize(data.directory, prices, now);
  assert.equal(saved.records, 0);
  assert.equal(saved.tokens.output.observed, 0);
  await fs.unlink(path.join(data.directory, 'enrollment.json'));
  const preview = await runOnce({ ...data, summary:true, now });
  assert.equal(preview.records, 0);
  assert.equal(preview.tokens.output.observed, 0);
  assert.equal(preview.freshness.lastObservedAt, '2026-09-19T12:00:00.000Z');
});

test('summaries carry a shared bounded usage context without leaking preview identities', async t => {
  const data=await fixture(t);
  await fs.writeFile(data.filename,usage('one',{cache_creation_input_tokens:null})+'\n');
  for(const enrolled of [true,false]) {
    if(!enrolled)await fs.unlink(path.join(data.directory,'enrollment.json'));
    const result=await runOnce({...data,summary:true});
    assert.equal(result.measurement.provenance,'deviceReported');
    assert.equal(result.measurement.population.records,result.records);
    assert.equal(result.measurement.window.kind,'calendarDay');
    assert.equal(result.tokens.cacheWrite.unknownRecords,1);
    assert.equal(result.coverage.measurement.population.unit,'devices reporting');
    assert.equal(result.coverage.measurement.population.enrolledCount,null);
    assert.equal(result.pricing.measurement.provenance,'estimate');
    assert.doesNotMatch(JSON.stringify(result),/SENTINEL|sessionHash|recordId|synthetic-session/);
  }
});
test('older portable spool records gain context at delivery without changing IDs or rewriting the spool', async t => {
  const data=await fixture(t);
  await fs.writeFile(data.filename,usage('one')+'\n');
  await runOnce({...data,summary:true});
  const file=path.join(data.directory,'records-v2.ndjson');
  const old=JSON.parse(await fs.readFile(file,'utf8'));
  delete old.measurement;
  const bytes=JSON.stringify(old)+'\n';
  await fs.writeFile(file,bytes);
  const out=output();
  await runOnce({...data,stdout:out.stream});
  const current=JSON.parse(out.value());
  assert.equal(current.id,old.id);
  assert.equal(current.measurement.provenance,'deviceReported');
  assert.equal(current.measurement.population.recordId,old.id);
  delete current.measurement;
  assert.deepEqual(current,old);
  assert.equal(await fs.readFile(file,'utf8'),bytes);
});
