# Install a standalone executable

The release executables do not require Node.js. They are prepared for macOS
(Apple silicon and Intel), Linux (arm64 and x64), and Windows (x64). Use the
assets attached to a release; source ZIP files are not executables. Only a
release built with `binaries.yml` carries them (0.3.0 and later); for an
earlier release the installers stop without installing anything.

## macOS or Linux

The short form downloads the installer and runs it from a local file:

```sh
curl -fsSLO https://raw.githubusercontent.com/SamSnead85/agent-console/main/install.sh && sh ./install.sh
```

To inspect it first, download the file, read it, then run it:

```sh
curl -fsSLO https://raw.githubusercontent.com/SamSnead85/agent-console/main/install.sh
less install.sh
sh ./install.sh
```

It installs to `~/.local/bin/agent-console`, or `$XDG_BIN_HOME/agent-console`
when set. Set `AGENT_CONSOLE_INSTALL_DIR` to choose a different user directory.
It checks the executable against the release's `SHA256SUMS` before installing.

## Windows PowerShell

Download, inspect, and run the script:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/SamSnead85/agent-console/main/install.ps1 -OutFile install.ps1
Get-Content .\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The one-line form is:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/SamSnead85/agent-console/main/install.ps1 -OutFile install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`-ExecutionPolicy Bypass` applies to that one PowerShell process only, so a
downloaded script can run on a computer whose policy would otherwise refuse
it; it changes no setting. It installs to the current user's `AppData\Local\Programs\AgentConsole`.
Set `AGENT_CONSOLE_INSTALL_DIR` to choose another user directory. It compares
the SHA-256 digest using `Get-FileHash` before installing.

## Check the release yourself

The release carries `SHA256SUMS` and signed build attestations. Compare your
download's SHA-256 with the line for its exact filename in `SHA256SUMS`, then
verify the attestation with `gh attestation verify FILE -R SamSnead85/agent-console`.

macOS builds without Apple Developer ID signing are labelled unsigned. macOS
may quarantine an unsigned download; after checking its SHA-256 and attestation,
open **System Settings → Privacy & Security** and choose **Open Anyway** for
that downloaded file. Do not use a system-wide Gatekeeper bypass.
