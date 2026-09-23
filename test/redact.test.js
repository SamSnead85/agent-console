import test from "node:test";
import assert from "node:assert/strict";

import {
  redactText,
  redactDeep,
  redactAndClip,
  MARK_RE,
} from "../lib/redact.js";
import { SECRETS } from "./fixtures/secrets.js";

const shapes = [
  [
    "Anthropic key",
    "Bash: export ANTHROPIC_KEY=" + SECRETS.anthropic + " && run",
  ],
  [
    "OpenAI key",
    "Bash: curl -H 'x-api-key: " + SECRETS.openai + "' https://api",
  ],
  [
    "GitHub classic token",
    "Bash: gh auth login --with-token <<< " + SECRETS.githubClassic,
  ],
  [
    "GitHub fine-grained token",
    "Bash: echo " + SECRETS.githubFine + " | gh auth",
  ],
  [
    "AWS access key id",
    "Bash: aws configure set aws_access_key_id " + SECRETS.aws,
  ],
  [
    "Google API key",
    "WebFetch: https://maps.example.com/api?k=" + SECRETS.google,
  ],
  ["Slack token", "Bash: SLACK_TOKEN=" + SECRETS.slack + " ./post.sh"],
  ["npm token", "Bash: npm config set //registry:_authToken=" + SECRETS.npm],
  ["Supabase key", 'Bash: ANON="' + SECRETS.supabase + '"'],
  ["Stripe key", "Bash: stripe listen --api-key " + SECRETS.stripe],
  [
    "Bearer token",
    "Bash: curl -H 'Authorization: Bearer " + SECRETS.bearer + "'",
  ],
  ["JWT", "Bash: TOKEN=" + SECRETS.jwt + " node verify.js"],
  [
    "connection string password",
    "Bash: DATABASE_URL='postgresql://ops:" +
      SECRETS.password +
      "@db.internal:5432/app'",
  ],
  [
    "PGPASSWORD assignment",
    "Bash: export PGPASSWORD=" + SECRETS.password + "; psql -h host",
  ],
  [
    "docker secret assignment",
    "Bash: docker run -e POSTGRES_PASSWORD=" +
      SECRETS.password +
      " -e POSTGRES_USER=app postgres",
  ],
  [
    "quoted secret assignment",
    'Bash: CLIENT_SECRET="' + SECRETS.password + '" ./deploy',
  ],
  ["JSON credential field", '{"apiKey": "' + SECRETS.openai + '"}'],
  ["flag form", "Bash: ./tool --api-key " + SECRETS.openai + " --verbose"],

  // ---- BARE names -------------------------------------------------------
  // Every fixture above prefixes the name (ANTHROPIC_KEY, PGPASSWORD,
  // CLIENT_SECRET, apiKey). The rule required that prefix — its name pattern
  // was a mandatory leading character followed by the suffix — so the six
  // unprefixed spellings the standing rule actually enumerates all served the
  // value in the clear, and the mutation that deletes the whole rule still died
  // on the prefixed fixtures. These are the ones that were leaking.
  ["bare PASSWORD", "Bash: export PASSWORD=" + SECRETS.password + " && deploy"],
  ["bare TOKEN", "Bash: TOKEN=" + SECRETS.password + " ./publish"],
  ["bare SECRET", "Bash: SECRET=" + SECRETS.password + " terraform apply"],
  ["bare KEY", "Bash: KEY=" + SECRETS.password + " ./sign"],
  ["bare PWD", "Bash: PWD=" + SECRETS.password + " ./legacy"],
  ["bare AUTH", "Bash: AUTH=" + SECRETS.password + " ./call"],
  ["lowercase json password", '{"password": "' + SECRETS.password + '"}'],
  [
    "password in a URL query",
    "Bash: curl 'https://api.internal/v1?password=" +
      SECRETS.password +
      "&x=1'",
  ],
  [
    "token in a URL query",
    "Bash: curl https://api.example.com/v1?token=" + SECRETS.password,
  ],
  [
    "heredoc dotenv",
    "Bash: cat > .env <<EOF\nPASSWORD=" + SECRETS.password + "\nEOF",
  ],

  // ---- shapes with no name at all ---------------------------------------
  ["curl basic auth", "Bash: curl -u ops:" + SECRETS.password + " https://x"],
  ["sshpass", "Bash: sshpass -p " + SECRETS.password + " ssh ops@host"],
  ["mysql attached password", "Bash: mysql -uroot -p" + SECRETS.password],
  [
    "docker login",
    "Bash: docker login -u ops -p " + SECRETS.password + " registry.example",
  ],
  ["netrc", "machine api.example.com login ops password " + SECRETS.password],
  [
    "URL userinfo with no user",
    "Bash: git clone https://" + SECRETS.bearer + "@github.com/x/y.git",
  ],
];

