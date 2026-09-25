/** Local-only signals from the collector's existing transcript tail and counted deltas. */
import { spawn } from 'node:child_process';
import { emptyAlertState, analyzeAlertEvent } from '../analysis/index.js';
import { tooFarAhead } from '../collector/activity.js';

const MAX_ALERTS = 100;
const MINUTE = 60_000;
const POLL_MS = 2_000;
const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : 0;

function desktop(kind) {
  const messages = { loop: 'Repeated tool call', spike: 'Session burn spike', stall: 'Spending without a tool success' };
  const message = messages[kind];
  if (!message) return;
  let command, args;
  if (process.platform === 'darwin') {
    command = 'osascript'; args = ['-e', `display notification "${message}" with title "Agent Console"`];
  } else if (process.platform === 'win32') {
    command = 'powershell.exe';
    const script = `$x=New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Agent Console</text><text>${message}</text></binding></visual></toast>'); [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; $n=[Windows.UI.Notifications.ToastNotification]::new($x); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Agent Console').Show($n)`;
    args = ['-NoProfile', '-Command', script];
  } else {
    command = 'notify-send'; args = ['Agent Console', message];
  }
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

/** How long an alert counts as "now"; older ones are history. */
export const ALERT_WINDOW_MS = 60 * MINUTE;
/** How long history is kept to show under "earlier". */
export const ALERT_HISTORY_MS = 24 * 60 * MINUTE;
const minuteIso = (ms) => new Date(Math.floor(ms / MINUTE) * MINUTE).toISOString();

/**
 * The collector supplies its salted identity and already-counted usage records.
 *
 * TIME TRUTH. An alert is dated by the transcript line that raised it
 * (`at`), not by when it was read (`seenAt`). An alert is `historical` —
 * listed under "earlier", never counted as live — when it is older than the
 * alert window, or when it was raised while `live()` said the reader was
 * still working through its first backlog: a first run over a month of
 * transcripts replays a month of loops in a few seconds, and none of them is
 * happening now. Only a live alert makes a desktop notification.
 */
export function createAlerts({ repeat = 5, spikeFactor = 3, stallMinutes = 5,
  notify = false, now = () => Date.now(), live = () => true, onAlert = () => {} } = {}) {
  const sessions = new Map();
  const alerts = [];
  let unsent = [];
  const stateFor = (id) => {
    let state = sessions.get(id);
    if (!state) {
      state = { analysis: emptyAlertState(), observedTokens: 0, seenCalls: new Set() };
      sessions.set(id, state);
    }
    return state;
  };
  const historical = (alert, t) => alert.backfill || alert.at < t - ALERT_WINDOW_MS;
  const observeLine = ({ tool, line, records = [], sessionHash, parentSessionHash, projectHash,
    historyStartOrdinal, hashIdentity }) => {
    if (!sessionHash || typeof hashIdentity !== 'function' || !line || typeof line !== 'object') return;
    const state = stateFor(sessionHash);
    const sourceAt = Number.isFinite(Date.parse(line.timestamp)) ? Date.parse(line.timestamp) : null;
    const laneHash = parentSessionHash || sessionHash;
    const eventAt = now();
    const observe = (kind, fields = {}) => {
      const next = analyzeAlertEvent(state.analysis,
        { kind, sessionHash, at: eventAt, sourceAt, ...fields },
        { repeat, spikeFactor, stallMinutes });
      state.analysis = next.state;
      for (const signal of next.signals) {
        let backfill = false;
        try { backfill = live() !== true; } catch { backfill = true; }
        const alert = { id: hashIdentity('alert', `${signal.kind}|${sessionHash}|${eventAt}|${alerts.length}`),
          kind: signal.kind, at: signal.at, seenAt: eventAt, sourceAt: signal.sourceAt, backfill,
          sessionHash, laneHash, projectHash: projectHash || null,
          // The signal's number: repeats for a loop, tokens for a spike or a stall.
          count: signal.tokens, tokens: signal.tokens };
        alerts.push(alert);
        if (alerts.length > MAX_ALERTS) alerts.shift();
        unsent.push(alert);
        if (unsent.length > MAX_ALERTS) unsent.shift();
        const shown = publicAlert(alert, eventAt);
        onAlert(shown);
        if (notify && !shown.historical) desktop(signal.kind);
      }
    };
    const call = (name, args, identity) => {
      if (typeof name !== 'string' || !name) return;
      if (typeof identity === 'string' && state.seenCalls.has(identity)) return;
      if (typeof identity === 'string') state.seenCalls.add(identity);
      const fingerprint = hashIdentity('tool-call', `${name}|${typeof args === 'string' ? args : JSON.stringify(args ?? null)}`);
      observe('call', { callHash: fingerprint });
    };

    if (tool === 'claude-code') {
      const content = Array.isArray(line.message?.content) ? line.message.content : [];
      if (line.type === 'assistant') for (const block of content) {
        if (block?.type === 'tool_use') call(block.name, block.input, block.id);
      }
      if (line.type === 'user') for (const block of content) {
        if (block?.type === 'tool_result' && block.is_error !== true) observe('success');
      }
    } else if (tool === 'codex') {
      const p = line.payload;
      const ordinal = Number.isSafeInteger(line.ordinal) ? line.ordinal : null;
      const replay = Number.isSafeInteger(historyStartOrdinal) && ordinal !== null && ordinal < historyStartOrdinal;
      if (!replay && line.type === 'response_item' && p?.type === 'function_call') {
        call(p.name, p.arguments, p.call_id);
      }
      if (!replay && line.type === 'response_item' && p?.type === 'function_call_output' && p.is_error !== true) {
        observe('success');
      }
    }
    // These records are the collector's per-event deltas. An unchanged Codex
    // cumulative token_count produces no record, so it cannot be counted twice.
    for (const record of records) {
      const tokens = count(record.fresh) + count(record.output) + count(record.cacheWrite) + count(record.cacheRead);
      if (tokens <= 0) continue;
      state.observedTokens += tokens;
      observe('usage', { tokens });
    }
    if (state.seenCalls.size > 2_000) state.seenCalls.clear();
  };
  function publicAlert(a, t) {
    return { id: a.id, kind: a.kind, at: a.at, seenAt: a.seenAt, historical: historical(a, t),
      sessionHash: a.sessionHash, laneHash: a.laneHash, projectHash: a.projectHash,
      count: a.count, tokens: a.tokens, sourceAt: a.sourceAt };
  }
  return {
    observeLine,
    /** Alerts of the last day, newest first by their own time; `historical` ones are not "now". */
    list() {
      const t = now();
      return alerts.filter((a) => a.at >= t - ALERT_HISTORY_MS && a.at <= t + MINUTE)
        .map((a) => publicAlert(a, t)).sort((a, b) => b.at - a.at);
    },
    /**
     * The alerts raised since the last drain, in the form a reporter sends
     * them: kind, minute, salted hashes and a count — nothing else
     * (docs/COLLECTOR-CONTRACT.md). The reporter's outbox keeps them, on
     * disk, until the console acknowledges the envelope that carried them
     * (lib/reporter-outbox.js). One older than the day, or dated past the
     * clock rule (lib/collector/activity.js), is not handed over.
     */
    drain() {
      const t = now();
      const out = unsent.filter((a) => a.at >= t - ALERT_HISTORY_MS && !tooFarAhead(a.at, t))
        .map((a) => ({ id: a.id, kind: a.kind, at: minuteIso(a.at), sessionHash: a.sessionHash,
          count: Number.isSafeInteger(a.count) && a.count >= 0 ? a.count : 0, historical: historical(a, t) }));
      unsent = [];
      return out;
    },
    totals() { return Object.fromEntries([...sessions].map(([hash, state]) => [hash, state.observedTokens])); },
    stop() {},
    get pollMs() { return POLL_MS; },
  };
}

export function demoAlerts(now = Date.now()) {
  return ['loop', 'spike', 'stall'].map((kind, i) => ({
    id: `demo-alert-${kind}`, kind, sessionHash: 'demo', laneHash: 'demo', projectHash: null,
    at: now - i * MINUTE, seenAt: now - i * MINUTE, sourceAt: now - i * MINUTE, historical: false,
    count: [5, 440_000, 650_000][i], tokens: [5, 440_000, 650_000][i],
  }));
}
