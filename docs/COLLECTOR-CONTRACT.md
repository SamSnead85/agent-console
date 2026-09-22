# The collector contract

This is the contract between the collector — the code that reads a machine's
Claude Code and Codex transcripts — and a hub that receives what it emits. The
collector emits an allowlisted metadata projection and nothing else; it does
not upload conversations. It was written by LockedIn Labs for its own console
and is published here, with the collector, under this package's MIT licence.

## Record and ingestion contract

```json
{
  "v": 1,
  "device": { "id": "enrolled-device-id", "label": "Workstation" },
  "freshness": { "lastObservedAt": "2026-09-20T12:34:00.000Z", "lastSyncedAt": null, "mode": "periodic" },
  "records": [
    {
      "id": "deterministic-record-hash",
      "tool": "claude-code",
      "model": "claude-opus-4-6",
      "sessionHash": "salted-session-hash",
      "parentSessionHash": null,
      "isSubagent": false,
      "projectHash": "salted-project-hash",
      "engagement": null,
      "reportingDevice": "enrolled-device-id",
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
      "measurement": {
        "provenance": "deviceReported",
        "population": { "kind": "usageEvent", "recordId": "deterministic-record-hash", "sessionHash": "salted-session-hash" },
        "window": { "kind": "event", "at": "2026-09-20T12:34:00.000Z" },
        "source": { "kind": "localTranscript", "tool": "claude-code" }
      }
    }
  ]
}
```

Send `POST /api/ingest` to the hub over HTTPS (or plain HTTP on this machine or a private network) with `Content-Type: application/json`
and `Authorization: Bearer <device token>`. A request contains at most 500
records. The reporter keeps the device token in a private file (mode 600) in its state
directory, or reads it from `AGENT_CONSOLE_TOKEN`; it never accepts a token flag, puts it in a URL,
prints it, or writes it into any repository. A local loopback test receiver may
use HTTP without sending a real credential.

The record fields have these meanings:

| Field | Meaning |
| --- | --- |
| `id` | HMAC-SHA256 of the tool, intrinsic session identifier and intrinsic event/message identifier, keyed by the shared organization salt. The same event copied to another enrolled device has the same id. Paths, inodes, creation times and byte offsets never enter this identity. |
| `tool` | Closed emitted tool identifier: `claude-code` or `codex`. |
| `model` | Explicit bounded model identifier from tool metadata, or the parser's unknown marker. Never inferred from a conversation, filename or project. Pricing uses an exact match. |
| `sessionHash` | Organization-salted digest of the intrinsic session identifier. Never the raw identifier. |
| `parentSessionHash` | Salted digest of explicitly known parentage, otherwise `null`. Missing parentage is unknown; a similar path or timestamp does not prove a parent. |
| `isSubagent` | Tool metadata indicates subagent work. This is not evidence that every parent relationship is known. |
| `projectHash` | Salted digest of the locally recorded project identity. No raw path, basename or repository name leaves the device. |
| `engagement` | Optional label assigned only through the local `labels.json` in the reporter's state directory — hand-edited, or filled with each project folder's name when the machine's owner passes `--share-project-names`. Without that mapping it is `null`. No project-name guess or model-derived classification. A label the receiver would not accept (`[a-z][a-z0-9-]{1,47}`, or an engagement UUID) is dropped to `null` here rather than sent: an invalid label refuses the whole batch, not the one record. |
| `reportingDevice` | Enrolled device sending the record; must equal the authenticated envelope device. It does not prove where the work executed. |
| `executionOrigin` | Organization-salted digest of an explicitly recorded execution origin, otherwise the literal `unknown`. Never inferred from the reporting device, path or project. |
| `at` | Event time, normalized to an ISO UTC minute. It is not upload time. |
| `fresh`, `output`, `cacheWrite`, `cacheRead` | Disjoint token classes, each a nonnegative safe integer when reported, or `null` when unreported. Cached input must not also appear in fresh input. Unknown is never converted to zero. |
| `cacheWrite5m`, `cacheWrite1h`, `ttl` | Lifetime components of `cacheWrite`, not extra tokens. `ttl: "split"` requires both components reported and their sum equal to `cacheWrite`. Total-only usage has null components and `ttl: "unknown"`. Unknown duration is a pricing assumption, not an observed five-minute write. |
| `observed` | Legacy flag, always `true`: the collector found a local usage event. It is never an independent verification claim. |
| `measurement` | Required fixed descriptor for all token classes and the event's activity: `provenance: "deviceReported"`, population matching this `id` and `sessionHash`, event window matching minute-rounded `at`, and local-transcript source matching `tool`. Extra or conflicting fields are refused. |

