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

## `emptyAlertState()` and `analyzeAlertEvent(state, event, options?)`

`analyzeAlertEvent` is a pure reducer. Pass the previous state and a sanitized
event `{ kind, sessionHash, at, sourceAt, callHash?, tokens? }`. Session and
call identifiers must be salted hashes made outside the core. Kinds are
`call`, `usage`, and `success`. It returns a new `state` and count-only
`signals` with `loop`, `spike`, or `stall` kinds. Defaults are five identical
calls, three times the recent session median for a response of at least 50,000
tokens, and 500,000 tokens spent for five minutes without an observed tool
success. These are configurable via `repeat`, `spikeFactor`, and
`stallMinutes`. A tool failure is not a success event. The caller owns log
tailing, hashing, notifications, and retention.
