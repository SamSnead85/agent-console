#!/usr/bin/env node

/*
 * The console's two data payloads as fixtures, for building a screen before
 * the hub it will run against:
 *
 *   node scripts/api-fixtures.mjs        writes fixtures/console-v0.4.json
 *                                        and fixtures/projects-v0.4.json
 *
 * Both come from the demonstration team (lib/hub/demo.js) through the same
 * code the hub serves /api/console and /api/projects with — nothing is typed
 * in by hand. One synthetic response on a model the price table does not
 * list is added to the demo's own machine, so the fixtures carry a partial
 * estimate as well as priced ones, and the demo's laptop is made to have
 * begun sharing two minutes ago, so they carry partial alert and activity
 * coverage beside complete, off and undeclared. Every name in them is the
 * demo's; every figure is generated. Saved lane keys are explicit synthetic
 * labels, with their alert references updated together. Runtime identifiers
 * are unchanged. docs/console-v0.4.schema.json and
 * docs/projects-v0.4.schema.json describe them (test/api-schema.test.js).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRegistry } from "../lib/hub/registry.js";
import { createStore } from "../lib/hub/store.js";
import { startDemo } from "../lib/hub/demo.js";
import { createFleetSignals } from "../lib/hub/fleet.js";
import { createActivityBook } from "../lib/collector/activity.js";
import { eventMeasurement } from "../lib/collector/measurement.js";
import { buildConsole } from "../lib/hub/aggregate.js";
import { projectsPayload } from "../lib/hub/projects.js";
import { allAlerts, consoleSignals, demoInterop, priceTableInfo } from "../lib/hub/routes.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const MINUTE = 60_000;

/** The demo's /api/console and /api/projects?period=<period>, built in-process. */
export async function demoPayloads({ period = "24h" } = {}) {
  const prices = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "collector", "prices.json"), "utf8"));
  const registry = createRegistry({ dir: null });
  const store = createStore({ dir: null, retentionMs: 8 * 86_400_000, prices });
  const fleet = createFleetSignals();
  const activity = createActivityBook();
  const demo = startDemo({ registry, store, fleet, activity, tickMs: 1e9 });
  demo.stop();
  const now = Date.now();
  // The laptop began sharing two minutes ago: its coverage of the windows is partial.
  fleet.markDemo("dev_demo_laptop", { alerts: "on", activity: "on" }, now - 2 * MINUTE);
  // One response on an unlisted model in the demo's docs-site lane: a partial estimate.
  const docs = [...store.sessions.values()].find((s) => s.deviceId === "dev_demo_studio" && demo.names.project(s.projectHash) === "docs-site" && !s.isSubagent);
  if (docs) {
    const row = { id: crypto.createHash("sha256").update("agent-console-fixture|unpriced").digest("hex"), tool: "claude-code", model: "claude-unlisted-demo",
      sessionHash: docs.sessionHash, parentSessionHash: null, isSubagent: false, projectHash: docs.projectHash, engagement: null,
      reportingDevice: "dev_demo_studio", executionOrigin: "unknown", at: new Date(Math.floor((now - 30 * MINUTE) / MINUTE) * MINUTE).toISOString(),
      fresh: 1200, output: 800, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, ttl: "unknown", cacheRead: 9000,
      observed: true, continuation: false, tier: "standard", cumulative: false };
    row.measurement = eventMeasurement(row);
    store.ingest("dev_demo_studio", [row]);
  }
  const alerts = { list: () => demo.alerts(now) };
  const hub = { product: "Agent Console", version: VERSION, demo: true, interop: true,
    listen: { address: "127.0.0.1", port: 4318, network: false }, consolePort: 4317, urls: ["http://127.0.0.1:4318"],
    networkCommand: null, fingerprint: "0".repeat(64), retentionDays: 8, wsl: false, prices: priceTableInfo(prices),
    release: { url: null, page: null }, local: { enabled: true, tools: ["claude-code", "codex"], firstRunComplete: true, progress: null, error: null,
      // The folders a console reads for its own machine, as a home directory would name them (synthetic).
      roots: [{ tool: "claude-code", path: "~/.claude/projects", exists: true, files: 42 }, { tool: "codex", path: "~/.codex/sessions", exists: true, files: 9 },
        { tool: "codex", path: "~/.codex/archived_sessions", exists: false, files: 0 }] } };
  const console = buildConsole({ store, registry, names: demo.names, now, hub,
    alerts: allAlerts({ alerts, fleet }, now), signals: consoleSignals({ alerts, fleet, activity }, now) });
  console.interop = demoInterop(now);
  const projects = await projectsPayload({ store, registry, names: demo.names, period, demo: true, now });
  return { console, projects };
}

/** Give saved examples recognizable, non-credential lane identifiers. */
export function fixturePayloads(payloads) {
  const result = structuredClone(payloads);
  const keys = new Map(result.console.lanes.map((lane, i) => [lane.key, `demo-lane-${String(i + 1).padStart(2, "0")}`]));
  for (const lane of result.console.lanes) lane.key = keys.get(lane.key);
  for (const alert of result.console.alerts) {
    if (!alert.lane) continue;
    const key = keys.get(alert.lane.key);
    if (!key) throw new Error("The synthetic alert refers to a missing lane.");
    alert.lane.key = key;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { console: view, projects } = fixturePayloads(await demoPayloads());
  fs.mkdirSync(path.join(ROOT, "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "fixtures", "console-v0.4.json"), JSON.stringify(view, null, 1) + "\n");
  fs.writeFileSync(path.join(ROOT, "fixtures", "projects-v0.4.json"), JSON.stringify(projects, null, 1) + "\n");
  process.stdout.write("wrote fixtures/console-v0.4.json and fixtures/projects-v0.4.json\n");
}
