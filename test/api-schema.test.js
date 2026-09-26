/**
 * H18: the v0.4 payload contract. The fixtures a screen is built against
 * match the schemas, the hub's own demo payload matches them today (so the
 * schemas cannot drift from the code), and the fixtures carry every new case
 * at least once: a historical alert, a spike with its magnitude, a machine
 * not watched, stacked series, counts over every lane, tool activity shared
 * and not shared, alert and activity coverage complete, partial, off and
 * undeclared, unknown coverage, and a partial project estimate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";

import { validate } from "./helpers/schema.js";
import { demoPayloads } from "../scripts/api-fixtures.mjs";

const read = (rel) => JSON.parse(fs.readFileSync(new URL("../" + rel, import.meta.url), "utf8"));
const CONSOLE_SCHEMA = read("docs/console-v0.4.schema.json");
const PROJECTS_SCHEMA = read("docs/projects-v0.4.schema.json");
const CONSOLE = read("fixtures/console-v0.4.json");
const PROJECTS = read("fixtures/projects-v0.4.json");

test("H18: the fixtures match the v0.4 schemas", () => {
  assert.deepEqual(validate(CONSOLE_SCHEMA, CONSOLE), []);
  assert.deepEqual(validate(PROJECTS_SCHEMA, PROJECTS), []);
  // The checker checks: a stray field, a wrong type and a missing section are each caught.
  assert.ok(validate(CONSOLE_SCHEMA, { ...CONSOLE, laneTotals: { ...CONSOLE.laneTotals, sampled: true } }).length > 0);
  assert.ok(validate(CONSOLE_SCHEMA, { ...CONSOLE, alerts: [{ ...CONSOLE.alerts[0], historical: "no" }] }).length > 0);
  const { fleet, ...noFleet } = PROJECTS;
  assert.ok(fleet && validate(PROJECTS_SCHEMA, noFleet).length > 0);
});

test("H18: the hub's own payloads match the schemas today, for every period", async () => {
  for (const period of ["1h", "24h", "7d", "30d"]) {
    const { console: view, projects } = await demoPayloads({ period });
    assert.deepEqual(validate(CONSOLE_SCHEMA, view), [], "console");
    assert.deepEqual(validate(PROJECTS_SCHEMA, projects), [], `projects ${period}`);
  }
});

test("H18: the fixtures exercise every new field", () => {
  assert.ok(CONSOLE.alerts.some((a) => a.historical), "a historical alert");
  assert.ok(CONSOLE.alerts.some((a) => !a.historical), "a live alert");
  assert.ok(CONSOLE.alerts.some((a) => a.kind === "spike" && a.factor > 1), "a spike with its magnitude");
  assert.ok(CONSOLE.alertsCoverage.unwatched > 0, "a machine not watched");
  for (const key of ["1h", "24h", "7d", "30d"]) assert.ok(CONSOLE.series[key].byDevice.bands.length > 0, key);
  assert.equal(CONSOLE.series["7d"].byLocalDay.days.length, 7);
  assert.ok(CONSOLE.laneTotals.total >= CONSOLE.lanes.length && CONSOLE.laneTotals.subagentCount > 0);
  assert.ok(CONSOLE.lanes.some((l) => l.activityShared && l.lastTool), "shared tool activity");
  assert.ok(CONSOLE.lanes.some((l) => !l.activityShared && l.activity === null), "activity not shared");
  for (const state of ["complete", "partial", "off", "undeclared"]) {
    assert.ok(CONSOLE.lanes.some((l) => l.activityCoverage.state === state), `activity coverage ${state}`);
  }
  assert.ok(CONSOLE.lanes.every((l) => l.activityCoverage.state === "complete" || !l.activity || Object.values(l.activity.calls).some((n) => n > 0)
    || l.activity.results.ok + l.activity.results.error > 0), "zero is drawn only under complete coverage");
  assert.ok(CONSOLE.alertsCoverage.since !== null && CONSOLE.alertsCoverage.reason === "sharing-started", "a partial alert watch");
  assert.ok(CONSOLE.devices.every((d) => d.sharing && d.sharing.alerts.state && Number.isInteger(d.sharing.rejectedFuture)));
  assert.ok(CONSOLE.devices.some((d) => d.coverage.reported === false && d.coverage.dropped === null), "coverage never reported");
  assert.ok(CONSOLE.devices.some((d) => d.coverage.dropped > 0), "coverage with drops");
  assert.ok(Object.values(CONSOLE.team.perMachine).every((p) => p.reporting > 0));
  assert.ok(CONSOLE.interop.otel.cumulativeIgnored > 0);
  assert.ok(PROJECTS.projects.some((p) => p.cost.status === "partial"), "a partial project estimate");
  assert.ok(PROJECTS.projects.some((p) => p.cost.status === "priced"));
  assert.ok(PROJECTS.projects.some((p) => p.parent && p.repoHash));
  assert.equal(PROJECTS.computedAt, PROJECTS.asOf);
  assert.ok(PROJECTS.fleet["24h"].tokens >= PROJECTS.tokens, "this machine is a part of the team");
  assert.equal(CONSOLE.hub.demo, true, "the fixtures are the demo's, never a real machine's");
});
