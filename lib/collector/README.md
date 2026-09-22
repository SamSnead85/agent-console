# The collector

Reads this machine's Claude Code and Codex transcripts and emits one metadata
record per usage event: the tool, the model id, the minute it happened, the four
disjoint token classes (fresh input, output, cache write, cache read), and
salted hashes of the session and project. `projectRecord` in `collector.js` is
the only way a record leaves, and it copies an allowlist of fields — nothing else
in a transcript can follow it out.

The console uses it in two places:

- **the hub's own machine** — `lib/hub/local.js` runs it every five seconds and
  hands the records straight to the hub's store;
- **every other machine** — `agent-console join` / `report` (`lib/reporter.js`)
  runs it every ten seconds and posts the records to the hub over HTTP.

It can also run on its own, for inspection:

```sh
node lib/collector/collector.js --summary      # today's totals on this machine, nothing sent
```

What is in here:

| File | Job |
| --- | --- |
| `parsers.js` | One transcript line in, zero or more usage records out. Claude's repeated usage blocks become per-message deltas; Codex's cumulative counters become per-event deltas; copied parent history is excluded. |
| `collector.js` | Walks the transcript folders, keeps a private cursor per file, spools records before delivery so a crash can replay but never lose one, and delivers to a hub, a file or stdout. |
| `transport.js` | Posts batches of at most 500 records, requires a complete receipt before the cursor moves, retries with bounded backoff, refuses redirects. |
| `pricing.js`, `prices.json` | Offline list-price estimates against exact model ids. An unlisted model or an unreported token class is *unpriced*, never priced at zero. |
| `measurement.js` | The provenance each figure carries: device-reported, or an estimate. |

Identity is portable: a record's id is an HMAC of the tool, the session id and
the transcript's own message id, keyed by the hub's organization salt. The same
transcript copied to two machines produces the same ids, and the hub counts it
once. Paths, file offsets and inodes never enter an id.

The full field-by-field contract is [docs/COLLECTOR-CONTRACT.md](../../docs/COLLECTOR-CONTRACT.md).
This collector was written by LockedIn Labs for its own console and is published
here under the package's MIT licence; see [PROVENANCE.md](../../PROVENANCE.md).
