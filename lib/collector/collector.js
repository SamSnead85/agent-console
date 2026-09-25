#!/usr/bin/env node
/*
 * The collector: reads this machine's Claude Code and Codex transcripts and
 * emits an allowlisted METADATA projection of each usage event — counts, a
 * model id, a minute, and salted hashes of the session and project. Nothing
 * else survives `projectRecord`, which is the only door a record leaves by.
 *
 * Ported from LockedIn Labs' dependency-free console collector under this
 * package's MIT licence. What changed for the hub: delivery can be handed to a
 * function (the hub reads its own machine in-process), collection can be
 * bounded to a retention window, a hosted service's interruption channel is
 * gone, and a delivered spool can be compacted so a long-running reporter
 * does not grow a file forever.
 */
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, salvageClaudeLine, countDebt, MODEL_ID } from './parsers.js';
import { aggregatePricing } from './pricing.js';
import { postRecords } from './transport.js';
import { eventMeasurement, usageMeasurement, localDayScope, coverageMeasurement, syncMeasurement } from './measurement.js';

const TOKEN_FIELDS = ['fresh', 'output', 'cacheWrite', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
const HASH = /^[a-f0-9]{64}$/;
const MODEL = MODEL_ID;
// Exactly the hub's label rule. A label this collector accepted but the hub
// did not would refuse the WHOLE batch, so an unusable label is dropped to
// null here instead of refusing every record beside it.
const ENGAGEMENT = /^[a-z][a-z0-9-]{1,47}$/;
const MAX_LINE = 32 * 1024 * 1024;
/* How much of an over-long line is kept to recover its usage (parsers.js, salvageClaudeLine). */
const SALVAGE_BYTES = 256 * 1024;
/* A streamed response with no uuid that never reaches its stop is a drop once it is this old. */
const PENDING_LIMIT_MS = 30 * 60_000;
const TIERS = new Set(['standard', 'fast', 'other']);
/*
 * How long a transcript's per-message high-water marks are kept. One API
 * response is written over lines seconds apart (the longest spread measured,
 * docs/accounting.md §12, was 559 seconds), so a mark hours old can no longer
 * change. Keeping every mark for ever made the cursor grow with the whole
 * history, and it is read and rewritten on every pass.
 */
export const STATE_WINDOW_MS = 6 * 3600_000;
/* Records handed to an in-process sink at once; the event loop runs between batches. */
export const DELIVER_BATCH = 5_000;
const SPOOL_FLUSH_BYTES = 1 << 20;
/* An idle pass still rewrites the cursor this often, so lastSyncedAt stays current. */
const CURSOR_REFRESH_MS = 60_000;
export const defaultRoots = (home = os.homedir()) => [
  { tool: 'claude-code', directory: path.join(home, '.claude', 'projects') },
  { tool: 'codex', directory: path.join(home, '.codex', 'sessions') },
];
/** Where a standalone collector keeps its private state. */
export const defaultStateDirectory = () => path.join(os.homedir(), '.agent-console', 'collector');
export const identityHasher = salt => (kind, value) => createHmac('sha256', salt).update(`${kind}|${value}`).digest('hex');
/* The offline price table ships with the package; read once per process, not once per pass. */
let pricesRead = null;
const bundledPrices = () => (pricesRead ??= fs.readFile(new URL('./prices.json', import.meta.url), 'utf8').then(JSON.parse));
async function readJSON(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Local collector state could not be read.'); }
}
async function atomicJSON(filename, data) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(temporary, filename);
  await fs.chmod(filename, 0o600);
}
async function enrollmentFor(directory) {
  const bundle = await readJSON(path.join(directory, 'enrollment.json'), null);
  if (!bundle) return null;
  const salt = typeof bundle.orgSalt === 'string' ? Buffer.from(bundle.orgSalt, 'base64url') : Buffer.alloc(0);
  if (bundle.v !== 1 || salt.length !== 32 || salt.toString('base64url') !== bundle.orgSalt ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(bundle.organizationId ?? '') ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(bundle.device?.id ?? '') ||
      typeof bundle.device?.label !== 'string' || bundle.device.label.trim().length === 0
      || bundle.device.label.length > 80 || /[\u0000-\u001f\u007f]/.test(bundle.device.label)) {
    // The label rule is the server's: 1-80 characters, no control characters.
    // A narrower rule here rejected labels the server had already accepted, so
    // the enrollment it issued could never be used.
    throw new Error('The server-issued enrollment bundle is invalid.');
  }
  const hashIdentity = identityHasher(salt);
  return { hashIdentity, device: bundle.device,
    fingerprint: hashIdentity('enrollment', `${bundle.organizationId}|${bundle.device.id}`),
    recordId: (tool, sessionId, messageId) => createHmac('sha256', salt).update(`${tool}|${sessionId}|${messageId}`).digest('hex'),
  };
}
async function initialize(directory) {
  const enrollment = await enrollmentFor(directory);
  if (!enrollment) {
    const error = new Error('Portable collection requires a server-issued organization enrollment. No metadata was emitted.');
    error.code = 'enrollment_required';
    throw error;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await fs.chmod(path.join(directory, 'enrollment.json'), 0o600);
  return enrollment;
}

async function withLock(directory, work) {
  const lockFile = path.join(directory, 'lock');
  let lock;
  try { lock = await fs.open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Collector state is locked. Verify no collector is running before removing a stale lock.');
    throw error;
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  try { return await work(); }
  finally { await lock.close(); await fs.unlink(lockFile); }
}
async function* walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  // Files before folders: a session's own transcript is read before its
  // subagents/, so a message a fork copied is credited to the session that
  // made it (docs/accounting.md §3.1). Totals do not depend on this order.
  const sorted = entries.sort((a,b) => (a.isDirectory() - b.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(filename);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield filename;
  }
}
/**
 * Complete lines only. Offsets are bytes, including CRLF and multibyte text.
 * A line longer than `maxLine` is never held whole: it is yielded as
 * `{ line: '', oversized: { head, tail } }` with its first and last bytes, so
 * its usage can still be recovered or its loss counted (A4).
 */
export async function* lines(filename, start = 0, end, maxLine = MAX_LINE) {
  if (end !== undefined && end < start) return;
  const stream = createReadStream(filename, { start, ...(end === undefined ? {} : { end }) });
  let pending = Buffer.alloc(0), offset = start, discarded = 0, head = null, tail = null;
  const keep = Math.min(SALVAGE_BYTES, maxLine);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const size = discarded + newline + 1;
      if (discarded || newline > maxLine) {
        const body = pending.subarray(0, newline);
        const whole = head ? Buffer.concat([tail, body]) : body;
        const oversized = { head: (head ?? body.subarray(0, keep)).toString('utf8'), tail: whole.subarray(Math.max(0, whole.length - keep)).toString('utf8') };
        yield { line: '', oversized, offset, endOffset: offset + size };
      } else yield { line: pending.subarray(0, newline).toString('utf8'), offset, endOffset: offset + size };
      offset += size; discarded = 0; head = null; tail = null; pending = pending.subarray(newline + 1);
    }
    if (pending.length > maxLine) {
      head ??= Buffer.from(pending.subarray(0, keep));
      const joined = tail ? Buffer.concat([tail, pending]) : pending;
      tail = Buffer.from(joined.subarray(Math.max(0, joined.length - keep)));
      discarded += pending.length; pending = Buffer.alloc(0);
    }
  }
}

