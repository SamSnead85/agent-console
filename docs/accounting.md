# Token accounting

The rules Agent Console follows to turn Claude Code and Codex transcripts into
token totals for a person, a team, a model and a session, and the conformance
suite that holds any implementation to them.

- **Spec version:** 1.0 (24 September 2026)
- **Conformance suite:** 1.0.0, in [`test/conformance/`](../test/conformance/),
  published as `@lockedinlabs/agent-console/conformance`
- **Words:** MUST and MUST NOT are requirements; everything else explains them.

Two implementations that follow these rules produce the same numbers to the
token from the same transcripts. The suite checks that.

## 1. Sources

- **Claude Code:** the JSONL transcripts under `~/.claude/projects/`: main
  sessions, `<session>/subagents/*.jsonl`, and any other `*.jsonl` below.
- **Codex:** the rollout JSONL under `~/.codex/sessions/`.

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
  in that conversation. Claude Code writes one line per content block
  (thinking, text, tool use), each with the usage as it stood then. Output
  grows across the lines, and the input and cache classes repeat.
- **Event time** is the timestamp of the first line that carries the message.
  An implementation MAY send the usage as increments, one for each line whose
  usage grew. Those increments MUST add up to the maximum, and every one MUST
  carry the event time. A response that starts at 23:59:30 and finishes at
  00:00:20 belongs wholly to 23:59.
- A message whose `model` is `<synthetic>` is not an event. These are API-error
  and interruption placeholders, and their usage is zero.
- Record identity is `(tool, sessionId, line uuid)`, or `message.id` plus
  `requestId` when a line has no uuid. A line with neither is not counted and
  is reported as coverage debt.

### Codex

- An event is one `event_msg` / `token_count` line whose cumulative
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

## 3.1 Counted once: deduplication

| Situation | What the logs contain | Rule |
|---|---|---|
| Streamed partial messages | Several lines with one `message.id`, output growing | One event; per-class maximum; dated by the first line (§2). |
| A re-written line | The same line uuid written twice (identical, or with smaller usage) | Adds nothing. |
| Delivery retries | A reporter re-sends records after a lost receipt, a crash, or a lost cursor | Same record ids, so first writer wins and the rest are duplicates. |
| API retries | A failed request (a `<synthetic>` error line, no usage), then a new request with a new `message.id` | The failure is not an event. The retry that the provider answered is a new event, because it was billed. |
| Resumed Claude sessions | A new transcript file that starts with a verbatim copy of earlier lines (same `sessionId`, `message.id` and line uuids), then new lines under the new session id | The copied lines are the same events: same identity, counted once. The new lines are a new session (§7). |
| Compaction | A `system` line with `subtype: "compact_boundary"`, and a user line with `isCompactSummary: true` | Neither carries usage. The first assistant message after compaction is an ordinary event, usually with a large cache write. History before the boundary is never counted again. A summarising call is counted only if the transcript records it as an assistant message with usage. |
| Subagent sidechains | `subagents/agent-<id>.jsonl` with `isSidechain: true`, `agentId`, and the parent's `sessionId` | Each subagent is its own session, `claude-code:<sessionId>:agent:<agentId>`, a child of the orchestrator's session. Its events are counted in the child only. |
| Codex forks and subagents | A child rollout that replays the parent's history before `subagent_history_start_ordinal` | The replayed events belong to the parent and are not counted in the child (§4). |
| Copies across machines | The same transcript on two machines (a synced folder, a copied home directory) | Identity comes from the transcript, under the organisation's salt, and never from a path or a device. First writer wins (§8). |

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
7. **Why not `last_token_usage`:** the cumulative difference is authoritative.
   `last_token_usage` covers only the latest request, and it would miss a
   request whose `token_count` was never written. On the reference machine,
   the two agree on every increase (§12).

## 5. Model attribution

- Claude Code: the event's own `message.model`.
- Codex: the `model` of the most recent `turn_context` before the event, else
  the first `session_meta.model`, else `unknown`.
- Model ids are exact, with no aliasing and no family fallback. A session that
  switches models contributes each event to that event's model.

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
devices in that team. Record ids come from the transcript, under the
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
- A figure names the table it came from (its check date and digest). It is a
  standard API-list-price estimate, not an invoice. It cannot see
  subscriptions, negotiated rates, batch or fast mode, data residency or taxes.

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
| `logs/` | Synthetic Claude Code and Codex transcripts, one tree per machine. Every rule above has at least one event that breaks a naive counter. |
| `expected.json` | Exact totals for the window, for both halves of it, and for calendar days in UTC and in `America/New_York`. Per team, person, device, model, session and session tree, with every class and the cost at the pinned rates. **These are summed from the declared ground-truth events, not produced by any counter.** |
| `collector-records.json` | Exactly what this package's collector sends at each delivery. A receiver in another codebase replays it to check its ingestion and roll-up against the same `expected.json`. |

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
