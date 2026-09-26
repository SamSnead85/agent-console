# Token accounting

The rules Agent Console follows to turn Claude Code and Codex transcripts into
token totals for a person, a team, a model and a session, and the conformance
suite that holds any implementation to them.

- **Spec version:** 1.1 (24 September 2026). 1.1 adds forked-subagent copies,
  Codex per-response records, drops that must be counted (§3.2), price tiers,
  exact provider model ids and the 30-day period.
- **Conformance suite:** 1.1.0, in [`test/conformance/`](../test/conformance/),
  published as `@lockedinlabs/agent-console/conformance`
- **Words:** MUST and MUST NOT are requirements; everything else explains them.

Two implementations that follow these rules produce the same numbers to the
token from the same transcripts. The suite checks that.

## 1. Sources

- **Claude Code:** the JSONL transcripts under `$CLAUDE_CONFIG_DIR/projects/`
  when that is set (each folder of a comma-separated list), otherwise
  `~/.claude/projects/`, and `~/.config/claude/projects/` where it exists:
  main sessions, `<session>/subagents/*.jsonl`, and any other `*.jsonl` below.
- **Codex:** the rollout JSONL under `$CODEX_HOME/sessions/` (otherwise
  `~/.codex/sessions/`), and under `archived_sessions/` beside it, where Codex
  moves a thread when it is archived. A thread that moves is the same thread:
  an implementation MUST NOT count what it holds again. This one knows a moved
  rollout by its first line (the thread's `session_meta`) and keeps reading it
  from where it was; record identity (§2) never includes a path, so a copy is
  counted once too.
- An explicit folder (`--claude-root`, `--codex-root`) replaces that tool's
  list. A `--home` stands for another machine's layout, so this user's
  `CLAUDE_CONFIG_DIR` and `CODEX_HOME` do not apply to it.

Transcripts are read locally and read-only. A transcript is evidence of what
the tool recorded. It is not the provider's invoice (§12).

## 2. The token event

A **token event** is one API response, with its usage split into the classes
in §3. Every total in this document is a sum of token events. Each event is
counted exactly once.

### Claude Code

- An event is one assistant message: a line with `"type": "assistant"` and a
  `message.usage` object, identified by its conversation's `sessionId` and
  `message.id`.
- **Usage** is the per-class maximum over every line that carries that message
  in that conversation, **in any file**. Claude Code writes one line per content
  block (thinking, text, tool use), each with the usage as it stood then. Output
  grows across the lines, and the input and cache classes repeat. A forked
  subagent copies its parent's context into its own `subagents/agent-*.jsonl`,
  so one message can appear in several files, with the same line uuids,
  sometimes as a mid-stream snapshot. The maximum is taken across all of them:
  an implementation MUST NOT keep it per file or per agent session.
- **Event time** is the timestamp of the first line that carries the message.
  A response that starts at 23:59:30 and finishes at 00:00:20 belongs wholly
  to 23:59.
- **Running maximum.** A reader sends a message as its per-class maximum as
  far as it has read, again each time a line grows it, marked `cumulative`
  and dated by the event time. A receiver MUST keep, for each such record id,
  the largest amount per class it has held, and add only the growth above it,
  to the minute it first held the id. A lower or equal reading adds nothing.
  Two readers that meet a message's lines, and forks' mid-stream copies of
  them, in different orders send different readings; the receiver's maximum
  is the same whichever arrives first (§8).
- A message whose `model` is `<synthetic>` is not an event. These are API-error
  and interruption placeholders, and their usage is zero.
- Record identity is `(tool, sessionId, message.id)` for a message whose lines
  carry uuids, sent as a running maximum. A line without a uuid is identified
  by `message.id` plus `requestId` and sent once, when its response stops. A
  line with neither is not counted and is reported as coverage debt. A 0.2
  collector sent a message as increments, one per line uuid whose usage grew;
  a receiver keeps accepting those, first writer wins, and a message a 0.2
  cursor had begun is finished in that form.
- The message is credited to the session of the first file that carries it.
  An implementation reads a session's own transcript before its `subagents/`
  folder, so a copied message stays with the session that made it. Which file
  that is never changes a total.

### Codex

- **Per-response records.** When a rollout writes `token_usage_record` lines,
  each is one event: one API response, identified by `(tool, thread id,
  response_id)`, with the record's own `usage` (not a running total), dated by
  the line's timestamp. Only records whose `payload.thread_id` is the rollout's
  own thread are counted; a record for another thread is history replayed into
  a fork. A repeated `response_id` adds nothing. The rollout's `token_count`
  totals then only move the baseline (§4.7).
- **A thread resumed by a Codex that writes records.** A thread that began
  before Codex wrote records is counted from its running totals, then from its
  records from its first own record on. Each record is written before its own
  running total, so switching there counts nothing twice. Only a record for
  the response the last counted running total already covered (its
  `last_token_usage` equals the record's usage) is late: it is not counted,
  and is reported as `lateUsageRecord`.
- Otherwise, an event is one `event_msg` / `token_count` line whose cumulative
  `info.total_token_usage` differs from the previous distinct cumulative total
  in the same thread.
- **Usage** is the per-class difference from the previous cumulative total.
  See §4 for restarts and forks.
- **Event time** is the line's timestamp.
- Record identity is `(tool, thread id, ordinal)`, where the thread id is the
  first `session_meta.id` in the file. A line without an ordinal falls back to
  its timestamp. If two different usages share one fallback identity, the
  implementation MUST NOT count both. It reports coverage debt instead.

## 3. Classes

Four disjoint classes. **Total = input + output + cache read + cache write.**

| Class | Claude Code | Codex |
|---|---|---|
| input (fresh, uncached) | `input_tokens` | `input_tokens − cached_input_tokens − cache_write_input_tokens` |
| output (includes thinking/reasoning) | `output_tokens` | `output_tokens` (`reasoning_output_tokens` is already inside it) |
| cache read | `cache_read_input_tokens` | `cached_input_tokens` |
| cache write | `cache_creation_input_tokens` | `cache_write_input_tokens` |

Cache write is further split by lifetime when the tool reports it:
**5-minute** (`cache_creation.ephemeral_5m_input_tokens`) and **1-hour**
(`cache_creation.ephemeral_1h_input_tokens`). They are parts of cache write
and MUST NOT be added to it again: `cacheWrite = 5m + 1h + unknown-lifetime`.
Codex reports no lifetime, so all of its writes have an unknown lifetime.
The same goes for a Claude line that has the total but no split.

A class the tool did not report is **unknown, not zero**. A sum that includes
an unknown is a floor, and it MUST be shown as one.

A lane carries its known sums as `tokensDayByClass` and the number of records
missing each class as `tokensDayUnknown`, including its subagents. An incomplete
class is a dash with its known floor explained; its total is marked `+`.

## 3.1 Counted once: deduplication

| Situation | What the logs contain | Rule |
|---|---|---|
| Streamed partial messages | Several lines with one `message.id`, output growing | One event; per-class maximum; dated by the first line (§2). |
| A re-written line | The same line uuid written twice (identical, or with smaller usage) | Adds nothing. |
| Delivery retries | A reporter re-sends records after a lost receipt, a crash, or a lost cursor | Same record ids, so first writer wins and the rest are duplicates; a running maximum adds only what it grew by (§2). |
| API retries | A failed request (a `<synthetic>` error line, no usage), then a new request with a new `message.id` | The failure is not an event. The retry that the provider answered is a new event, because it was billed. |
| Resumed Claude sessions | A new transcript file that starts with a verbatim copy of earlier lines (same `sessionId`, `message.id` and line uuids), then new lines under the new session id | The copied lines are the same events: same identity, counted once. The new lines are a new session (§7). |
| Compaction | A `system` line with `subtype: "compact_boundary"`, and a user line with `isCompactSummary: true` | Neither carries usage. The first assistant message after compaction is an ordinary event, usually with a large cache write. History before the boundary is never counted again. A summarising call is counted only if the transcript records it as an assistant message with usage. |
| Subagent sidechains | `subagents/agent-<id>.jsonl` with `isSidechain: true`, `agentId`, and the parent's `sessionId` | Each subagent is its own session, `claude-code:<sessionId>:agent:<agentId>`, a child of the orchestrator's session. Its events are counted in the child only. |
| Forked subagents | Several `agent-*.jsonl` files that each start with a copy of the parent's messages (same `message.id` and line uuids), some copies cut off mid-stream | One event per `(sessionId, message.id)` across every file, at its per-class maximum (§2). The copies add nothing, in any read order. |
| Codex per-response records | `token_usage_record` lines, one per `response_id`, beside the running total; a compaction request can appear only here | One event per own-thread `response_id` (§2, §4.7). |
| Codex forks and subagents | A child rollout that replays the parent's history before `subagent_history_start_ordinal` | The replayed events belong to the parent and are not counted in the child (§4). |
| Copies across machines | The same transcript on two machines (a synced folder, a copied home directory) | Identity comes from the transcript, under the organisation's salt, and never from a path or a device. First writer wins (§8). |

## 3.2 Nothing is dropped silently

A line that carries usage and cannot be counted by these rules is not an
event: its usage is unknown. It MUST still be **counted**, by reason, for the
machine that read it, and shown beside the figures it is missing from. A total
is then complete only when nothing was dropped. The reasons:

| Reason | What the line was |
|---|---|
| `missingTimestamp`, `missingProject`, `missingIdentity` | Usage without a readable time, project folder, or message and session identity. |
| `sidechainWithoutAgent` | A subagent line (`isSidechain: true`) without its `agentId`. |
| `noFinalUsage` | A response with no line uuid that never reached its stop (after 30 minutes). |
| `changedFinalUsage` | Usage that changed after a response without line uuids was counted. |
| `revisedDown` | A line rewritten in the same transcript with lower, non-zero usage. What was counted is not un-counted. A copy with all-zero usage, which Claude Code writes of counted lines, takes nothing away and is not a drop. |
| `missingReplayOrdinal`, `unboundedReplay`, `counterReset`, `ambiguousEventIdentity` | Codex readings §4 cannot place. |
| `lateUsageRecord` | A Codex per-response record written after the running total that already counted its response (§2). |
| `oversizedLine` | A line longer than the implementation holds (32 MiB here) whose usage could not be recovered from its first and last bytes. |
| `unreadableLine` | A complete line that looks like usage and is not valid JSON. |
| `future`, `hubFull`, `damaged` | Records the console itself could not keep: dated more than a day ahead of its clock, beyond its record limit, or damaged on its own disk. |
| `pastRetention` | A record inside the 30-day period that arrived after its day passed the console's minute retention. Without its id the daily totals cannot tell it from one already counted, so it is left out and the 30 days say they are partial (§6). |

A collector reports these counts with each delivery (the envelope's
`coverage`, [COLLECTOR-CONTRACT.md](COLLECTOR-CONTRACT.md)). They cover the
transcripts it still reads, not a time window: a transcript that is deleted,
or replaced by a new file at the same path, takes its drops with it. A recovered over-long line
(`oversizedLineRecovered`) and a cache write whose lifetime split did not add
up (`ttlConflict`, counted with an unknown lifetime) are not drops.

## 4. Codex cumulative counters

Codex writes a running total per thread. The parent thread's counter excludes
its children's usage, so each thread's own differences are added once.

1. **Unchanged total:** no event.
2. **Increase:** the event's usage is the difference in each class.
3. **Restart:** if any class goes *down*, the counter restarted from zero.
   When the event's `last_token_usage` equals the new cumulative total in every
   class, the new total is this event's usage. Any other drop could be a
   rollback to an earlier checkpoint, and the logs cannot tell the two apart.
   Such an event is not counted. It is reported as coverage debt
   (`counterReset`).
4. **Fork boundary:** events with `ordinal < subagent_history_start_ordinal`
   are inherited history. They set the baseline and are never counted. The
   child's first own request usually restarts from zero, below the inherited
   total. Rule 3 then applies, and that request MUST be counted.
5. **Fork without a boundary:** a child with `forked_from_id` and no
   `subagent_history_start_ordinal` is unmeasured coverage debt
   (`unboundedReplay`). It is never guessed with a timestamp heuristic.
6. **Rollover:** if a thread continues in a new rollout file, the thread id and
   ordinals identify the events, so replayed lines are duplicates. The first
   observation in a file with no earlier baseline counts its whole cumulative
   total. That is correct for a new thread. For a continued thread without
   ordinals, it is the known limit in §13.
7. **Per-response records first.** Where a rollout writes `token_usage_record`
   lines, they are the events (§2) and the rules above only keep the baseline.
   The running total can miss requests, such as a compaction call, that the
   per-response records show. Without them, the cumulative difference is
   authoritative: `last_token_usage` covers only the latest request, and it
   would miss a request whose `token_count` was never written. On the
   reference machine, the two agree on every increase (§12).

## 5. Model attribution

- Claude Code: the event's own `message.model`.
- Codex: the `model` of the most recent `turn_context` before the event, else
  the first `session_meta.model`, else `unknown`.
- Model ids are exact, with no aliasing and no family fallback. A session that
  switches models contributes each event to that event's model.
- An id is kept as written, including provider forms such as
  `us.anthropic.claude-opus-4-6-v1:0`, `claude-opus-4-6@20250805` or a
  `[1m]` suffix (`[A-Za-z0-9][A-Za-z0-9._:@[\]/-]{0,127}`). It is never
  turned into `unknown`; an id the price table does not list is unpriced.

## 6. Time windows and time zones

- Timestamps are instants. An offset such as `-04:00` is converted to UTC.
- An event's time is floored to the UTC minute. Windows are **half-open**
  `[from, to)` on whole UTC minutes. An event at exactly `to` belongs to the
  next window.
- "Last 24 hours" at time *t* means the 1,440 whole minutes that end with the
  minute containing *t*. An event dated after the current minute, from a
  machine whose clock runs ahead, counts once its minute arrives.
- A **calendar day** MUST name its IANA time zone. The same event can fall on
  different dates in UTC and in `America/New_York`. Team roll-ups default to UTC.
- The windows of a partition add up to the whole. For example, the two halves
  of a day add up to the day.

### Periods on screen

Every view answers for one period at a time, and the same period in each:
the Console headline and chart, Team, and Projects.

- **1 hour, 24 hours, 7 days:** that many whole minutes ending with the
  current one. The chart's bars are cut from exactly that span (1-minute,
  15-minute and 2-hour steps), so they add up to the headline.
- **30 days:** the last 30 **UTC calendar days**, today included, read from
  the console's daily totals. The console keeps a per-day rollup (by machine,
  model, project and price tier) for 400 days, long after its minute buckets
  are pruned at the retention edge. A record joins the daily totals when it
  arrives inside minute retention; one that arrives later (a reporter off for
  longer than the retention) is counted as `pastRetention` (§3.2) and the
  period is marked `partial`. The rollup keeps no sessions, so a session count
  for 30 days is unknown, not zero. A console that has not kept daily totals
  for all 30 days says from which day it has (`since`).
