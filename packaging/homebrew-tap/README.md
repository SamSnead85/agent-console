# LockedIn Labs Homebrew tap

Homebrew formulae for [Agent Console](https://github.com/SamSnead85/agent-console),
local fleet accounting for Claude Code and Codex by LockedIn Labs.

```sh
brew install SamSnead85/tap/agent-console
agent-console --open
```

The formula installs the release's standalone executable for your machine
(macOS on Apple silicon or Intel, Linux on arm64 or x64). It is Node.js with
the console inside, so nothing else is needed. On macOS the executable is
signed with an Apple Developer ID and notarized by Apple.

Homebrew checks every download against the SHA-256 in the formula, and those
values are copied from the release's own `SHA256SUMS`, never computed here.
To check a download yourself:

```sh
gh attestation verify "$(brew --cache agent-console)" -R SamSnead85/agent-console
```

Upgrade with `brew upgrade agent-console`; remove with
`brew uninstall agent-console` (the console's data in `~/.agent-console/` is
yours and stays).

## How this tap is updated

The formula is rendered, never hand-edited, by the Agent Console repository
after each release:

```sh
scripts/update-homebrew-tap.sh vX.Y.Z /path/to/homebrew-tap          # render, check, commit
scripts/update-homebrew-tap.sh vX.Y.Z /path/to/homebrew-tap --push   # and push
```

It downloads the release's `SHA256SUMS` and the four archives, checks each
archive against it and against its signed build attestation, renders
`Formula/agent-console.rb` from the template in
`packaging/homebrew-tap/Formula/agent-console.rb.in`, and commits it.

Agent Console is MIT licensed. Issues belong in the
[Agent Console repository](https://github.com/SamSnead85/agent-console/issues).
