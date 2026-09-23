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
 * never sent anywhere. Other machines' lanes show the label chosen on that machine,
 * or a short hash.
 */

import fs from "node:fs";
import path from "node:path";
import { defaultRoots, runOnce } from "../collector/collector.js";

const MAX_NAMES = 5_000;

/**
 * This machine's private names: project hash -> folder name and folder, and
 * session hash -> branch. Each entry remembers when it was last seen and is
 * dropped once that is older than the hub's retention, so the file holds only
 * what the console can still show. Mode 600; never sent anywhere.
 */
export function createNames(dir, { retentionMs = 8 * 86_400_000, now = () => Date.now() } = {}) {
  const file = dir ? path.join(dir, "names.json") : null;
  let saved = {};
  if (file) {
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { /* first run */ }
  }
  // 0.2.0 kept bare strings; they count as seen now and age out from here.
  const read = (map) => new Map(Object.entries(map || {}).map(([k, v]) => [k, Array.isArray(v) ? v : [v, now()]])
    .filter(([, v]) => typeof v[0] === "string" && Number.isFinite(v[1])));
  const maps = { project: read(saved.projects), branch: read(saved.branches), path: read(saved.paths) };
  let dirty = false;

  return {
    project: (hash) => (maps.project.get(hash) || [null])[0],
    branch: (hash) => (maps.branch.get(hash) || [null])[0],
    path: (hash) => (maps.path.get(hash) || [null])[0],
    set(kind, hash, value) {
      const map = maps[kind];
      if (!map || !hash || !value) return;
      const prior = map.get(hash);
      const t = now();
      if (prior && prior[0] === value && t - prior[1] < 3600_000) return;
      map.delete(hash);
      if (map.size >= MAX_NAMES) map.delete(map.keys().next().value);
      map.set(hash, [value, t]);
      dirty = true;
    },
    save() {
      const edge = now() - retentionMs;
      for (const map of Object.values(maps)) for (const [k, v] of map) if (v[1] < edge) { map.delete(k); dirty = true; }
      if (!file || !dirty) return;
      dirty = false;
      const temporary = file + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify({
        v: 2, projects: Object.fromEntries(maps.project), branches: Object.fromEntries(maps.branch), paths: Object.fromEntries(maps.path),
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
    if (projectHash && cwd) {
      names.set("project", projectHash, path.basename(cwd.replace(/[\\/]+$/u, "")) || cwd);
      names.set("path", projectHash, cwd);
    }
    if (sessionHash && branch) names.set("branch", sessionHash, branch);
  };

  let stopped = false, timer = null, running = null, lastError = null;
  // `progress` is the first read's "N of M files", so a machine with months of
  // transcripts shows it is working rather than an empty console.
  const status = { device, lastRunAt: null, lastDurationMs: null, firstRunComplete: false, error: null, roots: roots.map((r) => r.tool), progress: null };

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
        ...(status.firstRunComplete ? {} : { onProgress: (p) => { if (p.phase === "scan") status.progress = { files: p.files, filesTotal: p.filesTotal, records: p.records }; } }),
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
