/**
 * Efficiency and attribution — what the spend bought.
 *
 * The question this answers is "this session spent a ton of tokens and shipped
 * two PRs; that one shipped more". It is a fair question and an easy one to
 * answer dishonestly, so three rules constrain everything below.
 *
 *  1. Two different evidence bases, never blended. CODE is attributed by git
 *     author, which is exact. TOKENS are attributed by session, which is also
 *     exact. The bridge between them — which human spent which tokens — does
 *     not exist on disk, because one person drives many sessions and git
 *     records the committer, not the operator. So it is only ever drawn where a
 *     session DECLARED an author (lib/ingest.js), and everything else is
 *     reported as unattributed rather than assigned to whoever happened to
 *     commit that afternoon.
 *
 *  2. A ratio with a zero denominator is not printed. A research session, a
 *     code review, a long debugging argument that ends in a one-line fix — all
 *     spend tokens and merge nothing. "Infinity tokens per PR" is not a finding
 *     about that session, it is a finding about division, and printing it would
 *     rank honest work last.
 *
 *  3. Nothing here is called efficient or wasteful. The columns are counts and
 *     the ratios are labelled with what they divide. The judgement is the
 *     reader's, and they have the numerator and the denominator to make it.
 */

const KLINE = 1000;

/** tokens ÷ merged PRs, or null when there is nothing to divide by. */
export function perPr(tokens, prsMerged) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  if (!Number.isFinite(prsMerged) || prsMerged <= 0) return null;
  return tokens / prsMerged;
}

/** tokens ÷ thousands of lines touched (added + removed), or null. */
export function perKLine(tokens, added, removed) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  const lines = (Number(added) || 0) + (Number(removed) || 0);
  if (lines <= 0) return null;
  return tokens / (lines / KLINE);
}

/** The session-uuid half of a "<slug>|<uuid>" history key. */
export function sessionIdOf(key) {
  const parts = String(key).split("|");
  return parts.length > 1 ? parts[1] : parts[0];
}

/**
 * @param {object} input
 * @param {object} input.code   gitStatsForPeriod() result (carries `authors`)
 * @param {Array}  input.bySession history's period-scoped session totals
 * @param {Array}  input.rows   live roster rows (for PRs opened per session)
 * @param {Array}  input.registrations lib/ingest.js sessions (for declared authors)
 * @param {object} input.period the period this covers
 */
export function buildAttribution(input) {
  const code = input.code || { authors: [], totals: {}, repos: [] };
  const bySession = input.bySession || [];
  const rows = input.rows || [];
  const registrations = input.registrations || [];
  const totals = code.totals || {};

  // session id -> declared author, from registrations that supplied both.
  const declaredAuthor = new Map();
  for (const reg of registrations) {
    if (reg.author && reg.sessionId)
      declaredAuthor.set(reg.sessionId, reg.author);
  }
  // session key -> PRs opened from that session's own transcript.
  const prsOpened = new Map();
  const projectOf = new Map();
  for (const row of rows) {
    if (row.prsOpened) prsOpened.set(row.key, row.prsOpened);
    projectOf.set(row.key, row.project);
  }

  const sessions = bySession
    .filter((s) => s.key !== "(other)")
    .map((s) => {
      const id = sessionIdOf(s.key);
      const opened = prsOpened.get(s.key) || 0;
      return {
        key: s.key,
        short: s.short,
        project: s.project || projectOf.get(s.key) || null,
        tokens: s.total,
        prsOpened: opened,
        author: declaredAuthor.get(id) || null,
        // Tokens per PR OPENED, which is the only PR figure a session can own.
        // Merged PRs belong to a repository and a branch, not to a transcript.
        tokensPerPrOpened: perPr(s.total, opened),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const tokenTotal = sessions.reduce((n, s) => n + s.tokens, 0);
  const attributedTokens = new Map();
  let unattributedTokens = 0;
  for (const s of sessions) {
    if (s.author) {
      attributedTokens.set(
        s.author,
        (attributedTokens.get(s.author) || 0) + s.tokens,
      );
    } else {
      unattributedTokens += s.tokens;
    }
  }

  const authors = (code.authors || []).map((a) => {
    const tokens = attributedTokens.has(a.name)
      ? attributedTokens.get(a.name)
      : null;
    return {
      name: a.name,
      commits: a.commits,
      added: a.added,
      removed: a.removed,
      prsMerged: a.prsMerged,
      repos: a.repos,
      tokens,
      tokensDeclared: tokens !== null,
      tokensPerPr: tokens === null ? null : perPr(tokens, a.prsMerged),
      tokensPerKLine:
        tokens === null ? null : perKLine(tokens, a.added, a.removed),
      // Always computable, and often the more useful of the two: it says how
      // much code moved per merged PR regardless of who spent what.
      linesPerPr: a.prsMerged > 0 ? (a.added + a.removed) / a.prsMerged : null,
    };
  });

  // The fleet ratio. This one IS fully measured on both sides — every token in
  // the period against every PR merged in the period — and it is the figure to
  // quote when nobody has declared an author.
  const fleet = {
    tokens: tokenTotal,
    commits: totals.commits || 0,
    prsMerged: totals.prsMerged || 0,
    added: totals.added || 0,
    removed: totals.removed || 0,
    tokensPerPr: perPr(tokenTotal, totals.prsMerged || 0),
    tokensPerKLine: perKLine(tokenTotal, totals.added, totals.removed),
  };

  const soleAuthor = authors.length === 1 ? authors[0].name : null;

  return {
    period: input.period || null,
    fleet,
    authors,
    sessions: sessions.slice(0, 20),
    sessionCount: sessions.length,
    unattributedTokens,
    attributedTokens: tokenTotal - unattributedTokens,
    soleAuthor,
    // Said in the payload rather than left to the page, so the caveat travels
    // with the numbers into any other consumer of this API.
    caveats: [
      "Code is measured from local git in this period. Tokens are measured from transcripts in this period. Nothing links them except a session that declared an author.",
      soleAuthor && unattributedTokens > 0
        ? "Every commit in this period is authored by " +
          soleAuthor +
          ", so the fleet ratio is very likely theirs — but this console will not assert it, because no session declared it."
        : null,
      "Tokens per merged PR is blank where no PR merged. Not all work produces a PR, and a blank is not a zero.",
    ].filter(Boolean),
  };
}
