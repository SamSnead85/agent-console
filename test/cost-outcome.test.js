import test from 'node:test';
import assert from 'node:assert/strict';
import { costPerOutcome } from '@lockedinlabs/agent-console/analysis';
import fs from 'node:fs';
import { createRegistry } from '../lib/hub/registry.js';
import { createStore } from '../lib/hub/store.js';
import { startDemo } from '../lib/hub/demo.js';
import { projectsPayload } from '../lib/hub/projects.js';

test('shared cost ratios use only fully priced spend and positive local outcome counts', () => {
  const result = costPerOutcome({ usd: 12, pricedMessages: 6, unpricedMessages: 0, commits: 3, defaultMerges: 2 });
  assert.deepEqual(result, { status: 'estimated', perCommitUsd: 4, perDefaultMergeUsd: 6, defaultMerges: 2 });
  assert.equal(costPerOutcome({ usd: 12, pricedMessages: 6, unpricedMessages: 1, commits: 3, defaultMerges: 2 }).perCommitUsd, null);
  assert.equal(costPerOutcome({ usd: 0, pricedMessages: 1, unpricedMessages: 0, commits: 0, defaultMerges: null }).perDefaultMergeUsd, null);
  assert.ok(!JSON.stringify(costPerOutcome({ usd: 12, pricedMessages: 6, unpricedMessages: 0,
    commits: 3, defaultMerges: 2, command: 'CANARY-PRIVATE-COMMAND' })).includes('CANARY-PRIVATE-COMMAND'));
});

test('synthetic Projects payload uses the shared ratios and projects no Git paths', async () => {
  const prices = JSON.parse(fs.readFileSync(new URL('../lib/collector/prices.json', import.meta.url), 'utf8'));
  const store = createStore({ retentionMs: 8 * 86_400_000, prices });
  const registry = createRegistry();
  const names = startDemo({ store, registry }).names;
  const payload = await projectsPayload({ store, registry, names, period: '24h', demo: true });
  assert.ok(payload.projects.some((project) => project.costPerOutcome.perCommitUsd !== null));
  for (const project of payload.projects) {
    assert.deepEqual(Object.keys(project.costPerOutcome).sort(),
      ['defaultMerges', 'perCommitUsd', 'perDefaultMergeUsd', 'status']);
    assert.ok(!JSON.stringify(project.costPerOutcome).includes('CANARY-PRIVATE-COMMAND'));
  }
});