test("every credential shape is masked, and the raw value never survives", () => {
  for (const [name, input] of shapes) {
    const { text, kinds } = redactText(input);
    assert.ok(kinds.length > 0, name + ": no rule fired");
    assert.match(text, MARK_RE, name + ": no redaction mark in output");
    for (const secret of Object.values(SECRETS)) {
      if (!input.includes(secret)) continue;
      assert.ok(
        !text.includes(secret),
        name + ": the raw value survived redaction — " + text,
      );
    }
  }
});

/**
 * Every fixture above sits behind an anchor — an assignment, a flag, a URL —
 * and several rules fire on the anchor rather than on the credential's own
 * shape. That hid a real gap: the Stripe class matched `pk_` and `rk_` but not
 * `sk_`, the only one of the three that is dangerous, so a bare secret key in
 * prose passed through. Prose is exactly where these now arrive: a ledger note,
 * a session registration, a commit subject.
 */
test("a credential quoted in plain prose is masked on its own shape", () => {
  const bare = [
    ["stripe secret", SECRETS.stripe],
    ["stripe test secret", "sk" + "_test_" + "T".repeat(30)],
    ["anthropic", SECRETS.anthropic],
    ["openai", SECRETS.openai],
    ["github classic", SECRETS.githubClassic],
    ["github fine-grained", SECRETS.githubFine],
    ["aws", SECRETS.aws],
    ["google", SECRETS.google],
    ["slack", SECRETS.slack],
    ["npm", SECRETS.npm],
    ["supabase", SECRETS.supabase],
    ["jwt", SECRETS.jwt],
  ];
  for (const [name, secret] of bare) {
    const { text, kinds } = redactText("deploying now with " + secret + " ok");
    assert.ok(kinds.length > 0, name + ": no rule fired on the bare shape");
    assert.ok(
      !text.includes(secret),
      name + ": the raw value survived in plain prose — " + text,
    );
  }
});

test("the raw value is absent from the SERIALIZED payload, not just from one field", () => {
  // This is the property that actually matters: what reaches the browser is
  // JSON.stringify of a redacted snapshot, so the assertion is made against
  // exactly that string.
  const payload = {
    rows: [
      {
        project: "app",
        last: "Bash: export OPENAI_API_KEY=" + SECRETS.openai + " && psql",
        agents: [{ desc: "check " + SECRETS.githubClassic }],
        nested: { deeper: [[{ note: "jwt " + SECRETS.jwt }]] },
      },
    ],
    procs: [{ cmd: "/usr/bin/agent --token " + SECRETS.bearer }],
    ship: { repos: [{ recent: [{ subject: "fix: rotate " + SECRETS.aws }] }] },
  };
  const { value, count, kinds } = redactDeep(payload);
  const serialized = JSON.stringify(value);
  for (const key of ["openai", "githubClassic", "jwt", "bearer", "aws"]) {
    assert.ok(
      !serialized.includes(SECRETS[key]),
      key + " survived into the serialized payload",
    );
  }
  assert.ok(count >= 5, "expected at least five redactions, got " + count);
  assert.ok(Object.keys(kinds).length > 0, "no rule kinds were reported");
});

test("redaction keeps the shape and the length, so the operator sees what happened", () => {
  const { text } = redactText("Authorization: Bearer " + SECRETS.bearer);
  assert.ok(
    text.startsWith("Authorization: Bearer "),
    "the header shape was lost: " + text,
  );
  assert.match(text, /‹redacted 40›/u, "the length was not reported: " + text);
});

test("a connection string keeps its host and loses only the password", () => {
  const { text } = redactText(
    "postgresql://ops:" + SECRETS.password + "@db.internal:5432/app",
  );
  assert.ok(
    text.includes("db.internal:5432/app"),
    "the host was destroyed: " + text,
  );
  assert.ok(
    text.includes("postgresql://ops:"),
    "the user was destroyed: " + text,
  );
  assert.ok(!text.includes(SECRETS.password), "the password survived: " + text);
});

