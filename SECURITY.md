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

## What happens after you report

| Step | Within |
| --- | --- |
| We confirm we have your report | 3 business days |
| We tell you whether we can reproduce it, and how severe we think it is | 7 days |
| A fixed release for a critical or high-severity issue | 30 days |
| A fixed release for anything else | 90 days |

We keep you updated in the advisory until it is fixed, credit you in the
release notes unless you would rather we didn't, and publish the advisory
when the fixed release is out. If a fix will take longer than these times, we
say why in the advisory and agree a disclosure date with you.

## Supported versions

Fixes go into the latest release. Older releases are not patched, so upgrade to
the latest release before you report.

## How the console is protected

**Metadata only.** What leaves a machine is token counts, model ids, minutes and
hashes. One allowlist decides that (`projectRecord` in
`lib/collector/collector.js`), and an end-to-end test checks every request that
crosses the wire.

**Two listeners.** The console (its pages, its data, making join links,
removing machines) listens on 127.0.0.1 only, on its own port. Every console
API call needs the sign-in cookie, a loopback connection with a loopback Host
header (which also defeats DNS rebinding) and no proxy headers (`Forwarded`,
`X-Forwarded-For`, `Via` and the like are refused). Other machines talk to a
second port, which serves only the join page, the join exchange and
token-checked reporting. Nothing of the console is on it, whatever `--listen`
says.

When `--interop` is enabled, its loopback `/metrics` and telemetry ingest
paths refuse every request (`401`) until a dedicated scrape token, derived
from the console key, is available; the console key itself is never accepted
on them. Ingest will also require `X-Agent-Console-Interop: 1` and rejects browser
`Origin` headers. These paths are disabled without `--interop` and never
appear on the reporting listener.

**Signing in.** The console makes a random key on first start (`admin.key` in
its state directory, mode 600). A single-use sign-in link, printed at start and
opened by `--open`, starts a session for that browser: a random id in an
HttpOnly, SameSite=Strict cookie that lasts 30 days. The console keeps only a
verifier of each session (an HMAC under the key, in `sessions.json`, mode 600);
**Sign out** ends one, and a new key ends them all. Each state directory's
cookie has a name of its own, so two consoles on one computer do not share or
overwrite it. A browser sends a 127.0.0.1 cookie to every port on that address,
so another local web server you visit can see it; that is why it is random per
browser, ends with **Sign out** and expires. Only someone who can read the key
file, or who has a sign-in link, can sign in.

**A second start.** Starting the console again while it runs asks the running
one for a sign-in link, and never sends the key to do it. The running console
issues a single-use nonce; the second start answers with an HMAC of it under
the key, bound to the port it connected to; the console answers with an HMAC of
its own, which the second start checks before it prints a link or opens the
browser. A program that took the port first learns nothing and gets nothing
opened, and a proof relayed to the console from another port is refused.

**TLS, pinned.** The console makes its own certificate on first start and puts
its SHA-256 fingerprint in every join link. Joining and reporting go over TLS,
and the reporter accepts that certificate only: a different machine answering
at that address gets nothing.

**The join page.** A join link opens a page on the console's reporting port,
served over plain HTTP so a browser opens it without a certificate warning. The
code is in the link's fragment, which a browser never sends. The page hands out
a command to paste into a terminal, so it builds that command only from what it
can check: the release's download link, and a join link it rebuilds from its
own address and a fragment that must be exactly a code and a fingerprint. Every
character of that link must be one no shell gives a meaning to, and it goes in
single quotes, which sh, bash, zsh, fish and PowerShell all take literally.
A plain-HTTP page can still be changed by anyone who can change traffic on the
network, so the page is not what to trust. **Add a machine** leads with the
command itself: it is built on the console's own computer, and its owner sends
it over whatever channel they already trust to carry the link. On a network you
do not trust, send the command rather than the link. Whoever joins should run
the command they were sent, and check that it starts with
`npx --yes https://github.com/SamSnead85/agent-console/releases/download/` and
ends with the link in single quotes, with nothing after it.

**No code from the console.** The console never serves Agent Console itself.
Every command it prints installs the package from its GitHub release over
HTTPS. From 0.2.1 on, CI builds each release's package, attaches its SHA-256
checksum and records a signed build provenance attestation for it (see the
README's "Checking a download").

**Joining.** A join link carries a 128-bit code; the eight-character code for
typing by hand exists too. Either works once and lives at most an hour. Join
attempts are counted before they are read, ten per address and sixty in total
per ten minutes. The console stores only SHA-256 verifiers of codes and device
tokens, in files with mode 600.

**Reporting.** Each machine has its own bearer token; **Remove** revokes it at
once. Every record is checked for its exact shape before it is stored: exact
keys, ids and hashes of exactly 64 hex characters, plain model ids and labels,
minute timestamps, non-negative counts. Each machine may send 600 batches a
minute and 250,000 records a day. Callers outside private networks (RFC 1918,
CGNAT ranges such as Tailscale, link-local, IPv6 unique-local) are refused
unless the console was started with `--allow-public`.

**Storage.** Usage is kept one file per day for the retention period (8 days by
default), read back line by line with over-long or malformed lines skipped, and
deleted a day at a time. Derived state lives outside any repository
(`~/.agent-console/`); uninstalling does not delete it.

**The reporter.** Everything a console sends back is checked before use:
identifiers must have their exact shape, so none can steer a file path, and
text has control characters removed before it is printed, so none can drive
the terminal. Project hashes use a key only that machine holds. `leave`
deletes everything the enrolment left on the machine.

Known credential patterns are redacted from the console's answers before they
reach a browser; redaction cannot recognise every private business detail, so
use demo mode for screenshots and presentations.
