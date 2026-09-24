# The collector contract

This is the contract between the collector (the code that reads a machine's
Claude Code and Codex transcripts, `lib/collector/`) and the console that
receives what it emits. The collector emits an allowlisted metadata projection
and nothing else; it does not upload conversations.

## What a record is

```json
{
  "v": 1,
  "device": { "id": "dev_…", "label": "Workstation" },
  "freshness": { "lastObservedAt": "2026-09-20T12:34:00.000Z", "lastSyncedAt": null, "mode": "live" },
  "backlog": { "delivered": 500, "total": 68430 },
  "records": [
    {
      "id": "64 hex characters",
      "tool": "claude-code",
      "model": "claude-opus-5",
      "sessionHash": "64 hex characters",
      "parentSessionHash": null,
      "isSubagent": false,
      "projectHash": "64 hex characters",
      "engagement": null,
      "reportingDevice": "dev_…",
      "executionOrigin": "unknown",
      "at": "2026-09-20T12:34:00.000Z",
      "fresh": 100,
      "output": 40,
      "cacheWrite": 0,
      "cacheWrite5m": 0,
      "cacheWrite1h": 0,
      "ttl": "split",
      "cacheRead": 250,
      "observed": true,
      "continuation": false,
      "measurement": {
        "provenance": "deviceReported",
        "population": { "kind": "usageEvent", "recordId": "…", "sessionHash": "…" },
        "window": { "kind": "event", "at": "2026-09-20T12:34:00.000Z" },
        "source": { "kind": "localTranscript", "tool": "claude-code" }
      }
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | HMAC-SHA256 of the tool, the transcript's session id and its own event or message id, keyed by the console's shared salt. The same transcript copied to another machine gives the same id, so it is counted once. Paths, file offsets and inodes never enter it. |
| `tool` | `claude-code` or `codex`. |
| `model` | The model id the transcript names (`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`), or `unknown`. Pricing matches it exactly. |
| `sessionHash`, `parentSessionHash` | HMAC of the session id under the shared salt (so a subagent can be matched to its parent), or `null` when no parent is recorded. |
| `isSubagent` | The transcript marks this as subagent work. |
| `projectHash` | HMAC of the project folder under a key that only the reporting machine holds, so the console, which has the shared salt, cannot test guesses of a folder path against it. |
| `engagement` | `null`, unless the reporter was run with `--share-project-names`: then the project folder's last name, reduced to `[a-z][a-z0-9-]{1,47}`. Never a path. Records spooled while the option was on are sent with `null` once it is off. |
| `reportingDevice` | The enrolled machine that sent the record; must equal the envelope's device. |
| `executionOrigin` | Always `unknown` unless a transcript names where it ran (then a salted hash). |
| `at` | Event time, rounded down to the UTC minute: the minute the API response began. Every increment of one response carries the minute of its first transcript line ([accounting.md](accounting.md) §2). |
| `fresh`, `output`, `cacheWrite`, `cacheRead` | Disjoint token classes: non-negative integers, or `null` when the tool did not report the class. Unknown is never turned into zero. |
| `cacheWrite5m`, `cacheWrite1h`, `ttl` | The cache-write split by lifetime when the tool reports it (`ttl: "split"`, and they sum to `cacheWrite`), otherwise `null` and `ttl: "unknown"`. They are parts of `cacheWrite`, not extra tokens. |
| `observed` | Always `true`. |
| `continuation` | `true` when an earlier record already counted this API message. Claude Code writes one response over several transcript lines, and each line whose usage grew becomes its own record so no token is lost; only the first counts as a message. Codex records are `false`. |
| `measurement` | A fixed descriptor derived from the fields above; anything else is refused. |

The console refuses a record that does not have exactly these keys and these
shapes (a 0.2.0 record without `continuation` is still accepted and counts as a
message). Hashes must be 64 lowercase hex characters. Unrecognised transcript
lines and fields are ignored and never forwarded.

`backlog` is optional: two counts saying how far a large upload has got (see
below). Nothing else is in it.

## How it is delivered

`POST /api/ingest` on the console's reporting port, over TLS, with
`Authorization: Bearer <device token>` and at most 500 records per request. The
reporter accepts only the certificate whose SHA-256 fingerprint was in its join
link. The device token lives in a private file (mode 600) in the reporter's
state directory; it is never printed, never put in a URL and never shown on a
screen.

The answer is a receipt of counts:

```json
{ "accepted": 1, "duplicate": 0, "expired": 0, "rejected": [] }
```

For a valid request the counts plus the rejections equal the number of records
sent. `expired` counts records outside the console's retention window. A
malformed request gets a generic 400; 401 means the machine was removed; 429
carries `Retry-After`. A duplicate is not new usage.

**Large uploads.** The reporter sends one batch at a time and moves its cursor
after every acknowledged batch, so an upload that is paced or interrupted
resumes where it stopped; a replayed batch is harmless because a known id is a
duplicate. The console accepts 600 batches a minute per machine and at most
250,000 records per machine per UTC day; past either, it answers 429 with
`Retry-After`, which the reporter honours for up to two minutes per wait. While
`backlog.delivered < backlog.total` the console shows the machine as "catching
up · N of M records" and leaves it out of "right now".

## Joining

The console makes a join link: `http://<console>:<port>/join#<code>.<fingerprint>`.
The code is 128 random bits, works once and lives at most an hour; the
fingerprint is the SHA-256 of the console's self-signed certificate. The
reporter connects over TLS, checks the fingerprint before sending anything,
and spends the code at `POST /api/join`. The console answers with the device
token, the device's id and label, the console's id, the shared salt (32 bytes,
base64url) and its retention in days. The reporter checks the exact shape of
every field before using any of it, and removes control characters from any
text before printing it.

