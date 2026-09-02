import test from "node:test";
import assert from "node:assert/strict";

import {
  contentSecurityPolicy,
  corsHeaders,
  crossOriginResourcePolicy,
  originAllowed,
  parseEmbedOrigins,
} from "../lib/embed.js";
import { readConfig } from "../lib/config.js";

const ALLOWED = ["http://localhost:3000"];

test("embedding is off unless an operator names an origin", () => {
  for (const input of [undefined, null, "", false]) {
    assert.deepEqual(parseEmbedOrigins(input), { origins: [], errors: [] });
  }
  assert.deepEqual(readConfig([], {}).embed, []);
  assert.deepEqual(readConfig([], {}).embedErrors, []);

  // Off means genuinely off, in all four places the wall is built.
  assert.match(contentSecurityPolicy([]), /frame-ancestors 'none'/u);
  assert.equal(crossOriginResourcePolicy([]), "same-origin");
  assert.deepEqual(corsHeaders([], "http://localhost:3000"), {});
});

test("a wildcard is refused, and refused loudly", () => {
  const { origins, errors } = parseEmbedOrigins("*");
  assert.deepEqual(origins, []);
  assert.equal(errors.length, 1);
  // The message has to say why, because "*" is exactly what someone reaches
  // for first and the reason is not obvious from the flag's name.
  assert.match(errors[0], /private session transcripts/u);
});

test('"null" is refused: a sandboxed frame and a file:// page both send it', () => {
  for (const spelling of ["null", "NULL", "Null"]) {
    const { origins, errors } = parseEmbedOrigins(spelling);
    assert.deepEqual(origins, []);
    assert.match(errors[0], /identifies nobody/u);
  }
});

test("an origin must be a scheme and a host, and nothing else", () => {
  const bad = [
    // The likeliest typo of all. `new URL` does not reject it — it parses as
    // the scheme `localhost:` — so the message has to name the real mistake.
    ["localhost:3000", /has no scheme/u],
    ["ftp://localhost:3000", /must use http or https/u],
    ["http://localhost:3000/panel", /carries a path/u],
    ["http://localhost:3000/?x=1", /carries a path/u],
  ];
  for (const [input, expected] of bad) {
    const { origins, errors } = parseEmbedOrigins(input);
    assert.deepEqual(origins, [], input);
    assert.match(errors[0], expected, input);
  }

  // A path is refused rather than silently widened, and the message names the
  // origin the operator probably meant.
  assert.match(
    parseEmbedOrigins("http://localhost:3000/panel").errors[0],
    /"http:\/\/localhost:3000"/u,
  );
});

test("a list is parsed, trimmed and deduplicated", () => {
  const { origins, errors } = parseEmbedOrigins(
    " http://localhost:3000 , https://app.example.com,http://localhost:3000 ",
  );
  assert.deepEqual(origins, ["http://localhost:3000", "https://app.example.com"]);
  assert.deepEqual(errors, []);
});

test("one bad origin does not silently drop the good ones, or hide itself", () => {
  const { origins, errors } = parseEmbedOrigins("http://localhost:3000,*");
  assert.deepEqual(origins, ["http://localhost:3000"]);
  assert.equal(errors.length, 1);
  // The server refuses to start on any error, so a typo can never degrade
  // into "embedding is quietly narrower than you asked for".
});

test("--embed with no value is an error, not an empty allowlist", () => {
  // The upstream flag parser turns a bare `--embed` into the string "true".
  for (const bare of [true, "true"]) {
    const { origins, errors } = parseEmbedOrigins(bare);
    assert.deepEqual(origins, []);
    assert.match(errors[0], /needs at least one origin/u);
  }
});

test("matching is exact: no suffix, no port or scheme substitution", () => {
  assert.equal(originAllowed(ALLOWED, "http://localhost:3000"), true);

  for (const impostor of [
    "http://localhost:3001",
    "https://localhost:3000",
    "http://localhost",
    "http://evil.localhost:3000",
    "http://localhost:3000.evil.example",
    "http://localhost:3000/",
    "",
    null,
    undefined,
  ]) {
    assert.equal(originAllowed(ALLOWED, impostor), false, String(impostor));
  }
});

test("an allowed origin gets permission for exactly itself", () => {
  const headers = corsHeaders(ALLOWED, "http://localhost:3000");
  assert.equal(headers["access-control-allow-origin"], "http://localhost:3000");
  // Never the wildcard, even for an allowed request: the response is scoped to
  // the one origin that asked for it.
  assert.notEqual(headers["access-control-allow-origin"], "*");
  assert.equal(headers.vary, "Origin");
  assert.match(headers["access-control-allow-headers"], /X-Agent-Console/u);
  // The previous product name stays admissible, or a preflight would pass the
  // header the page is about to send and then refuse the request itself.
  assert.match(headers["access-control-allow-headers"], /X-Muster-Console/u);
});

test("a refused origin gets Vary but no permission", () => {
  const headers = corsHeaders(ALLOWED, "https://attacker.example");
  assert.equal(headers["access-control-allow-origin"], undefined);
  // Vary is still emitted. Without it a shared cache can store the refusal and
  // replay it to an allowed origin — or hand the allowed origin's response to
  // this one.
  assert.equal(headers.vary, "Origin");
});

test("naming an origin opens the frame and resource doors, and only for it", () => {
  const policy = contentSecurityPolicy(ALLOWED);
  assert.match(policy, /frame-ancestors http:\/\/localhost:3000/u);
  assert.doesNotMatch(policy, /frame-ancestors 'none'/u);
  assert.doesNotMatch(policy, /frame-ancestors \*/u);

  // Everything else in the policy is unmoved: no CDN, no font host, no beacon.
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    assert.ok(policy.includes(directive), directive);
  }

  // same-origin resource policy would block the very fetch the operator
  // authorized, so it relaxes — and the CORS allowlist stays the thing that
  // actually decides who reads the body.
  assert.equal(crossOriginResourcePolicy(ALLOWED), "cross-origin");
});

test("config reads --embed and the environment, and carries its errors", () => {
  const flagged = readConfig(["--embed", "http://localhost:3000"], {});
  assert.deepEqual(flagged.embed, ["http://localhost:3000"]);

  const env = readConfig([], { AGENT_CONSOLE_EMBED: "http://localhost:4000" });
  assert.deepEqual(env.embed, ["http://localhost:4000"]);

  // An explicit flag beats the environment rather than merging with it.
  const both = readConfig(["--embed", "http://localhost:3000"], {
    AGENT_CONSOLE_EMBED: "http://localhost:4000",
  });
  assert.deepEqual(both.embed, ["http://localhost:3000"]);

  const broken = readConfig(["--embed", "*"], {});
  assert.deepEqual(broken.embed, []);
  assert.equal(broken.embedErrors.length, 1);
});