- A minute period longer than the minute retention (7 days with
  `--retention-days` below 7) covers only the minutes still kept: it is
  marked `partial`, with `since` the retention edge.

## 7. Individual attribution

- **The unit of attribution is the enrolled device.** A device is one OS
  account's home directory on one machine, enrolled to exactly one person or to
  no one. A person's total is the sum of the events first reported by their
  devices.
- **One person, several machines:** each machine is enrolled to the same
  person. Moving between machines, or resuming a session on another one, never
  splits a person and never counts twice (§8).
- **A shared machine:** each OS account on it is its own device, enrolled to
  its own person. One OS account that several people use cannot be split from
  its transcripts. It is enrolled to one person, or to no one (**Unassigned**).
  It is never split by guesswork.
- **An orchestrator and its subagents:** subagent sessions, Claude sidechains
  and Codex child threads belong to the person of the device that reported
  them. That is the same device and person as the orchestrator, because they
  are written into the same home directory. A session's **own** total excludes
  its children. Its **tree** total adds each descendant exactly once.
- **Copies:** a transcript copied to another machine is credited to the device
  that reported it first. If that device belongs to someone else, the credit
  follows the device. This is a documented limit. Do not sync transcript
  folders between people.

## 8. Team roll-up

A team's total is the sum of the **distinct record ids** first reported by the
devices in that team, each at the largest reading held for it when it is a
running maximum (§2). Record ids come from the transcript, under the
organisation's salt, so none of these add anything:

