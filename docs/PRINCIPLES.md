# Principles

These are the bar every change to Agent Console meets. They exist so that the
console stays something an engineer can run in one line, trust with their
machine, and recommend to a colleague. Where a rule can be checked by a
machine, CI checks it, and this page says which job does.

## 1. One command to run

`npx` with the release link, and the console opens, signed in, reading this
machine. There is no account, no config file, no build step, and nothing else
to install beyond Node.js. The README's install line is run against the
published release in CI (`README install line`), and a unit test holds its
version to `package.json`.

## 2. Zero runtime dependencies

`dependencies` in `package.json` stays empty. Everything the console needs is
in Node.js or in this repository. Development-only tools are fine in CI and
never ship in the package. `npm run smoke:pack` installs the packed tarball
into an empty prefix and starts it.

## 3. Fast from a cold start, cheap when idle

The console answers within a second of its first start, and it stays
responsive while it reads a month of heavy history for the first time. After
that first read, a pass costs what changed, not what exists: an idle console
reads and writes next to nothing. The budgets, how
they are measured, and the synthetic history they are measured on are in
[PERFORMANCE.md](PERFORMANCE.md). CI (`Performance budget`) holds the counts
that do not depend on the machine: bytes read and written, files opened,
lines parsed.

## 4. Every feature is visible in `--demo`

`--demo` shows a synthetic team with every panel filled, reads nothing from
the machine, and stamps every generated figure DEMO. A new feature appears
there too, so anyone can see it in thirty seconds without trusting it with
their data. A test starts `--demo` with every console option and fails if an
option is added without a demo check (`test/demo-flags.test.js`).

## 5. No telemetry, ever

The console makes no request to any host but the ones you point it at: no
analytics, no update check, no crash reporting, no fonts or scripts from a
CDN. A reporter talks only to the console whose join link it was given.
`test/security.test.js` checks the pages load nothing from another origin.

## 6. Only counts leave a machine, and a canary proves it

What a reporter sends is token counts, model ids, minute timestamps and salted
hashes. Nothing else crosses the wire: no prompt, reply, file path, file
content, branch, command or credential. `projectRecord` is the only door, and
`docs/COLLECTOR-CONTRACT.md` names every field. The privacy canary
(`test/hub-e2e.test.js`) pushes transcripts full of planted canaries through
real processes and reads every request whole, every answer, every console read
and every file kept. A new field that leaves a machine, or a new route, extends
the canary in the same pull request, and anything new that leaves is opt-in.

## 7. Every number reconciles

A figure on screen has a source, a scope and a definition
([MEASUREMENTS.md](MEASUREMENTS.md), [accounting.md](accounting.md)). Unknown is
never shown as zero, and an unpriced model is named, not priced at $0. The
conformance suite (`test/conformance/`) holds the collector, the hub and the
screen to totals summed from ground truth, to the token.

## 8. Accessible

The console works from the keyboard with visible focus, meets WCAG AA
contrast in light and dark, and honours `prefers-reduced-motion`.
`test/accessibility.test.js` checks each of these.

## 9. Linux, macOS and Windows, all green

CI runs the whole suite on all three with the supported Node.js versions. A
change that only works on one is not finished.

## 10. The README and screenshots match the product

When the interface changes, the README and its screenshots change in the same
pull request. Screenshots come from `--demo` and carry no metadata. A pull
request that changes the interface without changing a screenshot says so
explicitly (`PR checks`).

## 11. Releases people can check

Versions follow [SemVer](https://semver.org). CI builds each release's package
from its tag and attaches it with a SHA-256 checksum and a signed build
provenance attestation (`gh attestation verify`). Every user-visible change
has a plain-language line in [CHANGELOG.md](../CHANGELOG.md) (`PR checks`).

## 12. Security reports are answered on a clock

[SECURITY.md](../SECURITY.md) says how to report privately and how quickly
each step happens. The repository itself passes the public-safety checks on
every push: no secrets, no personal paths or addresses, no machine names, no
image metadata.
