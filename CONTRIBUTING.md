# Contributing to Agent Console

Thanks for helping. Agent Console is maintained by
[LockedIn Labs](https://lockedinlabs.ai). Everyone who takes part agrees to the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as
[SECURITY.md](SECURITY.md) describes, and never in an issue.

The bar every change meets is in [docs/PRINCIPLES.md](docs/PRINCIPLES.md):
one command to run, zero runtime dependencies, fast and cheap when idle,
visible in `--demo`, no telemetry, a privacy canary for everything that leaves
a machine, numbers that reconcile, accessible, and green on Linux, macOS and
Windows. CI checks each of those it can.

## Where to start

Issues labelled [`good first issue`](https://github.com/SamSnead85/agent-console/labels/good%20first%20issue)
are small, self-contained and described well enough to start without asking.
Each says which file to look at and how to know it works. Comment on one to
take it, so two people don't do the same work.

## Setup

You need Node.js 22 or newer and Git. Nothing else gets installed, because the
project has no dependencies.

```sh
git clone https://github.com/SamSnead85/agent-console.git
cd agent-console
node bin/agent-console.mjs --demo --open   # synthetic data; reads nothing of yours
node bin/agent-console.mjs --open          # your own machine's sessions
```

## Tests

There is no install step (zero dependencies): run `npm test` directly after cloning.

```sh
npm test                          # the whole suite
node --test test/hub-e2e.test.js  # one file
npm run smoke:pack                # pack, install into a scratch prefix, start in demo mode
```

Both must pass before a pull request is merged. CI runs them on macOS, Linux and
Windows with Node 22 and 24. A bug fix comes with a test that fails without it.

CI also checks what a pull request publishes, since this repository is public:
no secrets, no personal paths, private email addresses or machine names, and
no image metadata, in the files, in every commit, and in the title and
description. A pull request that changes what people run adds a line to
`CHANGELOG.md`, and one that changes the interface retakes its screenshots from
`--demo` or says they still match.

## The privacy invariant

This is the rule every change has to keep. **Only counts, model ids, minute
timestamps and salted hashes leave a machine.** No prompt, reply, thinking,
tool input or output, file path, file name, file contents, branch, command line
or credential.

- `projectRecord` in `lib/collector/collector.js` is the only way a record
  leaves a machine. Anything it doesn't copy doesn't go.
- A change to what leaves must update
  [docs/COLLECTOR-CONTRACT.md](docs/COLLECTOR-CONTRACT.md) and the canary checks
  in `test/hub-e2e.test.js` in the same pull request. Any new opt-in has to be
  off by default, like `--share-project-names`.
- The console and every administrative action stay on the loopback listener,
  behind the sign-in cookie. The reporting port serves only the join page, the
  join exchange and ingestion; don't add anything to it.
  `test/security.test.js` holds each of these.
- The pages load nothing from another origin: no CDN, font service, analytics
  or telemetry. `test/security.test.js` checks this too.
- The console never serves code. Every command it prints installs the package
  from the GitHub release.
- Fixtures are synthetic. Don't commit real transcripts, screenshots of real
  sessions, tokens, join codes, hostnames, usernames or customer data. Use
  `--demo` for screenshots.

## Measurement rules

Every number needs a source, a scope and a definition. Unknown is not zero: a
missing token class makes a total a floor, and an unpriced model stays out of
the dollar figure and is named. [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) has
the details.

## Interface

Keep it compact and readable in both themes. Check any screen you change at
1440×900, 1280×800 and phone width, with no console errors. Any new dependency
or background activity needs a stated reason.

## Pull requests

Describe what changes for the person using the console and how you verified it,
and add a line under the next version in [CHANGELOG.md](CHANGELOG.md). Contributions
are accepted under the project's [MIT licence](LICENSE).