- the same transcript on a second machine;
- a machine that joins again under a new device id and re-reads its history;
- a reporter that lost its cursor, or retried a delivery, and re-sends.

The order of delivery can change which device, and therefore which person, is
credited with a copied event. It never changes a team total. These invariants
MUST hold for any window:
`team = Σ people (with Unassigned) = Σ devices = Σ models = Σ sessions = Σ session trees`,
and `total = input + output + cache read + cache write`.

## 9. Cost

- Cost is computed per event from a **versioned price table**: exact model ids,
  USD per million tokens for each class, the date each row was verified, and
  the vendor page it was checked against. For this package the table is
  [`lib/collector/prices.json`](../lib/collector/prices.json).
- `usd = (input × rate + output × rate + cache read × rate + cache write × rate) / 1,000,000`.
  Writes with a known lifetime use the 5-minute and 1-hour rates. Writes with
  an unknown lifetime use the table's stated assumption, and the figure says so.
- A model with no verified rate, or a class with no rate, contributes **no
  dollars**. It is reported as unpriced tokens, never as $0.
- **Price tier.** Claude Code writes `usage.speed` and `usage.service_tier`.
  Fast mode (`speed: "fast"`) is priced at the row's `fast` rates, with the
  published cache multipliers applied to the fast input rate, or at the
  standard rates where the vendor says fast requests are billed as standard.
  A model without either, and any service tier other than `standard`, is
  unpriced: never priced at the standard rate. A transcript that names no tier
  is priced at the standard rate, as the table's basis assumes.
