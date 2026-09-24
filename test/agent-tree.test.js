import test from 'node:test';
import assert from 'node:assert/strict';
import { agentTree } from '@lockedinlabs/agent-console/analysis';

test('shared agent tree keeps parent order and measured model, tokens and span', () => {
  const rows = agentTree([
    { sessionHash: 'child-hash', parentSessionHash: 'root-hash', model: 'synthetic-child', firstAt: 60_000, lastAt: 181_000, tokens: 250, outcome: 'succeeded' },
    { sessionHash: 'root-hash', parentSessionHash: null, model: 'synthetic-root', firstAt: 0, lastAt: 300_000, tokens: 1000 },
  ]);
  assert.deepEqual(rows.map((row) => [row.sessionHash, row.rootSessionHash, row.depth, row.tokens, row.durationMinutes, row.outcome]),
    [['root-hash', 'root-hash', 0, 1000, 5, 'unknown'], ['child-hash', 'root-hash', 1, 250, 2, 'succeeded']]);
  assert.ok(rows.every((row) => Object.keys(row).sort().join(',') ===
    'depth,durationMinutes,model,outcome,parentSessionHash,rootSessionHash,sessionHash,tokens'));
});

test('missing parents and malformed cycles stay visible with unknown outcomes', () => {
  const rows = agentTree([
    { sessionHash: 'orphan', parentSessionHash: 'missing', model: 'synthetic', firstAt: 0, lastAt: 0, tokens: null, outcome: 'private text' },
    { sessionHash: 'a', parentSessionHash: 'b', model: 'synthetic', tokens: 10 },
    { sessionHash: 'b', parentSessionHash: 'a', model: 'synthetic', tokens: 10 },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].outcome, 'unknown');
  assert.equal(rows[0].tokens, null);
  assert.ok(!JSON.stringify(rows).includes('private text'));
});
