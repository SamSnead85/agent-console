# Reporting in the background

A reporter runs only while something keeps it running. There are two ways to
keep one going without a terminal window open.

In the commands below, `agent-console` stands for the full command you were
sent: `npx --yes <release link>`, or `node <path>/bin/agent-console.mjs` from a
download. Do not type the short name on its own. It is not on your PATH, and
`npx agent-console` would fetch an unrelated package.

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

Each of the examples below runs `report` in the foreground. The service
manager keeps it running and restarts it if it stops. Join once by hand first,
so the enrolment exists. Use absolute paths: service managers do not read your
shell's PATH. Find them with `command -v node` and `command -v npx`.

Every example uses a report interval of 60 seconds. At that interval or less
the console shows the machine as **reporting**, and calls it **silent** after
90 seconds without a report. With `--interval` over 60, it shows the machine
as **reporting periodically**, and waits two hours before calling it silent.

### macOS: launchd

Save as `~/Library/LaunchAgents/ai.lockedinlabs.agent-console.reporter.plist`,
with your own paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.lockedinlabs.agent-console.reporter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/agent-console/bin/agent-console.mjs</string>
    <string>report</string>
    <string>--interval</string><string>60</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/agent-console-reporter.log</string>
  <key>StandardErrorPath</key><string>/tmp/agent-console-reporter.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.lockedinlabs.agent-console.reporter.plist
launchctl bootout gui/$(id -u)/ai.lockedinlabs.agent-console.reporter      # to stop it
```

### Linux: a systemd user service

Save as `~/.config/systemd/user/agent-console-reporter.service`:

```ini
[Unit]
Description=Agent Console reporter
After=network-online.target

[Service]
ExecStart=/usr/bin/node %h/agent-console/bin/agent-console.mjs report --interval 60
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-console-reporter
journalctl --user -u agent-console-reporter -f        # its output
systemctl --user disable --now agent-console-reporter # to stop it
```

`Restart=on-failure` does not restart a reporter that the console removed.
That reporter exits with code 3, so set `RestartPreventExitStatus=3` if your
systemd counts that as a failure.

### Windows: Task Scheduler

In PowerShell, with your own paths:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
  -Argument '"C:\Users\you\agent-console\bin\agent-console.mjs" report --interval 60'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "Agent Console reporter" -Action $action -Trigger $trigger -Settings $settings
Unregister-ScheduledTask -TaskName "Agent Console reporter" -Confirm:$false   # to stop it
```

## Exit codes

A service manager can act on these:

| Code | Meaning |
| --- | --- |
| 0 | stopped on request (`stop`, `leave`, Ctrl+C) |
| 1 | could not start (for example, the console could not be reached to join) |
| 2 | a mistake in the command: an unknown option, or a value out of range |
| 3 | the console removed this machine: join again with a new link |
| 4 | another reporter is already running for this state directory |
| 5 | `--once` could not deliver |
