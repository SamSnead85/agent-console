import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readProgress, PROGRESS_FILE, STALE_MS } from "../lib/progress.js";
import { SECRETS } from "./helpers.js";

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-progress-"));
}

function write(dir, value) {
  fs.writeFileSync(
    path.join(dir, PROGRESS_FILE),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

test("a well-formed progress file renders: percent, summary, remaining, fresh", () => {
  const dir = scratch();
  const now = Date.now();
  write(dir, {
    percent: 72.5,
    summary: "W4 landing — capability coverage green, two lanes in review",
    remaining: ["#140 act intents", "#138 gap register", ""],
    updatedAt: new Date(now - 5 * 60_000).toISOString(),
  });
  const p = readProgress(dir, now);
  assert.equal(p.available, true);
  assert.equal(p.percent, 72.5);
  assert.match(p.summary, /W4 landing/u);
  assert.deepEqual(p.remaining, ["#140 act intents", "#138 gap register"]);
  assert.equal(p.remainingCount, 2, "blank items are dropped, not rendered");
  assert.equal(p.stale, false);
  assert.equal(p.staleNote, null, "a fresh record carries no staleness label");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("older than 30 minutes carries the staleness label, verbatim", () => {
  const dir = scratch();
  const now = Date.now();
  write(dir, {
    percent: 90,
    summary: "one line",
    remaining: [],
    updatedAt: new Date(now - 45 * 60_000).toISOString(),
  });
  const p = readProgress(dir, now);
  assert.equal(p.available, true);
  assert.equal(p.stale, true);
  assert.equal(p.staleNote, "last updated 45m ago");

  // Exactly at the boundary is not yet stale; one minute past it is.
  write(dir, {
    percent: 90,
    summary: "one line",
    remaining: [],
    updatedAt: new Date(now - STALE_MS).toISOString(),
  });
  assert.equal(readProgress(dir, now).stale, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an absent file makes the widget absent — never a fabricated figure", () => {
  const dir = scratch();
  const p = readProgress(dir, Date.now());
  assert.equal(p.available, false);
  assert.equal(p.reason, "no progress file");
  assert.equal(p.percent, undefined, "no percent may be invented");
  assert.equal(readProgress(null, Date.now()).available, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a malformed file makes the widget absent, each shape with its reason", () => {
  const dir = scratch();
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const cases = [
    ["{not json", /not JSON/u],
    ['"a string"', /not an object/u],
    [
      { summary: "s", remaining: [], updatedAt: iso },
      /percent is not a number/u,
    ],
    [
      { percent: "80", summary: "s", remaining: [], updatedAt: iso },
      /not a number/u,
    ],
    [
      { percent: NaN, summary: "s", remaining: [], updatedAt: iso },
      /not a number/u,
    ],
    [
      { percent: 150, summary: "s", remaining: [], updatedAt: iso },
      /out of range/u,
    ],
    [
      { percent: -1, summary: "s", remaining: [], updatedAt: iso },
      /out of range/u,
    ],
    [{ percent: 50, remaining: [], updatedAt: iso }, /summary is missing/u],
    [
      { percent: 50, summary: "   ", remaining: [], updatedAt: iso },
      /summary is missing/u,
    ],
    [{ percent: 50, summary: "s", remaining: [] }, /updatedAt is missing/u],
    [
      { percent: 50, summary: "s", remaining: [], updatedAt: "not a date" },
      /unparseable/u,
    ],
  ];
  for (const [value, reason] of cases) {
    write(dir, value);
    const p = readProgress(dir, now);
    assert.equal(p.available, false, JSON.stringify(value) + " was accepted");
    assert.match(p.reason, reason, JSON.stringify(value));
    assert.equal(p.percent, undefined, "a refused file must yield no figure");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("progress text is masked like everything else rendered", () => {
  const dir = scratch();
  const now = Date.now();
  write(dir, {
    percent: 10,
    summary:
      "gate blocked: psql postgresql://ops:" +
      SECRETS.password +
      "@db:5432/app",
    remaining: ["rotate PASSWORD=" + SECRETS.password],
    updatedAt: new Date(now).toISOString(),
  });
  const p = readProgress(dir, now);
  assert.equal(p.available, true);
  assert.ok(!p.summary.includes(SECRETS.password), p.summary);
  assert.ok(!p.remaining[0].includes(SECRETS.password), p.remaining[0]);
  fs.rmSync(dir, { recursive: true, force: true });
});
