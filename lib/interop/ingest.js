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

export function parseOtlpMetrics(body, now, hash) {
  const samples = [];
  for (const resource of body?.resourceMetrics || []) for (const scope of resource?.scopeMetrics || []) {
    for (const metric of scope?.metrics || []) {
      if (metric?.name !== 'claude_code.token.usage'
        || ![1, '1', 'AGGREGATION_TEMPORALITY_DELTA'].includes(metric?.sum?.aggregationTemporality)) continue;
      for (const point of metric.sum.dataPoints || []) {
        const model = attr(point.attributes, 'model');
        const kind = kindOf[attr(point.attributes, 'type')];
        const tokens = COUNT(point.asInt ?? point.asDouble);
        if (!MODEL.test(model || '') || !kind || tokens === null) continue;
        const at = timeMs(point.timeUnixNano, now);
        const seriesHash = hash(JSON.stringify([metric.name, point.attributes, point.timeUnixNano, tokens]));
        samples.push({ source: 'otel', at, model, kind, tokens, seriesHash });
        if (samples.length >= 1000) return samples;
      }
    }
  }
  return samples;
}

const KONG_KIND = {
  prompt_tokens: 'input', completion_tokens: 'output', cache_read_input_tokens: 'cacheRead',
  cache_creation_input_tokens: 'cacheWrite', cache_write_5m_tokens: 'cacheWrite', cache_write_1h_tokens: 'cacheWrite',
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
  const keep = (incoming) => {
    const now = Date.now();
    const seen = new Set(samples.filter((item) => item.source === 'otel').map((item) => item.seriesHash));
    samples = samples.filter((item) => item.at >= now - 86_400_000);
    let added = 0;
    for (const sample of incoming) {
      if (sample.at < now - 86_400_000 || sample.at > now + 60_000) continue;
      if (sample.source === 'otel') {
        if (seen.has(sample.seriesHash)) continue;
        seen.add(sample.seriesHash);
      } else samples = samples.filter((item) => item.source !== sample.source || item.seriesHash !== sample.seriesHash);
      samples.push(sample);
      added++;
    }
    samples = samples.slice(-10_000);
    return added;
  };
  return {
    acceptOtlp(body) { return keep(parseOtlpMetrics(body, Date.now(), hash)); },
    acceptGateway(source, body) { return keep(parseGatewayMetrics(source, body, Date.now(), hash)); },
    snapshot(now = Date.now()) { return summarizeInterop(samples, now); },
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
