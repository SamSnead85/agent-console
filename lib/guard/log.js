/** Projected local guard decisions for the signed-in console only. */
import fs from 'node:fs';
import { guardPaths } from './cli.js';

export function guardView(home, now = Date.now()) {
  const p = guardPaths(home);
  let installed = false, decisions = [];
  try {
    const settings = JSON.parse(fs.readFileSync(p.settingsFile, 'utf8'));
    installed = (settings.hooks?.PreToolUse || []).some((group) =>
      group.hooks?.some((hook) => hook.args?.[0] === p.hook));
  } catch { /* absent or invalid settings means no installed guard */ }
  try {
    const codex = JSON.parse(fs.readFileSync(p.codexFile, 'utf8'));
    installed ||= (codex.hooks?.PreToolUse || []).some((group) =>
      group.hooks?.some((hook) => hook.command?.includes(p.hook) && hook.command?.endsWith(' codex')));
  } catch { /* no Codex hook */ }
  try {
    const stat = fs.statSync(p.guardDir + '/decisions.ndjson');
    const start = Math.max(0, stat.size - 128_000);
    const fd = fs.openSync(p.guardDir + '/decisions.ndjson', 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    decisions = buffer.toString('utf8').split('\n').slice(start ? 1 : 0).flatMap((line) => {
      try {
        const item = JSON.parse(line);
        if (!Number.isFinite(item.at) || item.at < now - 24 * 3600_000
          || !/^[a-z][a-z0-9-]{0,63}$/u.test(item.ruleId)
          || !['allow', 'ask', 'block'].includes(item.action)) return [];
        return [{ at: item.at, ruleId: item.ruleId, action: item.action }];
      } catch { return []; }
    }).slice(-20).reverse();
  } catch { /* no decisions yet */ }
  return { installed, decisions };
}
