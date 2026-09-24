/**
 * @lockedinlabs/agent-console/conformance — the token-accounting conformance
 * suite as data, so another implementation can pin the same files.
 *
 *   import { suite, manifest, expected, collectorRecords, logsRoot } from "@lockedinlabs/agent-console/conformance";
 *
 * - manifest.json          the organisation, its machines and people, the window, and the delivery order
 * - logs/                  synthetic Claude Code and Codex transcripts, one tree per machine
 * - expected.json          exact totals per window, team, person, machine, model and session, from ground truth
 * - collector-records.json what this package's collector sends at each delivery step (collector-shaped input)
 *
 * The rules are in docs/accounting.md. Nothing here is real: every prompt,
 * path and branch is a synthetic canary. Zero dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.dirname(fileURLToPath(import.meta.url));
export const logsRoot = path.join(root, "logs");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));

export const manifest = read("manifest.json");
export const expected = read("expected.json");
export const collectorRecords = read("collector-records.json");
export const suite = manifest.suite;
export const files = Object.freeze({
  manifest: path.join(root, "manifest.json"),
  expected: path.join(root, "expected.json"),
  collectorRecords: path.join(root, "collector-records.json"),
  logs: logsRoot,
});
