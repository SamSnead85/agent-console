# What the numbers mean

## Sources

Claude Code: the JSONL transcripts under `~/.claude/projects`. Codex: the
rollout JSONL under `~/.codex/sessions`. Both are read locally and read-only,
on each machine, by the collector (`lib/collector/`). Only the transcripts
written inside the console's retention window (8 days by default) are read.
The field-by-field rules are in [COLLECTOR-CONTRACT.md](COLLECTOR-CONTRACT.md).

## Tokens

Four disjoint classes: **input** (fresh input, not from cache), **output**,
**cache write** and **cache read**. Thinking tokens are already inside output;
one-hour cache writes are already inside cache write. A class a tool did not
report is unknown, not zero: the total is then a floor, and the screen says so.

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

The estimate cannot see subscriptions, negotiated rates, batch or fast mode,
data-residency premiums, taxes or tool fees. It is not an invoice.

## Projects (this machine only)

Tokens, estimated cost, sessions and branches per project folder, from the
console's own machine only, beside what that folder's local Git history
recorded in the same period: commits, lines added and removed, and commits
referencing #N (merge commits of pull requests, and subjects ending `(#N)`,
which can name an issue as well as a merged pull request). Only commits whose
author email is the repository's configured `user.email` are counted; with
none configured, every author is, and the page says so. Git
evidence describes delivery activity. It does not measure value, quality or
causation, and tokens do not measure productivity.
