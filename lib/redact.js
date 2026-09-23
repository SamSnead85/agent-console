/**
 * Server-side credential redaction.
 *
 * This dashboard renders live command strings, process argv, agent task
 * descriptions, branch names and commit subjects. Those strings routinely
 * contain credentials, and the screen gets opened in meetings and on shared
 * displays. Masking therefore happens HERE, in the process that reads the
 * transcripts, before anything is serialized — never in CSS, never in the
 * browser. A value the browser never receives cannot be leaked by a screenshot,
 * a devtools panel, or a saved HAR file.
 *
 * Redaction is deliberately visible rather than silent: the shape of the secret
 * and its length survive, the value does not. Seeing that a session just passed
 * an API key on a command line is itself operationally useful.
 *
 * TWO ORDERING RULES ARE LOAD-BEARING, and both were bugs before they were
 * rules:
 *
 *  1. Redaction runs on the WHOLE string, before any truncation. A rule anchored
 *     on something to the right of the secret — the connection-string rule needs
 *     the "@host" — stops firing when the cut lands between the secret and its
 *     anchor, and the entire password is then served in the clear. Callers that
 *     shorten a string for display must use `redactAndClip`, never `.slice`.
 *
 *  2. A shell line-continuation is joined before matching, so a secret split
 *     across a wrapped line is one token again. Collapsing it to a space instead
 *     breaks the value's character class and every rule misses it.
 */

/** Rendered in place of every masked value. */
export function mark(length) {
  return "\u2039redacted " + length + "\u203a";
}

/** Matches an already-applied mark, so callers can detect/verify redaction. */
export const MARK_RE = /\u2039redacted (?:\d+|[a-z ]+)\u203a/u;
const MARK_RE_G = /\u2039redacted (?:\d+|[a-z ]+)\u203a/gu;

/**
 * Characters a bare (unquoted) secret may contain.
 *
 * U+2039 is excluded so a value that has already been masked can never be
 * captured and masked a second time. That is what makes every rule here, and
 * `redactDeep` as a whole, idempotent — which matters because a string may be
 * masked once at ingest (see `redactAndClip`) and then walked again on its way
 * out through `sendJson`.
 */
const BARE = "[^\\s\"';&|\\u2039]";

/**
 * Ordered rules. Order is load-bearing: the broad `NAME=value` assignment rule
 * runs before the narrow provider-token shapes so that a key inside an
 * assignment is masked once and cleanly, rather than masked by shape and then
 * chopped a second time by the assignment rule.
 */
