# Measurement contract

## Sources and scope

Claude: recursive JSONL transcripts in `~/.claude/projects`, with process/session
associations in `~/.claude/sessions`. Codex: rollout JSONL in `~/.codex/sessions`.
Collection is local and read-only. Discovery defaults to files modified within
72 hours; source-root overrides do not imply cross-machine aggregation.

Claude response records are deduplicated within each file by message ID, using
per-category high-water counters. Parent totals include subagent usage, so do
not add parent and child totals again. Metadata journals are not agents.
Deduplication across copied transcripts or machines is not implemented.

History uses five-minute buckets. Rolling periods include the first overlapping
bucket, so the lower boundary can extend by less than five minutes. Claude
session rows remain local-day scoped. Thinking tokens are already part of
output; one-hour writes are already part of total cache writes.

Codex counters are cumulative per thread. They are never added to Claude period
totals or priced in this release. Fork replay handling exists for activity
signals, but period attribution across resets and model changes needs further
validation before a combined usage headline is appropriate.

## Costs

Rates checked September 20, 2026 against
[Anthropic's published pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Standard API-equivalent USD per million tokens; not subscription charges,
credits, taxes, negotiated rates, fast mode, geography premiums, or tool fees.

Fable 5.1 and Mythos 5.1: input $10, output $50, cache reads $0.25, five-minute
writes $12.50, one-hour writes $20. Older Fable 5/Mythos 5 cache reads remain $1.
The model-specific rate is intentional; a global 10% cache multiplier is wrong
for 5.1. Unknown model IDs are unpriced. Mixed totals report a partial priced
subtotal; unknown subagent costs are null rather than zero.

A high cached-token share is not a waste score. Input reuse is cache reads /
(cache reads + cache creation + fresh input). Cache share of all tokens includes
output in the denominator. Neither is a universal industry benchmark.

## Activity and evidence

Subagent activity currently means its transcript changed within two minutes.
This is not a vendor-confirmed execution state. Process evidence, recent usage,
and heuristic stall/deadhead signals have different meanings; inspect `?` for
their definitions. Silent thinking or waiting can resemble inactivity.

Commits, lines, and pull-request evidence describe delivery activity. They do
not prove business value, quality, or causality. Optional progress inputs are
reported judgments, not independently measured completion percentages.

## Coverage

Missing logs, an offline device, unpriced usage, and unavailable process data
must not be interpreted as zero activity or zero cost.

Since 0.2.0 other computers can report to a hub. Each reporting device is
enrolled with its own token and reports what its own transcripts say; the hub
records when it last heard from each one. A device that stops reporting keeps
its last contact time and is excluded, by name, from "right now" figures; its
earlier reports still count. Record ids are keyed by the transcript's own
session and message identity under the hub's organization salt, so a transcript
copied to a second device is recognised and counted once. The reporting device
is not proof of where the work ran; execution origin stays unknown unless a
transcript names it. Device counts mean devices reporting — never seats or
people. The full rules are in [COLLECTOR-CONTRACT.md](COLLECTOR-CONTRACT.md).