The shared salt lets machines agree on copied transcripts. It never leaves a
machine in a report. `leave` deletes the credentials, the salt, the project key,
the labels, the spool and the cursor.

## Identity and replay

Claude Code records take the line's `uuid` as their event id, falling back to
`message.id` plus `requestId`. Codex records take the session and the event's
sequence number or timestamp. A record without intrinsic identity is not sent;
it is counted as coverage debt. The collector keeps a cursor per transcript
file and per destination, spools records before delivery so a crash can replay
but never lose one, and never makes up a new id for a retry.

## Formats read

**Claude Code.** Assistant `message.usage` carries `input_tokens`,
`output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`,
plus the cache-write split in `usage.cache_creation`. Several lines can repeat
the same `message.id` with growing usage; the collector emits per-message
increments, all dated by the response's first line, and nothing for an
identical repeat. A subagent is identified by
`isSidechain` and `agentId` within its `sessionId`.

**Codex.** The first `session_meta` identifies the session and its parent.
`token_count` events carry cumulative `total_token_usage`; successive values
become deltas, and fresh input is the input delta minus the cache-read and
cache-write deltas (null if a part is missing). A forked session's replayed
prefix, before `subagent_history_start_ordinal`, is not counted again. A
counter that goes backwards restarted from zero: when the event's own
`last_token_usage` equals the new total in every class, that total is the
event's usage (this is also how a forked child's first own request looks after
its inherited history). A fork without that boundary, and a drop that
`last_token_usage` does not explain, are reported as coverage debt rather than
guessed. The full rules are in [accounting.md](accounting.md).

## Prices

[`prices.json`](../lib/collector/prices.json) is an offline, dated table: each
row has an exact model id, the date it was checked, the vendor page it came
from, and USD per million tokens for each class, or `null` where no rate was
published. Only an exact listed model with every reported class priced gets an
estimate; anything else is unpriced, never priced at zero. The figure is a
standard-API-price estimate, not an invoice: it cannot see subscriptions,
negotiated rates, batch or fast mode, or taxes.

## What the numbers do not say

A machine that has sent nothing may be idle, off, or unable to read its logs:
the console shows when it last heard from each machine instead of a zero.
Transcript counters are what the tools wrote; they are not reconciled with the
vendor. Tokens measure usage, not productivity or value.

Tests use synthetic transcripts only. `test/hub-e2e.test.js` runs real reporter
and console processes over canary-filled transcripts and checks every request
that crosses the wire, everything the console stores and everything the
reporter keeps.
