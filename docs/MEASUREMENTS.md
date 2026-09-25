# What the numbers mean

## Sources

Claude Code: the JSONL transcripts under `~/.claude/projects`. Codex: the
rollout JSONL under `~/.codex/sessions`. Both are read locally and read-only,
on each machine, by the collector (`lib/collector/`). Only the transcripts
written inside the console's retention window (8 days by default) are read.
The console also keeps daily totals for 400 days, which answer the 30-day
period after the minute detail is gone.
The field-by-field rules are in [COLLECTOR-CONTRACT.md](COLLECTOR-CONTRACT.md).

## Tokens

Four disjoint classes: **uncached input** (fresh input, not from cache), **output**,
**cache write** and **cache read**. Thinking tokens are already inside output;
one-hour cache writes are already inside cache write (the cache-write tooltip
shows the 5-minute, 1-hour and unreported-lifetime parts). A class a tool did
not report is unknown, not zero: the total is then a floor, and the screen says
so. A line that carries usage and cannot be counted is counted as a drop, by
reason, and the screen says how many ([accounting.md](accounting.md) §3.2).

**Periods.** One switch sets the period for every view: 1 hour, 24 hours and
7 days are whole minutes ending now, and the chart's bars add up to the
headline; 30 days are the last 30 UTC days, from the daily totals.

**Cache read share** is cache reads divided by all four classes. The other
common reading, cache reads as a share of input only (cache read ÷ (cache read
+ cache write + input)), is in the cache-read tooltip and in the API, labelled
as such. Neither is a benchmark, and a high share is not a waste score.

**Messages** are API responses. Claude Code writes one response over several
transcript lines; the lines after the first are marked as continuations and
are not counted again. Their token increments are still counted, once.

## Machines and copies

Each machine reports what its own transcripts say, under its own device token.
Record ids come from the transcript itself (session and message ids) under the
console's shared salt, not from a path, so a transcript copied to a second
machine is recognised and counted once, credited to the machine that sent it
first. The reporting machine is not proof of where the work ran.

A machine that stops reporting keeps its last contact time, its sessions show
an unknown five-minute figure, and it is left out of "right now" by name. A
machine still sending a large backlog is shown as "catching up · N of M
records" and is also left out of "right now" until it has sent everything.
Machine counts are machines reporting, never seats or people.

## Costs

Estimates at standard API list prices from an offline, dated table
([`lib/collector/prices.json`](../lib/collector/prices.json)), for Claude and
OpenAI models, so Claude Code and Codex use are both priced where a published
rate exists. Each row names the vendor page it came from and when it was
checked. A model without a verified rate, or a record missing a token class, is
left out of the dollar figure and counted as unpriced: never priced at zero.
Where some usage is unpriced, a figure is marked partial; where all of it is,
the burn rate reads "unpriced" instead of a dollar amount.

Fast mode is priced at its own published rates; another service tier, or fast
mode on a model without published fast rates, is unpriced. The estimate cannot
see subscriptions, negotiated rates, batch, data-residency premiums, taxes or
tool fees. It is not an invoice.

## Projects (this machine only)

Tokens, estimated cost, sessions and branches per project folder, from the
console's own machine only, beside what that folder's local Git history
recorded in the same period: commits, lines added and removed, and pull
requests merged (counted from merge and squash-merge commit subjects). Git
evidence describes delivery activity. It does not measure value, quality or
causation, and tokens do not measure productivity.
