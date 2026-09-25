# Changelog

## 0.3.0 — unreleased

- Separate telemetry read and ingest credentials with independent live
  rotation. Exporters must use `metrics-token --scope ingest`.
- Add `policy status --json` for installed-file/source drift checks; protect
  recognized policy writes and ask before uninspected interpreter execution.
  Status explicitly distinguishes installed configuration from runtime proof.

What your agents are doing, not only what they spent: context and cache
health, live alerts and an agent tree in each lane; a project policy you can
apply and remove; optional local metrics; figures that follow one period
everywhere; and reporters that keep going in the background and survive a
console's restart.

**Upgrading from 0.2.2.** Upgrade the console before its reporters: a 0.3.0
reporter's records carry a `tier` key that a 0.2.x console refuses (joining
pins a reporter to its console's version, so this happens only when a reporter
is upgraded by hand). A console whose machines join over Tailscale or other
carrier-grade NAT addresses (100.64.0.0/10) must now be started with
`--allow-cgnat`. A Prometheus scraper of `/metrics` needs the token that
`metrics-token` prints. The burn is now a fifteen-minute average.

**Seeing what agents are doing**

- **Context and cache health in each lane.** The Context column shows each
  session's latest complete input reading; open it for the last 16 readings,
  growth and possible cache breaks, with a dated list-price estimate of what a
  break cost. These are observed patterns, not a proven cause.
- **Live alerts** for repeated identical tool calls, a spend spike against the
  session's recent median, and spend without an observed successful tool
  result. Thresholds are set with `--alert-repeat`, `--alert-spike-factor` and
  `--alert-stall-minutes`; `--desktop-alerts` opts in to native notifications,
  which name the signal and never include tool arguments. Alerts stay on this
  machine.
- **An agent tree in each lane**: the orchestrator and its subagents, each with
  its model, observed tokens and duration. The outcome is "unknown" until a
  result is recorded; activity is not treated as success.
- **Spend in the window of the work**: Projects shows estimated spend per local
  commit and per integration into the default branch in the same period,
  labelled as correlation, not attribution. Anything unpriced leaves the ratio
  unknown.
- **A shared analysis core**, `@lockedinlabs/agent-console/analysis` (version
  1): the same dependency-free functions the console uses for context health,
  alerts, the agent tree, spend per outcome, the policy file and interop, for
  other Node.js programs. [docs/ANALYSIS.md](docs/ANALYSIS.md) is the contract.

**Project policy**

- **An optional `agent-policy.yaml`** (or JSON) with a published schema and a
  shared parser; unknown fields fail validation.
- **`agent-console policy diff`, `apply` and `remove`** compile the policy into
  repository-scoped Claude Code agents, settings and a local hook, with private
  backups so `remove` restores the files that were there before. Starting the
  console installs nothing. [docs/policy.md](docs/policy.md) says what is
  enforced and what is not.
- All three refuse a symlinked `.claude` path and never write the user-level
  Claude directory. The hook classifies quoted, wrapped and `sh -c` commands
  and path-qualified interpreters, catches `cat .env`-style secret reads and
  `git -C <path> push --force`, and asks or denies when it cannot load its
  classifier.

**Metrics and telemetry (opt-in)**

- **`--interop`** adds a Telemetry panel with Claude Code OpenTelemetry and
  AI-gateway token readings, kept apart from transcript totals so a request is
  never counted twice, a local Prometheus `/metrics` endpoint and a Grafana
  dashboard. [docs/INTEROP.md](docs/INTEROP.md) has setup and formats.
- `/metrics` and telemetry ingest take **separate scoped credentials**, printed
  by `metrics-token --scope read|ingest`. Each supports independent `--rotate`;
  the console key itself is never accepted.
  A `--demo` console prints its token at start and stamps `/metrics` DEMO.

**Joining and security**

- **Every command the console and the join page print checks the release file
  against the release's `SHA256SUMS`** before running anything, and keeps the
  checked file in `~/.agent-console/releases/`.
- **One address over its join limit no longer counts toward the total**, so
  one device cannot hold off everyone's joins; IPv6 addresses count by their
  /64.
