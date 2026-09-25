/** Local-only signals from the collector's existing transcript tail and counted deltas. */
import { spawn } from 'node:child_process';
import { emptyAlertState, analyzeAlertEvent } from '../analysis/index.js';

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

/** The collector supplies its salted identity and already-counted usage records. */
export function createAlerts({ repeat = 5, spikeFactor = 3, stallMinutes = 5,
  notify = false, now = () => Date.now(), onAlert = () => {} } = {}) {
  const sessions = new Map();
  const alerts = [];
  const stateFor = (id) => {
    let state = sessions.get(id);
    if (!state) {
      state = { analysis: emptyAlertState(), observedTokens: 0, seenCalls: new Set() };
      sessions.set(id, state);
    }
    return state;
  };
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
        const alert = { id: hashIdentity('alert', `${signal.kind}|${sessionHash}|${eventAt}|${alerts.length}`),
          ...signal, laneHash, projectHash: projectHash || null };
        alerts.push(alert);
        if (alerts.length > MAX_ALERTS) alerts.shift();
        onAlert(alert);
        if (notify) desktop(signal.kind);
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
  return {
    observeLine,
    list() { return alerts.filter((a) => a.at >= now() - 60 * MINUTE).slice(-20).reverse(); },
    totals() { return Object.fromEntries([...sessions].map(([hash, state]) => [hash, state.observedTokens])); },
    stop() {},
    get pollMs() { return POLL_MS; },
  };
}

export function demoAlerts(now = Date.now()) {
  return ['loop', 'spike', 'stall'].map((kind, i) => ({
    id: `demo-alert-${kind}`, kind, sessionHash: 'demo', laneHash: 'demo', projectHash: null,
    at: now - i * MINUTE, sourceAt: now - i * MINUTE - 800, tokens: [5, 440_000, 650_000][i],
  }));
}
