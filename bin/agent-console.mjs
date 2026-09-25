#!/usr/bin/env node
/*
 * The console's entry point.
 *
 * Deliberately thin. `join`, `report`, `stop` and `leave` run the reporter — the small
 * program another machine runs to show up on somebody's console. `policy` and
 * `metrics-token` are small utilities. `--version`
 * prints the version. No command, or an option, starts the console itself, in
 * THIS process rather than a child: a spawn would only add a process whose exit
 * codes have to be translated back. Any other word is refused: a mistyped
 * `joni` must not start a console that reads this machine.
 */

const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  process.stderr.write(
    "\n  Agent Console needs Node.js 22 or newer; this is " + process.version + ".\n" +
      "  Install the current LTS from https://nodejs.org and run the same command again.\n\n",
  );
  process.exit(1);
}

const command = process.argv[2];
if (command === "--version" || command === "-v" || command === "version") {
  // Answered here so asking for the version never starts a console.
  const { readFileSync } = await import("node:fs");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  process.stdout.write("agent-console " + version + "\n");
} else if (command === "join" || command === "report" || command === "leave" || command === "stop") {
  const { main } = await import("../lib/reporter.js");
  await main(command, process.argv.slice(3));
} else if (command === "metrics-token") {
  const { mainMetricsToken } = await import("../lib/hub/metrics-token.js");
  process.exitCode = mainMetricsToken(process.argv.slice(3));
} else if (command === "policy") {
  const { mainPolicy } = await import('../lib/policy/cli.js');
  try { mainPolicy(process.argv.slice(3)); }
  catch (error) { process.stderr.write('Agent Console policy: ' + error.message + '\n'); process.exitCode = 1; }
} else if (command === undefined || command.startsWith("-")) {
  await import("../server.js");
} else if (command === "help") {
  process.argv.splice(2, 1, "--help");
  await import("../server.js");
} else {
  const { closest } = await import("../lib/config.js");
  const near = closest(command, ["join", "report", "stop", "leave", "policy", "metrics-token", "help", "version"]);
  const json = process.argv.includes("--json");
  const message = `"${command}" is not an Agent Console command.` + (near ? ` Did you mean "${near}"?` : "")
    + " The commands are join, report, stop, leave, policy and metrics-token; with no command, or only options, the console starts.";
  if (json) process.stdout.write(JSON.stringify({ ok: false, event: "error", kind: "usage", message }) + "\n");
  else process.stderr.write("\n  " + message + "\n  Run --help for the options.\n\n");
  process.exitCode = 2;
}
