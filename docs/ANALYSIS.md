# Shared analysis API · version 1

Import from `@lockedinlabs/agent-console/analysis`. `ANALYSIS_VERSION` changes
when an incompatible shape or interpretation is introduced. This module has no
runtime dependencies, file access, server, or UI. Callers supply sanitized
plain data; the core never reads transcripts itself.

## `contextHealth(samples, prices, options?)`

- `samples`: one session's usage readings, each `{ at, tokens, cacheRead,
  cacheWrite, cacheWrite5m, cacheWrite1h, model }`. `at` is Unix milliseconds;
  counts are nonnegative integers; `model` is a model ID. No conversation or
  tool content is accepted.
- `prices`: `{ version, checkedOn, rows }`, where each row has `model` and
  `cacheRead`, `cacheWrite`, `cacheWrite5m`, `cacheWrite1h` rates in USD per
  million tokens. Supply verified rows only. `checkedOn` is a date string.
- `options.bloatTokens`: threshold for a heavy latest reading, default 160,000.

The result has `status` (`unknown`, `normal`, or `bloated`), `latest` tokens,
`growth` relative to the first retained reading, up to 16 count-only samples,
up to 8 possible cache `breaks`, and `priceTable` version/check date. A break
is an `idle-gap` only when the gap exceeds the previous write's known lifetime:
five minutes for a 5-minute-only write, one hour for a 1-hour-only write.
Mixed or unsplit writes produce `lifetime-unknown` after five minutes; a large
write within the known lifetime is a `possible-prefix-rewrite`. These are
signals, not proof of expiration or a rewrite. `estimatedExtraUsd` compares that write
with a hypothetical cache read at the verified rate. It is `null` when the
model has no verified price. An empty sample list returns `unknown` with null
readings and price metadata.

These are signals from counts, not proof of a changed prefix or a complete
accounting of all request costs. The caller decides how to render them.

## `agentTree(sessions)`

Accepts plain session rows: `{ sessionHash, parentSessionHash,
model, firstAt, lastAt, tokens, outcome? }`. Identifiers must be salted hashes;
times are Unix milliseconds and `tokens` is a nonnegative observed count.
Returns depth-ordered rows with a root session hash and observed duration in minutes. The console supplies first and last observed minutes within its 24-hour window, so its span and token count cover the same period. Missing parents
become roots, and malformed parent cycles cannot recurse forever. `outcome`
is `unknown` unless the caller provides the allowed `succeeded` or `failed`
enum from a real result. The current reporter records usage but no outcome,
so the console omits the outcome label instead of inventing success.
