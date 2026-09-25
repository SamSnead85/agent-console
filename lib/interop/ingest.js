/** Local-only opt-in OTLP/HTTP JSON and gateway Prometheus adapters. */
import { createHmac, randomBytes } from 'node:crypto';
import { summarizeInterop } from '../analysis/index.js';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const COUNT = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const attr = (attributes, name) => attributes?.find((item) => item?.key === name)?.value?.stringValue;
const timeMs = (value, fallback) => {
  try { return typeof value === 'string' && /^\d{10,22}$/u.test(value) ? Number(BigInt(value) / 1_000_000n) : fallback; }
  catch { return fallback; }
};
const kindOf = { input: 'input', output: 'output', cacheRead: 'cacheRead', cacheCreation: 'cacheWrite' };

/* An attribute list in one canonical form: sorted by key, each value by its
   OTLP type (an int64 sent as a string or a number is the same int), so the
   same series sent with its attributes in another order is the same series. */
const MAX_ATTRIBUTES = 128;
function canonicalValue(value, depth) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (typeof value.stringValue === 'string') return ['s', value.stringValue];
  if (value.intValue !== undefined) return ['i', String(value.intValue)];
  if (value.doubleValue !== undefined) return ['d', String(Number(value.doubleValue))];
  if (value.boolValue !== undefined) return ['b', value.boolValue === true || value.boolValue === 'true'];
  if (typeof value.bytesValue === 'string') return ['y', value.bytesValue];
  if (value.arrayValue) return ['a', (Array.isArray(value.arrayValue.values) ? value.arrayValue.values : []).slice(0, MAX_ATTRIBUTES).map((v) => canonicalValue(v, depth + 1))];
  if (value.kvlistValue) return ['k', canonicalAttributes(value.kvlistValue.values, depth + 1)];
  return null;
}
export function canonicalAttributes(list, depth = 0) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ATTRIBUTES).filter((item) => item && typeof item.key === 'string')
    .map((item) => JSON.stringify([item.key, canonicalValue(item.value, depth)]))
    .sort().map((text) => JSON.parse(text));
}
/* A scope is its name, its version and its attributes. */
const scopeIdentity = (scope) => [typeof scope?.name === 'string' ? scope.name : '', typeof scope?.version === 'string' ? scope.version : '',
  canonicalAttributes(scope?.attributes)];

/**
 * Delta-temporality token points only. A cumulative series cannot be added up
 * without reconstructing its deltas, which this adapter does not do: its
 * points are counted in `stats.cumulativeIgnored` and shown, never summed.
 * `seriesHash` names the series — the resource that sent it (its attributes,
 * such as service.instance.id), the instrumentation scope, the metric and the
 * point's attributes, each in canonical order — as a keyed hash only: no
 * label leaves this function. With `stamp`, the point's own start and time,
 * it is the identity a re-sent point is dropped by; two resources with the
 * same point at the same time are two series and both count.
 */
export function parseOtlpMetrics(body, now, hash, stats = null) {
  const samples = [];
  const nanos = (value) => (typeof value === 'string' && /^\d{1,22}$/u.test(value) ? value : null);
  for (const resource of body?.resourceMetrics || []) {
    const resourceIdentity = canonicalAttributes(resource?.resource?.attributes);
    for (const scope of resource?.scopeMetrics || []) {
      const scopeId = scopeIdentity(scope?.scope);
      for (const metric of scope?.metrics || []) {
        if (metric?.name !== 'claude_code.token.usage') continue;
        if (![1, '1', 'AGGREGATION_TEMPORALITY_DELTA'].includes(metric?.sum?.aggregationTemporality)) {
          if (stats && [2, '2', 'AGGREGATION_TEMPORALITY_CUMULATIVE'].includes(metric?.sum?.aggregationTemporality)) {
            stats.cumulativeIgnored += Array.isArray(metric.sum.dataPoints) ? Math.min(metric.sum.dataPoints.length, 1000) : 0;
          }
          continue;
        }
        for (const point of metric.sum.dataPoints || []) {
          const model = attr(point.attributes, 'model');
          const kind = kindOf[attr(point.attributes, 'type')];
          const tokens = COUNT(point.asInt ?? point.asDouble);
          if (!MODEL.test(model || '') || !kind || tokens === null) continue;
          const at = timeMs(point.timeUnixNano, now);
          const seriesHash = hash(JSON.stringify(['otel-series', resourceIdentity, scopeId, metric.name, canonicalAttributes(point.attributes)]));
          const stamp = `${nanos(point.startTimeUnixNano) ?? ''}|${nanos(point.timeUnixNano) ?? String(at)}`;
          samples.push({ source: 'otel', at, model, kind, tokens, seriesHash, stamp });
          if (samples.length >= 1000) return samples;
        }
      }
    }
  }
  return samples;
}

