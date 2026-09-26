# Agent Console Homebrew tap

This directory is the source for the Agent Console Homebrew tap repository
(`SamSnead85/homebrew-tap`). A maintainer publishes the tap after a release
carries the standalone archives and `SHA256SUMS`.

Render the formula from the release checksums, from the Agent Console
repository:

```sh
node scripts/render-homebrew-formula.mjs v0.3.0 SHA256SUMS Formula/agent-console.rb
```

Inspect the generated formula, check its four archive digests against the
release, then put `Formula/agent-console.rb` in the tap repository. Do not
commit the `.rb.in` template as the active formula.

Once the tap is public and its formula is present:

```sh
brew install SamSnead85/tap/agent-console
agent-console --open
```

`SamSnead85/tap` resolves to the `SamSnead85/homebrew-tap` GitHub repository.
Homebrew installs the exact platform archive listed in the formula and checks
its SHA-256.
