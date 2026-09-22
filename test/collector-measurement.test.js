import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { eventMeasurement, usageMeasurement, localDayScope, coverageMeasurement } from '../lib/collector/measurement.js';
import { aggregatePricing, priceRecord } from '../lib/collector/pricing.js';
const prices = JSON.parse(await readFile(new URL('../lib/collector/prices.json', import.meta.url), 'utf8'));
const row = { id:'synthetic-hash',sessionHash:'synthetic-session-hash',tool:'claude-code',at:'2026-09-20T12:34:00.000Z',
 model:'claude-opus-4-6',fresh:100,output:40,cacheRead:2,cacheWrite:0,cacheWrite5m:null,cacheWrite1h:null,ttl:'unknown' };

test('event context is fixed, portable, minute-scoped and never provider verified', () => {
 const context=eventMeasurement(row);
 assert.deepEqual(context, {provenance:'deviceReported',population:{kind:'usageEvent',recordId:row.id,sessionHash:row.sessionHash},
  window:{kind:'event',at:row.at},source:{kind:'localTranscript',tool:row.tool}});
 assert.deepEqual(eventMeasurement({...row,reportingDevice:'different-device'}),context);
 assert.throws(()=>{context.provenance='verified';},TypeError);
 assert.throws(()=>{context.population.recordId='other';},TypeError);
});
test('aggregate populations and nullable windows expose no event or session identifiers', () => {
 const context=usageMeasurement([row]);
 assert.deepEqual(context.population,{kind:'suppliedRecords',records:1});
 assert.equal(context.window.firstObservedAt,row.at);
 assert.equal(context.window.lastObservedAt,row.at);
 assert.doesNotMatch(JSON.stringify(context),/synthetic-hash|sessionHash|session-hash/);
 assert.equal(usageMeasurement([]).window.firstObservedAt,null);
 assert.equal(usageMeasurement([]).window.lastObservedAt,null);
});
test('a local reporting day follows the calendar boundary, including daylight savings', () => {
 const previous=process.env.TZ;
 try {
  process.env.TZ='America/New_York';
  const scope=localDayScope(new Date('2026-03-08T15:00:00Z'));
  assert.deepEqual(scope.window,{kind:'calendarDay',from:'2026-03-08T05:00:00.000Z',to:'2026-03-09T04:00:00.000Z',timeZone:'America/New_York'});
 } finally { if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous; }
});
test('token populations remain device reported while every cost is a dated rate estimate', () => {
 const scope=localDayScope(new Date('2026-09-20T15:00:00Z'));
 const result=aggregatePricing([row,{...row,model:'unlisted',cacheWrite:null}],prices,scope);
 assert.equal(result.total,null);
 assert.equal(result.measurement.provenance,'estimate');
 assert.equal(result.priced.measurement.provenance,'deviceReported');
 assert.equal(result.unpriced.measurement.provenance,'deviceReported');
 assert.equal(result.priced.usdMeasurement.provenance,'estimate');
 assert.equal(result.priced.measurement.population.records,1);
 assert.equal(result.unpriced.measurement.population.records,1);
 assert.equal(result.unpriced.tokens.cacheWrite,null);
 assert.deepEqual(result.measurement.window,scope.window);
 assert.deepEqual(result.priced.usdMeasurement.source.rates,[{model:'claude-opus-4-6',verifiedOn:'2026-09-20',source:'https://platform.claude.com/docs/en/about-claude/pricing'}]);
 assert.equal(priceRecord(row,prices).measurement.provenance,'estimate');
});
test('local diagnostics name devices reporting and never invent an enrolled denominator', () => {
 const context=coverageMeasurement([{tool:'codex',directory:'/SENTINEL_PRIVATE_PATH'}],new Date('2026-09-20T12:00:00Z'),true);
 assert.equal(context.population.unit,'devices reporting');
 assert.equal(context.population.enrolledCount,null);
 assert.equal(context.window.parserDebt,'currentCursorHistory');
 assert.equal(context.provenance,'deviceReported');
 assert.doesNotMatch(JSON.stringify(context),/SENTINEL|seat|person/);
});