const KONG_KIND = {
  prompt_tokens: 'input', completion_tokens: 'output',
};
const LITELLM_KIND = {
  litellm_input_tokens_metric_total: 'input', litellm_output_tokens_metric_total: 'output',
  litellm_input_cached_tokens_metric_total: 'cacheRead',
  litellm_input_cache_creation_tokens_metric_total: 'cacheWrite',
};

export function parseGatewayMetrics(source, body, now, hash) {
  if (source !== 'kong' && source !== 'litellm') return [];
  const samples = [];
  for (const line of String(body).split('\n')) {
    const match = /^([a-z_]+)(?:\{([^}]*)\})?\s+(\d+(?:\.\d+)?)(?:\s+\S+)?$/u.exec(line.trim());
    if (!match) continue;
    const [, metric, labelText = '', raw] = match;
    const labels = Object.fromEntries([...labelText.matchAll(/([A-Za-z_]+)="([^"\\]*)"/gu)].map((m) => [m[1], m[2]]));
    const kind = source === 'kong' && metric === 'ai_llm_tokens_total'
      ? KONG_KIND[labels.token_type] : source === 'litellm' ? LITELLM_KIND[metric] : null;
    const model = source === 'kong' ? labels.ai_model : labels.model;
    const tokens = COUNT(raw);
    if (!kind || !MODEL.test(model || '') || tokens === null) continue;
    samples.push({ source, at: now, model, kind, tokens,
      seriesHash: hash(metric + '|' + labelText) });
    if (samples.length >= 1000) return samples;
  }
  return samples;
}

export function createInteropStore() {
  const salt = randomBytes(32);
  const hash = (value) => createHmac('sha256', salt).update(value).digest('hex');
  let samples = [];
  // Counted since this console started, and shown beside the OTel figure.
  const stats = { dedupedSamples: 0, cumulativeIgnored: 0 };
  const keep = (incoming) => {
    const now = Date.now();
    const seen = new Set(samples.filter((item) => item.source === 'otel').map((item) => item.seriesHash + '|' + item.stamp));
    samples = samples.filter((item) => item.at >= now - 86_400_000);
    let added = 0;
    for (const sample of incoming) {
      if (sample.at < now - 86_400_000 || sample.at > now + 60_000) continue;
      if (sample.source === 'otel') {
        const key = sample.seriesHash + '|' + sample.stamp;
        if (seen.has(key)) { stats.dedupedSamples += 1; continue; }
        seen.add(key);
      } else samples = samples.filter((item) => item.source !== sample.source || item.seriesHash !== sample.seriesHash);
      samples.push(sample);
      added++;
    }
    samples = samples.slice(-10_000);
    return added;
  };
  return {
    acceptOtlp(body) { return keep(parseOtlpMetrics(body, Date.now(), hash, stats)); },
    acceptGateway(source, body) { return keep(parseGatewayMetrics(source, body, Date.now(), hash)); },
    snapshot(now = Date.now()) { return summarizeInterop(samples, now, stats); },
  };
}

export function readInteropBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let exceeded = false;
    req.on('data', (part) => {
      size += part.length;
      if (size > limit) exceeded = true;
      else if (!exceeded) chunks.push(part);
    });
    req.on('end', () => exceeded ? reject(new Error('too large')) : resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
