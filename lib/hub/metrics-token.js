/**
 * `metrics-token`: prints the bearer token that /metrics and the telemetry
 * ingest take when the console runs with --interop.
 *
 * The token is derived from the console's key (lib/hub/admin.js), so only a
 * process running as the console's user, able to read that key, can print it.
 * It is not the key: the key never leaves its file. A new key (delete
 * admin.key and start the console again) makes a new token and ends the old.
 */

import fs from "node:fs";
import { readConfig } from "../config.js";
import { invocation } from "../invocation.js";
import { readAdminKey, scrapeToken } from "./admin.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export function mainMetricsToken(argv, { env = process.env, out = process.stdout, err = process.stderr, cmd = invocation(VERSION) } = {}) {
  const config = readConfig(argv, env);
  if (config.help) {
    out.write([
      "",
      `  ${cmd} metrics-token [--state-dir <path>] [--json]`,
      "",
      "  Prints the scrape token that /metrics and the telemetry ingest take when the console runs",
      "  with --interop. --state-dir names the console's data directory (default ~/.agent-console/hub).",
      "",
    ].join("\n") + "\n");
    return 0;
  }
  // A mistake is refused before the key is read: a mistyped --state-dir must
  // not print the token of a different console.
  const unknown = [...config.errors];
  if (unknown.length) {
    if (config.json) out.write(JSON.stringify({ ok: false, event: "error", kind: "usage", errors: unknown }) + "\n");
    else err.write(unknown.map((problem) => "\n  " + problem).join("") + "\n\n");
    return 2;
  }
  if (config.demo) {
    err.write("\n  A demonstration console keeps its key in memory: it prints its scrape token when it starts with --interop.\n\n");
    return 2;
  }
  const key = readAdminKey(config.stateDir);
  if (!key) {
    err.write(`\n  There is no console key in ${config.stateDir} yet. Start the console once, then run this again.\n\n`);
    return 1;
  }
  const token = scrapeToken(key);
  if (config.json) {
    out.write(JSON.stringify({ ok: true, token, stateDir: config.stateDir }) + "\n");
  } else {
    out.write([
      "",
      `  Scrape token for /metrics and the telemetry ingest of the console in ${config.stateDir}:`,
      "",
      `  ${token}`,
      "",
      "  Send it as the header  Authorization: Bearer <token>  (see docs/INTEROP.md). Keep it like a",
      "  password. It changes, and the old one stops working, whenever the console's key changes.",
      "",
    ].join("\n") + "\n");
  }
  return 0;
}
