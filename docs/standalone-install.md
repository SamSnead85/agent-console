# Install a standalone executable

The release executables do not require Node.js. They are prepared for macOS
(Apple silicon and Intel; signed with an Apple Developer ID and notarized from
0.4.0), Linux (arm64 and x64, glibc 2.28 or newer), and Windows (x64, which
Windows 11 on Arm also runs; **not code-signed**). Use the assets attached to
a release; source ZIP files are not executables. Only a release built with
`binaries.yml` carries them (0.3.0 and later); for an earlier release the
installers stop without installing anything.

Both installers download the executable for this computer and the release's
`SHA256SUMS`, and install nothing unless the SHA-256 matches. Neither asks for
administrator rights, and neither uses the GitHub API, so a busy office network
never meets its rate limit. To remove what they install, see
[uninstall.md](uninstall.md).

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
when set. Set `AGENT_CONSOLE_INSTALL_DIR` to choose a different user directory,
and `AGENT_CONSOLE_VERSION=vX.Y.Z` to install a release other than the latest.

`~/.local/bin` is not on the default `PATH` on macOS, nor on some Linux
distributions. When the folder is not on yours, the installer says so and
prints the one line that adds it for your shell, for example for zsh:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

(bash: `~/.bash_profile` on macOS, `~/.bashrc` on Linux; fish:
`fish_add_path ~/.local/bin`.) Open a new terminal afterwards. Until then, run
it by the full path the installer printed.

On Linux the executable is Node.js 24's official build, which needs glibc 2.28
or newer. On Alpine (musl) or an older distribution such as CentOS 7 the
installer stops and says so; install Node.js 22 or newer from the
distribution there and use the `npx` line in the README.

## Windows PowerShell

The Windows executable is **not code-signed**: there is no Authenticode
certificate ([why](executables.md#signed-or-not-plainly)). Install it with
this installer, which checks it against `SHA256SUMS` before it puts it in
place, or use Node.js and the npm package instead.

Download, inspect, and run the script:

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/SamSnead85/agent-console/main/install.ps1 -OutFile install.ps1
Get-Content .\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The one-line form downloads the script to a new temporary file, stops on any
error (a failed download runs nothing), checks the file arrived, runs it, and
removes it:

```powershell
& { $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; $f = Join-Path ([IO.Path]::GetTempPath()) ('agent-console-install-' + [Guid]::NewGuid().ToString('N') + '.ps1'); try { Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/SamSnead85/agent-console/main/install.ps1' -OutFile $f; if (-not (Test-Path -LiteralPath $f) -or (Get-Item -LiteralPath $f).Length -eq 0) { throw 'The installer did not download. Nothing was run.' }; powershell -NoProfile -ExecutionPolicy Bypass -File $f; if ($LASTEXITCODE -ne 0) { throw 'The installer stopped without installing.' } } finally { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }
```

The download page's copy of this command also sets `AGENT_CONSOLE_VERSION` to
the release it shows, so it installs exactly that release.

`-ExecutionPolicy Bypass` applies to that one PowerShell process only, so a
downloaded script can run on a computer whose policy would otherwise refuse
it; it changes no setting. The installer runs in Windows PowerShell 5.1, which
every Windows 10 and 11 has, and in PowerShell 7. It turns off the progress
bar that makes large downloads crawl in Windows PowerShell 5.1, and asks for
TLS 1.2, which GitHub requires.

It installs to the current user's `AppData\Local\Programs\AgentConsole` and
adds that folder to the user's `PATH` (only the user's, never the system's),
so `agent-console --open` works in any PowerShell window opened afterwards.
Set `AGENT_CONSOLE_INSTALL_DIR` to choose another user directory,
`AGENT_CONSOLE_VERSION` for another release, and
`AGENT_CONSOLE_NO_MODIFY_PATH=1` to leave `PATH` alone. It compares the SHA-256
digest using `Get-FileHash` before installing.

On Windows 11 on Arm it installs the x64 executable, which Windows runs under
emulation. Windows 10 on Arm cannot run x64 programs; there, use Node.js 22 or
newer and the `npx.cmd` line in the README.

## Behind a proxy

Corporate networks often send traffic through a proxy, and some inspect TLS
with their own root certificate. Each tool that downloads Agent Console reads
the proxy from a different place:

| What downloads | Proxy | TLS inspection |
| --- | --- | --- |
| `install.sh` (`curl`) | `HTTPS_PROXY` | `CURL_CA_BUNDLE=<company root>.pem` |
| `install.ps1` (PowerShell) | Windows' proxy settings, signed in as you | Windows' certificate store (usually already set up by IT) |
| `npx` and `npm` | `HTTPS_PROXY` (or `npm config set proxy`) | `NODE_EXTRA_CA_CERTS=<company root>.pem` |
| the check at the start of a join command (Node.js) | `HTTPS_PROXY` **and** `NODE_USE_ENV_PROXY=1` (Node.js 22.21 or newer; any 24) | `NODE_EXTRA_CA_CERTS=<company root>.pem`, or `NODE_USE_SYSTEM_CA=1` (Node.js 22.19 or newer; 24.6 or newer) to use the system's certificates |

Node.js's own downloads ignore `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is
set, so on such a network the README's `npx` line can work while a join
command stops with `fetch failed`. Set the variables in the terminal before
running the command:

```sh
export HTTPS_PROXY=http://proxy.example.com:8080 NODE_USE_ENV_PROXY=1
export NODE_EXTRA_CA_CERTS=/path/to/company-root.pem
```

```powershell
$env:HTTPS_PROXY = 'http://proxy.example.com:8080'; $env:NODE_USE_ENV_PROXY = '1'
$env:NODE_EXTRA_CA_CERTS = 'C:\path\to\company-root.pem'
```

The reporter's own connection to your console never uses a proxy: it goes
straight to the console, pinned to the console's certificate, whatever these
variables say.

## Check the release yourself

The release carries `SHA256SUMS` and signed build attestations. Compare your
download's SHA-256 with the line for its exact filename in `SHA256SUMS`, then
verify the attestation with `gh attestation verify FILE -R SamSnead85/agent-console`.

The macOS executables are signed with an Apple Developer ID and notarized by
Apple from 0.4.0, so they open without a Gatekeeper warning. The Windows
executable is not code-signed; `install.ps1` is the way to install it, because
it checks the file against `SHA256SUMS` first. Signing, per platform, is
stated in each release's notes and in
[executables.md](executables.md#signed-or-not-plainly), with what to do for an
unsigned macOS download from 0.3.0 or earlier.