- **Carrier-grade NAT (100.64.0.0/10, also Tailscale's range) is no longer
  private by default.** Start the console with `--allow-cgnat` to accept it;
  the start banner says so when it sees such an address.
- **Signed out, a console can print a new sign-in link** in its own window,
  from the button on its sign-in page or from a second start. A demo console
  can be signed into again without a restart.

**Accounting**

- **Fixed: a message a forked subagent copied from its parent is counted
  once.** Copies, including ones cut off mid-stream, were counted again in each
  fork's file, so input, cache and message counts could be overstated.
- **Nothing is dropped silently.** Every transcript line that carries usage and
  cannot be counted is counted by reason, sent with each report, and shown
  beside the figures and on its machine's row in Team, as are records the
  console itself could not keep.
- **Codex per-response usage records are counted**, one per response,
  including requests the running total never shows, such as compaction.
- **Model ids are kept exactly**, including Bedrock and Vertex forms, instead of
  becoming `unknown`. A transcript line too long to read has its usage
  recovered where possible, and is reported when it is not. Usage that grows on
  a line already counted is counted; usage rewritten lower is reported.
- **One period everywhere.** The period switch (1H, 24H, 7D and the new 30D)
  drives the headline tokens, cost, messages, model list and machine list, and
  Team and Projects offer the same periods with the same edges. The chart's
  bars add up to the headline. 30 days come from daily totals the console keeps
  for 400 days, after its minute detail is pruned.
- **Fast mode is priced at its published rates**, and any other service tier
  is left unpriced instead of being priced at the standard rate.
- Input is labelled "uncached input", the cache-write split by lifetime is
  shown, Team shows "no priced model" rather than $0.00 when nothing is priced,
  and the JSON counts priced and unpriced messages and records separately.
- **Projects counts only your commits**: those authored with the repository's
  `user.email`, so a fresh clone no longer credits other people's work to this
  machine. "PRs merged" is now "commits referencing #N", which is what it
  counts.
- The accounting spec is 1.1 and the conformance suite 1.1.0, with a case with
  exact expected totals for each of these.

**Reporters and machines**

- **`--background` and a periodic mode.** A reporter can keep running after its
  window closes, and one reporting less often than every minute shows as
  "reporting periodically" instead of flapping to silent.
  [docs/BACKGROUND.md](docs/BACKGROUND.md) has launchd, systemd and Task
  Scheduler examples for starting it at login.
- **One reporter per state directory, for its whole life**: a second one is
  refused and names the one that is running. New `stop` command.
- **`leave` tells the console** and stops a reporter running in another window;
  the console shows the machine as having left, not as silent.
- **Joining the same console again keeps the machine's entry and history**
  instead of adding a second machine with the same name.
- **Reporters survive a console's port change.** The console keeps its
  reporting port across restarts, and a reporter that loses its console looks
  for the same pinned certificate on nearby ports. A console with a new
  certificate is reported as "certificate changed", not "cannot reach".
- **Removed machines no longer count as silent** in the chart's "incomplete"
  label, the burn's "left out" list or "N of M machines". For two minutes
  after a restart, a machine that was reporting shows as "Reconnecting".

**The console**

- **The burn is the average of the last fifteen minutes**, not five, so one
  burst of agent traffic does not swing it. A lane's "tokens · 5 min" is
  unchanged.
- **One meaning of "session" on every view**: a top-level session, with its
  subagents counted apart, over "the last 24 h" rather than "today". "1 person",
  not "1 people".
- **Pause motion stops the animation, not the data.** Figures keep updating
  while paused, without moving.
- **Add a machine gives the exact command** to restart a this-machine-only
  console on the network. The week's line no longer runs through the hero's
  label.
- **Mistakes are refused, not ignored**: an unknown command (`joni`), an
  unknown option (`--intervall`), or a value out of range (`--interval abc`).
- **Input the console changes is said**: a machine name it cannot use, a
  duplicate name for the same person, and a link duration outside 5 to 60
  minutes. With `--json`, errors are JSON lines, and the console prints an
  event when a machine joins or leaves.

## 0.2.2 — 2026-09-24

Security fixes, accounting you can reconcile, and a console that is nearly
free when idle. Upgrade from 0.2.1: this release fixes three security issues,
described in advisory
[GHSA-grq6-4rfv-hxhj](https://github.com/SamSnead85/agent-console/security/advisories/GHSA-grq6-4rfv-hxhj).

**Security**

- **The join page checks the whole link before it offers a command.** It
  rebuilds the link from the parts it checked and puts it in single quotes, and
  gives no command for a link it cannot vouch for. The console's commands use
  single quotes too, and the reporter accepts a link with the quotes that
  cmd.exe passes through.
- **Add a machine leads with the command to send.** It is built on the
  console's own computer; the link, which opens a page served over plain HTTP,
  is the alternative. `SECURITY.md` explains the choice.
- **A second start never sends the console's key.** It proves it can read the
  key instead, and prints a sign-in link or opens the browser only for a
  console that proved it holds the same key. Something else answering on the
  port is told nothing, and the second start says so.
- **Each browser has its own session.** Sessions are random, last 30 days and
  end with the new **Sign out**; the console keeps only a verifier of each, and
  a new key ends them all. Each console's cookie has a name of its own, so
  signing in to one console on a computer no longer signs you out of another.
  Everyone signs in once more after upgrading.

**Accounting**

- **[docs/accounting.md](docs/accounting.md)** defines one token event, what
  is counted once (streaming, re-written lines, retries, resumed sessions,
  compaction, subagents, copies), Codex's cumulative counters, classes and
  cache lifetimes, models, windows and time zones, who a session belongs to,
  team roll-up and cost.
- **A conformance suite**, `@lockedinlabs/agent-console/conformance`: synthetic
  logs for five machines and two people, exact expected totals summed from
  ground truth, and the collector's own output for other receivers to replay.
- **Fixed: a streamed Claude response is dated by its first line.** Its later
  increments were dated by their own lines, so a response that crossed a
  window edge was split across two windows.
- **Fixed: a Codex counter that restarts is counted.** The restarting request,
  including every forked child's first own request, was dropped as coverage
  debt.
- **Fixed: "last 24 hours" is exactly the last 1,440 minutes.** The console's
  day included one extra minute and any record dated ahead of the hub's clock.
- The hub keeps 5-minute, 1-hour and unknown-lifetime cache writes apart, and
  `lib/hub/accounting.js` reports exact totals for any whole-minute window by
  team, person, machine, model, session and session tree.

**Performance**

- **Faster, and nearly free when idle.** On a month of heavy history (a
  million transcript lines), the first read takes half the time and half the
  memory, and the console keeps answering while it runs. An idle console used
  a quarter of a CPU core and rewrote tens of megabytes every five seconds;
  it now uses under 3% and writes nothing. Unchanged transcripts are not
  reopened, the cursor no longer grows with history, and lines no record
  reads are not parsed. Every record is byte for byte the same. A benchmark
  on synthetic history (`bench/`) and a budget CI enforces are in
  [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

**How the project is kept**

- **[docs/PRINCIPLES.md](docs/PRINCIPLES.md)**: the bar every change meets,
  and where CI checks it. New checks: the README's install line is run
  against the published release; every console option is started in
  `--demo`; a pull request that changes what people run adds a changelog line,
  and one that changes the interface retakes or confirms its screenshots.
  SECURITY.md now says how quickly a report is answered and fixed.
- **A public-safety gate on every push and pull request.** gitleaks checks each
  new commit and the tree. `npm run check:public` refuses absolute home paths,
  private email addresses, machine network names, credential shapes, image
  metadata, and names on a private denylist that CI reads from a repository
  secret, in files, in every line a commit added, in commit identities and in
  a pull request's title and body. It reports where and which rule, never the
  text. `scripts/public-safety/strip-images.mjs` removes image metadata without
  re-encoding.
- **The privacy canary covers everything that leaves a machine**: whole
  requests (path and headers as well as body), every answer the hub sends
  back, every read the console serves, and the hub's own transcripts, which
  must never leave through the reporting port. A new GET route that the
  canary does not read fails the suite.

**Fixed**

- **About one generated certificate in 256 was invalid,** so a hub could fail
  to start at random.

## 0.2.1 — 2026-09-23

Safer by default, and the fixes from a first-time install.

**Security**

- **Agent Console now comes only from its GitHub release.** The console no
  longer serves the package to machines that join, and every command it prints
  installs the release over HTTPS. From this release on, CI builds each release's
  package with a published SHA-256 and a signed build attestation.
- **Reports are encrypted and pinned.** Joining and reporting go over TLS to a
  certificate the console makes for itself; the join link carries its
  fingerprint, and the reporter talks to that certificate only.
- **The console is signed in, and never on the network.** It listens on
  127.0.0.1 on its own port and needs a sign-in cookie; `--open` and the
  sign-in link printed at start set it. Other machines use a separate port
  (normally 6788) that serves only joining and reporting, refuses callers
  outside private networks unless `--allow-public`, and refuses proxied requests
  to the console.
- **Joining is harder to guess.** Links carry a 128-bit code that lives at most
  an hour; attempts are counted before they are read.
- **The console checks every record's exact shape**, keeps usage one file per
  day, reads it back line by line, and limits each machine to 250,000 records a
  day, so a bad or hostile reporter cannot stop it from starting.
- **The reporter trusts nothing it is sent.** It checks every identifier a
  console returns and strips control characters before printing. Project hashes
  use a key only the reporting machine holds. Leaving out
  `--share-project-names` stops names at once, and `leave` deletes everything
  the enrolment left behind.

**Fixed**

- A machine with a large history now finishes uploading. It keeps every batch
  the console accepted, resumes where it stopped, honours the console's pacing,
  and shows "catching up · N of M records" meanwhile. The console no longer
  shows it as "Reporting · now" until everything has arrived.
- The reporter says what actually went wrong instead of always "cannot reach
  the hub".
- Messages count API responses, not transcript lines (the count was 64% high
  for Claude). Tokens were never affected.
- The burn rate shows "unpriced" instead of "$0.00/hour" for models without a
  verified price.
- A busy port: a second start points at the console already running; another
  program on the default port moves the console to the next free one.
- The first read of a long history shows its progress, and the browser opens
  after two seconds.

**Added**

- Claude Opus 5.5 pricing, from Anthropic's published pricing page
  (checked 2026-09-22).
- `--version`, clearer install steps, the full LockedIn Labs lockup in the
  README, and the community and licence files an open-source project needs.

**Changed**

- Machines that joined a 0.2.0 console join again with a new link.
- The v0.1 detail endpoints (`/api`, `/api/history`) and the embeddable panel
  are gone; the Projects view now reads the console's own data.

## 0.2.0 — 2026-09-22

Many machines, one console. Agent Console now shows the AI coding agents on
every computer you connect, in LockedIn Labs' console design.

- **Connect other computers by link.** One computer runs the console (the hub);
  **Add a machine** makes a join link with a single-use code that expires in 30
  minutes. The other computer opens it and runs one command — `npx` fetches
  Agent Console from the hub itself — and it starts reporting within seconds.
  Each machine gets its own device token, stored privately on that machine and
  kept on the hub only as a verifier; **Remove** revokes it at once. The console
  shows who joined and when.
- **A team view.** The total across every machine, and per machine and per
  person — tokens, share, cache read and cache write shares, model split and
  list-price cost, over 24 hours or 7 days. One person's several machines (or
  several accounts) roll up into one row; a transcript copied between machines
  is counted once.
- **The console, redesigned.** The terminal look is gone. IBM Plex (shipped with
  the package, SIL OFL 1.1), a graphite ground, one cobalt accent, colour only
  for state, light and dark themes. The band shows tokens for the last 24 hours
  with the cache read / cache write / output / input split and each class's share
  of all tokens; tokens over time (1H · 24H · 7D); burn right now in tok/min and
  tok/s with per-model share and spend; and one lane per session with its model,
  hour of activity, five-minute tokens, subagents and machine. Show unavailable
  and Pause motion sit in the band's header. One animation loop, text redrawn at
  most eight times a second, `prefers-reduced-motion` honoured.
- **Gaps shown as gaps.** A machine that stops reporting shows when it was last heard
  from, is left out of "right now" by name, and its lanes read unknown rather
  than zero; the chart marks where it becomes incomplete. A missing token class
  makes a total a floor, and an unpriced model is excluded from dollars and named.
- **The collector.** LockedIn Labs' dependency-free collector is now part of the
  package (`lib/collector/`, with its tests and [contract](docs/COLLECTOR-CONTRACT.md)):
  portable salted record identity, cursors per destination, a write-ahead spool,
  bounded retries, and a verified offline price table covering current Claude
  and OpenAI models.
- **Privacy, proven.** Only counts, model ids, timestamps and salted hashes leave
  a machine. An end-to-end test runs real reporter and hub processes over
  canary-filled transcripts and checks every byte on the wire and on disk.
  `--share-project-names` is the one opt-in, and sends a folder's name, never
  its path.
- **Network posture.** The hub still binds `127.0.0.1` by default. `--listen`
  opens only the join page, the package, the join exchange and token-checked
  reporting to other computers, with a printed warning; the console and every
  administrative action answer only on the hub's own computer.
- **Demo mode** is a synthetic team of five machines, stamped DEMO on every
  view, reading nothing and accepting no machine.
- **Projects** (tokens and Git delivery evidence for the hub's own computer) is
  one click away instead of on the first screen.

Breaking: Node.js 22 or newer is required. The v0.1 session-roster page and its
browser modules are removed; `/api`, `/api/history` and `<agent-console-panel>`
still work.

Limits: the reporter runs while its window is open (no background service is
installed); on Windows, CI covers the hub, collector, joining and reporting but
not yet the Projects view; the hub serves plain HTTP, so use it on a network you
trust or behind a VPN or tunnel.

## 0.1.0 — 2026-09-20

First public standalone Agent Console release. The local observability console
is available without a coordination CLI, ledger, account, or build step.

- Preserve the dark instrument-panel interface, session trees, token composition,
  history, activity signals, and delivery evidence.
- Add verified Fable 5.1/Mythos 5.1 pricing with their model-specific cache rates.
- Preserve unknown subagent costs and exclude metadata journals from agent counts.
- Make legacy coordination opt-in; keep the default demo focused on local usage.
- Add explicit transcript-root configuration and clearer device/Claude scope.
- Add exact bucket details to the history chart on hover.
- Publish installable GitHub release artifacts, source, synthetic screenshots,
  measurement documentation, and automated macOS/Linux checks.

Limits: Codex costs and combined period totals, native installers, multi-device
collection, and team aggregation are not implemented in this release.
