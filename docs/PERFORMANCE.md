# Performance

Agent Console reads the history your agents already wrote, and then keeps
reading as they write more. The rule it keeps is simple. **The first read
costs about one read of the history. After that, a pass costs what changed,
not what exists.** A console left open all day must not burn a core or wear
out a disk because the history behind it is long.

## How it is measured

Everything here runs on synthetic history that no one wrote, made by
[`bench/generate.mjs`](../bench/generate.mjs). The generator follows the
tools' own shapes:

- a Claude Code response streamed over several lines that share a message id
  and grow in usage;
- subagent sidechain files;
- tool output of a few kilobytes, with a long tail;
- Codex rollouts with cumulative token counts and forked child threads.

Every file's modification time is its last line's time, as on a real disk.
The same arguments always produce the same bytes.

| Scenario | History |
| --- | --- |
| One heavy month | 1,000,268 lines, 1.87 GB, 240 sessions and 254 subagent transcripts over 30 days (`--lines 1000000 --sessions 240 --days 30`) |
| A team of ten | 10 machines × 80,000 lines, 1.44 GB, 600 sessions over 8 days (`--homes 10 --lines 800000 --sessions 60 --days 8`) |

```sh
node bench/generate.mjs --out /tmp/ac-bench --lines 1000000 --sessions 240 --days 30
node bench/run.mjs cold --home /tmp/ac-bench/home-1 --retention-days 30
node bench/generate.mjs --out /tmp/ac-team --lines 800000 --sessions 60 --days 8 --homes 10
node bench/run.mjs team --homes /tmp/ac-team
node --expose-gc bench/check.mjs          # the budget CI enforces
```

`bench/run.mjs` drives real processes: a hub, and in the team case ten
reporters that join by link. It samples memory and CPU from the operating
system.

## Budgets

**Held by CI on every push** (`Performance budget`, `bench/check.mjs`). These
are counts, not times, so a slow or fast runner cannot make them pass or
fail. They run at 20,000 and 100,000 lines.

| What | Budget | Measured |
| --- | --- | --- |
| First read: bytes read per byte of history | ≤ 1.35 | 1.27 |
| First read: writes per 1,000 records | ≤ 2 | 1.2–1.7 |
| First read: JSON parses per transcript line | ≤ 1.15 | 0.98–1.06 |
| Idle pass: bytes read | ≤ 128 KB | 84 KB |
| Idle pass: bytes written | ≤ 1 KB | 16 B |
| Idle pass: files opened | ≤ 20 | 9 |
| Idle pass at 100,000 lines vs 20,000 lines (bytes read) | ≤ 1.5× | 0.97× |
| Five new lines: bytes read / written | ≤ 256 KB / 384 KB | 93 KB / 175 KB |
| Cursor size | ≤ 256 KB | 84 KB |
| Console answer for one machine | ≤ 64 KB | 15–19 KB |
| Restart: store load time ÷ bare JSON.parse time of the same records | ≤ 6.5 | 4.3–4.8 |

The last row is a ratio of two timings taken back to back in one process,
each the best of three. That makes it hold across machines. It is there to
catch per-record work creeping into the store.

**Held by review, measured with `bench/run.mjs`.** These depend on the
machine. The figures below are from a 32-core Apple silicon desktop on
Node 22.

| What | Budget |
| --- | --- |
| First start to first paint | ≤ 1 s |
| The console's answer during a first read | ≤ 500 ms |
| First read of one heavy month (1M lines) | ≤ 30 s |
| Peak memory during that first read | ≤ 700 MB |
| Idle CPU, one heavy month | ≤ 5% of a core |
| A new response visible on the console | ≤ one pass interval + 1 s |
| Restart on a heavy month, first paint | ≤ 3 s |
| Hub CPU, ten reporters, steady | ≤ 2% of a core |
| Console answer, ten machines | ≤ 100 ms, ≤ 160 KB |
| Frame time, ten machines, 80 lanes | p99 ≤ 16.7 ms, no long tasks |

## Before and after (24 September 2026)

