# Direction

The console is the product: fast to start, no account, read-only collection,
metadata only, and a dense screen that tells the truth about gaps.

Shipped in 0.2.0: many machines reporting to one hub, joined by single-use
links; per-person and per-machine views; copied-transcript deduplication.

Next candidates, none of them implemented yet:

1. A background service for the reporter (launchd, systemd, Task Scheduler) so
   reporting survives a restart without a terminal window.
2. HTTPS on the hub without a separate proxy, and Windows in CI.
3. Codex period attribution and pricing for more models as vendors publish
   rates; the price table stays dated and offline.
4. Project and label management from the console, rather than per machine.
5. Signed installers and in-place updates.