/** Parses a line, or the recoverable part of an over-long one. */
function parseItem(tool, item, context, parser) {
  if (!item.oversized) return parseLine(tool, item.line, context, parser);
  const { head, tail } = item.oversized;
  const carriesUsage = tool === 'codex' ? /token_count|token_usage_record/.test(head) : tail.includes('"usage":{') && (head.includes('"assistant"') || tail.includes('"assistant"'));
  if (!carriesUsage) return { records: [], state: parser };
  const salvaged = tool === 'codex' ? null : salvageClaudeLine(head, tail);
  if (salvaged) {
    const result = parseLine(tool, salvaged, context, parser);
    return { records: result.records, state: countDebt(tool, context, result.state, 'oversizedLineRecovered') };
  }
  return { records: [], state: countDebt(tool, context, parser, 'oversizedLine') };
}
async function anchor(filename, offset) {
  if (!offset) return '';
  const handle = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(offset, 128));
    const read = await handle.read(buffer, 0, buffer.length, offset - buffer.length);
    return createHash('sha256').update(buffer.subarray(0, read.bytesRead)).digest('hex');
  } finally { await handle.close(); }
}
/**
 * Forgets per-message marks older than STATE_WINDOW_MS before the newest one
 * in the same transcript, and all of them once the transcript itself has been
 * quiet that long. Returns whether anything was dropped.
 */
export function pruneParserState(parser, now = Date.now()) {
  if (!parser || typeof parser !== 'object') return false;
  const maps = ['claudeUsage', 'codexEventIds', 'claudeFallbackSent', 'claudeFallbackPending'].filter(key => parser[key] && typeof parser[key] === 'object');
  if (!maps.length) return false;
  const age = value => {
    const at = typeof value === 'string' ? value : typeof value?.firstAt === 'string' ? value.firstAt : null;
    const ms = at === null ? NaN : Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  };
  let newest = -Infinity;
  for (const key of maps) for (const value of Object.values(parser[key])) { const at = age(value); if (at !== null && at > newest) newest = at; }
  let changed = false;
  if (newest < now - STATE_WINDOW_MS) {
    for (const key of maps) { delete parser[key]; changed = true; }
    return changed;
  }
  const edge = newest - STATE_WINDOW_MS;
  for (const key of maps) {
    for (const [k, value] of Object.entries(parser[key])) {
      const at = age(value);
      if (at !== null && at < edge) { delete parser[key][k]; changed = true; }
    }
  }
  return changed;
}

