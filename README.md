<p align="center">
  <a href="https://lockedinlabs.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-on-dark.svg">
      <img src="docs/brand/lockup-on-light.svg" alt="LockedIn Labs" width="360">
    </picture>
  </a>
</p>

<h1 align="center">Agent Console</h1>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/SamSnead85/agent-console"></a>
  <a href="https://github.com/SamSnead85/agent-console/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/SamSnead85/agent-console"></a>
  <a href="https://nodejs.org"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/node-%3E%3D22-339933"></a>
  <a href="https://github.com/SamSnead85/agent-console/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/SamSnead85/agent-console/ci.yml?branch=main&label=CI"></a>
</p>

<p align="center">
  See what your AI coding agents use (sessions, tokens, cache reads and writes,
  models and list-price cost) on this computer and every computer you connect.
</p>

![Agent Console in demo mode, dark](docs/console-demo-dark.png)

*The console in demo mode. Every figure in this picture is generated.
[The same screen in the light theme.](docs/console-demo-light.png)*

**Only counts, model ids, timestamps, and salted hashes of session and project
identifiers leave a machine. No prompt, no response, no file path, no file
content.** One allowlist in the code enforces that, and a test pushes
real-shaped transcripts full of planted canaries through the real reporter and
the real hub and checks every byte that crosses the wire. (There is one
opt-in: `--share-project-names` also sends each project folder's *name* — never
its path. It is off unless you pass it.)

## Start here

You need a Mac, a Linux machine or a Windows PC, and about two minutes.

1. **Install Node.js 22 or newer.** Get the LTS version from
   [nodejs.org](https://nodejs.org). To check, open a terminal (*Terminal* on a
   Mac, *PowerShell* on Windows) and type `node --version` — it should say
   `v22` or higher.
2. **Start it.** Paste this into the terminal and press Return:

   ```sh
   npx --yes https://github.com/SamSnead85/agent-console/releases/download/v0.2.1/lockedinlabs-agent-console-0.2.1.tgz --open
   ```

   That fetches Agent Console from this project's GitHub release (nothing to
   download by hand) and opens it in your browser, normally at
   `http://127.0.0.1:6787`. If that port is taken, the terminal prints the
   address it used instead. Leave the terminal window open; closing it (or
   pressing Ctrl+C) stops the console. The same command starts it again.

   The first start reads the Claude Code and Codex history already on this
   computer. With months of it that can take a minute; the terminal counts the
   files as it goes, and so does the console.