const RULES = [
  {
    kind: "private-key",
    re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/gu,
    replace: () => "\u2039redacted private key\u203a",
  },
  {
    // FOO_API_KEY=..., PGPASSWORD=..., "authToken": "...", SECRET = '...'
    //
    // The leading name run is OPTIONAL. It was mandatory and one character
    // wide, which meant the suffix could never BE the whole name: PGPASSWORD=
    // and API_KEY= matched, but the bare PASSWORD=, TOKEN=, SECRET=, KEY=,
    // ?password= in a URL query and {"password": …} in a JSON body all served
    // the value in the clear. Those are the exact names the standing rule
    // enumerates, so they are the ones that must not be missed.
    kind: "assignment",
    re: new RegExp(
      "\\b((?:[A-Za-z_][A-Za-z0-9_-]*)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|CREDENTIALS|APIKEY|AUTH))" +
        '("?)\\s*([:=])\\s*(?:"([^"\\n]*)"|\'([^\'\\n]*)\'|(' +
        BARE +
        "+))",
      "giu",
    ),
    replace: (m, name, q, sep, dq, sq, bare) => {
      const value = dq ?? sq ?? bare ?? "";
      if (value.length === 0) return m;
      return name + q + sep + mark(value.length);
    },
  },
  {
    // --token XYZ, --api-key=XYZ
    kind: "flag",
    re: new RegExp(
      "(^|[\\s([{])(--?[A-Za-z0-9-]*(?:key|token|secret|password|passwd|auth)[A-Za-z0-9-]*)(\\s*[= ]\\s*)(?!-)(" +
        BARE +
        "+)",
      "gimu",
    ),
    replace: (m, prefix, flag, sep, value) =>
      prefix + flag + sep.replace(/\s+/gu, " ") + mark(value.length),
  },
  {
    // The short password flags, which carry no word a name rule could match.
    // Anchored on the tool that is known to take a password there, because a
    // bare `-p` is a port to psql and a package to npm.
    kind: "password-flag",
    re: new RegExp(
      "\\b(sshpass|mysql|mysqldump|mariadb|mongosh|redis-cli|docker\\s+login|htpasswd)\\b" +
        "([^\\n]{0,200}?\\s)(-p|--password|-a)(=|\\s*)(?!-)(" +
        BARE +
        "+)",
      "giu",
    ),
    replace: (m, tool, mid, flag, sep, secret) =>
      tool + mid + flag + sep + mark(secret.length),
  },
  {
    // curl -u user:password, --user user:password
    kind: "basic-auth-flag",
    re: new RegExp(
      "(\\s-u|\\s--user)(\\s+|=)([^\\s:\"';&|]{1,128}):(" + BARE + "+)",
      "gu",
    ),
    replace: (m, flag, sep, user, secret) =>
      flag + sep + user + ":" + mark(secret.length),
  },
  {
    // .netrc / .authinfo: machine <host> login <user> password <secret>
    kind: "netrc-password",
    re: new RegExp(
      "\\b(machine\\s+\\S+[^\\n]{0,200}?\\bpassword\\s+)(" + BARE + "+)",
      "giu",
    ),
    replace: (m, head, secret) => head + mark(secret.length),
  },
  {
    kind: "authorization-header",
    re: /\b(Authorization\s*:\s*)([A-Za-z-]+\s+)?([A-Za-z0-9._~+/=-]{8,})/giu,
    replace: (m, head, scheme, value) =>
      head + (scheme || "") + mark(value.length),
  },
  {
    kind: "bearer-token",
    re: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12,})/gu,
    replace: (m, scheme, value) => scheme + " " + mark(value.length),
  },
  {
    // scheme://user:password@host — the password only; host stays legible.
    kind: "connection-string",
    re: /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s:/@]{1,128})(:)([^\s@/]{1,512})(@)/gu,
    replace: (m, scheme, user, colon, secret, at) =>
      scheme + user + colon + mark(secret.length) + at,
  },
  {
    // scheme://TOKEN@host — userinfo with no user:password separator, which is
    // how a PAT is pasted into a clone URL. The 16-character floor keeps a
    // plain `ssh://user@host` username legible.
    kind: "url-userinfo",
    re: /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s:/@\u2039]{16,512})(@)/gu,
    replace: (m, scheme, secret, at) => scheme + mark(secret.length) + at,
  },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/gu,
    replace: (m) => "eyJ" + mark(m.length),
  },
  {
    kind: "anthropic-openai-key",
    re: /\bsk-(?:ant-)?(?:proj-)?(?:api\d{2}-)?[A-Za-z0-9_-]{16,}/gu,
    replace: (m) =>
      m.slice(0, m.startsWith("sk-ant-") ? 7 : 3) + mark(m.length),
  },
  {
    kind: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/gu,
    replace: (m) =>
      m.slice(0, m.startsWith("github_pat_") ? 11 : 4) + mark(m.length),
  },
  {
    kind: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{12,}/gu,
    replace: (m) => m.slice(0, 4) + mark(m.length),
  },
  {
    kind: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{20,}/gu,
    replace: (m) => "AIza" + mark(m.length),
  },
  {
    kind: "slack-token",
    re: /\bxox[abprse]-[A-Za-z0-9-]{10,}/gu,
    replace: (m) => m.slice(0, 5) + mark(m.length),
  },
  {
    kind: "npm-token",
    re: /\bnpm_[A-Za-z0-9]{20,}/gu,
    replace: () => "npm_" + mark(36),
  },
  {
    // This console's own device tokens. None should ever reach a page — the
    // hub keeps only verifiers — so this is the net under that promise.
    kind: "agent-console-token",
    re: /\bacd_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu,
    replace: () => "acd_" + mark(43),
  },
  {
    kind: "supabase-key",
    re: /\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{10,}/gu,
    replace: (m) => m.slice(0, m.indexOf("_", 3) + 1) + mark(m.length),
  },
  {
    kind: "stripe-key",
    // `sk_` — the SECRET key, and the only one of the three that is dangerous —
    // was missing from this class. The suite did not notice because its fixture
    // sits behind `--api-key`, and a different rule fired on that anchor; a bare
    // `sk_live_…` in prose (a ledger note, a session registration, a commit
    // subject) passed through unmasked. `sk-ant-`/`sk-proj-` are hyphenated and
    // are matched by their own rules, so there is no overlap here.
    re: /\b[rps]k_(?:live|test)_[A-Za-z0-9]{16,}/gu,
    replace: (m) => m.slice(0, m.lastIndexOf("_") + 1) + mark(m.length),
  },
];

