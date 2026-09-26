import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyAlertState, analyzeAlertEvent } from '@lockedinlabs/agent-console/analysis';

test('shared alert rules detect repeated calls, session spike and stalled spend from hashes and counts', () => {
  let state = emptyAlertState();
  const original = state;
  const events = [];
  const observe = (kind, at, fields = {}) => {
    const next = analyzeAlertEvent(state, { kind, at, sourceAt: at - 100, sessionHash: 'salted-session', ...fields });
    state = next.state;
    events.push(...next.signals);
  };
  for (let i = 0; i < 5; i += 1) observe('call', i, { callHash: 'salted-tool-and-args' });
  assert.equal(events[0].kind, 'loop');
  assert.equal(original.repeatCount, 0, 'the pure reducer must not mutate its input');
  for (let i = 0; i < 5; i += 1) observe('usage', i * 1000, { tokens: 20_000 });
  observe('usage', 6_000, { tokens: 100_000 });
  assert.equal(events.at(-1).kind, 'spike');
  observe('usage', 6 * 60_000, { tokens: 600_000 });
  assert.ok(events.some((event) => event.kind === 'stall'));
  assert.ok(events.every((event) => Object.keys(event).every((key) =>
    ['kind', 'sessionHash', 'at', 'sourceAt', 'seenAt', 'tokens'].includes(key))));
  const projected = analyzeAlertEvent({ ...state, rawCommand: 'CANARY-PRIVATE-COMMAND' },
    { kind: 'success', sessionHash: 'salted-session', at: 7 * 60_000 });
  assert.ok(!JSON.stringify(projected).includes('CANARY-PRIVATE-COMMAND'));
});