**Or download it.** On the [GitHub page](https://github.com/SamSnead85/agent-console),
press the green **Code** button, then **Download ZIP**, and unzip it. You get a
folder called `agent-console-main`. In a terminal, go into that folder and
start the console:

```sh
cd ~/Downloads/agent-console-main
node bin/agent-console.mjs --open
```

On Windows (PowerShell) the first line is `cd $HOME\Downloads\agent-console-main`.
If `node` then says it cannot find `bin/agent-console.mjs`, Windows unzipped
the folder inside another one of the same name: run `cd agent-console-main`
once more. (If you use git: `git clone https://github.com/SamSnead85/agent-console.git`,
then `cd agent-console`.)

**The .tgz on the release page.** The [releases page](https://github.com/SamSnead85/agent-console/releases/latest)
lists a file named `lockedinlabs-agent-console-<version>.tgz`. It is the
packaged console that the one-line command above fetches for you. You don't
need to download or open it. *Source code (zip)* on the same page is that
release's code, used the same way as Download ZIP (its folder is named
`agent-console-<version>`).

The rest of this page writes commands as `node bin/agent-console.mjs`. If you
used the one-line command, put `npx --yes <that release link>` in its place.

Nothing to install beyond Node, no account, no build step, no dependencies.

To look around before it reads anything of yours:
`node bin/agent-console.mjs --demo --open` shows a synthetic team of five
machines. Everything on that screen is stamped **DEMO**.

### Add another computer

A teammate's laptop, your second machine, a second user account on this one —
each reports to the same console and they all add up.

1. Start the console so other computers on your network can reach it:

   ```sh
   node bin/agent-console.mjs --listen 0.0.0.0 --open
   ```

   It prints a warning saying exactly what that opens up (see
   [How the machines connect](#how-the-machines-connect)).
2. In the console, press **Add a machine**. Say whose machine it is and what to
   call it, press **Create join link**, then **Copy link** and send it to them.
3. On the other computer, they open the link and follow its one step: paste a
   single command into a terminal. It needs Node.js 22 or newer and nothing else
   — it fetches Agent Console from *your* computer, not from the internet's
   package registry.

The machine appears on your console within seconds, and the console shows who
joined and when. A join link works **once**, and only for 30 minutes. On the
screen the link and its code stay masked; **Copy** puts them on the clipboard.

![Add a machine: the join link, masked, and the one command](docs/console-demo-join-dark.png)

![The Team view in demo mode, light](docs/console-demo-team-light.png)

### What works where

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| The console, reading this computer | Yes — tested in CI | Yes — tested in CI | Yes — the console, collector and demo are tested in CI |
| Joining and reporting to another computer's console | Yes — tested in CI | Yes — tested in CI | Yes — tested in CI |
| Projects view (Git evidence) | Yes, with `git` | Yes, with `git` | Expected to work with `git` installed; not yet tested |

CI runs the whole suite on macOS and Linux (Node 22 and 24). On Windows it runs
the hub, collector, join-by-link and reporting tests — including the
multi-process privacy test — and the package smoke test; the older Projects
view's tests are not yet run there.

Windows: use PowerShell, and when Windows asks whether Node.js may accept
connections on the machine running the console, allow it on private networks.

## What you see

**Tokens · last 24 hours** — the total across every machine, the list-price
estimate, the number of messages (API responses, not transcript lines), and the split into **cache read**, **cache write**,
**output** and **input**, each with its share of all tokens. (Cache read as a
share of *input tokens only* — the other common reading — is in the cache-read
tooltip and in the API, labelled as such.)

**Tokens over time** — the last hour, day or week. Where a machine has stopped
reporting, the chart says from when it is incomplete.

**Burn · right now** — tokens per minute (or per second) over the last five
minutes, the dollars per hour it implies, and each model's share and spend over
the day, with real Anthropic and OpenAI marks.

**Lanes** — one row per session: whether it is live, the project and branch, the
model, its last hour of activity, tokens in the last five minutes, how many
subagents it is running, and which machine it is on.

**Machines** and **Team** — every machine and every person: tokens, share of the
total, cache read and write shares, model split and cost, for 24 hours or
7 days; every join link, who used it and when. Two machines with the same
person roll up into one row.

**Projects** — this computer only: tokens per project, and what Git recorded in
the same period (commits, lines changed, pull requests merged). It is read on
this computer and never sent anywhere.

### What the numbers promise

- **A machine that stops reporting is not zero.** It shows when it was last
  heard from, its sessions show an unknown five-minute figure, and it is left out
  of "right now" by name.
- **A machine still sending its history is not complete.** A computer that
  joins with months of transcripts shows "catching up · N of M records" until
  everything has arrived, and is left out of "right now" until then. If its
  upload is interrupted it carries on from where it stopped.
- **Unknown is not zero.** A message that did not report a token class makes the
  total a floor, and the screen says so. A model with no verified list price is
  left out of the dollar figure — never priced at $0 — and the screen says how
  many tokens that leaves out. If everything in the burn window is unpriced,
  the burn shows "—/hour · unpriced" rather than a dollar rate.
- **Copied transcripts count once.** Record ids come from the transcript itself,
  not from where the file sits, so the same session read on two machines is one
  set of events.
- **Dollars are estimates** at standard API list prices from a dated, offline
  table (`lib/collector/prices.json`). They are not an invoice and not a
  subscription charge. Tokens measure usage, not productivity.
- **Demo is never mixed with measured data.** A console started with `--demo`
  reads nothing, accepts no machine, and stamps DEMO on every view.

## How the machines connect

One computer runs the console — the **hub**. Every other computer runs a small
**reporter** that reads *its own* Claude Code and Codex transcripts and sends the
hub metadata every ten seconds.

```
  laptop ── reporter ──┐                        ┌── the console (this computer only)
                       ├── POST /api/ingest ──> hub
  workstation ─ reporter ┘   (device token)      └── reads its own transcripts too
```

**What the network can reach.** By default the hub listens on `127.0.0.1` —
this computer only. With `--listen 0.0.0.0` (or a specific address) other
computers can reach exactly four things: the join page, the package the join
command downloads, the join exchange (which needs a live, single-use code), and
reporting (which needs a device token). **The console itself, its data, and
every button on it — making links, removing machines — answer only on the
computer running it**, whatever `--listen` says. To look at the console from
elsewhere, tunnel to it: `ssh -L 6787:127.0.0.1:6787 you@hub-computer`, then
open `http://127.0.0.1:6787`.

**Credentials.** A join link carries a single-use code that expires in 30
minutes (`--invite-minutes` to change). The reporter spends it once and receives
its own device token, which it keeps in a private file (mode 600) under
`~/.agent-console/reporter/`. The token is never printed, never put in a URL and
never shown on a screen; the hub stores only a SHA-256 verifier of it. **Remove**
on the Team view revokes a machine at once — its reporter stops and says why —
and what it already reported stays, marked as removed.

**The wire.** On your own computer or a private network (`10.x`, `172.16–31.x`,
`192.168.x`, `100.64–127.x` such as Tailscale, `*.local`) the reporter uses plain
HTTP, and says so. Anywhere else it requires HTTPS unless you pass
`--allow-http`. Use a network you trust, a VPN such as Tailscale or WireGuard,
or an SSH tunnel.

**Storage.** The hub keeps 8 days of usage (`--retention-days`) in
`~/.agent-console/hub/` (`--state-dir`), as an append-only file of metadata
records. Nothing leaves that directory.

### The reporter

```sh
agent-console join <join link>          # enrol this computer, then keep reporting
agent-console report                    # keep reporting after a restart (no new link)
agent-console leave                     # forget this computer's enrolment
```

Run from a download it is `node bin/agent-console.mjs join …`; run the way the
join link suggests it is `npx --yes http://<hub>/agent-console-<version>.tgz join …`.
Options: `--name` (what to call this computer), `--interval <seconds>`, `--once`,
`--state-dir`, `--home`, `--claude-root`, `--codex-root`, `--allow-http`,
`--share-project-names`, `--json`.

The reporter keeps going only while its window is open. To start it at login,
add `agent-console report` to your system's startup items (launchd, systemd or
Task Scheduler); this release does not install a background service for you.

## Privacy, precisely

What leaves a reporting computer, per usage event: the tool (`claude-code` or
`codex`), the model id, the minute it happened, the four token counts, whether
it was a subagent, and HMAC-SHA256 hashes of the session, its parent and the
project directory, keyed by a salt the hub makes and shares only with the
machines that join it. The machine's name is whatever the console's owner typed
when making the link (or `--name` when joining). With `--share-project-names`,
also the last part of each project folder's name, reduced to letters, digits and
dashes.

What never leaves: prompts, replies, thinking, tool input and output, file
paths, file names, file contents, git branches, command lines, credentials.

On the hub's own computer the console also shows local project names and
branches — read from its own disk, shown only on loopback, never stored with
the records and never sent anywhere.

The proof is `test/hub-e2e.test.js`: synthetic transcripts in the tools' real
formats, with canaries in every private field, go through a real reporter
process and a real hub process; a relay records every request body, and the
test checks the wire, the hub's files, the reporter's files and the console's
own payload for every canary. The field-by-field contract is
[docs/COLLECTOR-CONTRACT.md](docs/COLLECTOR-CONTRACT.md).

## Troubleshooting

**The console opened on a port other than 6787.** Another program had 6787,
so the console took the next free port and printed the address it used. If
Agent Console itself is already running there, a second start says so and
opens that one instead. A port you choose with `--port` is never changed: if
it is busy you are told to pick another.

**The reporter says "the hub is pacing uploads" or "catching up".** A computer
joining with a lot of history sends it in batches, and the hub paces them. Leave
the window open: every batch that arrived is kept, and the console shows the
machine as "catching up · N of M records" until it is done.

**The other computer cannot reach the console.** Check, in order: the console
was started with `--listen 0.0.0.0`; both computers are on the same network
(not a guest network); the address in the link is still this computer's address
(it can change when you change networks — make a new link); and the firewall
allows Node.js to accept connections — macOS asks the first time (choose
*Allow*; or System Settings → Network → Firewall → Options), Windows asks the
same (allow *Private networks*), and on Linux with `ufw`:
`sudo ufw allow 6787/tcp`.

**"This join code is not valid" or "has expired."** Each link works once, for
30 minutes. Press **Add a machine** again and send the new link.

**A machine shows "Silent since …".** Its reporter stopped: the window was
closed, the computer slept, or it changed networks. On that computer run
`agent-console report` (or the `npx … report` command from the join page) —
no new link needed. If it says the hub no longer accepts it, it was removed:
send it a new link.

**A machine shows "Joined — waiting for its first report."** It has joined but
its reporter has not delivered yet; if it stays that way, the reporter window
was closed right after joining.

**The numbers look low.** The console keeps 8 days, and the first start reads
only transcripts written in that window. Claude Code and Codex must be writing
their usual logs (`~/.claude/projects`, `~/.codex/sessions`); if yours live
elsewhere, pass `--claude-root` / `--codex-root`.

**`npx` or `node` is "not found".** Node.js is not installed, or the terminal
was opened before it was — install it from nodejs.org and open a new terminal.

## Options

```sh
node bin/agent-console.mjs --help          # the console
node bin/agent-console.mjs join --help     # the reporter
```

| Console option | Default / purpose |
| --- | --- |
| `--open` | open the browser once it is listening |
| `--port <n>` | `6787` |
| `--listen <address>` | `127.0.0.1`; `0.0.0.0` accepts other computers (see above) |
| `--demo` | a synthetic fleet; reads nothing, accepts no machine |
| `--name <text>`, `--person <text>` | this computer's name and owner on the console (`This machine`, `You`) |
| `--no-local` | do not read this computer (a hub on a server) |
| `--state-dir <path>` | `~/.agent-console/hub` |
| `--retention-days <n>` | `8` (1–90) |
| `--invite-minutes <n>` | `30` |
| `--claude-root`, `--codex-root` | where this computer's transcripts are |
| `--json` | print launch details as JSON and keep running |

The Projects view keeps v0.1's options: `--repo`, `--home`, `--window-hours`,
`--history-dir`, and the opt-in legacy panels `--github` and `--muster`.
Environment equivalents use the `AGENT_CONSOLE_` prefix.

## Embedding

A dependency-free `<agent-console-panel>` can show a compact reading inside
another local application. Allow that application's exact origin:

```sh
node bin/agent-console.mjs --embed http://localhost:3000
```

```html
<script src="http://127.0.0.1:6787/panel.js"></script>
<agent-console-panel src="http://127.0.0.1:6787" rows="5"></agent-console-panel>
```

Wildcard and `null` origins are refused. See [SECURITY.md](SECURITY.md).

## Development

```sh
npm test               # the whole suite, including the multi-machine end-to-end tests
npm run smoke:pack     # pack, install into a scratch prefix, start it in demo mode
```

No dependencies to install. CI runs both on macOS and Linux, Node 22 and 24,
and the hub and reporter tests plus the smoke test on Windows.
See [CONTRIBUTING.md](CONTRIBUTING.md) (including the privacy rule every change
keeps), [CHANGELOG.md](CHANGELOG.md) and [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md).
Report security problems privately, as [SECURITY.md](SECURITY.md) describes.
Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Origins and license

MIT © 2026 LockedIn Labs. The console began as a local engineering dashboard;
the collector in `lib/collector/` is LockedIn Labs' own and is published here
under the same licence. Redistribution authorization and source origins are in
[PROVENANCE.md](PROVENANCE.md). IBM Plex is included under the SIL Open Font
License 1.1 (`public/fonts/LICENSE-OFL.txt`). The Anthropic and OpenAI marks
identify the models they make and belong to their owners. Every bundled
third-party asset is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## About LockedIn Labs

Agent Console is built and maintained by [LockedIn Labs](https://lockedinlabs.ai).
