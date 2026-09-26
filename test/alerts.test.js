import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createAlerts, demoAlerts } from '../lib/hub/alerts.js';
import { parseLine } from '../lib/collector/parsers.js';
import { createRegistry } from '../lib/hub/registry.js';
import { createStore } from '../lib/hub/store.js';
import { createNames, startLocalCollection } from '../lib/hub/local.js';
import { claudeSession } from './fixtures/transcripts.js';

const salt = Buffer.alloc(32, 7);
const hashIdentity = (kind, value) => createHmac('sha256', salt).update(`${kind}|${value}`).digest('hex');
const sessionHash = hashIdentity('session', 'claude-code:synthetic-session');
const projectHash = hashIdentity('project', '/synthetic-project');

test('collector-fed lines raise bounded local signals without retaining tool arguments', () => {
  let clock = Date.now();
  const engine = createAlerts({ now: () => clock, repeat: 5, spikeFactor: 3, stallMinutes: 5 });
  const line = (i, tool = true) => ({ type: 'assistant', sessionId: 'synthetic-session',
    timestamp: new Date(clock).toISOString(), message: { id: `msg-${i}`, stop_reason: 'tool_use',
      content: tool ? [{ type: 'tool_use', id: `call-${i}`, name: 'Bash', input: { command: 'CANARY-PRIVATE-COMMAND' } }] : [] } });
  const feed = (i, tokens, tool = true) => engine.observeLine({ tool: 'claude-code', line: line(i, tool),
    records: [{ fresh: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }],
    sessionHash, projectHash, hashIdentity });
  for (let i = 0; i < 5; i += 1) feed(i, 20_000);
  assert.ok(engine.list().some((a) => a.kind === 'loop' && a.tokens === 5));
  feed(5, 100_000, false);
  assert.ok(engine.list().some((a) => a.kind === 'spike'));
  clock += 6 * 60_000;
  feed(6, 600_000, false);
  assert.ok(engine.list().some((a) => a.kind === 'stall'));
  assert.ok(!JSON.stringify(engine.list()).includes('CANARY-PRIVATE-COMMAND'));
  for (const alert of engine.list()) {
    assert.deepEqual(Object.keys(alert).sort(),
      ['at', 'count', 'historical', 'id', 'kind', 'laneHash', 'projectHash', 'seenAt', 'sessionHash', 'sourceAt', 'tokens']);
    assert.equal(alert.historical, false, 'a line read as it is written is live');
    assert.equal(alert.laneHash, sessionHash);
    assert.equal(alert.projectHash, projectHash);
  }
  assert.deepEqual(demoAlerts(clock).map((a) => a.kind), ['loop', 'spike', 'stall']);
});

test('the conformance Codex rollout counts unchanged cumulative totals only once', () => {
  const filename = new URL('./conformance/logs/personA-studio/codex/sessions/2026/09/20/rollout-2026-09-20T14-00-00-d0000003-0000-4000-8000-000000000003.jsonl', import.meta.url);
  const engine = createAlerts();
  const context = { hashIdentity, recordId: (tool, session, message) => hashIdentity('record', `${tool}|${session}|${message}`),
    reportingDevice: 'dev_synthetic', projectHash: hashIdentity('project', 'unknown'),
    onParsedLine(line, result) {
      engine.observeLine({ tool: 'codex', line, records: result.records,
        sessionHash: result.state.sessionHash, parentSessionHash: result.state.parentSessionHash,
        projectHash: result.state.projectHash, historyStartOrdinal: result.state.historyStartOrdinal, hashIdentity });
    } };
  let state = {};
  for (const raw of fs.readFileSync(filename, 'utf8').trim().split('\n')) {
    state = parseLine('codex', raw, context, state).state;
  }
  const hash = hashIdentity('session', 'codex:d0000003-0000-4000-8000-000000000003');
  assert.equal(engine.totals()[hash], 4_990);
  assert.ok(!JSON.stringify([engine.list(), engine.totals()]).includes('CANARY-'));
});

test('the local collector tail raises a populated, private alert after a log append', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-alert-tail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const transcriptDir = path.join(root, 'transcripts');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const registry = createRegistry({ dir: stateDir });
  const store = createStore({ dir: stateDir, retentionMs: 86_400_000 });
  const names = createNames(stateDir);
  const engine = createAlerts({ repeat: 5 });
  const local = startLocalCollection({ registry, store, names, stateDir,
    roots: [{ tool: 'claude-code', directory: transcriptDir }], intervalMs: 2_000,
    onTranscriptLine: engine.observeLine });
  try {
    await local.ready;
    const raw = claudeSession({ sessionId: 'synthetic-alert-session', cwd: '/synthetic-project',
      start: Date.now() - 15_000, turns: 5, stepMs: 1_000 });
    const lines = raw.trim().split('\n').map((row) => JSON.parse(row));
    for (const line of lines) if (line.type === 'assistant') {
      const block = line.message.content.find((item) => item.type === 'tool_use');
      block.name = 'Bash';
      block.input = { command: 'CANARY-PRIVATE-COMMAND' };
    }
    const appendedAt = Date.now();
    fs.writeFileSync(path.join(transcriptDir, 'synthetic.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const deadline = appendedAt + 6_000;
    while (!engine.list().some((alert) => alert.kind === 'loop') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(engine.list().some((alert) => alert.kind === 'loop'), 'a newly appended loop was observed');
    assert.ok(engine.list()[0].projectHash && engine.list()[0].laneHash);
    assert.ok(!JSON.stringify(engine.list()).includes('CANARY-PRIVATE-COMMAND'));
    t.diagnostic(`synthetic append to local alert: ${Date.now() - appendedAt} ms`);
  } finally {
    local.stop();
  }
});
