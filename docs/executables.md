# Standalone executables

For a computer without Node.js. Each release built with
[`binaries.yml`](../.github/workflows/binaries.yml) carries, beside the package,
one executable per platform: Node.js 24 (LTS) with the release package inside,
as a single file. It is the same program the one-line `npx` install runs, and it
needs nothing else installed.

| File on the release page | For |
| --- | --- |
| `agent-console-darwin-arm64`, `agent-console-darwin-arm64.tar.gz` | macOS, Apple silicon |
| `agent-console-darwin-x64`, `agent-console-darwin-x64.tar.gz` | macOS, Intel |
| `agent-console-linux-x64`, `agent-console-linux-x64.tar.gz` | Linux, x64 |
| `agent-console-linux-arm64`, `agent-console-linux-arm64.tar.gz` | Linux, arm64 |
| `agent-console-win32-x64.exe` | Windows, x64 (Windows 11 on Arm runs it under emulation) |

Each executable is about 115 MB; a `.tar.gz` is about 40 MB and holds the same
executable with its execute permission kept, `LICENSE`, Node.js's licence as
`LICENSE.node`, and `THIRD_PARTY_NOTICES.md`.

```sh
tar xzf agent-console-darwin-arm64.tar.gz
./agent-console --open
```

A bare executable downloaded in a browser loses its execute permission on macOS
and Linux; `chmod +x agent-console-darwin-arm64` gives it back.

## Check a download before you run it

Every file is listed in the release's `SHA256SUMS` and covered by the same
signed build attestation as the package:

```sh
shasum -a 256 agent-console-darwin-arm64       # must match its line in SHA256SUMS
gh attestation verify agent-console-darwin-arm64 -R SamSnead85/agent-console
```

On Windows, `Get-FileHash agent-console-win32-x64.exe` prints the same hash in
upper case.

## Signed or not, plainly

The release page says beside each file whether it is signed, and the release
notes say it per platform, from the same record the build wrote after signing.

- **macOS: signed and notarized**, from 0.4.0. Each
  macOS executable is signed with an Apple Developer ID under the hardened
  runtime, with a secure timestamp and the identifier
  `ai.lockedinlabs.agent-console`, then notarized by Apple. It opens without a
  Gatekeeper warning however it arrives: `install.sh`, Homebrew, or a browser
  download. To check it yourself:

  ```sh
  codesign -dv agent-console-darwin-arm64                  # TeamIdentifier=643FW3ZH6M
  spctl --assess --type install -vv agent-console-darwin-arm64   # source=Notarized Developer ID
  ```

  A bare executable cannot carry its notarization ticket inside it, so the
  first start on a Mac asks Apple for the ticket; a Mac that is offline the
  first time it runs a browser-downloaded copy cannot confirm it. (`spctl
  --type execute` answers *does not seem to be an app* for every command-line
  program, notarized or not; `--type install` is the assessment that applies.)

  Releases up to 0.3.0 are unsigned: they carry only the ad-hoc signature Apple
  silicon requires of every program. Fetched with `curl` or Homebrew they run
  as they are; downloaded in a browser, macOS stops their first start. After
  checking the hash and attestation, clear the quarantine on that one file
  (`xattr -d com.apple.quarantine ./agent-console-darwin-arm64`) or choose
  **Open Anyway** in **System Settings → Privacy & Security**. Never turn
  Gatekeeper off for the whole computer.
- **Windows: not code-signed.** There is no Authenticode certificate. Node.js's
  own signature is removed when the package is put inside, because the change
  breaks it, and nothing is put in its place. Install it with
  [`install.ps1`](../install.ps1) ([how](standalone-install.md#windows-powershell)):
  it checks the file against `SHA256SUMS` before copying it into place. A copy
  downloaded in a browser instead may meet SmartScreen's *Windows protected
  your PC*: check its hash, then choose **More info → Run anyway**. On a PC
  with Smart App Control turned on, Windows refuses unsigned programs
  outright; there, use Node.js, which is signed: the README's `npx.cmd` line
  or the npm package.
- **Linux:** no signing scheme applies; the hash and the attestation are the
  check.

## What it does on your computer

On its first start the executable unpacks the package, the same files as the
release tarball, each checked against the SHA-256 recorded when it was built,
into a folder named for its version and contents:

| | Folder |
| --- | --- |
| macOS | `~/Library/Caches/agent-console/` |
| Linux | `$XDG_CACHE_HOME/agent-console/`, or `~/.cache/agent-console/` |
| Windows | `%LOCALAPPDATA%\agent-console\Cache\` |

`AGENT_CONSOLE_CACHE_DIR` chooses another folder. Every start checks the files
again and puts back any that changed. Other versions' folders stay in place
because a running older console may still need them. After stopping all copies,
you can remove this cache to reclaim the space; the next start unpacks it again.
It fetches nothing, and it keeps its data where the npm package does (`~/.agent-console/`).
[uninstall.md](uninstall.md) lists everything to delete. The commands it prints, such
as the one to run it again, name the executable, never `node`.

## How it is built

[`packaging/sea/build.mjs`](../packaging/sea/build.mjs) runs `npm pack`, puts
every packed file into a [Node.js single executable
application](https://nodejs.org/api/single-executable-applications.html) with
[`main.cjs`](../packaging/sea/main.cjs) as its first script, and injects it
into a copy of the Node.js that ran the build, with
[postject](https://github.com/nodejs/postject), the one build tool, pinned by
[its lockfile](../packaging/sea/package-lock.json). CI builds each target on its
own platform's runner and starts it there with no Node.js on `PATH`
([`smoke.mjs`](../packaging/sea/smoke.mjs)): version, unpack, repair of a
changed file, preserving a running older version, demo console, sign-in, join page and a
background reporter. The package itself still has
no dependencies.

A release's macOS executables are signed and notarized on the macOS runners,
from five repository secrets: `MACOS_CERT_P12_BASE64` (the base64 of a
*Developer ID Application* certificate and its key, exported as .p12),
`MACOS_CERT_P12_PASSWORD`, `APPLE_API_KEY_P8_BASE64` (the base64 of an App
Store Connect API key), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. The
certificate goes into a throwaway keychain; `build.mjs` signs under the
hardened runtime with only the two entitlements V8 needs to compile JavaScript
([`entitlements.plist`](../packaging/sea/entitlements.plist); without
`allow-jit` Node.js cannot start), submits to Apple's notary service, checks
the ticket names the file's CDHash, and asks Gatekeeper to accept a
quarantined copy ([`notarized.mjs`](../packaging/sea/notarized.mjs); the
release asks again of the file installed from the release page). Only then
is the file labelled signed, and only then do `SHA256SUMS` and the build
attestation cover it. If any secret is missing,
the release stops before anything is built or attached; it never ships an
unsigned macOS file in place of a signed one. Pull requests build unsigned and say so;
a manual run of *Standalone executables* with **release** checked signs and
notarizes exactly as a release does, as a dry run before a tag. On a Mac with the Developer ID in its keychain,
the same build runs with `MACOS_SIGN_IDENTITY` and
`APPLE_NOTARY_KEYCHAIN_PROFILE` (a `notarytool store-credentials` profile).
