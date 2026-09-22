# Security

Agent Console reads local session logs that may contain private work. What it
takes from them is metadata only — token counts, model ids, minutes and salted
hashes — and that is decided in one allowlist (`projectRecord` in
`lib/collector/collector.js`), proven by an end-to-end test.

**The console answers only on the computer it runs on.** Every page, API and
administrative action (making join links, removing machines) requires a
loopback connection carrying a loopback Host header, which also defeats DNS
rebinding. That holds whatever `--listen` says.

**`--listen` opens four things to the network, nothing more:** the join page,
the package tarball the join command installs, the join exchange (a single-use
code, 30 minutes, rate-limited per address) and ingestion (a per-device bearer
token, rate-limited, strictly validated: exact record keys, 64-character salted
hashes, minute timestamps, non-negative counts, fixed provenance). The hub stores
only SHA-256 verifiers of device tokens and join codes, in files with mode 600.

**The wire is plain HTTP.** The reporter accepts it only for loopback and
private-network addresses unless `--allow-http` is passed. Run the hub on a
network you trust, or put it behind a VPN (Tailscale, WireGuard), a TLS proxy,
or an SSH tunnel.

**Do not expose the console itself** (for example by proxying port 6787 onto a
public interface). To view it remotely, use an SSH tunnel to its loopback port.

Known credential patterns are redacted from the Projects view and `/api` before
they reach a browser; redaction cannot identify every private business detail.
Use demo mode for screenshots and presentations. Derived state lives outside the
repository (`~/.agent-console/`); uninstalling does not delete it.

Report vulnerabilities using this repository's GitHub private vulnerability
reporting feature. Include a synthetic reproduction and the affected version. Do
not submit real transcripts, tokens, credentials or customer data in issues.
