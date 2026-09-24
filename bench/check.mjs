#!/usr/bin/env node

/*
 * The performance budget, as CI enforces it: node --expose-gc bench/check.mjs
 *
 * Runs bench/ops.mjs at two history sizes and holds the counts to
 * bench/budgets.json. Everything gated here is an operation count (bytes
 * read and written, files opened, lines parsed, bytes kept), so a slow or
 * fast CI machine cannot make it pass or fail. Times are printed for
 * information only.
 *
 * The rule the budgets encode: the first read costs about one read of the
 * history; after that, a pass costs what changed, not what exists.
 */

import fs from "node:fs";
import { measure } from "./ops.mjs";

const { sizes, sessions, budgets } = JSON.parse(fs.readFileSync(new URL("./budgets.json", import.meta.url), "utf8"));
const runs = [];
for (const lines of sizes) runs.push(await measure({ lines, sessions, days: 8 }));
const [small, large] = [runs[0], runs.at(-1)];

const checks = [];
const check = (name, value, limit) => checks.push({ name, value, limit, ok: value <= limit });
for (const r of runs) {
  const tag = `${r.lines.toLocaleString("en-US")} lines`;
  check(`${tag}: first read, bytes read per byte of history`, +(r.first.bytesRead / r.sourceBytes).toFixed(3), budgets["first.bytesReadPerSourceByte"]);
  check(`${tag}: first read, writes per 1,000 records`, +(r.first.writes / (r.first.records / 1000)).toFixed(2), budgets["first.writesPerThousandRecords"]);
  check(`${tag}: first read, JSON parses per transcript line`, +(r.first.jsonParses / r.lines).toFixed(3), budgets["first.jsonParsesPerLine"]);
  check(`${tag}: idle pass, bytes read`, r.idle.bytesRead, budgets["idle.bytesRead"]);
  check(`${tag}: idle pass, bytes written`, r.idle.bytesWritten, budgets["idle.bytesWritten"]);
  check(`${tag}: idle pass, files opened`, r.idle.opens, budgets["idle.opens"]);
  check(`${tag}: five new lines, bytes read`, r.fiveNewLines.bytesRead, budgets["fiveNewLines.bytesRead"]);
  check(`${tag}: five new lines, bytes written`, r.fiveNewLines.bytesWritten, budgets["fiveNewLines.bytesWritten"]);
  check(`${tag}: cursor size, bytes`, r.cursorBytes, budgets.cursorBytes);
  check(`${tag}: console answer, bytes`, r.consoleBytes, budgets.consoleBytes);
}
// Reading stored records back at a restart, relative to parsing them.
check(`${large.lines.toLocaleString("en-US")} lines: restart, store load time per JSON.parse time`, large.storeLoad.ratio, budgets["storeLoad.ratioToParse"]);
// A pass with nothing new must not cost more because the history is longer.
check(`idle pass cost, ${large.lines.toLocaleString("en-US")} vs ${small.lines.toLocaleString("en-US")} lines (bytes read ratio)`,
  +(large.idle.bytesRead / Math.max(1, small.idle.bytesRead)).toFixed(2), budgets["idle.growthRatio"]);

const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) process.stdout.write(`${c.ok ? "ok  " : "OVER"}  ${c.name.padEnd(width)}  ${String(c.value).padStart(10)}  budget ${c.limit}\n`);
process.stdout.write("\nFor information (not gated; depends on the machine):\n");
for (const r of runs) process.stdout.write(`  ${r.lines.toLocaleString("en-US")} lines, ${(r.sourceBytes / 1048576).toFixed(0)} MB: first read ${r.first.ms} ms, idle pass ${r.idle.ms} ms, five new lines ${r.fiveNewLines.ms} ms, store load ${r.storeLoad.loadMs} ms for ${r.storeLoad.records.toLocaleString("en-US")} records, heap ${r.heapMb} MB\n`);
const over = checks.filter((c) => !c.ok);
if (over.length) {
  process.stdout.write(`\n${over.length} over budget. If the cost is deliberate, raise the budget in bench/budgets.json in the same pull request and say why.\n`);
  process.exitCode = 1;
}