/** A final allowlist is the only way parser records reach disk or a sink. */
export function projectRecord(raw, labels = {}) {
  if (!raw || !HASH.test(raw.id) || !HASH.test(raw.sessionHash) || !HASH.test(raw.projectHash) ||
      (raw.parentSessionHash !== null && !HASH.test(raw.parentSessionHash)) ||
      !['claude-code', 'codex'].includes(raw.tool) || typeof raw.isSubagent !== 'boolean' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(raw.reportingDevice ?? '')) return null;
  const parsedAt = new Date(raw.at);
  if (!Number.isFinite(parsedAt.getTime())) return null;
  parsedAt.setUTCSeconds(0, 0);
  const engagement = labels[raw.projectHash];
  const record = {
    id: raw.id, tool: raw.tool, model: MODEL.test(raw.model ?? '') ? raw.model : 'unknown',
    sessionHash: raw.sessionHash, parentSessionHash: raw.parentSessionHash,
    isSubagent: raw.isSubagent, projectHash: raw.projectHash,
    engagement: typeof engagement === 'string' && ENGAGEMENT.test(engagement) ? engagement : null,
    at: parsedAt.toISOString(),
    reportingDevice: raw.reportingDevice,
    executionOrigin: raw.executionOrigin === 'unknown' || HASH.test(raw.executionOrigin) ? raw.executionOrigin : 'unknown',
    ttl: raw.ttl === 'split' ? 'split' : 'unknown',
    tier: TIERS.has(raw.tier) ? raw.tier : null,
    // True when an earlier record already counted this API message.
    continuation: raw.continuation === true,
    // True when the amounts are the message's running maximum (parsers.js).
    cumulative: raw.cumulative === true,
  };
  for (const field of TOKEN_FIELDS) record[field] = Number.isSafeInteger(raw[field]) && raw[field] >= 0 ? raw[field] : null;
  if (record.ttl === 'split' && (record.cacheWrite5m === null || record.cacheWrite1h === null ||
      !Number.isSafeInteger(record.cacheWrite5m + record.cacheWrite1h) ||
      record.cacheWrite5m + record.cacheWrite1h !== record.cacheWrite)) return null;
  if (record.ttl === 'unknown' && (record.cacheWrite5m !== null || record.cacheWrite1h !== null)) return null;
  record.observed = true;
  record.measurement = eventMeasurement(record);
  return record;
}
/** Discard only an incomplete crash tail from this collector's own spool. */
async function repairSpool(filename) {
  // Read-write, not append: Windows refuses to truncate a file opened for appending.
  let handle;
  try { handle = await fs.open(filename, 'r+'); }
  catch (error) { if (error.code === 'ENOENT') { await fs.writeFile(filename, '', { mode: 0o600 }); return; } throw error; }
  try {
    const size = (await handle.stat()).size;
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - 64 * 1024);
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (newline >= 0) { if (start + newline + 1 !== size) await handle.truncate(start + newline + 1); return; }
      end = start;
    }
    if (size) await handle.truncate(0);
  } finally { await handle.close(); }
}
/**
 * `sinceMs` bounds the work to a retention window: a transcript untouched since
 * then is not opened at all, and an event older than it is parsed (so counter
 * baselines stay correct) but never spooled. `onLocalLabel` is for the hub's
 * own machine only — it receives the raw project directory and branch so the
 * console can name local lanes, and it is never set on a reporter.
 */
/**
 * `shareLabels: false` ignores labels.json and empties it, so turning the
 * project-name opt-in off stops names at once. `projectKey` (a reporter's own
 * secret) keys project hashes, so a hub, which knows the shared salt, cannot
 * test guesses of a folder path against them.
 */
