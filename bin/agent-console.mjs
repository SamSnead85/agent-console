#!/usr/bin/env node
/*
 * The console's entry point.
 *
 * Deliberately thin. `join`, `report` and `leave` run the reporter — the small
 * program another machine runs to show up on somebody's console. Anything
 * else starts the console itself, in THIS process rather than a child: a
 * spawn would only add a process whose exit codes have to be translated back.
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
if (command === "join" || command === "report" || command === "leave") {
  const { main } = await import("../lib/reporter.js");
  await main(command, process.argv.slice(3));
} else {
  await import("../server.js");
}