- Unpriced messages and records are different counts: a streamed response is
  one message over several records. Each is named for what it counts.
- **By class.** Pricing is linear in tokens, so a minute bucket of one model
  and one tier splits exactly when those rates reconcile with its saved
  dollars. The console's estimate by class (`cost.byClass`) is the sum of
  those splits; a lane's `costDay` is its whole estimate. A bucket with any
  unpriced record, or saved dollars that no longer reconcile after a table
  change, cannot be split; its dollars are carried whole as `unsplitUsd`, named on the screen
  and never spread across the classes. The four classes plus `unsplitUsd`
  add up to the estimate, to the cent.
- A figure names the table it came from (its check date and digest). It is a
  standard API-list-price estimate, not an invoice. It cannot see
  subscriptions, negotiated rates, batch, data residency or taxes.

## 10. Privacy

Only these leave a machine: counts, model ids, minute timestamps, and salted
hashes of session and project identifiers. Prompts, replies, tool inputs and
outputs, file names, paths, branch names and raw session ids never do. The
conformance suite fills its synthetic logs with canaries and fails if any
canary reaches a record, a report or the screen.

## 11. Conformance

`@lockedinlabs/agent-console/conformance` exports:

| File | What it is |
|---|---|
| `manifest.json` | The organisation (synthetic salt), five devices, two people plus an unassigned account, the window, and seven deliveries in order: a first report, a second machine with a synced copy, a lost cursor, a shared box, a re-join, and a no-op. |
| (1.1 cases) | A response copied into three forked subagents, one copy a mid-stream snapshot; Codex per-response records with a compaction the running total never shows, and a fork that replays them; a line longer than the collector under test holds (64 KiB); fast mode; a Vertex-style model id and a priority service tier, both counted and unpriced; and five lines that cannot be counted, which `expected.json` lists under `dropped` by machine and reason. |
| `logs/` | Synthetic Claude Code and Codex transcripts, one tree per machine. Every rule above has at least one event that breaks a naive counter. |
| `expected.json` | Exact totals for the window, for both halves of it, and for calendar days in UTC and in `America/New_York`. Per team, person, device, model, session and session tree, with every class and the cost at the pinned rates. **These are summed from the declared ground-truth events, not produced by any counter.** |
| `collector-records.json` | Exactly what this package's collector sends at each delivery, and the `coverage` it reports with it. A receiver in another codebase replays it to check its ingestion, roll-up and drop counts against the same `expected.json`. |

