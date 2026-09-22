/**
 * The hub reads its own machine the same way a reporter does — through the
 * collector, into the same store, under the same salted identities — except
 * that delivery is a function call instead of an HTTP POST.
 *
 * One privilege the hub's own machine has, and only it: its lanes may be
 * NAMED. The hub is reading its own disk and serving the result on loopback,
 * so it keeps a private map from a project's salted hash to the directory's
 * last path segment, and from a session to its git branch. That map lives in
 * the hub's state directory (mode 600), is never part of a record, and is
 * never sent anywhere. Other machines' lanes show the label their owner chose,
 * or a short hash.
 */

import fs from "node:fs";
import path from "node:path";
import { defaultRoots, runOnce } from "../collector/collector.js";

const MAX_NAMES = 5_000;

export function createNames(dir) {
  const file = dir ? path.join(dir, "names.json") : null;
  let saved = { projects: {}, branches: {} };
  if (file) {
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first run */ }
  }
  const projects = new Map(Object.entries(saved.projects || {}));
  const branches = new Map(Object.entries(saved.branches || {}));
  let dirty = false;

  return {
    project: (hash) => projects.get(hash) || null,
    branch: (hash) => branches.get(hash) || null,
    set(kind, hash, value) {
      const map = kind === "project" ? projects : branches;
      if (!hash || !value || map.get(hash) === value) return;
      if (map.size >= MAX_NAMES) map.delete(map.keys().next().value);
      map.set(hash, value);
      dirty = true;
    },
    save() {
      if (!file || !dirty) return;
      dirty = false;
      const temporary = file + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify({
        projects: Object.fromEntries(projects), branches: Object.fromEntries(branches),
      }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    },
  };
}

/** A lock left by a hub that crashed is removed only if its process is gone. */
export function clearDeadLock(directory) {
  const lock = path.join(directory, "lock");
  let pid;
  try { pid = JSON.parse(fs.readFileSync(lock, "utf8")).pid; } catch { return; }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") fs.unlinkSync(lock);
  }
}

/**
 * @param {object} options
 * @param {object} options.registry
 * @param {object} options.store
 * @param {object} options.names       createNames()
 * @param {string} options.stateDir    the hub's state directory
 * @param {Array}  [options.roots]     transcript roots (default: this user's)
 * @param {number} [options.intervalMs]
 * @param {(error: Error) => void} [options.onError]
 */
export function startLocalCollection({ registry, store, names, stateDir, roots = defaultRoots(), intervalMs = 5000, label, person, onError = () => {} }) {
  const device = registry.localDevice({ label, person });
  const directory = path.join(stateDir, "local");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "enrollment.json"), JSON.stringify({
    v: 1,
    organizationId: registry.organizationId,
    device: { id: device.id, label: device.label },
    orgSalt: registry.orgSalt,
  }), { mode: 0o600 });
  clearDeadLock(directory);

  const onLocalLabel = ({ sessionHash, projectHash, cwd, branch }) => {
    if (projectHash && cwd) names.set("project", projectHash, path.basename(cwd.replace(/[\\/]+$/u, "")) || cwd);
    if (sessionHash && branch) names.set("branch", sessionHash, branch);
  };

  let stopped = false, timer = null, running = null, lastError = null;
  const status = { device, lastRunAt: null, lastDurationMs: null, firstRunComplete: false, error: null, roots: roots.map((r) => r.tool) };

  async function tick() {
    if (stopped) return;
    const started = Date.now();
    try {
      await runOnce({
        directory,
        roots,
        watch: true,           // reports every few seconds: this is a live source
        compact: true,
        sinceMs: started - store.retentionMs,
        onLocalLabel,
        sinkName: "hub",
        deliver: async (reportingDevice, records, freshness) => {
          const receipt = store.ingest(reportingDevice.id, records);
          registry.touch(reportingDevice.id, { freshness });
          return receipt;
        },
      });
      names.save();
      status.error = null;
      lastError = null;
    } catch (error) {
      // Reported once per distinct failure, not every five seconds.
      const message = String(error && error.message);
      status.error = message;
      if (message !== lastError) onError(error);
      lastError = message;
    } finally {
      status.lastRunAt = Date.now();
      status.lastDurationMs = status.lastRunAt - started;
      status.firstRunComplete = true;
      if (!stopped) { timer = setTimeout(() => { running = tick(); }, intervalMs); timer.unref?.(); }
    }
  }
  running = tick();

  return {
    status,
    get ready() { return running; },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
}
