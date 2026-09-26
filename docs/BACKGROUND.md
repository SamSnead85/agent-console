# Reporting in the background

A reporter runs only while something keeps it running. There are two ways to
keep one going without a terminal window open.

In the commands below, `agent-console` stands for the command you run it
with: just `agent-console` if you installed the standalone executable, the npm
package or the Homebrew formula; the full command you were sent
(`npx --yes <release link>`); or `node <path>/bin/agent-console.mjs` from a
download. Never type `npx agent-console`: that name on the npm registry is an
unrelated package.

## Until you log out: `--background`

```sh
agent-console join '<join link>' --background
agent-console report --background       # later, with the saved enrolment
```

The join happens in the window, so you see at once if it worked. Then the
reporter moves to a process of its own, and the window can close. Its output
goes to `reporter.log` in the state directory (`~/.agent-console/reporter/`
unless you pass `--state-dir`).

```sh
agent-console stop     # stops it; this machine stays enrolled
agent-console leave    # stops it, takes this machine off the console, deletes the enrolment
```

One reporter runs per state directory. A second `report` is refused and names
the process that is already running. A background reporter does not start
again after the computer restarts. For that, use your system's service
manager, as below.

## At every login: a service

A service manager starts `report` at login and keeps it running. Join once by
hand first, so the enrolment exists, then stop that reporter (`agent-console
stop`, or Ctrl+C): one reporter runs per enrolment.

**The command the service runs** is the one the reporter printed when it
joined, under *to start again later*, with `report`. Service managers read
neither your shell's `PATH` nor `~`, so every path is absolute:

| You run Agent Console as | The service runs | Needs `PATH` |
| --- | --- | --- |
| the standalone executable or Homebrew | `/Users/you/.local/bin/agent-console report --interval 60` (the path `command -v agent-console` prints) | no |
| the npm package | `/usr/local/bin/agent-console report --interval 60` (the path `command -v agent-console` prints) | yes: the folder `node` is in |
| the release link or a join command | `/usr/local/bin/npx --yes file:/Users/you/.agent-console/releases/lockedinlabs-agent-console-<version>.tgz report --interval 60` (the checked file the join command kept) | yes: the folder `node` is in |
| a download | `/usr/local/bin/node /Users/you/agent-console/bin/agent-console.mjs report --interval 60` | no |

`npx` and the npm package's command are scripts that start `node` from
`PATH`, so for them the service must be given a `PATH` that holds `node`
(`dirname "$(command -v node)"` prints its folder).

Every example uses a report interval of 60 seconds. At that interval or less
the console shows the machine as **reporting**, and calls it **silent** after
90 seconds without a report. With `--interval` over 60, it shows the machine
as **reporting periodically**, and waits two hours before calling it silent.

A service restarts a reporter that failed, and leaves alone one that stopped
for a reason: stopped on request (0), a mistake in its command (2, including
`report` after `leave`), removed by the console (3), or another reporter
already running (4). See [exit codes](#exit-codes).

### macOS: launchd

Save as `~/Library/LaunchAgents/ai.lockedinlabs.agent-console.reporter.plist`,
with your own user name and command. The short `/bin/sh` program in it runs
the reporter, passes on a request to stop, and turns the "stopped for a
reason" codes into a clean exit, because launchd can restart only on a
non-zero exit (`SuccessfulExit`) and cannot be told which codes to leave
alone:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.lockedinlabs.agent-console.reporter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>"$0" "$@" &amp; child=$!
trap 'kill -TERM "$child" 2>/dev/null' TERM INT HUP
wait "$child"; status=$?
while kill -0 "$child" 2>/dev/null; do wait "$child"; status=$?; done
case "$status" in 2|3|4) exit 0 ;; esac
exit "$status"</string>
    <string>/Users/you/.local/bin/agent-console</string>
    <string>report</string>
    <string>--interval</string><string>60</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/agent-console-reporter.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/agent-console-reporter.log</string>
</dict>
</plist>
```

For the npm package, the release link or a download, put that command's
words in place of the three `<string>`s after the program (one word per
`<string>`), and make sure `PATH` holds the folder `node` is in.

```sh
plutil -lint ~/Library/LaunchAgents/ai.lockedinlabs.agent-console.reporter.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.lockedinlabs.agent-console.reporter.plist
launchctl print gui/$(id -u)/ai.lockedinlabs.agent-console.reporter | grep -E 'state|last exit'
```

To stop it for good, unload it first, then leave: otherwise it starts again
at the next login.

```sh
launchctl bootout gui/$(id -u)/ai.lockedinlabs.agent-console.reporter
agent-console leave        # only if this machine should also leave the console
```

### Linux: a systemd user service

Save as `~/.config/systemd/user/agent-console-reporter.service`, with your own
command:

```ini
[Unit]
Description=Agent Console reporter
After=network-online.target

[Service]
ExecStart=%h/.local/bin/agent-console report --interval 60
# Only for the npm package or the release link: where node is.
# Environment=PATH=/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=30
# Stopped for a reason: a mistake in the command, removed by the console,
# or another reporter running. Not restarted.
RestartPreventExitStatus=2 3 4

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-console-reporter
journalctl --user -u agent-console-reporter -f        # its output
```

A user service runs while you are logged in. To keep it running after you log
out, and to start it at boot, run `loginctl enable-linger` once.

To stop it for good: `systemctl --user disable --now agent-console-reporter`,
then `agent-console leave` if this machine should also leave the console.

### Windows: Task Scheduler

In PowerShell, with your own command. This is for the executable
[`install.ps1`](standalone-install.md#windows-powershell) installs; for a
download, `-Execute` is `node.exe`'s full path and `-Argument` starts with the
full path of `bin\agent-console.mjs`:

```powershell
$action = New-ScheduledTaskAction -Execute "$env:LOCALAPPDATA\Programs\AgentConsole\agent-console.exe" `
  -Argument 'report --interval 60'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "Agent Console reporter" -Action $action -Trigger $trigger -Settings $settings
```

Without `-AllowStartIfOnBatteries` and `-DontStopIfGoingOnBatteries`, Task
Scheduler's defaults do not start the task on a laptop running on battery and
stop it when the power cable comes out, so the laptop quietly stops
reporting. The reporter runs in a console window that opens at login:
minimise it, but closing it stops the reporter until the next login.

To stop it for good:

```powershell
Unregister-ScheduledTask -TaskName "Agent Console reporter" -Confirm:$false
agent-console leave        # only if this machine should also leave the console
```

## Exit codes

A service manager can act on these:

| Code | Meaning |
| --- | --- |
| 0 | stopped on request (`stop`, `leave`, Ctrl+C) |
| 1 | could not start (for example, the console could not be reached to join) |
| 2 | a mistake in the command: an unknown option, a value out of range, or `report` on a machine that has not joined (or has left) |
| 3 | the console removed this machine: join again with a new link |
| 4 | another reporter is already running for this state directory |
| 5 | `--once` could not deliver |