Ignore unrecognized transcript lines and fields. Do not forward them. Reject
invalid values rather than coercing strings, negative values or unsafe counts
into apparently valid usage. The receiver should reject extra record fields;
this keeps a future parser change from quietly adding conversation content.

The response contract is:

```json
{
  "accepted": 1,
  "duplicate": 0,
  "rejected": [{ "id": "another-record-hash", "because": "invalid_record" }]
}
```

`accepted`, `duplicate` and the optional `expired` (outside the hub's retention window: accounted for, not stored) are record counts. Each rejection carries the
submitted record id and a closed reason code, never reflected source text.
For a valid envelope the counts plus rejection count equal the submitted batch
length. A wholly invalid envelope may instead receive a generic 400 response;
401/403 indicates invalid, expired or revoked enrollment authority; 413 is an
oversized request; 429 may carry `Retry-After`. Neither successful ingestion nor
a duplicate is evidence of billable spend.

## Enrollment and authorization

The hub's owner issues a single-use join code for a named person and machine.
The joining machine spends the code once and receives a private `enrollment.json`
bundle with shape `{ v: 1, organizationId, device: { id, label }, orgSalt }`, plus
its own device token, both stored mode 600 in the reporter's state directory. Organization and device ids
are opaque; `orgSalt` is 32 bytes encoded as base64url. The collector neither
generates its own device enrollment nor replaces a missing shared salt. The
device label follows the server's rule, 1 to 80 characters with no control
characters, so a label the server accepted at enrollment is never rejected by
the bundle that carries it.
The token grants only ingestion for that enrollment. The server derives person,
organization and permitted device from the token; the payload cannot nominate
another tenant or person. A mismatched payload device id is refused.

Enrollment, rotation and revocation need audit records and owner-visible device
standing. Store a verifier rather than a reusable token at the receiver. A
revoked device cannot submit new records; previously accepted history stays
attributed to the enrollment that sent it. The local token is supplied through
the environment by the owner. No screen ever shows it: the join code a person copies is shown masked, and the
token itself goes straight from the hub to the machine that spent the code. The collector never enrolls itself against a guessed endpoint.

The enrollment server issues `orgSalt`, identical for all devices in the same
organization. The reporter stores it in its state directory with mode
600; it must not invent a device-local replacement. Session, project and
intrinsic record identities use that shared salt. This deliberately permits
correlation within the organization. The salt does not leave the device in
ingestion payloads. Local cursor, enrollment bundle and
`labels.json` files also use mode 600 and stay out of version control. The
initial labels file is `{}`; the owner may add entries mapping an emitted
`projectHash` to a neutral engagement identifier, for example
`{ "<projectHash>": "engagement-example" }`. That label is attached when new
records enter the local spool; changing the mapping does not rewrite previously
captured or ingested records. A changed salt changes correlation and requires
an explicit migration with the receiving service. Replaying the same history
under a new salt would inflate totals. Device labels and engagement labels are deliberate user-supplied metadata;
they must not contain paths, credentials, prompts or private customer details.

Collection, export and POST refuse to proceed without enrollment. The collector
keeps `records-v2.ndjson` and `cursor-v2.json`; its state fingerprint binds the organization, device and orgSalt; changing that
bundle is refused instead of silently mixing identities.

An unenrolled `--summary` is a read-only local preview. Equality keys exist
only transiently in memory; no portable metadata records, salt, spool or
cursor are created or emitted. Its summary says `enrolled: false`,
`coverage.enrolledCount: null` and `freshness.lastSyncedAt: null`, with
`mode: "periodic"`. Observed local preview usage does not assert enrollment.

## Idempotence, delivery and restart

The receiver enforces uniqueness on `(organization, id)`, across every enrolled
device. First writer wins: every later occurrence is `duplicate`, including a
copy sent by another device with a different reporting device or local label.
It never changes the original record, attribution or usage totals. A duplicate
post updates only the reporting device's `lastSyncedAt`; it does not make old
work newly observed. Conflicting metadata can produce a separate diagnostic,
but cannot replace or count the canonical event again. Event time rounded to a
minute is not an idempotency key: several events can occur in that minute.

The portable identity inputs are the tool, session id and the transcript's own
event identifier. Claude Code prefers the line's `uuid`, falling back to
`message.id` plus `requestId`. Codex uses the session and the event's intrinsic
sequence/timestamp. Missing intrinsic identity is reported as coverage debt;
there is no path or byte-offset fallback. Raw identity inputs remain local.

The collector keeps a local cursor and only resumes after its acknowledged
position. Pending or uncertain delivery remains retryable. A timeout after the
server committed is resolved by replaying the same ids. Do not generate new ids
when retrying. Retry transient network failures, 429 and server failures with
bounded backoff; honor `Retry-After`. Authentication failures require owner
action. The collector must not follow a redirect that could send the bearer
credential to another destination.

Handle partial rejection without claiming the rejected records were ingested.
Only acknowledged accepted/duplicate records may leave the pending delivery
set; permanent rejections need an explicit local diagnostic before the cursor
can move past them. Diagnostics contain counts and closed reason codes, not
source lines or paths. Local file rotation/truncation resets the local read
cursor safely without changing intrinsic record ids. Local source identity and
byte offsets serve only resumable reads.

For local output, `--once` writes NDJSON to stdout or appends to `--out`.
Run on its own, the collector syncs once and then hourly; the reporter (`agent-console join` / `report`) delivers every ten seconds in live mode.
`--sync-now` and `--once` sync once and exit; optional `--watch` polls every two
seconds and reports live mode. Each destination has its own delivery
cursor: stdout, each resolved output filename, and each explicit POST endpoint.
Switching destinations therefore sends that destination's outstanding history.
A durable source cursor prevents a restart from rereading all source history.
`--post <url>` selects delivery to the explicit receiver. Local output is at
least once: a crash after a write but before its cursor commit can repeat an id,
so downstream consumers must deduplicate it just as the hub does.
`--summary` reports today's observed strata and pricing standing, grouped by
the machine's local calendar day and time zone even though record timestamps
are UTC. Summary reads do not consume any delivery cursor. Do not commit real
output, cursor state or transcript fixtures.

## Coverage and measurement

The unit for device counts is **devices reporting**, never seats or
workforce coverage. An enrollment token authenticates the sender; it does not
verify a locally editable transcript or its counters. The three provenance
values have separate meanings:

| Provenance | Meaning |
| --- | --- |
| `deviceReported` | A collector reported a local event or its own collection state. Every record emitted here uses this value. |
| `estimate` | A rate was applied to reported tokens. Monetary descriptors include each applied model's rate date and vendor source. |
| `verified` | A provider or authoritative ledger supplies its own record. This collector never assigns it to usage, activity or cost. A verified price-table row does not turn a cost estimate into verified spend. |

The additive record descriptor derives only from existing portable event
fields. It changes no HMAC input, record ID or first-writer attribution.
`window.kind: "event"` denotes the timestamp of a reported increment, rounded
down to its UTC minute; it does not invent an execution duration or prove the
process was active throughout that minute. Existing v2 spool entries gain the
derived descriptor in memory at delivery, without rewriting the spool or
resetting any source or sink cursor. The receiver must accept this amended
strict shape before rollout. When reading older canonical rows, it can derive
this same fixed descriptor from their fields; no replay or new ID is needed.

Every reported numeric field has this measurement context:

| Fields | Shared descriptor |
| --- | --- |
| Record token classes and event activity | That record's `measurement`: one portable usage event, event minute, local tool source. |
| Summary `records`, every `tokens.*.observed` and `tokens.*.unknownRecords` | Summary `measurement`: this device's deduplicated records, exact local calendar-day `[from,to)` and IANA time zone, reporting tools. Observed values are subtotals; an unknown-record count prevents treating them as complete. |
| Summary `coverage` counters and activity state | `coverage.measurement`: this device's collector snapshot and configured tools. Source/file counters describe the scan; parser debt covers current cursor history when enrolled or available local history in preview. It is not a daily usage total. `enrolledCount` stays null because only the receiver knows its roster. |
| Pricing `priced.records`, `priced.tokens`, `unpriced.records`, `unpriced.tokens` | The respective group's `measurement`: `deviceReported`, with that group's record population and the same requested reporting window. |
| Pricing `total`, per-record `usd` | Pricing result `measurement`: `estimate`, with population/window and exact applied rate dates and source URLs. Unknown amounts remain null. |
| Pricing `priced.usd` | `priced.usdMeasurement`: `estimate` for only the priced population. |
| Pricing `assumptions[].records` | That entry's `measurement`: only the records to which the assumption applies. |
| Programmatic collection `added` and `emitted` | Result `measurement`: this device's local collector state for that sync attempt. These are delivery/collection counts, not provider consumption. |

Descriptors are immutable objects in the local API and serialized alongside
values. A view extracting a value must carry or reference its descriptor;
it must not display a detached number. Standalone pricing calls without a
requested calendar scope use an `observedEvents` window with first/last known
event time; missing endpoints remain null. No aggregate descriptor emits record,
session or project IDs, including the unenrolled preview.

Refusal counts belong to the receiver's authoritative refusal register and use
`verified` with that ledger as their source. Missing usage records cannot supply
a refusal count, and this collector emits none.

**A missing collector is incomplete coverage, never zero.** The hub keeps an
enrolled-device roster and separate coverage/last-contact state. A device that
has sent no usage might be idle, offline, uninstalled, unable to read a source,
or missing a supported parser. The ingestion batch alone cannot distinguish
these. Enrollment and separate authenticated heartbeat state must make that distinction;
never manufacture a zero-usage event to represent a heartbeat.

Report the sources and devices observed, the reporting window, unknown model
or usage classes, unassigned engagements, skipped inherited/reset baselines,
missing intrinsic identity and missing parentage. Organization-salted hashes
let devices agree on copied sessions and events. Report copied work once using
the canonical record's first reporting device; do not infer execution origin
from that attribution.

Each enrolled device has separate `lastObservedAt` (newest canonical observed
event time) and `lastSyncedAt` (server time of its last successful post). An
empty authenticated sync can update contact without manufacturing usage. The
receiver is authoritative for successful sync times; client freshness is
metadata, not permission to replace stored history. A batch replay consisting
only of duplicates changes only that device's sync time.

| Coverage state | Meaning |
| --- | --- |
| `active` | Newest observed event is no more than five minutes old. |
| `reportedToday` | A known observation occurred during the current reporting calendar day, but is older than five minutes. |
| `stale` | Known observations predate the current reporting calendar day. |
| `neverReported` | An enrolled device has no observed record, even if an empty sync has established contact. |

State counts must use the full enrolled-device roster as their denominator and
state the calendar time zone. An active observation is not proof an agent is
currently executing. Hourly data uses `freshness.mode: "periodic"` and is never
drawn as live. A live label requires frequent delivery and current freshness;
changing a display label cannot make a periodic source live.

| Standing | What may be claimed |
| --- | --- |
| Device reported | Metadata and token counters reported by a supported local event, after its format and token semantics have been checked; not independently reconciled. |
| Estimated | Token counters multiplied by a named, dated public API rate assumption. |
| Unknown | Absent collector/source coverage, unsupported event format, missing token class, unlisted model, unrecorded parentage or unmapped engagement. |

The tool-reported counters are not independently reconciled with the provider.
Counter resets, cumulative snapshots, streamed partial responses and parent
rollups require parser-specific handling before records can be summed. Never
sum a cumulative session total beside its own increments. Parent plus subagent
usage is valid only where the source reports distinct usage, not a repeated
rollup. Keep the parser's verified format notes with this contract.

Tokens measure recorded usage. They do not measure productivity, quality,
completed work, profit or a person's performance.

## Offline pricing

[prices.json](../lib/collector/prices.json) is a separate, reviewable snapshot; runtime pricing
makes no network call. Every row carries an exact model id, verification status,
`verifiedOn`, a vendor source URL and USD per million token rates, with null
for an unverified rate. Every model id found in the local inventory has an
explicit row, including `claude-fable-5-1`; an inventory row can be unpriced.
Rates were checked on vendor pages on 20 September 2026. Source and release
reconciliation are summarised in [PROVENANCE.md](../PROVENANCE.md).

The table's basis is standard global API pricing. Anthropic cache writes use
the observed five-minute/one-hour split where present. A total without lifetime
uses the five-minute rate with an explicit assumption; the source record stays
unknown. OpenAI uses its published standard short-context rate, with the
short-context basis labeled as an assumption because the record does not carry
request context size. It does not invent Anthropic lifetime rates for OpenAI.
The record does not establish fast/batch mode, inference geography, negotiated
discounts, subscription allocation, taxes or tool-specific charges.
Consequently the result is always labeled an
**API-equivalent estimate**, never an invoice. Public rates are not evidence of
the price paid for a subscription or internal model.

`priceRecord(record, table)` returns `{status, usd, model, verifiedOn, assumptions, measurement}` and a
closed `reason` for unpriced records. Only exact listed ids with all four
reported token classes and verified rates for every nonzero component receive
`status: "estimated"`. A zero count needs no rate; a null count remains unknown.
A model alias, internal
identifier, suffix or version is not matched by prefix. An unreported counter
or unlisted model returns `status: "unpriced", usd: null`. There is no guessed
internal-model price and no zero-cost fallback. Inconsistent lifetime splits
are unpriced, never clamped. A split replaces the total's pricing contribution,
so cache writes are charged exactly once.

`aggregatePricing(records, table, scope?)` expects already deduplicated records and
returns `priced` and `unpriced` strata, each with record and token counts. The
priced stratum carries its `usd` subtotal; the unpriced stratum lists model ids.
`total` is null whenever any record is unpriced. A null token class propagates
to that stratum's aggregate for that class. `status` is `estimated` when all
records can be estimated, `partial` for mixed strata, and `unpriced` when none
can be estimated. Aggregate `assumptions` lists the labels and the number of
priced records to which each applies. Lifetime token fields remain subsets and
must not be added to the four disjoint classes. A subtotal must never be
displayed as complete spend.

## Source formats checked on this machine

The following structural fields were verified against real local files;
only field names and counter semantics are recorded here. No real transcript,
source path, session identifier or conversation text is part of these examples.

**Claude Code:** assistant `message.usage` carries `input_tokens`,
`output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`.
Several content blocks can repeat the same `message.id`, with cumulative usage
growing on later blocks. The parser emits per-message high-water increments and
emits nothing for an identical repeat. Where a line has no `uuid`, the
`message.id` plus `requestId` fallback buffers the high-water measurement until
a nonempty `stop_reason` establishes completion, then emits the final usage
once. Later changed usage under the same final identity is coverage debt,
never a second charge. The four usage classes are already
separate; cache counters are not subtracted from the reported fresh-input
counter. `usage.cache_creation.ephemeral_5m_input_tokens` and
`ephemeral_1h_input_tokens` provide the cache-write split when both are reported
consistently with the total. When `isSidechain` and `agentId` identify a child within `sessionId`,
derive the child pseudonym from session plus agent, and its parent pseudonym
from the session. `parentUuid` points to a message, not a parent session.

**Codex:** the first `session_meta.payload.id` identifies the current session;
later replayed ancestor metadata cannot replace that identity. Explicit
`payload.parent_thread_id`, then
`payload.source.subagent.thread_spawn.parent_thread_id`, supplies parentage
where available. A separate `session_id` is not treated as parent authority.
`turn_context.payload.model` supplies the model and recorded `cwd` supplies
the input to local project hashing. Neither the raw cwd nor the raw parent or
session identifier leaves the collector.

Codex `event_msg` records whose `payload.type` is `token_count` carry cumulative
`info.total_token_usage`: `input_tokens`, `cached_input_tokens`,
`cache_write_input_tokens` when reported, and `output_tokens`.
`reasoning_output_tokens` is already within output and is not added again.
Successive cumulative records become deltas. Fresh input is the input delta
minus reported cache-read and cache-write deltas; it stays null if a required
component is missing or the components are inconsistent. Some modern records explicitly report zero cache writes;
others omit that class and it remains null.

Fork metadata's `subagent_history_start_ordinal` establishes the exact replay
boundary. Every copied prefix event before that ordinal updates the cumulative
baseline but emits no measurement. Once the boundary is reached, count only
successive deltas. All 3,814 observed forks in the metadata check carried this
boundary. Missing event ordinals inside a bounded fork are coverage debt; a
fork without a boundary emits no ambiguous usage and increments
`unboundedReplay` debt. A native non-fork's first snapshot is its initial
measurement. A counter decrease resets the baseline, emits no reset delta and
increments `counterReset` debt. These omissions can undercount incomplete
source history, but cannot charge copied parent work again. Record ids use
intrinsic transcript identity under the organization salt, independently of
path and byte offset.

## Proof and limits

Use only synthetic fixtures in tests. At minimum prove disjoint token classes,
parentage where explicitly recorded, repeated cumulative snapshot handling,
stable ids on replay, unknown pricing through aggregation, lifetime-specific
cache pricing, and rejection of invalid counters. Ingest a synthetic transcript
from device A, then its byte-identical copy from B with the same orgSalt. The
second result must be `accepted: 0, duplicate: N` and every usage total must
stay unchanged. A synthetic prompt, response, path, filename, command, branch
and credential sentinel must be absent from every emitted record and normal
diagnostic. The collector never needs to copy a transcript into the repository.

Three questions determine whether the resulting numbers are decision-useful:

1. Which devices, tools and times are missing, and can copied or rolled-up
   records inflate what was observed?
2. Which token/model classes are unpriced, and which pricing assumptions differ
   from the actual purchasing agreement?
3. Who assigned engagement labels, and can the observed usage be reconciled
   with an independent source before it is used in financial reporting?
