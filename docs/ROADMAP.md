# Direction

Agent Console is one screen for the AI coding agents on every machine you
connect: fast to start, no account, read-only collection, metadata only.

In 0.2.1: machines join by single-use link and report over TLS pinned to the
console's certificate; the console is signed in and never on the network; per
person and per machine views; copied transcripts counted once; large first
uploads resume where they stopped; CI on macOS, Linux and Windows.

In 0.3.0: context and cache health, live alerts and an agent tree in each
lane; spend per commit and per integration in Projects; a project policy file
that compiles into Claude Code controls and can be removed; opt-in local
metrics and telemetry; one period (1 hour to 30 days) on every view; and
reporters that run in the background and survive a console's restart.

In 0.4.0: a redesigned console with consistent period charts, optional shared
alerts and tool activity, explicit coverage and loss reporting, durable pending
contributions, and presentation aliases.

Candidates for later:

1. Installing the reporter as a login service for you (launchd, systemd, Task
   Scheduler). 0.3.0 has `--background` and examples to set one up by hand.
2. Prices for more models as vendors publish rates; the table stays dated and
   offline.
3. Choosing which projects a machine shares by name, from the console.
4. Signed installers and in-place updates.