`test/conformance/build.mjs` writes all of them. `node test/conformance/build.mjs --check`
confirms that the files on disk are current. `test/conformance.test.js` runs
the whole path, collector → hub store → accounting → console screen, and
requires every figure to match to the token, and each dollar figure to within
1e-9 USD.

## 12. Why these rules: what the logs showed

These are counts from one heavily used machine, taken read-only on
24 September 2026 (counts, model ids and timestamps only):

- **Claude, one UTC day:** 32,676 usage lines, 21,546 distinct messages.
  15,601 messages were written over several lines, and 14,621 of those had
  usage that changed between lines. 1,203 crossed a minute boundary, and the
  longest spread 559 seconds. That is why an event is dated by its first line.
- **Claude, 30 days:** 3,319 messages appeared in two files: a session file
  copied into another project folder, and resumed files that start with
  earlier history. Every copy kept its `sessionId` and line uuids, so identity
  dedup counts each once. One file held 8,753 re-written lines with the same
  uuid, all with unchanged usage.
- **Codex, 45 days:** 53 counters went down. In all 53 the event's
  `last_token_usage` equalled the new total. 2,144 subagent rollouts (2,097 of
  them forks) replayed their parent's history before
  `subagent_history_start_ordinal`. In none of them did the first own
  request's cumulative total exceed its own usage.
  On every increase, the cumulative difference equalled `last_token_usage`.