**One heavy month, a hub reading its own machine** (`bench/run.mjs cold`, retention 30 days):

| | Before | After |
| --- | --- | --- |
| First paint | 135 ms | 148 ms |
| First read complete | 39.2 s | 17.9 s |
| Worst console answer during the first read | 3,573 ms | 66 ms |
| Peak memory | 1,463 MB | 512 MB |
| CPU for the first read | 39.2 s | 16.8 s |
| A new response visible | 6.3–6.9 s | 4.8–5.6 s |
| Idle CPU | 24.1% of a core | 1.7% of a core |
| Restart: first paint / ready | 4.2 s / 6.5 s | 2.6 s / 3.2 s |

**The collector's pass, counted** (100,000 lines, `bench/check.mjs`):

| | Before | After |
| --- | --- | --- |
| Idle pass: bytes read / written | 4.6 MB / 9.2 MB | 84 KB / 16 B |
| Idle pass: files opened | 274 | 9 |
| Cursor size | 4.6 MB (grows with history) | 84 KB (bounded) |
| First read: writes | one per record | 1.2 per 1,000 records |
| Store load ÷ JSON.parse | 7.5 | 4.3–4.8 |

At the heavy month's scale the old cursor was 47.0 MB (it is now 1.1 MB),
and the old idle pass read it and rewrote it twice every five seconds. That
was the 24% of a core, and more than a terabyte a day of disk writes.

**A team of ten** (`bench/run.mjs team`):

| | Before | After |
| --- | --- | --- |
| Catch-up, all ten machines | 20.8 s | 21.2 s |
| Hub CPU during catch-up | 7.0 s | 6.6 s |
| Reporters' CPU during catch-up (all ten) | 61.5 s | 24.5 s |
| Reporter peak memory | 257 MB | 224 MB |
| Hub CPU, steady | 0.6% | 0.6% |
| Console answer | 59 ms, 107 KB | 48 ms, 107 KB |

The frame time in the browser with ten machines and 80 lanes over 12 seconds
(six polls, 120 Hz display): p50 8.3 ms, p99 10.2 ms, worst 10.4 ms, no long
tasks. The console shows at most 80 lanes and updates rows in place, so the
list needs no virtualisation.

## What changed to get there

- **Unchanged transcripts are skipped.** Same size, same modification time,
  fully read: nothing is opened, parsed or copied.
- **The cursor is bounded.** The per-message marks that turn a streamed
  response into increments are kept for six hours after a transcript's newest
  response, and dropped once a transcript is quiet that long. One response's
  lines are seconds apart; the longest spread measured was 559 seconds.
  Transcripts outside the retention window give up their state.
- **Nothing is rewritten when nothing changed.** An idle pass writes no
  cursor, apart from refreshing its sync time once a minute.
- **Lines that cannot change a record are not parsed.** For Codex that means
  anything but `session_meta`, `turn_context` and `token_count`. For Claude
  Code it means any line without usage. Tool output, prompts and replies are
  most of the bytes.
- **Salted hashes are computed once per value per pass**, not once per line.
  They are held only in memory.
- **The spool is written in blocks**, not one write per record.
- **The hub's own machine is delivered in batches of 5,000**, streamed from
  the spool, with the event loop free between batches. The console keeps
  answering during a first read, and the whole backlog is never in memory at
  once.
- **The hub prices a record without building a descriptor it throws away.**
  Price-table rows are looked up once per model.

The records themselves are unchanged. Differential runs produced
byte-identical output before and after for all 546,687 records of the heavy
month, 107,685 records of a second history, and every conformance machine.
`test/collector-incremental.test.js` also holds that a transcript read in two
passes, split mid-response, gives exactly the records of one pass.

## Known limits

- A restart reads the stored records before the console answers. At a heavy
  month with `--retention-days 30` (about 450,000 records) that is about two
  and a half seconds. At the default eight days (about 150,000 records) the
  store loads in about 0.7 seconds. Answering first and loading in the
  background needs the console to show that it is still loading.
- A reporter's first catch-up holds its backlog in memory while it sends it
  in batches of 500. The hub's own machine no longer does.
