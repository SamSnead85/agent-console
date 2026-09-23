# The collector

Reads this machine's Claude Code and Codex transcripts and emits one metadata
record per usage event: the tool, the model id, the minute it happened, the four
disjoint token classes (fresh input, output, cache write, cache read), and
hashes of the session and project. `projectRecord` in `collector.js` is the only
way a record leaves, and it copies an allowlist of fields; nothing else in a
transcript can follow it out.

The console uses it in two places:

- **the console's own machine**: `lib/hub/local.js` runs it every five seconds
  and hands the records straight to the store;
- **every other machine**: the reporter (`lib/reporter.js`) runs it every ten
  seconds and posts the records to the console over TLS, pinned to the
  console's certificate (`pinned.js`).

It can also run on its own, for inspection:

```sh
node lib/collector/collector.js --summary      # today's totals on this machine, nothing sent
```

| File | Job |
| --- | --- |
| `parsers.js` | One transcript line in, zero or more usage records out. Claude's repeated usage blocks become per-message deltas; Codex's cumulative counters become per-event deltas; copied parent history is excluded. |
| `collector.js` | Walks the transcript folders, keeps a private cursor per file, spools records before delivery so a crash can replay but never lose one, and moves its delivery cursor with every acknowledged batch. |
| `transport.js` | Posts batches of at most 500 records, requires a complete receipt for each, honours `Retry-After`, retries with bounded backoff, refuses redirects. |
| `pinned.js` | HTTPS that accepts one certificate only: the one whose fingerprint was in the join link. |
| `pricing.js`, `prices.json` | Offline list-price estimates against exact model ids. An unlisted model or an unreported token class is *unpriced*, never priced at zero. |
| `measurement.js` | The provenance each figure carries: reported by a device, or an estimate. |

The field-by-field contract is [docs/COLLECTOR-CONTRACT.md](../../docs/COLLECTOR-CONTRACT.md).