- **Codex, 14 days:** counting the replayed history would have added 1,057
  events and 57,112,458 tokens that belong to the parents. Before rule 4.3,
  dropping restarts lost 19 events and 2,583,216 tokens in that window.

## 13. Known limits

- If a future Claude Code version rewrote the session id or line uuids when it
  copied history, copies would no longer share an identity. The suite pins the
  observed behaviour, so a change in format shows up as a failing conformance
  run, not as silent double counting.
- A continued Codex thread whose new file lacks ordinals, and whose first
  cumulative total includes earlier usage, cannot be told apart from a new
  thread.
- Transcripts are what the tools wrote. They are not reconciled with the
  provider's usage API or invoice, and requests a tool never logged are
  invisible.
- Attribution follows the enrolled device, not the human at the keyboard
  (§7).
- Drops (§3.2) have no record identity, so a transcript copied to two machines
  is counted as dropped by each machine that reads it.
- A line rewritten with lower usage cannot un-count what was reported. Marks
  are kept for six hours after a message's first line, so a rewrite later than
  that is not recognised as one.
- Codex `compacted` lines repeat the latest per-response record; they are
  not read, because every one observed was a copy of a record already in the
  rollout.
- An over-long Claude Code line is recovered only when its usage, uuid and
  time are outside the message content, where Claude Code writes them.

The Console keeps separate lanes for each machine and session hash while
shared record IDs still count once across machines. The accounting report
retains its session-hash grouping; when it needs machine-specific session
facts, it uses the latest reporting machine. Use the Console machine view
for per-machine lane attribution.
