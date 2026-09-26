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
| `agent-console-win32-x64.exe` | Windows, x64 |

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

Release executables are unsigned unless the release notes say *signed and notarized*; v0.3.0 is unsigned.

- **macOS: unsigned** unless the release page says *signed and notarized*.
  Unsigned means it carries only the ad-hoc signature Apple silicon requires of
  every program, not a Developer ID. Fetched with `curl`, or by Homebrew for a
  formula, it runs as it is: macOS quarantines files that apps such as browsers
  and mail save. Downloaded in a browser, macOS stops its first start. After checking its hash
  and attestation, either clear the quarantine on that one file:

  ```sh
  xattr -d com.apple.quarantine ./agent-console-darwin-arm64
  ```

  or run it once, open **System Settings → Privacy & Security**, choose **Open
  Anyway** beside its name, and run it again. Never turn Gatekeeper off for the
  whole computer.
- **Windows: unsigned.** Node.js's own signature is removed when the package is
  put inside, because the change breaks it; there is no Authenticode signature
  in its place. If SmartScreen says *Windows protected your PC*, choose **More
  info → Run anyway**, after checking the hash.
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
again and puts back any that changed. It fetches nothing, and it keeps its data
where the npm package does (`~/.agent-console/`). The commands it prints, such
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
changed file, demo console, sign-in and join page. The package itself still has
no dependencies.

Signing with a Developer ID and notarization need five repository secrets:
`APPLE_DEVELOPER_ID_P12` (the base64 of a *Developer ID Application*
certificate exported as .p12), `APPLE_DEVELOPER_ID_P12_PASSWORD`,
`APPLE_NOTARY_KEY_P8` (the base64 of an App Store Connect API key),
`APPLE_NOTARY_KEY_ID` and `APPLE_NOTARY_ISSUER`. With all five set, a release's
macOS executables are signed under the hardened runtime
([`entitlements.plist`](../packaging/sea/entitlements.plist)) and notarized
before they are attached; without them, they are labelled unsigned.
