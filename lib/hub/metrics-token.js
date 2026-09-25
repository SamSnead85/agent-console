/** Print or independently rotate a scoped telemetry credential for the local console owner. */

import { readConfig } from "../config.js";
import { readAdminKey, scrapeToken } from "./admin.js";
import { checkScope, interopGeneration, rotateInteropCredential } from "./interop-credentials.js";

export function mainMetricsToken(argv, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  let scope = "read", rotate = false;
  const options = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scope") scope = argv[++i];
    else if (argv[i] === "--rotate") rotate = true;
    else options.push(argv[i]);
  }
  try { checkScope(scope); } catch (error) { err.write(error.message + "\n"); return 2; }
  const config = readConfig(options, env);
  if (config.listenErrors.length) { err.write(config.listenErrors.join("\n") + "\n"); return 2; }
  if (config.demo) {
    err.write("\n  A demonstration console keeps its key in memory: it prints its scrape token when it starts with --interop.\n\n");
    return 2;
  }
  const key = readAdminKey(config.stateDir);
  if (!key) {
    err.write(`\n  There is no console key in ${config.stateDir} yet. Start the console once, then run this again.\n\n`);
    return 1;
  }
  let generation;
  try {
    generation = rotate ? rotateInteropCredential(config.stateDir, scope) : interopGeneration(config.stateDir, scope);
  } catch (error) { err.write(error.message + "\n"); return 1; }
  const token = scrapeToken(key, scope, generation);
  if (config.json) {
    out.write(JSON.stringify({ ok: true, token, scope, rotated: rotate, stateDir: config.stateDir }) + "\n");
  } else {
    out.write([
      "",
      `  ${scope === "read" ? "Read token for /metrics" : "Write token for telemetry ingest"} of the console in ${config.stateDir}:`,
      "",
      `  ${token}`,
      "",
      "  Send it as the header  Authorization: Bearer <token>  (see docs/INTEROP.md). Keep it like a",
      "  password. Rotate this scope with --rotate; other telemetry scopes and browser sessions stay valid.",
      "",
    ].join("\n") + "\n");
  }
  return 0;
}
