/**
 * What may not appear in this public repository, as rules anyone can read.
 *
 * These rules are generic on purpose. They describe shapes (a home folder, a
 * private email address, a machine's network name, a credential) and never
 * the particular names they protect. Names that must never be published,
 * people, internal projects, customers, live in a private list that CI reads
 * from a repository secret (see denylist.js). A list of names in a public
 * file would publish exactly what it is meant to protect, and hashing it
 * would not help: anyone can hash a list of company names and compare.
 */

/*
 * Placeholder account names that documentation and tests use for a home
 * folder. Anything else after /Users/ or /home/ is treated as a real person's
 * account name.
 */
const PLACEHOLDER_ACCOUNTS = [
  "me", "you", "dev", "user", "username", "name", "someone", "somebody", "persona",
  "example", "alice", "bob", "carol", "runner", "runneradmin", "admin", "test", "shared", "x", "…", "...",
];
const placeholder = `(?:${PLACEHOLDER_ACCOUNTS.map((a) => a.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})`;

/*
 * Email domains that belong to nobody: reserved for documentation and tests
 * (RFC 2606, RFC 6761) and the no-reply addresses Git hosting and tools use.
 */
const EMAIL_OK = [
  /@example\.(?:com|org|net)$/iu,
  /@[a-z0-9.-]*\.(?:example|invalid|test|localhost)$/iu,
  /@(?:example|invalid|test|localhost)$/iu,
  /^noreply@github\.com$/iu,
  /@users\.noreply\.github\.com$/iu,
  /^noreply@anthropic\.com$/iu,
  /^git@github\.com$/iu,
  // The project's own public contact addresses.
  /^(?:hello|security|conduct|oss)@lockedinlabs\.ai$/iu,
];

/**
 * @typedef {object} Rule
 * @property {string} id      short, stable, safe to print
 * @property {string} why     one line a contributor can act on
 * @property {RegExp} pattern global; a match is a finding unless `allow` says otherwise
 * @property {(match: string) => boolean} [allow]
 */

/** @type {Rule[]} */
export const RULES = [
  {
    id: "home-path",
    why: "an absolute home folder names the account it belongs to; use ~, a relative path, or /home/dev",
    // A segment that starts with a dot (/home/.claude, /Users/.localized) is a hidden folder, never an account name.
    pattern: new RegExp(String.raw`(?:/Users/|/home/|[A-Za-z]:\\+Users\\+)(?!${placeholder}(?![A-Za-z0-9._-]))(?![<$%{\[(*.])[A-Za-z0-9._-]+`, "gu"),
  },
  {
    id: "home-path",
    why: "a tool's encoded project folder (-Users-<account>-…) names the account it belongs to",
    pattern: new RegExp(String.raw`-(?:Users|home)-(?!${placeholder}-)[A-Za-z0-9._]+-`, "gu"),
  },
  {
    id: "email",
    why: "only documentation (example.com, *.invalid) and no-reply addresses may appear",
    pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/gu,
    // A file name such as icon@2x.png has the shape of an address but is not one.
    allow: (m) => EMAIL_OK.some((ok) => ok.test(m)) || /\.(?:png|jpe?g|gif|svg|webp|js|mjs|css|json|md|ts|tgz|woff2?)$/iu.test(m),
  },
  {
    id: "hostname",
    why: "a machine's own network name identifies the machine; use a role such as Laptop or Workstation",
    // Machine names as operating systems write them (a hyphenated name on
    // .local or .lan, a tailnet name, the default name macOS gives a Mac), not
    // code such as device.local or db.internal.
    pattern: /\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\.(?:lan|local|home\.arpa)\b(?![.-][A-Za-z0-9])|\b[A-Za-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net\b|\b[A-Za-z0-9]+-(?:MacBook(?:-Pro|-Air)?|Mac-Studio|Mac-mini|iMac(?:-Pro)?)(?:-\d+)?\b/giu,
  },
  {
    id: "credential",
    why: "a live credential shape; build synthetic ones at runtime from pieces (see test/fixtures/secrets.js)",
    pattern: /\b(?:sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}|sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-kimi-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9._-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|nf[pc]_[A-Za-z0-9]{30,}|sbp_[a-f0-9]{40}|npm_[A-Za-z0-9]{36}|sk_live_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,})/gu,
    // AWS's own documentation key is public.
    allow: (m) => m === "AKIAIOSFODNN7EXAMPLE",
  },
];

/**
 * Findings in one piece of text. A match is reported by position and rule
 * only: CI logs of a public repository are public too, so the matched text is
 * never repeated, only masked.
 * @param {string} text
 * @param {Rule[]} [rules]
 * @returns {{rule: string, why: string, line: number, column: number, masked: string}[]}
 */
export function scanText(text, rules = RULES) {
  const findings = [];
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const locate = (index) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, column: index - lineStarts[lo] + 1 };
  };
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      if (rule.allow && rule.allow(m[0])) continue;
      const at = locate(m.index);
      const lineText = text.slice(lineStarts[at.line - 1], text.indexOf("\n", m.index) === -1 ? text.length : text.indexOf("\n", m.index));
      if (/public-safety:\s*allow\s+([a-z-]+)/u.exec(lineText)?.[1] === rule.id && rule.id !== "credential") continue;
      findings.push({ rule: rule.id, why: rule.why, ...at, masked: mask(m[0]) });
    }
  }
  return findings;
}

/** Enough to find it, not enough to read it: the first two characters and the length. */
export function mask(value) {
  const s = String(value);
  return s.length <= 2 ? "*".repeat(s.length) : `${s.slice(0, 2)}${"*".repeat(Math.min(12, s.length - 2))} (${s.length} chars)`;
}

/** Commit identities that are safe to publish: GitHub's no-reply forms and tool bots. */
export function isPublicIdentityEmail(email) {
  return EMAIL_OK.some((ok) => ok.test(String(email).trim()));
}
