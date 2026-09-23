# Changelog

## 0.2.1 — not yet released

Fixes from a cold-install test that followed the README as a first-time user
would (its figures matched an independent count of the raw logs to within
0.044%), plus open-source completeness and LockedIn Labs branding.

Fixed:

- **A machine with a large history now finishes uploading.** The reporter moved
  its cursor only after every batch of a delivery had succeeded; the hub paced
  a 68,430-record first upload (429, wait 60 s), the reporter waited at most
  4 s, gave up and started again from the first record, indefinitely. It now
  keeps every acknowledged batch and resumes from there, honours `Retry-After`
  (up to two minutes), and comes straight back when paced. The hub allows 600
  batches a minute per machine (300,000 records) instead of 120.
- **Honest status while a machine catches up.** The console showed such a
  machine as "Reporting · now". It is now "Catching up · N of M records", left
  out of "right now" by name, with its lanes' five-minute figure unknown, and the
  figures are marked incomplete until it has sent everything. The reporter says
  "catching up · sent N of M records" as it goes.
- **The reporter says what actually went wrong.** "Cannot reach the hub" only
  when nothing answered; otherwise "the hub is pacing uploads" or "the hub
  answered with an error (HTTP 503)", with how many records are already safe.
- **Messages count messages.** Claude Code writes one response over several
  transcript lines, and the count was of records: 26% high overall, 64% for
  Claude. Records now carry `continuation` (true when an earlier record already
  counted that message), and the console counts only the first. Tokens were
  never affected. Records from 0.2.0 reporters are still accepted and count as
  before, so upgrade the console first; reporters that join through its link
  get its version.
- **No more "$0.00/hour est." for unpriced use.** When everything in the burn
  window is on a model with no verified price, the burn reads "—/hour ·
  unpriced"; when some is, "partial", with the models named.
- **Port already in use.** If Agent Console is already running on the port,
  starting it again says so and opens that one. If another program has the
  default port, the console takes the next free one and prints the address it
  used. A port given with `--port` is never changed.
- **The first read shows progress.** Reading months of transcripts prints
  "N of M files" in the terminal and on the console, and the browser opens
  after two seconds instead of waiting for the whole read.

Added:

- **Claude Opus 5.5 pricing** ($4 input, $20 output, $5 / $8 cache writes,
  $0.20 cache hits per million tokens), from Anthropic's published pricing page,
  checked 2026-09-22.
- **`agent-console --version`** (or `-v`) prints the version and exits. Before
  this, the flag was ignored and the console started.
- **Easier start.** The README's first step is one `npx` command that fetches
  the release from GitHub. The ZIP route names the folder to go into
  (`agent-console-main`), including the nested folder Windows makes, and the
  README explains the `.tgz` on the release page.
- **Licences travel with the package.** `THIRD_PARTY_NOTICES.md` lists every
  bundled third-party asset (IBM Plex under the SIL OFL 1.1, the Anthropic and
  OpenAI marks drawn from Simple Icons) and is now in the npm package along
  with `CHANGELOG.md` and `SECURITY.md`. `public/fonts/LICENSE-OFL.txt` now
  carries IBM Plex Mono's copyright notice as well as IBM Plex Sans'.
- **Community files.** A Code of Conduct (Contributor Covenant 2.1), a tighter
  CONTRIBUTING guide that spells out the privacy rule every change keeps, a
  SECURITY policy that points to GitHub's private vulnerability reporting, and
  issue and pull request templates.
- **LockedIn Labs, consistently.** The README opens with the full LockedIn Labs
  lockup (the mark and the letterspaced wordmark as the console's header draws
  them, outlined, in a light and a dark version so it follows GitHub's theme),
  then "Agent Console", badges and a one-line pitch, and closes with a line
  about LockedIn Labs. The console and join-page footers read "© LockedIn
  Labs", the installed app's name is "Agent Console · LockedIn Labs", the
  header wordmark is written "LockedIn Labs" (the capitals are styling), and the
  reporter's terminal banner names LockedIn Labs. The package keywords now
  include `tokens`, `llm` and `usage`.
- The provenance record and a test fixture no longer name an individual.

Wire format: the envelope gains an optional `backlog: { delivered, total }`
and records gain `continuation`; both are counts or flags, nothing more. See
[docs/COLLECTOR-CONTRACT.md](docs/COLLECTOR-CONTRACT.md).

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
- **Honest gaps.** A machine that stops reporting shows when it was last heard
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
