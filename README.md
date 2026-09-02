<div align="center">

# Agent Console

**An instrument panel for the AI coding sessions you are already running.**

No fleet. No coordination. No account. It reads what Claude Code and Codex
already write to your disk and tells you where the money went, what is alive,
and what is stuck.

[![License: MIT](https://img.shields.io/badge/license-MIT-4c6fff.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-3c873a.svg)](#requirements)
[![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-2ea44f.svg)](package.json)

</div>

```sh
npx @lockedinlabs/agent-console
# http://127.0.0.1:6787
```

That is the whole install. It works in any directory, including one that is
not a Git repository, and it needs nothing running beside it.

## What it is for

You have four Claude Code windows open. They are not a fleet and they are not
coordinated — they are just four sessions, on different projects, and between
them they are spending real money and writing real code. You cannot see any of
it in one place.

That is the entire problem this solves. On the machine it was built on, a
single ordinary afternoon looked like this:

| | |
|---|---|
| Sessions seen | **127** across **104** projects |
| Live right now | **7** |
| Tokens today | **590.8M** |
| Estimated | **$429.14** |
| Cumulative threads excluded | **118** — see [what it refuses](#what-it-refuses-to-tell-you) |

None of those sessions knew about each other. They did not have to.

## What it shows

- **Where the money went.** Token classes priced separately, scoped by period
  and by project, because cache reads and output tokens are not the same
  expense and a single total hides which one is eating the budget.
- **What is actually alive.** A session with a live process and a silent
  transcript is *stalled*, not working, and it is named as such. A session
  burning tokens and producing nothing is *deadheading*.
- **What shipped.** Commits, merges, changed lines, and pull requests from
  this machine today, beside the tokens they cost.
- **Sub-agent trees.** How many agents a session spawned, how many are live,
  and how much of the spend is theirs.
- **The pressure signals.** Retries, hook errors, cache misses, compactions,
  quota pressure, unusually large swarms.

Every number carries its own definition. Press `?`, or click any underlined
word, and the reference opens at that term — served by the server, interpolated
against the constants that actually enforce it, so the explanation cannot drift
away from the code.

## What it refuses to tell you

This is the part that makes the rest trustworthy.

- **Codex counters are cumulative, and are never added to a day.** They cover
  the whole life of a thread. Summed beside Claude's day-scoped totals they
  produced 109.9 **billion** tokens against a real day of 590 million — about
  190× the truth, labelled "today". They are marked `Σ`, kept out of every
  period total, and the exclusion is stated rather than hidden.
- **An unknown model rate stays `unpriced`.** It never becomes `$0`. The price
  table carries its verification date and turns visibly stale rather than
  quietly presenting an old estimate as current.
- **Dollar figures are estimates at published API list prices.** They are not
  your subscription invoice, and the screen says so.
- **A session on another machine is never rendered live.** This program reads
  one disk. A session that declared itself from elsewhere is real evidence
  that a session exists and no evidence at all about whether it is working, so
  the row says `UNKNOWN`.
- **Missing evidence is never rendered as zero.** There is no vulnerability
  count, no defect count, and no causal "this skill is looping" diagnosis,
  because nothing here measures those things.

## Embedding it

The console goes into other applications — a command center, an internal
dashboard, a page of your own. One script tag and one element:

```html
<script src="http://127.0.0.1:6787/panel.js"></script>
<agent-console-panel src="http://127.0.0.1:6787" rows="5"></agent-console-panel>
```

Start the console with that page's origin allowed:

```sh
agent-console --embed http://localhost:3000
```

The panel uses Shadow DOM, so it cannot restyle the page it lands in and the
page cannot restyle it by accident. Everything you *are* meant to restyle is a
custom property:

```css
agent-console-panel {
  --ac-bg: #fff;
  --ac-fg: #111;
  --ac-rule: #e3e8ee;
  --ac-accent: #2f6fd0;
  --ac-radius: 8px;
}
```

It is read-only. The console has an acknowledge route; the panel does not call
it. An embedded widget that can mutate what it observes is a surface nobody
audited.

For a full page rather than a panel, iframe `http://127.0.0.1:6787` — the same
`--embed` list drives `frame-ancestors`. Or skip both and read `GET /api`
yourself with an `X-Agent-Console: 1` header, which is what the panel does.

### What `--embed` will not do

The default posture is loopback bind, pinned Host, no CORS, no framing. Those
four together stop a page on the public internet from resolving its own
hostname to `127.0.0.1` and reading your prompts out of your own browser.
`--embed` opens exactly one door in that wall:

- **`*` is refused.** Always. There is no flag for it.
- **`null` is refused** — a sandboxed frame and a `file://` page both send it,
  so it identifies nobody.
- **Origins match exactly.** `http://localhost:3000` does not admit
  `http://localhost:3001`, and does not admit `https://localhost:3000`.
- **A malformed allowlist stops the server**, rather than starting with
  embedding quietly off while you debug a panel that says "no answer".
- **The Host pin is never relaxed**, and a request that fails it earns no
  permission at all — not even to read the refusal.

## Options

| Flag | |
|---|---|
| `--port <n>` | listener port, always bound to `127.0.0.1` (default `6787`) |
| `--open` | open the page once it is listening |
| `--demo` | a deterministic synthetic tour: no scans, no network, no history written |
| `--embed <origins>` | comma-separated origins allowed to fetch and frame this console |
| `--window-hours <n>` | how far back a transcript may have been touched (default `72`) |
| `--poll-ms <n>` | refresh interval (default `10000`) |
| `--repo <path>` | a repository whose Git history and Muster ledger are read |
| `--history-dir <path>` | where derived history is kept (default `~/.muster-console`) |
| `--no-muster` | do not read a Muster coordination ledger |
| `--json` | print launch metadata and keep running |

Every flag has an `AGENT_CONSOLE_` environment equivalent.

Want to see it before pointing it at your own transcripts?

```sh
npx @lockedinlabs/agent-console --demo --open
```

Demo mode is a separate in-memory data source, not a filter over a real scan.
It reads no transcript, process table, repository, ledger, or history
directory, makes no outbound request, and writes nothing.

## Privacy

- It binds `127.0.0.1` and refuses every routable address. There is no flag to
  change that, because there is no configuration under which serving private
  transcripts on a routable interface is correct.
- It reads `~/.claude/projects`, `~/.claude/sessions`, `~/.codex/sessions`,
  local process arguments, and local Git history.
- Known credential forms are redacted on the server before anything is
  serialized to the browser. That is defense in depth, not permission to
  expose the console to an untrusted local user.
- Derived history — project slugs, session ids, model names, token totals —
  is kept in `~/.muster-console`, outside any repository, mode `0700`.
  Uninstalling does not delete it.
- It sends no analytics anywhere.

For another computer or a phone, keep it on loopback and carry it through a
trusted authenticated encrypted tunnel:

```sh
ssh -N -L 6787:127.0.0.1:6787 studio.example
```

## Coordination is optional

If a [Muster](https://github.com/SamSnead85/muster) ledger exists in the
repository you point `--repo` at, the console shows the coordination board
too: packages, holders, write fences, recorded branch and HEAD, dependency
gates, lease state. If there is no ledger, that band says so and everything
else works exactly the same.

The console does not require Muster, does not start it, and never writes to it.

## Requirements

- **Node.js ≥ 18.** No build step, no bundler, no runtime dependencies.
- macOS and Linux are the tested surfaces. On native Windows, process-level
  telemetry is unavailable — the collector uses the POSIX `ps` interface — and
  the console renders that as unavailable rather than as zero processes.

## Provenance

This console was extracted from the Muster CLI, where it shipped as "Muster
Console". Its origins and the redistribution terms it is subject to are
recorded in [PROVENANCE.md](PROVENANCE.md); read that file before publishing
this package anywhere.

## License

MIT © 2026 LockedIn Labs. See [LICENSE](LICENSE).
