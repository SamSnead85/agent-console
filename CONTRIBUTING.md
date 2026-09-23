# Contributing to Agent Console

Thanks for helping. Agent Console is maintained by
[LockedIn Labs](https://lockedinlabs.ai). Everyone who takes part agrees to the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as
[SECURITY.md](SECURITY.md) describes, and never in an issue.

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

```sh
npm test                          # the whole suite
node --test test/hub-e2e.test.js  # one file
npm run smoke:pack                # pack, install into a scratch prefix, start in demo mode
```

Both must pass before a pull request is merged. CI runs them on macOS and Linux
with Node 22 and 24. On Windows it runs the hub and reporter tests and the smoke
test. A bug fix comes with a test that fails without it.

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
- The console and every administrative action answer on loopback only. Don't
  widen what `--listen` exposes.
- The page loads nothing from another origin: no CDN, font service, analytics
  or telemetry. `test/server.test.js` checks this.
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
and add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md). Contributions
are accepted under the project's [MIT licence](LICENSE).
