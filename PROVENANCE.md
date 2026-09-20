# Provenance

This console was recovered from LockedIn Labs' `SprintLoop-FDE/fleet-dashboard`
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

REDISTRIBUTION AUTHORIZED: Sam Sweilem, 2026-09-20. This package may be redistributed under its MIT licence.

The owner instructed Codex to publish the current console as the open-source
observability product, after the proprietary origin and MIT redistribution
requirement had been disclosed in the same conversation.
