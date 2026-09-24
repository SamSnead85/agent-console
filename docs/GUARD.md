# Local Guard · policy version 1

Guard is optional and local. `guard init` writes `~/.agent-console/guard/policy.json`
and a private salt. It does not edit an agent's settings. The default policy
has safe example rules; edit it before or after installing the hook. The file
must match [the version 1 schema](policy.schema.json). Each rule chooses one
action (`allow`, `ask`, `block`) for a tool and a named pattern. `*` matches
all supported tools. More restrictive matching actions win. `on_error`
defaults to `ask` when the policy is readable, and unreadable policies are
also treated as `ask`.

```json
{
  "version": 1,
  "on_error": "ask",
  "rules": [
    { "id": "force-push", "tool": "*", "pattern": "force-push", "action": "block" }
  ],
  "models": [
    { "projectHash": "<64 lowercase hex characters from guard project-hash>",
      "allowedModelIds": ["claude-sonnet-5"], "action": "block" }
  ]
}
```

The example placeholder is explanatory, not a valid hash; replace it with the
output of `node bin/agent-console.mjs guard project-hash <directory>`. Model
rules match the session's exact working-directory hash and canonical model ID.
Only Claude Code exposes a model-switch hook here. Its `PreModelSwitch` hook
can block or ask when a model leaves that allow-list.

## Install and undo

`guard install` adds `PreToolUse` and `PreModelSwitch` command hooks to
`~/.claude/settings.json`. `guard install-codex` separately adds a `PreToolUse`
command hook to `~/.codex/hooks.json`; Codex requires review and trust through
`/hooks` before it runs. Each command prints the settings file it changed and
the exact backup location. `guard uninstall` and `guard uninstall-codex`
remove only Agent Console's handlers and preserve unrelated hooks. The
policy, salt and local decision log remain so you can inspect them; deleting
the guard directory after uninstall removes that local data.

Codex's native sandbox (`read-only`, `workspace-write`, or unrestricted) and
approval policy are separate controls. Keep them enabled. As documented in
[Codex Hooks](https://developers.openai.com/en-US/docs/hooks), `PreToolUse`
can deny a call, but its `ask` decision is currently unsupported and would
let the call continue. The Codex adapter therefore maps guard `ask` to a
**block** and logs the applied action. Codex's hook reference currently has
no `PreModelSwitch` event, so the model allow-list is a Claude Code rule.
The Claude hook uses the
[Claude Code hook events and decisions](https://code.claude.com/docs/en/hooks).
These source capabilities were checked 23 September 2026.

## Scope and privacy

The classifier recognizes common shell forms of force-push, protected-branch
push, recursive deletion outside the working project, download-to-interpreter
pipelines, credential reads, and production migrations. It is a best-effort
local command check, not a shell parser or an operating-system boundary;
scripts, aliases, indirect file references and tools without the expected
arguments can evade a pattern. The agent's native approval and sandbox remain
the stronger boundaries. A command-hook startup failure or timeout is
controlled by the host's hook runtime, not by `on_error`; Claude Code
currently lets a timed-out `PreToolUse` call continue.

The hook has no network access or network dependency. It records only time,
rule ID and applied action in `~/.agent-console/guard/decisions.ndjson` and
shows recent decisions in the signed-in local console. It never records
command text, a file path, or a credential. These local decision records are
not included in reports to another machine. The exported analysis functions
accept only named facts, salted hashes and model IDs.
