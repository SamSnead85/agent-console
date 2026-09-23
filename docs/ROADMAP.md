# Direction

Agent Console is one screen for the AI coding agents on every machine you
connect: fast to start, no account, read-only collection, metadata only.

In 0.2.1: machines join by single-use link and report over TLS pinned to the
console's certificate; the console is signed in and never on the network; per
person and per machine views; copied transcripts counted once; large first
uploads resume where they stopped; CI on macOS, Linux and Windows.

Candidates for later, none of them started:

1. A background service for the reporter (launchd, systemd, Task Scheduler) so
   reporting survives a restart without a terminal window.
2. Prices for more models as vendors publish rates; the table stays dated and
   offline.
3. Choosing which projects a machine shares by name, from the console.
4. Signed installers and in-place updates.
