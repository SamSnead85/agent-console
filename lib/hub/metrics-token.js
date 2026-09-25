/**
 * `metrics-token`: prints the bearer token that /metrics and the telemetry
 * ingest take when the console runs with --interop.
 *
 * The token is derived from the console's key (lib/hub/admin.js), so only a
 * process running as the console's user, able to read that key, can print it.
 * It is not the key: the key never leaves its file. A new key (delete
 * admin.key and start the console again) makes a new token and ends the old.
 */

import { readConfig } from "../config.js";
import { readAdminKey, scrapeToken } from "./admin.js";

export function mainMetricsToken(argv, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const config = readConfig(argv, env);
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
