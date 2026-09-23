# Security

## Reporting a vulnerability

Report it privately through GitHub Security Advisories:
[**Security → Report a vulnerability**](https://github.com/SamSnead85/agent-console/security/advisories/new).
Only the maintainers can read the report, and the advisory is where the fix and
the disclosure are coordinated. Please do not open a public issue for a
vulnerability.

Include the affected version (the console's footer shows it), your operating
system and Node.js version, and a reproduction that uses synthetic data. Never
include real transcripts, device tokens, join links or codes, credentials or
customer data. `--demo` is useful for reproductions and screenshots.

## Supported versions

Fixes go into the latest release. Older releases are not patched, so upgrade to
the latest release before you report.

## What the console protects, and how

Agent Console reads local session logs that may contain private work. What it
takes from them is metadata only: token counts, model ids, minutes and salted
hashes. One allowlist decides that (`projectRecord` in
`lib/collector/collector.js`), and an end-to-end test proves it.

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
they reach a browser. Redaction cannot recognise every private business detail,
so use demo mode for screenshots and presentations. Derived state lives outside
the repository (`~/.agent-console/`), and uninstalling does not delete it.
