import test from 'node:test';
import assert from 'node:assert/strict';
import { contextHealth } from '../lib/hub/context.js';

const prices = { v: 1, inventoryCheckedOn: '2026-09-20', rows: [{ model: 'synthetic-model', status: 'verified',
  usdPerMillion: { cacheRead: 1, cacheWrite: 10, cacheWrite5m: 10, cacheWrite1h: 15 } }] };
const at = Date.parse('2026-09-20T12:00:00Z');
const sample = (offset, tokens, cacheRead, cacheWrite) => ({ at: at + offset * 60_000, tokens,
  cacheRead, cacheWrite, cacheWrite5m: cacheWrite, cacheWrite1h: 0, model: 'synthetic-model' });

test('heavy context and a post-TTL write are signalled with a dated estimate', () => {
  const health = contextHealth([sample(0, 90_000, 80_000, 5_000), sample(9, 190_000, 0, 100_000)], prices);
  assert.equal(health.status, 'bloated');
  assert.equal(health.latest, 190_000);
  assert.equal(health.breaks[0].kind, 'idle-gap');
  assert.equal(health.breaks[0].estimatedExtraUsd, 0.9);
  assert.deepEqual(health.priceTable, { version: 1, checkedOn: '2026-09-20' });
});

test('mid-session rewrite remains a possible signal and unknown prices stay unknown', () => {
  const health = contextHealth([sample(0, 60_000, 50_000, 5_000), sample(1, 90_000, 0, 40_000)], { v: 1, rows: [] });
  assert.equal(health.breaks[0].kind, 'possible-prefix-rewrite');
  assert.equal(health.breaks[0].estimatedExtraUsd, null);
  assert.equal(contextHealth([], prices).status, 'unknown');
});
