/**
 * Merges into the default branch are read three ways on the Projects table and
 * in the Projects inspector: null is evidence the console could not read (no
 * default branch is known), 0 is an observed none, and a positive count is that
 * count. Unavailable evidence is never drawn as "no merge" (docs/PRINCIPLES.md).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { costPerOutcome } from "../lib/analysis/cost-outcome.js";
import { createGitStatsStore, gitStatsForPeriod } from "../lib/gitstats.js";

const JS = fs.readFileSync(new URL("../public/console.js", import.meta.url), "utf8");

function slice(from, to) {
  const start = JS.indexOf(from);
  const end = JS.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `console.js no longer holds ${from.trim()}`);
  return JS.slice(start, end);
}

// Run the page's own renderers with synthetic readings and plain helpers.
const helpers = {
  D: null,
  esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  fmt: (n) => String(n),
  money: (n) => "$" + n.toFixed(2),
  pct: (x) => (x === null ? "—" : Math.round(x * 100) + "%"),
  plural: (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`,
  demoStamp: () => "",
  shareBar: () => "",
  modelRows: () => "",
  // presenting is off: names pass through; a project is keyed by its hash, or its name for a hub without one
  pn: (kind, value) => value,
  doorId: (kind, id) => String(id),
  present: false,
  projectKeyOf: (x) => x.projectHash || x.name,
  hhmm: () => "",
};
const rows = vm.runInNewContext(slice("  const na = ", "  async function loadProjects(") + "\n({ projectRow, na, mergeReading: typeof mergeReading === \"function\" ? mergeReading : undefined, projCost, projMoney, projMoneyWhy })", { ...helpers });
const projectInspectBody = vm.runInNewContext(slice("  const ikv = ", "  function paintInspect(") + "\nprojectInspectBody",
  { ...helpers, na: rows.na, mergeReading: rows.mergeReading, projCost: rows.projCost, projMoney: rows.projMoney, projMoneyWhy: rows.projMoneyWhy });

const text = (html) => html.replace(/<[^>]*>/gu, "").replace(/&#39;/gu, "'").replace(/\s+/gu, " ").trim();
function mergeCells(html) {
  const cell = (src) => {
    const found = html.match(new RegExp(`<td[^>]*data-src="projects\\.costPerOutcome\\.${src}"[^>]*>([\\s\\S]*?)</td>`, "u"));
    assert.ok(found, `no ${src} cell`);
    return found[1];
  };
  return { count: cell("defaultMerges"), per: cell("perDefaultMergeUsd") };
}
function inspectorMerge(html) {
  const found = html.match(/<div class="v"[^>]*data-src="projects\.costPerOutcome\.perDefaultMergeUsd">([\s\S]*?)<\/div><div class="l">([\s\S]*?)<\/div>/u);
  assert.ok(found, "no $ / merge reading in the inspector");
  return { value: found[1], label: found[2] };
}

function project(defaultMerges, usd = 12) {
  return {
    name: "atlas-api", tokens: 1000, usd, sessions: 2, branches: ["feature"],
    repo: { name: "atlas-api", commits: 3, added: 10, removed: 2, prsMerged: 0, defaultMerges, mine: true },
    costPerOutcome: costPerOutcome({ usd, pricedMessages: 4, unpricedMessages: 0, commits: 3, defaultMerges }),
  };
}
const render = (x) => ({ row: mergeCells(rows.projectRow(x, { tokens: 1000 }, "24 h")), inspector: inspectorMerge(projectInspectBody(x, "24 h", null, [])) });

test("the Projects table and inspector tell unavailable merges from no merge and from a count", () => {
  const unread = render(project(null));
  const none = render(project(0));
  const two = render(project(2));

  // null: unavailable evidence, said in words with its reason, never zero and never "no merge".
  for (const html of [unread.row.count, unread.row.per, unread.inspector.value]) assert.doesNotMatch(text(html), /no merge|^0$|\$/u);
  for (const html of [unread.row.count, unread.row.per, unread.inspector.value]) {
    assert.match(text(html), /^no default — No default branch is known here, so merges into it could not be counted: unavailable, not zero$/u,
      "the unavailable reading carries its reason as readable text");
    assert.match(html, /title="No default branch is known here/u);
  }
  assert.equal(text(unread.inspector.label), "$ / merge · est. · merges not counted");

  // 0: an observed none — the count is 0 and the ratio has nothing to divide by.
  assert.equal(text(none.row.count), "0");
  assert.match(text(none.row.per), /^no merge — No local default-branch integration in the period/u);
  assert.match(text(none.inspector.value), /^no merge — /u);
  assert.equal(text(none.inspector.label), "$ / merge · est. · 0 merges");

  // A positive count and its ratio.
  assert.equal(text(two.row.count), "2");
  assert.equal(text(two.row.per), "$6.00 est.");
  assert.equal(text(two.inspector.value), "$6.00");
  assert.equal(text(two.inspector.label), "$ / merge · est. · 2 merges");

  // A count with no verified price is unpriced, not "no merge" and not unavailable.
  const unpriced = render(project(2, null));
  assert.equal(text(unpriced.row.count), "2");
  assert.match(text(unpriced.row.per), /^unpriced — /u);
  assert.match(text(unpriced.inspector.value), /^unpriced — /u);
});

test("a readable repository with one feature-branch commit and no known default branch shows merges unavailable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-merges-"));
  try {
    const git = (...args) => execFileSync(process.platform === "win32" ? "git" : "/usr/bin/git", args, { cwd: dir, stdio: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
    git("init", "-q", "-b", "feature");
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "feature work");

    const stats = await gitStatsForPeriod(createGitStatsStore(), [dir], Date.now() - 3_600_000, { periodKey: "1h" });
    const repo = stats.repos[0];
    assert.equal(repo.commits, 1, "the repository is readable");
    assert.equal(repo.defaultMerges, null, "no main, master or origin/HEAD: the default branch is not known");

    const x = project(repo.defaultMerges);
    x.repo = { ...x.repo, commits: repo.commits, defaultMerges: repo.defaultMerges };
    x.costPerOutcome = costPerOutcome({ usd: 12, pricedMessages: 4, unpricedMessages: 0, commits: repo.commits, defaultMerges: repo.defaultMerges });
    assert.equal(x.costPerOutcome.defaultMerges, null);
    const { row, inspector } = render(x);
    assert.doesNotMatch(text(row.per) + " | " + text(inspector.value) + " | " + text(inspector.label), /no merge/u);
    for (const html of [row.count, row.per, inspector.value]) assert.match(text(html), /^no default — .*unavailable, not zero$/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