export const RULE_KINDS = RULES.map((r) => r.kind);

/**
 * Mask every credential shape in one string.
 * Returns the masked text and the kinds that fired, so the UI can show a live
 * "N redacted" counter instead of hiding the fact that anything happened.
 */
export function redactText(input) {
  if (typeof input !== "string" || input.length === 0) {
    return { text: input, kinds: [] };
  }
  let text = input;
  const kinds = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (!rule.re.test(text)) continue;
    rule.re.lastIndex = 0;
    let fired = 0;
    text = text.replace(rule.re, (...args) => {
      const out = rule.replace(...args);
      if (out !== args[0]) fired += 1;
      return out;
    });
    for (let i = 0; i < fired; i += 1) kinds.push(rule.kind);
  }
  return { text, kinds };
}

/** How many already-masked values a string carries. */
export function countMarks(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  MARK_RE_G.lastIndex = 0;
  const found = text.match(MARK_RE_G);
  return found ? found.length : 0;
}

/**
 * Join shell line-continuations so a value split across a wrapped line is one
 * token again. Collapsing the break to a space instead — which is what a naive
 * whitespace normalisation does — puts a space inside the secret and every rule
 * stops matching it.
 */
function joinContinuations(text) {
  return text.replace(/\\\r?\n[ \t]*/gu, "");
}

/**
 * Redact a string, then shorten it for display — in that order.
 *
 * This is the ONLY sanctioned way to shorten a transcript-derived string. The
 * cut is moved back to the start of a mask if it would land inside one, so a
 * mark is never served half-written.
 *
 * @param {string} input raw text
 * @param {number} max   maximum characters of the masked result
 * @param {string} [ellipsis] appended when the result was actually cut
 */
export function redactAndClip(input, max, ellipsis) {
  if (typeof input !== "string" || input.length === 0) return input;
  const { text } = redactText(joinContinuations(input));
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= max) return collapsed;

  let cut = max;
  // Never cut inside "‹redacted N›": the fragment would read like content.
  const open = collapsed.lastIndexOf("\u2039", cut);
  if (open !== -1) {
    const close = collapsed.indexOf("\u203a", open);
    if (close === -1 || close >= cut) cut = open;
  }
  return collapsed.slice(0, cut) + (ellipsis || "");
}

/**
 * Walk any JSON-serializable value and mask every string in it.
 *
 * Applied to the whole snapshot immediately before JSON.stringify, so a field
 * added later to the payload is covered without anyone remembering to opt in.
 * Object KEYS are not rewritten: they are this program's own fixed schema names
 * and never carry user data.
 *
 * The counter reports how many masked values are in the SERVED payload, not how
 * many this particular pass produced — a value masked earlier, at ingest, is
 * still on the operator's screen and still belongs in the "N redacted" chip.
 */
export function redactDeep(value, counter) {
  const state = counter || { count: 0, kinds: Object.create(null) };
  const walk = (node) => {
    if (typeof node === "string") {
      const already = countMarks(node);
      const { text, kinds } = redactText(node);
      for (const k of kinds) {
        state.count += 1;
        state.kinds[k] = (state.kinds[k] || 0) + 1;
      }
      if (already > 0) {
        state.count += already;
        state.kinds["masked-at-ingest"] =
          (state.kinds["masked-at-ingest"] || 0) + already;
      }
      return text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out = {};
      for (const key of Object.keys(node)) out[key] = walk(node[key]);
      return out;
    }
    return node;
  };
  const redacted = walk(value);
  return { value: redacted, count: state.count, kinds: state.kinds };
}
