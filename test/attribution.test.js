import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAttribution,
  perKLine,
  perPr,
  sessionIdOf,
} from "../lib/attribution.js";
import { parseNumstat } from "../lib/gitstats.js";

const REC = "";
const SEP = "";

/**
 * The single most dangerous number on this panel. A session that merged nothing
 * has an undefined ratio, not an infinite one, and printing Infinity would rank
 * honest research work last on a screen labelled "effort".
 */
test("a ratio with a zero denominator is null, never Infinity and never zero", () => {
  assert.equal(perPr(1_000_000, 0), null);
  assert.equal(perPr(1_000_000, null), null);
  assert.equal(perPr(0, 4), null);
  assert.equal(perPr(1_000_000, 4), 250_000);

  assert.equal(perKLine(1_000_000, 0, 0), null);
  assert.equal(perKLine(0, 100, 100), null);
  assert.equal(perKLine(1_000_000, 500, 500), 1_000_000);
});

test("a session key splits into its project slug and its session id", () => {
  assert.equal(sessionIdOf("-Users-me-App|abc-123"), "abc-123");
  assert.equal(sessionIdOf("bare"), "bare");
});

test("numstat attributes commits, lines and PRs to their author", () => {
  const at = Math.floor(Date.now() / 1000);
  const raw =
    REC +
    at +
    SEP +
    "feat: a (#7)" +
    SEP +
    "Ada\n\n3\t1\ta.txt\n" +
    REC +
    at +
    SEP +
    "chore: b" +
    SEP +
    "Ada\n\n10\t2\tb.txt\n" +
    REC +
    at +
    SEP +
    "fix: c (#9)" +
    SEP +
    "Grace\n\n1\t1\tc.txt\n";
  const stats = parseNumstat(raw, null);
  assert.equal(stats.commits, 3);
  const ada = stats.authors.get("Ada");
  assert.equal(ada.commits, 2);
  assert.equal(ada.added, 13);
  assert.equal(ada.removed, 3);
  assert.deepEqual(Array.from(ada.prs), [7]);
  const grace = stats.authors.get("Grace");
  assert.equal(grace.commits, 1);
  assert.deepEqual(Array.from(grace.prs), [9]);
});

/**
 * The author field was appended LAST rather than inserted second so that the
 * pre-existing two-field framing keeps parsing, and so that a subject
 * containing a unit separator cannot shift the author into the PR position.
 */
test("a log framed without an author still parses, under one unknown author", () => {
  const at = Math.floor(Date.now() / 1000);
  const raw = REC + at + SEP + "feat: a (#7)\n\n3\t1\ta.txt\n";
  const stats = parseNumstat(raw, null);
  assert.equal(stats.commits, 1);
  assert.deepEqual(Array.from(stats.prs), [7]);
  assert.equal(stats.authors.get("unknown").commits, 1);
});

function attribution(over) {
  return buildAttribution({
    code: {
      authors: [
        {
          name: "Ada",
          commits: 10,
          added: 4000,
          removed: 1000,
          prsMerged: 4,
          repos: ["app"],
        },
      ],
      totals: { commits: 10, prsMerged: 4, added: 4000, removed: 1000 },
      repos: [],
    },
    bySession: [
      { key: "slug|s1", short: "s1", project: "app", total: 8_000_000 },
      { key: "slug|s2", short: "s2", project: "app", total: 2_000_000 },
    ],
    rows: [
      { key: "slug|s1", project: "app", prsOpened: 2 },
      { key: "slug|s2", project: "app", prsOpened: 0 },
    ],
    registrations: [],
    period: { id: "24h", label: "last 24 hours" },
    ...over,
  });
}

/**
 * Git records the committer, not the operator, and one human drives many
 * sessions. Assigning the fleet's whole token spend to whoever happened to
 * commit is a guess, and a guess in this column is the difference between a
 * measurement and an accusation.
 */
test("token spend is not attributed to an author who never declared it", () => {
  const a = attribution();
  assert.equal(a.authors[0].tokens, null);
  assert.equal(a.authors[0].tokensDeclared, false);
  assert.equal(a.authors[0].tokensPerPr, null);
  assert.equal(a.unattributedTokens, 10_000_000);
  assert.equal(a.attributedTokens, 0);
  assert.equal(a.soleAuthor, "Ada");
  assert.ok(
    a.caveats.some((c) => /will not assert it/u.test(c)),
    "the sole-author hint was not stated as a hint",
  );
});

test("a session that declared an author has its tokens attributed exactly", () => {
  const a = attribution({
    registrations: [{ sessionId: "s1", author: "Ada" }],
  });
  assert.equal(a.authors[0].tokens, 8_000_000);
  assert.equal(a.authors[0].tokensDeclared, true);
  assert.equal(a.authors[0].tokensPerPr, 2_000_000);
  assert.equal(a.authors[0].tokensPerKLine, 1_600_000);
  assert.equal(
    a.unattributedTokens,
    2_000_000,
    "the undeclared session was swept up",
  );
  assert.equal(a.attributedTokens, 8_000_000);
});

/**
 * The join is the session id, and nothing else. A registration that names an
 * author but no session cannot say WHICH tokens are that author's, so it must
 * attribute none of them — otherwise one declaration anywhere on the machine
 * silently claims the fleet's entire spend for whoever wrote it.
 */
test("an author declared without a session id attributes nothing", () => {
  const a = attribution({
    registrations: [{ author: "Ada" }, { sessionId: null, author: "Grace" }],
  });
  assert.equal(
    a.authors[0].tokens,
    null,
    "an authorless declaration was used to attribute the whole fleet's spend",
  );
  assert.equal(a.unattributedTokens, 10_000_000);
  assert.equal(a.attributedTokens, 0);
});

/**
 * Both sides of the fleet ratio are measured over the same period, so it is the
 * figure to quote when nobody has declared an author.
 */
test("the fleet ratio is measured on both sides", () => {
  const a = attribution();
  assert.equal(a.fleet.tokens, 10_000_000);
  assert.equal(a.fleet.prsMerged, 4);
  assert.equal(a.fleet.tokensPerPr, 2_500_000);
  assert.equal(a.fleet.tokensPerKLine, 2_000_000);
});

test("a session's own PR figure is the PRs it opened, and a zero yields no ratio", () => {
  const a = attribution();
  const [first, second] = a.sessions;
  assert.equal(first.prsOpened, 2);
  assert.equal(first.tokensPerPrOpened, 4_000_000);
  assert.equal(second.prsOpened, 0);
  assert.equal(
    second.tokensPerPrOpened,
    null,
    "a session that opened no PR was given a ratio",
  );
});

test("the aggregate row the history panel appends is never treated as a session", () => {
  const a = attribution({
    bySession: [
      { key: "slug|s1", short: "s1", project: "app", total: 8_000_000 },
      {
        key: "(other)",
        short: "",
        project: "3 more sessions",
        total: 5_000_000,
      },
    ],
  });
  assert.equal(a.sessionCount, 1);
  assert.equal(a.fleet.tokens, 8_000_000);
});

test("a period with no commits produces no ratios rather than zeroes", () => {
  const a = attribution({
    code: {
      authors: [],
      totals: { commits: 0, prsMerged: 0, added: 0, removed: 0 },
      repos: [],
    },
  });
  assert.deepEqual(a.authors, []);
  assert.equal(a.fleet.tokensPerPr, null);
  assert.equal(a.fleet.tokensPerKLine, null);
});
