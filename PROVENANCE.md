# Provenance

This console was recovered from a private LockedIn Labs repository
at commit `fca5fca39fc27dd462606605c117027798924a56`, built across these source
commits:

- `56c9254`
- `74a5532`
- `71680aa`
- `eb0276b`
- `a634cf0`
- `fca5fca`

It then shipped briefly inside the Muster CLI as `lib/dashboard/console/`, and
was extracted into this package on 2026-09-02.

## The licence gate

The source repository is proprietary ("All rights reserved") while this package
is MIT. **Do not publish, package for third parties, tag, or release this
console until LockedIn Labs records an explicit authorization to relicense and
redistribute it.**

That rule was prose in a file no tool read, which is not a control. It is
mechanical now: `scripts/pack-smoke.mjs` refuses to package this code until the
decision exists in this file.

### Recording the decision

The owner records it by adding one line here, beginning exactly:

```text
REDISTRIBUTION AUTHORIZED: <who authorized it>, <date>. This package may be
redistributed under its MIT licence.
```

The prefix is matched literally, and a `<placeholder>` is rejected, so this
documentation cannot satisfy the check it describes — the first version of the
gate was defeated by exactly that. Nothing here grants the authorization; that
is the owner's to give.

## Recorded decision

REDISTRIBUTION AUTHORIZED: LockedIn Labs, 2026-09-20. This package may be redistributed under its MIT licence.

The owner instructed Codex to publish the current console as the open-source
observability product, after the proprietary origin and MIT redistribution
requirement had been disclosed in the same conversation.

## The collector (0.2.0)

`lib/collector/` — `collector.js`, `parsers.js`, `pricing.js`, `measurement.js`,
`transport.js`, `prices.json` and their tests — is LockedIn Labs' own
dependency-free console collector, written for its internal console and
published in this package under the package's MIT licence on 2026-09-22. Its
measurement rules (per-message high water, disjoint cache classes, per-model
cache-read rates) were themselves derived from this package's 0.1.0 release.

Adapted for the hub: delivery can be a function call (the hub reads its own
machine in-process), collection can be bounded to a retention window, a
delivered spool can be emptied, the device credential may come from the
reporter's private state file, plain HTTP is accepted on private networks, and
a receipt may count records outside the hub's window as `expired`. A hosted
service's endpoints and its process-interruption channel were removed.

`prices.json` rows name the vendor page each rate was read from and the date it
was checked; they are standard list prices, not negotiated or subscription
rates. The field-by-field contract is `docs/COLLECTOR-CONTRACT.md`.

## Fonts and marks

IBM Plex Sans and IBM Plex Mono (`public/fonts/`) are Copyright 2019 IBM Corp.
and are included under the SIL Open Font License 1.1, whose text travels with
them. The LockedIn Labs mark belongs to LockedIn Labs. The Anthropic and OpenAI
marks are the vendors' own published marks, used only to identify their models.

