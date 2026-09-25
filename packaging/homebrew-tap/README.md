# Agent Console Homebrew tap (handoff)

This directory is the source for the public `SamSnead85/homebrew-tap` repository.
The orchestrator creates that repository and copies the rendered formula and this
README after a release contains the standalone archives and `SHA256SUMS`.

Render the formula from the release checksums:

```sh
node scripts/render-homebrew-formula.mjs v0.3.0 SHA256SUMS Formula/agent-console.rb
```

Run that command from the Agent Console repository. Inspect the generated
formula, verify the four archive digests against the release, then put
`Formula/agent-console.rb` in the tap repository. Do not commit the `.rb.in`
template as the active formula.

Once the tap is public and its formula is present:

```sh
brew install lockedinlabs/tap/agent-console
agent-console --open
```

The `lockedinlabs/tap` command resolves to the `lockedinlabs/homebrew-tap`
GitHub repository. If the orchestrator creates only
`SamSnead85/homebrew-tap`, use `brew install SamSnead85/tap/agent-console`
until the LockedIn Labs organisation owns or mirrors the tap. Homebrew installs
the exact platform archive listed in the formula and checks its SHA-256.