test("multi-line commands are covered, because the rendered string spans lines", () => {
  const input =
    'Bash: ANON="' +
    SECRETS.supabase +
    '"\nBASE="https://example.test"\ncurl "$BASE"';
  const { text } = redactText(input);
  assert.ok(
    !text.includes(SECRETS.supabase),
    "value survived across a newline: " + text,
  );
});

test("ordinary text is left alone", () => {
  const clean = [
    "Bash: git log --since=midnight --pretty=format:%h",
    "Read: apps/web/src/app/page.tsx",
    "Edit: docs/guide.md",
    "feat(console): add the burn band",
    "a 1.5-billion-token thread lifetime",
    "claude-opus-5",
    "/home/dev/projects/thing",
  ];
  for (const line of clean) {
    const { text, kinds } = redactText(line);
    assert.equal(text, line, "over-redacted: " + line + " -> " + text);
    assert.equal(kinds.length, 0, "a rule fired on clean text: " + line);
  }
});

test("non-strings pass through unharmed and numbers stay numbers", () => {
  const { value } = redactDeep({ n: 42, b: true, z: null, list: [1, 2, 3] });
  assert.deepEqual(value, { n: 42, b: true, z: null, list: [1, 2, 3] });
});

test("object keys are not rewritten", () => {
  const { value } = redactDeep({ PASSWORD: "x" });
  assert.deepEqual(Object.keys(value), ["PASSWORD"]);
});

test("a value is masked before it is shortened, never after", () => {
  // The connection-string rule is anchored on the trailing "@host". Cutting the
  // string first removes that anchor, the rule stops firing, and — unlike the
  // shape rules, which at worst leak a prefix — the ENTIRE password is served.
  const head = "psql postgresql://ops:" + SECRETS.password;
  // Sized so the "@" the rule is anchored on lands one character past the cut.
  const filler = "cd /srv/deploy && " + "x".repeat(140 - 18 - head.length);
  const raw = filler + head + "@db.internal:5432/app -c 'select 1'";
  assert.equal(
    raw.indexOf("@"),
    140,
    "the fixture is not positioned correctly",
  );
  const clipped = redactAndClip(raw, 140);
  assert.ok(
    !clipped.includes(SECRETS.password),
    "the password survived the clip: " + clipped,
  );
  assert.ok(clipped.length <= 140, "the clip did not bound the length");

  // The naive order, kept here as the thing that must stay refuted.
  const naive = redactText(raw.slice(0, 140)).text;
  assert.ok(
    naive.includes(SECRETS.password),
    "the fixture no longer demonstrates the defect it was written for",
  );
});

test("a secret split by a shell line-continuation is still one secret", () => {
  const raw =
    "psql postgresql://ops:" +
    SECRETS.password.slice(0, 8) +
    "\\\n      " +
    SECRETS.password.slice(8) +
    "@db:5432/app";
  const out = redactAndClip(raw, 200);
  assert.ok(
    !out.includes(SECRETS.password.slice(8)),
    "the tail of a wrapped password was served in the clear: " + out,
  );
});

test("a clip never cuts a redaction mark in half", () => {
  const raw = "run " + "y".repeat(60) + " PASSWORD=" + "z".repeat(40);
  for (let max = 60; max <= 120; max += 1) {
    const out = redactAndClip(raw, max);
    const opens = (out.match(/\u2039/gu) || []).length;
    const closes = (out.match(/\u203a/gu) || []).length;
    assert.equal(
      opens,
      closes,
      "a half-written mark at max=" + max + ": " + out,
    );
    assert.ok(!out.includes("z".repeat(40)));
  }
});

test("masking is idempotent, so a value masked at ingest is not chopped again", () => {
  const once = redactAndClip("export PASSWORD=" + SECRETS.password, 200);
  const twice = redactText(once).text;
  assert.equal(twice, once, "a second pass rewrote an already-masked value");
  const deep = redactDeep({ last: once });
  assert.equal(deep.value.last, once);
  assert.equal(
    deep.count,
    1,
    "a value masked at ingest must still be counted for the on-screen chip",
  );
});
