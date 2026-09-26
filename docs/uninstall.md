# Uninstall Agent Console

Agent Console installs nothing system-wide and needs no administrator rights:
everything it creates is in your own user account, in the places below. Work
through the three steps in order; skip what you never set up.

In the commands, `agent-console` stands for however you run it: the
standalone executable or a global npm install (`agent-console`), the release
link (`npx --yes <release link>`), or a download (`node <folder>/bin/agent-console.mjs`).
In Windows PowerShell, type `npx.cmd` and `npm.cmd` for `npx` and `npm`.

## 1. Stop what runs

**A console** running in a terminal window: press Ctrl+C there. Before that,
**Sign out** at the foot of the console ends your browser's session.

**A reporter** on a computer that reports to a console:

```sh
agent-console leave
```

It stops a reporter running in the background, tells the console this
computer has left, and deletes the enrolment (`~/.agent-console/reporter/`).
(`stop` only stops it and keeps the enrolment.)

**A service that starts the reporter at login** ([BACKGROUND.md](BACKGROUND.md)).
Remove it before anything else, or it starts the reporter again:

- macOS (launchd):

  ```sh
  launchctl bootout gui/$(id -u)/ai.lockedinlabs.agent-console.reporter
  rm ~/Library/LaunchAgents/ai.lockedinlabs.agent-console.reporter.plist
  rm -f ~/Library/Logs/agent-console-reporter.log /tmp/agent-console-reporter.log
  ```
- Linux (systemd):

  ```sh
  systemctl --user disable --now agent-console-reporter
  rm ~/.config/systemd/user/agent-console-reporter.service
  systemctl --user daemon-reload
  ```
- Windows (Task Scheduler), in PowerShell:

  ```powershell
  Stop-ScheduledTask -TaskName "Agent Console reporter" -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "Agent Console reporter" -Confirm:$false
  ```

**Project policy.** In each repository where you ran `policy apply`, run
`agent-console policy remove` from the repository root. It restores the
`.claude/` files that were there before and deletes the ones apply created.
Do this while you still have Agent Console to run it with.

## 2. Remove the program

Whichever way you installed it:

| Installed with | Remove with |
| --- | --- |
| The release link (`npx --yes <release link>`) or a join command | Nothing was installed; npm keeps a copy in its cache (below). |
| npm | `npm uninstall -g @lockedinlabs/agent-console` |
| Homebrew | `brew uninstall agent-console`, then `brew untap SamSnead85/tap` if nothing else uses the tap |
| `install.sh` | `rm ~/.local/bin/agent-console` (or the `agent-console` in `$XDG_BIN_HOME` or the `AGENT_CONSOLE_INSTALL_DIR` you chose). If you added a `PATH` line to `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` or `~/.profile` for it, delete that line. |
| `install.ps1` | The PowerShell lines below |
| Docker | `docker rm -f agent-console-hub`, `docker volume rm agent-console-state` (the hub's data), and `docker image rm ghcr.io/samsnead85/agent-console:<tag>` |
| A download or `git clone` | Delete the folder |

`install.ps1` put the executable in its own folder and that folder on your
PATH. To remove both, in PowerShell:

```powershell
$dir = Join-Path $env:LOCALAPPDATA 'Programs\AgentConsole'   # or the AGENT_CONSOLE_INSTALL_DIR you chose
Remove-Item -LiteralPath $dir -Recurse -Force
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$path = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$key.SetValue('Path', (($path -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne $dir }) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
$key.Close()
```

Or remove the folder from **Path** under *Edit environment variables for your
account* (Start, type "environment variables").

**npm's copy.** `npx` and the join command keep the package in npm's cache,
one folder per release under `_npx`. To remove those folders:

```sh
for d in "$(npm config get cache)"/_npx/*/; do
  grep -qs '"@lockedinlabs/agent-console"' "$d/package.json" && rm -r "$d"
done
```

```powershell
Get-ChildItem (Join-Path (npm.cmd config get cache) '_npx') -Directory |
  Where-Object { Select-String -Quiet -SimpleMatch -Pattern '"@lockedinlabs/agent-console"' -Path (Join-Path $_.FullName 'package.json') -ErrorAction SilentlyContinue } |
  Remove-Item -Recurse -Force
```

npm also keeps the downloaded file in its general cache; `npm cache clean --force`
empties that whole cache, for every package.

## 3. Remove its data

Everything Agent Console keeps is in one folder, `~/.agent-console/`
(`%USERPROFILE%\.agent-console\` on Windows):

| Inside it | What it is |
| --- | --- |
| `hub/` | a console's data: the metadata records, its TLS certificate and key, sign-in sessions, enrolled machines, and where it has read to in this computer's transcripts |
| `reporter/` | a reporter's enrolment, log and where it has read to (`leave` already removed these) |
| `releases/` | release files a join command checked and kept |
| `policy/` | what `policy apply` saved to restore later, and the policy hook's decision log |

Delete the folder to remove all of it. If you started a console or a reporter
with `--state-dir`, or set `AGENT_CONSOLE_STATE_DIR` or
`AGENT_CONSOLE_REPORTER_DIR`, delete that folder too.

```sh
rm -r ~/.agent-console
```

```powershell
Remove-Item -LiteralPath (Join-Path $HOME '.agent-console') -Recurse -Force
```

**The standalone executable's unpacked copy.** On its first start the
executable unpacks the package into a cache folder
([executables.md](executables.md#what-it-does-on-your-computer)):

| | Delete |
| --- | --- |
| macOS | `~/Library/Caches/agent-console/` |
| Linux | `~/.cache/agent-console/` (or `$XDG_CACHE_HOME/agent-console/`) |
| Windows | `%LOCALAPPDATA%\agent-console\` |

or the `AGENT_CONSOLE_CACHE_DIR` you set.

Your Claude Code and Codex history (`~/.claude/`, `~/.codex/`) is theirs, not
Agent Console's: it read those files and never changed them.

**Firewall permission.** If you allowed incoming connections when macOS or
Windows asked (to let other computers report to your console), the system
keeps that permission. Remove it in **System Settings → Network → Firewall →
Options** on a Mac, or in **Windows Defender Firewall → Allow an app through
firewall** on Windows (the entry is named after `node` or `agent-console`).
