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
      "tier": "standard",
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
| `model` | The model id the transcript names, exactly (`[A-Za-z0-9][A-Za-z0-9._:@[\]/-]{0,127}`, which includes Bedrock and Vertex forms such as `us.anthropic.claude-opus-4-6-v1:0` and `claude-opus-4-6@20250805`), or `unknown`. Pricing matches it exactly; an id the price table does not list is unpriced. |
| `sessionHash`, `parentSessionHash` | HMAC of the session id under the shared salt (so a subagent can be matched to its parent), or `null` when no parent is recorded. |
| `isSubagent` | The transcript marks this as subagent work. |
| `projectHash` | HMAC of the project folder under a key that only the reporting machine holds, so the console, which has the shared salt, cannot test guesses of a folder path against it. |
| `engagement` | `null`, unless the reporter was run with `--share-project-names`: then the project folder's last name, reduced to `[a-z][a-z0-9-]{1,47}`. Never a path. Records spooled while the option was on are sent with `null` once it is off. |
| `reportingDevice` | The enrolled machine that sent the record; must equal the envelope's device. |
| `executionOrigin` | Always `unknown` unless a transcript names where it ran (then a salted hash). |
| `at` | Event time, rounded down to the UTC minute: the minute the API response began. Every reading of one response carries the minute of its first transcript line ([accounting.md](accounting.md) §2). |
| `fresh`, `output`, `cacheWrite`, `cacheRead` | Disjoint token classes: non-negative integers, or `null` when the tool did not report the class. Unknown is never turned into zero. |
| `cacheWrite5m`, `cacheWrite1h`, `ttl` | The cache-write split by lifetime when the tool reports it (`ttl: "split"`, and they sum to `cacheWrite`), otherwise `null` and `ttl: "unknown"`. They are parts of `cacheWrite`, not extra tokens. |
| `observed` | Always `true`. |
| `continuation` | `true` when an earlier record already counted this API message, so only the first counts as a message. Codex records are `false`. |
| `cumulative` | `true` when the token classes are a Claude message's running per-class maximum, sent again under the same message-level `id` each time a line grows it. The console keeps the largest reading per class for that id and adds only the growth above it; a lower or equal reading adds nothing ([accounting.md](accounting.md) §2). `false` for Codex records and for a response sent once at its stop. |
| `tier` | The price tier the response was billed under: `standard`, `fast` (Claude Code's `usage.speed: "fast"`), `other` (a `usage.service_tier` other than `standard`), or `null` when the transcript does not say. Fast mode is priced at the table's fast rates; `other` is unpriced ([accounting.md](accounting.md) §9). |
| `measurement` | A fixed descriptor derived from the fields above; anything else is refused. |

The console refuses a record that does not have exactly these keys and these
shapes (a 0.2.0 record without `continuation` is still accepted and counts as a
message, a 0.2.1 or 0.2.2 record without `tier` is accepted and priced at
standard rates, as it always was, and a record without `cumulative` is kept
first-writer-wins). Hashes must be 64 lowercase hex characters. Unrecognised transcript
lines and fields are ignored and never forwarded.

`backlog` is optional: two counts saying how far a large upload has got (see
below). Nothing else is in it.

`coverage` is optional: what the reporter's collector could not count, as
counts by reason (`{ "unreadableLine": 1, "unboundedReplay": 2 }`). Reason
names are plain words, the values non-negative integers, at most 32 of them.
The console shows them beside the figures ([accounting.md](accounting.md) §3.2).
A 0.2 reporter does not send it, and a 0.2 console ignores it.

`share` says what this run of the reporter shares beyond its records, on
every envelope of every delivery (later batches too):

```json
"share": { "alerts": "on", "activity": "off" }
```

`"on"` means the run was started with `--share-alerts` or
`--share-tool-activity`; each is off unless given, each run. The declaration,
not the presence of a list, is what the console trusts: a later batch carries
no lists and changes nothing; `"off"` makes that machine's alerts or activity
unavailable on the console from that envelope on; a reporter older than 0.4
sends no `share` and is accepted as before, its alerts and activity shown as
unavailable, never as zero. An envelope that carries a list its own `share`
says is off is refused.

`alerts` is optional and sent only when `share.alerts` is `"on"`. It is the
alerts the reporter's own collector raised that the console has not yet
acknowledged, on the first envelope of a delivery only, and only when there is
one:

```json
"alerts": [
  { "id": "64 hex characters", "kind": "spike", "at": "2026-09-20T12:34:00.000Z",
    "sessionHash": "64 hex characters", "count": 440000, "historical": false }
]
```

| Field | Meaning |
| --- | --- |
| `id` | A salted hash naming this alert, so a resent envelope is not counted twice. |
| `kind` | `loop` (the same tool call with the same arguments, repeated), `spike` (one response far above the session's recent median), or `stall` (spending without a tool success). Nothing else. |
| `at` | The minute of the transcript line that raised it — the line's own time, not when it was read. |
| `sessionHash` | The session's hash, as on its records. |
| `count` | The alert's one number: repeats for a loop, tokens for a spike or a stall. |
| `historical` | `true` when it was raised while the reporter's first pass was reading history: the console lists it under "earlier" and never counts it as live. |

The tool's name and arguments are hashed together on the machine to tell a
repeat, and the hash stays there. At most 100.

`activity` is optional and sent only when `share.activity` is `"on"`:
contributions, each one session's tool calls counted by kind and tool results
counted as ok or error in one minute, as the reporter sealed them, that the
console has not yet acknowledged.

```json
"activity": [
  { "id": "64 hex characters", "sessionHash": "64 hex characters", "at": "2026-09-20T12:34:00.000Z",
    "calls": { "read": 3, "edit": 2, "shell": 1, "search": 0, "web": 0, "agent": 0, "mcp": 1, "other": 0 },
    "results": { "ok": 6, "error": 1 },
    "lastTool": { "kind": "edit", "at": "2026-09-20T12:34:00.000Z" } }
]
```

`id` names the contribution: an HMAC under the shared salt of the device, a
random per-state epoch, the session and the contribution's own sequence
number. A resend — an answer that was lost, a later batch that failed, a
reporter that restarted — carries the same id, and the console counts it
once. More calls in the same minute read on a later pass are a new
contribution with a new id; the console adds the two, and never keeps one
minute's maximum in place of a sum. The console keys what it has counted by
the authenticated machine as well as the id, so the same session hash, or
even the same id, on two machines is two readings.

A tool's name is mapped to its kind on the machine that read it
(`lib/collector/activity.js`): Claude Code's Read is `read`; Write, Edit and
MultiEdit are `edit`; Bash is `shell`; Grep, Glob and LS are `search`;
WebFetch and WebSearch are `web`; Task is `agent`; every MCP tool is `mcp`,
whatever its server is called; and a tool the list does not know is `other`.
Codex's shell and exec calls are `shell`, `apply_patch` is `edit`. The name
itself, its arguments, its output, a path and a server's name have no field
to go in: the console refuses an entry with any key or kind not listed here.
All eight kinds are present in every entry. At most 500 entries.

**Time.** One rule everywhere: a minute, an alert or a last tool dated more
than two minutes after the receiving clock is refused — by the console for an
envelope's entries, one by one, and by the collector for its own transcript
lines. A refused entry is counted on the machine's row (`sharing.rejectedFuture`),
never stored, so it cannot become "now" later; the rest of the envelope, and
every record in it, is accepted. The console's five-minute window has two
edges: a minute after the current one is not in it yet, and a last tool later
than now is not the last tool yet.

**Custody on the reporter.** What the console has not acknowledged is kept in
the collector's own cursor file (`extras` in `cursor-v2.json`, mode 600),
written in the same atomic step as the transcript positions it was read from:
after a crash either both are on disk, or neither is and those lines are read
again. A transcript that fails half-way, or a pass that fails before its
cursor is written, has its lines read again rather than counted twice. It
holds exactly the envelope's shapes — counts, fixed kinds, minutes and salted
hashes — at most 1,000 contributions no older than an hour and 100 alerts no
older than a day, and it drops a kind as soon as a run does not share it. It
is emptied as the console acknowledges it, and replayed with the same ids
until then. `leave` deletes it with the cursor.

**Custody on the console.** The console keeps these counts in memory: alerts
for a day, activity for a quarter of an hour. After it restarts it does not
hold what it had, and it says so rather than showing zero (below).

A console older than 0.4 ignores `share` and both lists; a 0.4 console refuses
an envelope whose `share` or lists do not have exactly these shapes.

### What the console shows for them

`GET /api/console` says how much of each window every machine's alerts and
activity cover, as a `coverage`: `{ "state", "since", "reason" }`.

| `state` | Meaning | What a screen may draw |
| --- | --- | --- |
| `complete` | Shared for the whole window. | Counts, and zero where nothing was held. |
| `partial` | Shared only since `since`. | Counts as a floor; where nothing is held, unavailable — never zero. |
| `off` | The machine's reporter says it does not share (since `since`). | Unavailable. |
| `undeclared` | An older reporter that does not say. | Unavailable. |
| `unknown` | Nothing from the machine's reporter since the console started (`since`). | Unavailable. |

`reason` is one fixed word, or `null` for `complete`: `console-restarted`
(these counts are kept in memory; before this console started at `since` they
are not held), `sharing-started` (the machine began sharing at `since`),
`sharing-off`, `reporter-undeclared`, `not-heard`. A machine that joined after
the console started has sent it everything it ever read, so its first `"on"`
has no gap.

Where it appears:

- each lane: `activityCoverage` over the five-minute window. `activity` is
  zeros only when it is `complete`, counts (a floor) when `partial`, and
  `null` when nothing is held under `partial` or the machine does not share.
  `activityShared` stays, true for `complete` and `partial`.
- each machine: `sharing: { alerts, activity, rejectedFuture }`, alerts over
  the last hour and activity over the last five minutes.
- `alertsCoverage` keeps `watched`, `unwatched` and `unwatchedDevices` (a
  machine is watched when its alerts are `complete` or `partial`) and adds
  `since` and `reason`: when a watched machine is covered for only part of
  the hour, the latest time from which every watched machine's alerts are
  held, and why — "no alert" is known only since then; `null` when the hour is
  whole. `byDevice` gives each current machine's coverage of the hour.

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
`message.id` plus `requestId`; growth on a line already counted (a copy in a
forked subagent's file, or a rewrite) gets an id of its own, derived from the
line and its usage. Codex records take the session and the response's
`response_id`, or the event's sequence number or timestamp. A record without intrinsic identity is not sent;
it is counted as coverage debt. The collector keeps a cursor per transcript
file and per destination, spools records before delivery so a crash can replay
but never lose one, and never makes up a new id for a retry.

## Formats read

**Claude Code.** Assistant `message.usage` carries `input_tokens`,
`output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`,
plus the cache-write split in `usage.cache_creation`. Several lines can repeat
the same `message.id` with growing usage; the collector sends the message's
running maximum each time a line grows it, all dated by the response's first
line, and nothing for an identical repeat. The per-message marks are shared by
every transcript the collector reads, so a forked subagent's copy of a message
sends nothing unless it is larger. `usage.speed` and `usage.service_tier` set `tier`. A line too long
to hold is read from its first and last bytes; its usage is recovered when
Claude Code wrote it where expected, and otherwise it is coverage debt. A subagent is identified by
`isSidechain` and `agentId` within its `sessionId`.

**Codex.** The first `session_meta` identifies the session and its parent.
A rollout that writes per-response `token_usage_record` lines is counted from
them, one event per `response_id` of its own thread (a record for another
thread is history replayed into a fork); its `token_count` totals then only
move the baseline.
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
negotiated rates, batch, data residency or taxes. Fast mode is priced from a
row's `fast` rates where the vendor publishes them; without them it is
unpriced. `aliases` lists the short ids a vendor publishes for a dated one
(`claude-haiku-4-5` for `claude-haiku-4-5-20251001`), each with its source and
the day it was checked; an alias prices at its dated row and nothing else is
matched loosely.

## What the numbers do not say

A machine that has sent nothing may be idle, off, or unable to read its logs:
the console shows when it last heard from each machine instead of a zero.
Transcript counters are what the tools wrote; they are not reconciled with the
vendor. Tokens measure usage, not productivity or value.

Tests use synthetic transcripts only. `test/hub-e2e.test.js` runs real reporter
and console processes over canary-filled transcripts and checks every request
that crosses the wire, everything the console stores and everything the
reporter keeps.