export async function collect({ directory, roots = defaultRoots(), sinceMs = null, onLocalLabel = null, onProgress = null, onTranscriptLine = null, shareLabels = true, projectKey = null, maxLineBytes = MAX_LINE }) {
  const { hashIdentity: sharedHash, recordId, device, fingerprint } = await initialize(directory);
  const keyedHash = projectKey
    ? (kind, value) => kind === 'project' ? createHmac('sha256', projectKey).update(`project|${value}`).digest('hex') : sharedHash(kind, value)
    : sharedHash;
  // Every Claude Code line repeats its session and folder, so the same few
  // HMACs would be computed on every line. Remembered for this pass only, in
  // memory; the raw values are never written anywhere.
  const memo = new Map();
  const hashIdentity = (kind, value) => {
    const key = `${kind}\0${value}`;
    let hashed = memo.get(key);
    if (hashed === undefined) {
      if (memo.size >= 20_000) memo.clear();
      hashed = keyedHash(kind, value);
      memo.set(key, hashed);
    }
    return hashed;
  };
  const cursorFile = path.join(directory, 'cursor-v2.json');
  const cursor = await readJSON(cursorFile, { v: 2, fingerprint, sources: {}, sinks: {}, lastObservedAt: null, lastSyncedAt: null });
  if (cursor.v !== 2 || cursor.fingerprint !== fingerprint || !cursor.sources || !cursor.sinks) throw new Error('The local cursor format is unsupported.');
  // Per-message marks shared by every transcript (docs/accounting.md §2): a
  // forked subagent's copy of a message adds only what it grew by (A1).
  if (!cursor.shared || typeof cursor.shared !== 'object') cursor.shared = {};
  if (!cursor.coverageDebt || typeof cursor.coverageDebt !== 'object') cursor.coverageDebt = {};
  const labelsFile = path.join(directory, 'labels.json');
  try { await fs.writeFile(labelsFile, '{}\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await fs.chmod(labelsFile, 0o600);
  if (!shareLabels) await atomicJSON(labelsFile, {});
  const labels = shareLabels ? await readJSON(labelsFile, {}) : {};
  await repairSpool(path.join(directory, 'records-v2.ndjson'));
  const spool = await fs.open(path.join(directory, 'records-v2.ndjson'), 'a', 0o600);
  // Records are written to the spool in blocks, not one write each; the
  // cursor is written only after the last block, so the order that makes a
  // crash replay rather than lose a record is unchanged.
  let spoolBuffer = [], spoolBytes = 0;
  const flushSpool = async () => {
    if (!spoolBuffer.length) return;
    const block = spoolBuffer.join('');
    spoolBuffer = []; spoolBytes = 0;
    await spool.appendFile(block);
  };
  const coverage = { sourcesAvailable: 0, sourcesExpected: roots.length, filesRead: 0, unreadableFiles: 0 };
  let added = 0;
  let dirty = false;
  const now = Date.now();
  // The file list comes first so a long first read can report "N of M files".
  const listed = [];
  let listedWhole = true;
  for (const root of roots) {
    try {
      const stat = await fs.stat(root.directory);
      if (!stat.isDirectory()) continue;
      coverage.sourcesAvailable++;
      const files = [];
      for await (const filename of walk(root.directory)) files.push(filename);
      listed.push({ root, files });
    } catch (error) { if (error?.code !== 'ENOENT') listedWhole = false; coverage.unreadableFiles++; }
  }
  const present = new Set();
  const progress = { phase: 'scan', files: 0, filesTotal: listed.reduce((sum, entry) => sum + entry.files.length, 0), records: 0 };
  try {
    for (const { root, files } of listed) {
      try {
        for (const filename of files) {
          progress.files++;
          try {
            const stat = await fs.stat(filename);
            const fileKey = hashIdentity('source-file', `${root.tool}\0${filename}\0${stat.birthtimeMs}`);
            present.add(fileKey);
            if (sinceMs !== null && stat.mtimeMs < sinceMs) {
              coverage.filesSkipped = (coverage.filesSkipped ?? 0) + 1;
              // Outside the window: its state is no longer needed. If it is
              // written to again it is read from the start, and whatever is
              // older than the window is left out as before.
              if (cursor.sources[fileKey]) { delete cursor.sources[fileKey]; dirty = true; }
              continue;
            }
            const known = cursor.sources[fileKey];
            // Unchanged since the last pass (same size, same modification
            // time, fully read): nothing to open, parse or copy.
            if (known && known.offset === stat.size && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
              if (pruneParserState(known.parser, now)) dirty = true;
              coverage.filesRead++;
              if (onProgress) { progress.records = added; onProgress({ ...progress }); }
              continue;
            }
            dirty = true;
            let previous = known ?? { offset: 0, generation: 0, parser: {}, anchor: '' };
            if (stat.size < previous.offset || (previous.offset && previous.anchor !== await anchor(filename, previous.offset))) {
              previous = { offset: 0, generation: previous.generation + 1, parser: {}, anchor: '' };
            }
            const sourceId = hashIdentity('source-generation', `${fileKey}\0${previous.generation}`);
            const context = { sourceId, fileTag: hashIdentity("source-path", `${root.tool}\0${filename}`), hashIdentity, recordId, reportingDevice: device.id, shared: cursor.shared,
              projectHash: hashIdentity('project', 'unknown'), parentSessionHash: null, isSubagent: false,
              ...(onLocalLabel ? { onLocalLabel } : {}),
              ...(onTranscriptLine ? { onParsedLine: (line, result) => {
                try { onTranscriptLine({ tool: root.tool, line, records: result.records,
                  sessionHash: result.state.sessionHash, parentSessionHash: result.state.parentSessionHash,
                  projectHash: result.state.projectHash, historyStartOrdinal: result.state.historyStartOrdinal,
                  hashIdentity }); }
                catch { /* an optional local signal cannot block accounting */ }
              } } : {}),
            };
            const since = sinceMs === null ? null : new Date(sinceMs).toISOString();
            let parser = structuredClone(previous.parser), offset = previous.offset;
            for await (const item of lines(filename, offset, stat.size - 1, maxLineBytes)) {
              const result = parseItem(root.tool, item, { ...context, offset: item.offset }, parser);
              parser = result.state;
              for (const raw of result.records) {
                const record = projectRecord(raw, labels);
                if (record && since !== null && record.at < since) continue;
                if (record) {
                  const line = `${JSON.stringify(record)}\n`;
                  spoolBuffer.push(line); spoolBytes += line.length; added++;
                  if (spoolBytes >= SPOOL_FLUSH_BYTES) await flushSpool();
                  if (!cursor.lastObservedAt || record.at > cursor.lastObservedAt) cursor.lastObservedAt = record.at;
                }
              }
              offset = item.endOffset;
            }
            pruneParserState(parser, now);
            cursor.sources[fileKey] = { offset, generation: previous.generation, parser, anchor: await anchor(filename, offset), size: stat.size, mtimeMs: stat.mtimeMs };
            coverage.filesRead++;
          } catch { coverage.unreadableFiles++; }
          if (onProgress) { progress.records = added; onProgress({ ...progress }); }
        }
      } catch { coverage.unreadableFiles++; }
    }
    // A no-uuid response still streaming this long after it began will not
    // finish: it is a drop, counted as such, and its mark is let go.
    const pending = cursor.shared.claudeFallbackPending ?? {};
    for (const [key, at] of Object.entries(pending)) {
      if (Date.parse(at) < now - PENDING_LIMIT_MS || typeof at !== 'string') {
        delete pending[key];
        cursor.coverageDebt.noFinalUsage = (cursor.coverageDebt.noFinalUsage ?? 0) + 1;
        dirty = true;
      }
    }
    if (pruneParserState(cursor.shared, now)) dirty = true;
    // A transcript that is gone (deleted, or replaced by a new file at the same
    // path) takes its state and its drops with it: drops describe the
    // transcripts still read (docs/accounting.md §3.2). Its records stay
    // counted; the shared marks keep a copy from being sent again.
    if (listedWhole) {
      for (const key of Object.keys(cursor.sources)) if (!present.has(key)) { delete cursor.sources[key]; dirty = true; }
    }
    // Write-ahead metadata spool: a crash can replay an ID but cannot lose it.
    await flushSpool();
    if (added) await spool.sync();
    if (dirty || added) await atomicJSON(cursorFile, cursor);
  } finally { await spool.close(); }
  coverage.skippedBaselines = Object.values(cursor.sources).reduce((sum, source) => sum + (source.parser?.skippedBaselines ?? 0), 0);
  coverage.coverageDebt = { ...cursor.coverageDebt };
  for (const source of Object.values(cursor.sources)) for (const [kind, count] of Object.entries(source.parser?.coverageDebt ?? {})) {
    coverage.coverageDebt[kind] = (coverage.coverageDebt[kind] ?? 0) + count;
  }
  return { cursor, hashIdentity, device, coverage, added, changed: dirty || added > 0 };
}
export function localDay(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export async function summarize(directory, prices, now = new Date()) {
  const date = localDay(now), seen = new Set(), records = [], byMessage = new Map();
  const tokens = Object.fromEntries(TOKEN_FIELDS.map(key => [key, { observed: 0, unknownRecords: 0 }]));
  for await (const { line } of lines(path.join(directory, 'records-v2.ndjson'))) {
    let record; try { record = JSON.parse(line); } catch { continue; }
    if (localDay(record.at) !== date) continue;
    // A message's running maximum: the latest line replaces the earlier ones.
    if (record.cumulative === true) { byMessage.set(record.id, record); continue; }
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  records.push(...byMessage.values());
  for (const record of records) {
    for (const key of TOKEN_FIELDS) record[key] === null ? tokens[key].unknownRecords++ : tokens[key].observed += record[key];
  }
  const scope = localDayScope(now);
  return { date, records: records.length, tokens, measurement: usageMeasurement(records, scope), pricing: aggregatePricing(records, prices, scope) };
}
export function coverageState(lastObservedAt, now = new Date()) {
  if (!lastObservedAt) return 'neverReported';
  const age = new Date(now).getTime() - Date.parse(lastObservedAt);
  if (age >= 0 && age <= 5 * 60_000) return 'active';
  return localDay(lastObservedAt) === localDay(now) ? 'reportedToday' : 'stale';
}
/** Before enrollment, only aggregate numbers leave memory: no ingestion IDs,
 * records, local salt, spool, or cursor is created. These transient equality
 * keys are not portable record IDs and are never serialized. */
export async function summarizeUnenrolled(options = {}) {
  const now = options.now ?? new Date();
  const roots = options.roots ?? defaultRoots();
  const date = localDay(now);
  const records = new Map(), seen = new Set();
  const coverage = { sourcesAvailable: 0, sourcesExpected: roots.length, filesRead: 0, unreadableFiles: 0, skippedBaselines: 0, coverageDebt: {}, enrolledCount: null };
  const transientKey = value => createHash('sha256').update(value).digest('hex');
  let lastObservedAt = null;
  const shared = {};
  for (const root of roots) {
    try {
      if (!(await fs.stat(root.directory)).isDirectory()) continue;
      coverage.sourcesAvailable++;
      for await (const filename of walk(root.directory)) {
        let state = {};
        try {
          const context = { sourceId: `preview-${coverage.filesRead}`, reportingDevice: 'unenrolled-preview',
            hashIdentity: (kind, value) => transientKey(`${kind}|${value}`),
            recordId: (tool, session, message) => transientKey(`${tool}|${session}|${message}`),
            projectHash: transientKey('unknown-project'), parentSessionHash: null, isSubagent: false, shared };
          const size = (await fs.stat(filename)).size;
          for await (const item of lines(filename, 0, size - 1)) {
            const parsed = parseItem(root.tool, item, { ...context, offset: item.offset }, state);
            state = parsed.state;
            for (const record of parsed.records) {
              if (seen.has(record.id)) continue;
              seen.add(record.id);
              if (!lastObservedAt || record.at > lastObservedAt) lastObservedAt = record.at;
              if (localDay(record.at) === date) records.set(record.id, record);
            }
          }
          coverage.filesRead++;
          coverage.skippedBaselines += state.skippedBaselines ?? 0;
          for (const [kind, count] of Object.entries(state.coverageDebt ?? {})) coverage.coverageDebt[kind] = (coverage.coverageDebt[kind] ?? 0) + count;
        } catch { coverage.unreadableFiles++; }
      }
    } catch { coverage.unreadableFiles++; }
  }
  const tokens = Object.fromEntries(TOKEN_FIELDS.map(key => [key, { observed: 0, unknownRecords: 0 }]));
  for (const record of records.values()) for (const key of TOKEN_FIELDS) {
    if (!Number.isSafeInteger(record[key])) tokens[key].unknownRecords++;
    else tokens[key].observed += record[key];
  }
  const prices = options.prices ?? JSON.parse(await fs.readFile(new URL('./prices.json', import.meta.url), 'utf8'));
  const scope = localDayScope(now);
  return { date, records: records.size, tokens, measurement: usageMeasurement([...records.values()], scope),
    pricing: aggregatePricing([...records.values()], prices, scope),
    enrolled: false, freshness: { lastObservedAt, lastSyncedAt: null, mode: 'periodic' },
    coverage: { ...coverage, state: coverageState(lastObservedAt, now), measurement: coverageMeasurement(roots, now) } };
}
async function write(stream, value) {
  await new Promise((resolve, reject) => {
    const failure = error => reject(error);
    stream.once('error', failure);
    stream.write(value, error => {
      // A failed callback is followed by an error event; leave its listener
      // installed until that event so failure cannot escape the Promise.
      if (error) reject(error);
      else { stream.off('error', failure); resolve(); }
    });
  });
}

export async function runOnce(options = {}) {
  const now = options.now ?? new Date();
  const directory = options.directory ?? defaultStateDirectory();
  if (options.summary && !(await enrollmentFor(directory))) return summarizeUnenrolled(options);
  await initialize(directory);
  if (options.out) {
    const output = await fs.realpath(options.out).catch(async () => path.join(await fs.realpath(path.dirname(path.resolve(options.out))), path.basename(options.out)));
    for (const root of [...(options.roots ?? defaultRoots()).map(root => root.directory), directory]) {
      const base = await fs.realpath(root).catch(() => path.resolve(root));
      if (output === base || output.startsWith(base + path.sep)) throw new Error('Output must be separate from transcript sources and collector state.');
    }
  }
  return withLock(directory, async () => {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const shareLabels = options.shareLabels !== false;
    const { cursor, hashIdentity, device, coverage, added, changed } = await collect({ directory, roots: options.roots,
      sinceMs: options.sinceMs ?? null, onLocalLabel: options.onLocalLabel ?? null,
      onTranscriptLine: options.onTranscriptLine ?? null, onProgress,
      shareLabels, projectKey: options.projectKey ?? null, maxLineBytes: options.maxLineBytes ?? MAX_LINE });
    const prices = options.prices ?? await bundledPrices();
    const freshness = { lastObservedAt: cursor.lastObservedAt, lastSyncedAt: cursor.lastSyncedAt, mode: options.watch ? 'live' : 'periodic' };
    coverage.state = coverageState(cursor.lastObservedAt, now);
    coverage.measurement = coverageMeasurement(options.roots ?? defaultRoots(), now, true);
    coverage.enrolledCount = null; // The receiver owns the current organization-wide enrollment count.
    if (options.summary) return { ...await summarize(directory, prices, now), enrolled: true, freshness, coverage };
    const sink = options.deliver ? `direct:${hashIdentity('sink', options.sinkName ?? 'direct')}`
      : options.post ? `post:${hashIdentity('sink', options.post)}` : options.out ? `file:${hashIdentity('sink', path.resolve(options.out))}` : 'stdout';
    const spoolPath = path.join(directory, 'records-v2.ndjson');
    const start = cursor.sinks[sink]?.offset ?? 0;
    // A catch-up interrupted earlier keeps its count, so "N of M" does not
    // restart from zero when the reporter does.
    const earlier = cursor.sinks[sink]?.catchUp;
    const base = earlier && earlier.delivered < earlier.total ? earlier.delivered : 0;
    const syncedBefore = cursor.lastSyncedAt;
    const records = [], ends = [], seen = new Set();
    let offset = start, emitted = 0, backlog, receipt = null;
    const fromSpool = (line) => {
      const record = JSON.parse(line);
      // Additive v1.2 context does not rewrite the portable spool or cursor.
      record.measurement = eventMeasurement(record);
      // A name spooled while the opt-in was on does not leave once it is off.
      if (!shareLabels) record.engagement = null;
      return record;
    };
    if (options.deliver) {
      // In-process delivery (the hub reading its own machine) keeps the same
      // rule as a POST: the cursor moves only once every record has a
      // receipt. The spool is streamed in batches with the event loop free
      // between them, so a first read of months of history neither holds
      // every record in memory at once nor stops the console answering.
      receipt = { accepted: 0, duplicate: 0, expired: 0, rejected: [] };
      let batch = [], sent = false, inBatch = new Map();
      const flush = async () => {
        const part = await options.deliver(device, batch, freshness);
        if (!part || part.rejected?.length) throw new Error('Ingestion rejected metadata records; the delivery cursor was retained.');
        for (const key of ['accepted', 'duplicate', 'expired']) receipt[key] += part[key] ?? 0;
        emitted += batch.length; batch = []; inBatch = new Map(); sent = true;
      };
      for await (const item of lines(spoolPath, start)) {
        const record = fromSpool(item.line);
        // A message's running maximum is spooled once per line that grew it:
        // the latest replaces the one before, in this batch or the next.
        if (record.cumulative === true) {
          if (inBatch.has(record.id)) {
            const index = inBatch.get(record.id);
            batch[index] = { ...record, continuation: batch[index].continuation };
          }
          else { inBatch.set(record.id, batch.length); batch.push(record); }
        } else if (!seen.has(record.id)) { batch.push(record); seen.add(record.id); }
        offset = item.endOffset;
        if (batch.length >= DELIVER_BATCH) { await flush(); await new Promise(resolve => setImmediate(resolve)); }
      }
      if (batch.length || !sent) await flush();
      backlog = { delivered: base + emitted, total: base + emitted };
      cursor.lastSyncedAt = new Date().toISOString();
    } else {
      const at = new Map();
      for await (const item of lines(spoolPath, start)) {
        const record = fromSpool(item.line);
        // The latest running maximum replaces an earlier one; its place, and
        // the cursor offset that place acknowledges, stay the earlier line's,
        // so an interrupted delivery re-sends it rather than skipping it.
        if (record.cumulative === true && at.has(record.id)) {
          const index = at.get(record.id);
          records[index] = { ...record, continuation: records[index].continuation };
        }
        else if (!seen.has(record.id)) {
          if (record.cumulative === true) at.set(record.id, records.length);
          records.push(record); ends.push(item.endOffset); seen.add(record.id);
        }
        offset = item.endOffset;
      }
      emitted = records.length;
      backlog = { delivered: base, total: base + records.length };
    }
    if (options.deliver) {
      // Delivered above.
    } else if (options.post) {
      // The cursor moves with every acknowledged batch, not only at the end: a
      // backlog of tens of thousands of records that is paced or interrupted
      // resumes where it stopped instead of starting over. Written at most
      // every two seconds, and always before an error leaves this function.
      const cursorFile = path.join(directory, 'cursor-v2.json');
      let savedAt = 0;
      const save = async (force) => {
        if (!force && Date.now() - savedAt < 2000) return;
        savedAt = Date.now();
        await atomicJSON(cursorFile, cursor);
      };
      if (onProgress && records.length) onProgress({ phase: 'deliver', delivered: base, total: backlog.total });
      try {
        // Opt-in alert and activity counts (lib/reporter.js): taken now, and
        // dropped from the outbox only once the console has the envelope.
        const extra = options.outbox ? options.outbox.take() : {};
        receipt = await postRecords(options.post, device, records, {
          freshness, token: options.token, allowHttp: options.allowHttp, backlog, coverage: coverage.coverageDebt,
          ...(extra.alerts ? { alerts: extra.alerts } : {}), ...(extra.activity ? { activity: extra.activity } : {}),
          onBatch: async (batch, { delivered, total }) => {
            if (batch.rejected.length) throw new Error('Ingestion rejected metadata records; the delivery cursor was retained.');
            cursor.lastSyncedAt = new Date().toISOString();
            const done = delivered === total;
            cursor.sinks[sink] = { offset: done ? offset : ends[delivered - 1], lastSyncedAt: cursor.lastSyncedAt,
              ...(done ? {} : { catchUp: { delivered: base + delivered, total: backlog.total } }) };
            if (onProgress) onProgress({ phase: 'deliver', delivered: base + delivered, total: backlog.total });
            await save(done);
          },
          ...(options.transport ?? {}),
        });
      } catch (error) {
        await save(true);
        if (error && typeof error === 'object') error.progress = { delivered: cursor.sinks[sink]?.catchUp?.delivered ?? base, total: backlog.total };
        throw error;
      }
      if (receipt.rejected.length) throw new Error('Ingestion rejected metadata records; the delivery cursor was retained.');
      options.outbox?.ack();
      cursor.lastSyncedAt = new Date().toISOString();
    } else {
      if (options.out) {
        const handle = await fs.open(options.out, 'a', 0o600);
        try {
          for (const record of records) await handle.write(`${JSON.stringify(record)}\n`);
          await handle.sync();
        } finally { await handle.close(); }
      } else {
        for (const record of records) await write(options.stdout ?? process.stdout, `${JSON.stringify(record)}\n`);
      }
    }
    cursor.sinks[sink] = { offset, lastSyncedAt: options.post || options.deliver ? cursor.lastSyncedAt : null };
    // A reporter has exactly one destination. Once it has acknowledged the
    // whole spool there is nothing left to replay, so the spool is emptied
    // rather than kept growing for the life of the machine. The cursor is
    // committed first; a crash between the two replays at most the delivered
    // tail, which the hub counts as duplicate.
    const sinks = Object.keys(cursor.sinks);
    const compact = options.compact === true && sinks.length === 1 && sinks[0] === sink
      && offset > 0 && offset === (await fs.stat(spoolPath)).size;
    if (compact) cursor.sinks[sink].offset = 0;
    // A pass that found nothing new leaves the cursor as it is, apart from a
    // refresh of lastSyncedAt once a minute.
    const refresh = (options.deliver || options.post) && (!syncedBefore || Date.now() - Date.parse(syncedBefore) >= CURSOR_REFRESH_MS);
    if (changed || emitted || offset !== start || compact || refresh) await atomicJSON(path.join(directory, 'cursor-v2.json'), cursor);
    if (compact) await fs.writeFile(spoolPath, '', { mode: 0o600 });
    return { added, emitted, coverage, receipt, freshness, backlog: { delivered: backlog.total, total: backlog.total }, measurement: syncMeasurement(now) };
  });
}
export function argumentsFor(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (['--once','--sync-now','--watch','--summary','--help'].includes(value)) options[value.slice(2)] = true;
    else if (value === '--out' || value === '--post') {
      const next = args[++index];
      if (!next || next.startsWith('--')) throw new Error('An output destination is required.');
      options[value.slice(2)] = next;
    } else throw new Error('Unknown collector option. Use --help.');
  }
  if ([options.once, options['sync-now'], options.watch, options.summary].filter(Boolean).length > 1 || (options.post && options.out) || (options.summary && (options.out || options.post))) {
    throw new Error('Choose one mode and one output destination.');
  }
  return options;
}
async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node lib/collector/collector.js [--once | --sync-now | --watch | --summary] [--out destination | --post https://hub.example/api/ingest]\nDevice authorization is read only from AGENT_CONSOLE_TOKEN. Output contains usage metadata only.\nMost people want `agent-console join` instead, which enrols this machine and reports for you.');
    return;
  }
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  do {
    const result = await runOnce(options);
    if (options.summary) console.log(JSON.stringify(result, null, 2));
    else if (result.coverage.sourcesAvailable < result.coverage.sourcesExpected || result.coverage.unreadableFiles) {
      console.error('Collector coverage is incomplete; missing activity is unknown.');
    }
    const recurring = !options.once && !options['sync-now'] && !options.summary;
    if (recurring && !stopping) {
      const interval = options.watch ? 2000 : 3_600_000;
      const until = Date.now() + interval;
      while (!stopping && Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(1000, until - Date.now())));
    }
    if (!recurring) break;
  } while (!stopping);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { if (error.code === 'enrollment_required') { console.error(error.message); process.exitCode = 1; return; } console.error('Collector could not complete. Check local state, permissions, or ingestion availability; delivery was not acknowledged.'); process.exitCode = 1; });
}
