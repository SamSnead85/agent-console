# Agent Console policy layer

`agent-policy.yaml` is an optional policy in the repository root. It uses a
documented YAML subset: two-space nested mappings, scalar lists, inline
scalar arrays, plain or quoted strings, positive numbers, booleans, and
whole-line comments. JSON with the same fields works too. Anchors, tags,
multiline strings, and inline comments are rejected. The schema is
[`policy.schema.json`](policy.schema.json); `version: 1` is required. An
organization policy supplied explicitly by the operator overrides repository
fields recursively; arrays replace the repository array. Unknown fields fail
validation rather than being silently ignored. No policy is active merely
because a console dashboard runs.

```yaml
version: 1
on_error: ask
effort:
  default_by_task:
    search: low
    exploration: low
    log_reading: low
    code_edit: high
  max_allowlist: []
routing:
  roles:
    search:
      model: haiku
    exploration:
      model: haiku
    log_reading:
      model: haiku
    code_edit:
      model: opus
      with_verifying_test: sonnet
escalation:
  after_failures: 2
  model: opus
model_allowlist: [haiku, sonnet, opus]
budgets:
  per_run:
    tokens: 200000
    usd: 50
  per_day:
    tokens: 1000000
    usd: 200
cache:
  forbid_model_switch_in_task: true
  idle_gap_minutes: 5
gates:
  force_push: ask
  delete_outside_repo: block
  pipe_to_interpreter: ask
  credential_read: ask
  production_migration: block
```

The defaults above are the version 1 defaults. `max` effort requires the task
class in `effort.max_allowlist`. Every routed and escalation model must be in
`model_allowlist`. The per-run and per-day budgets are intent and analysis
thresholds; a tool-launch hook has no verified live token balance or price
from Claude Code, so the compiler must report hard budget enforcement as
**not enforceable yet**. Similarly, a verifying test and N failed attempts
cannot be inferred safely from an agent's launch prompt. The compiler can
publish named role agents and flag overrides; it must not assert it proved a
test or a failure count. An idle gap is an observed cache-health signal, not
an API-enforced cache TTL.

## Native controls in `policy apply`

Run `agent-console policy diff` from the repository root to preview each
create or update. `agent-console policy apply` writes repo-scoped `.claude/agents/*.md`,
`.claude/settings.json`, and a local command hook under `.claude/hooks/`.
`agent-console policy remove` restores the exact prior settings and deletes
only generated files. Use `--project <path>` to choose another repository or
`--org-policy <file>` with `diff` and `apply` to overlay organization rules.
The first apply stores original bytes in a private backup under
`~/.agent-console/policy/`; a changed generated file must be reviewed before
`remove` will restore it. Applying twice without a change is a no-op. Edit a
policy by removing the old compiled files and applying the new version.
On POSIX the backup directory and files use modes 700 and 600; on Windows
their protection follows the account's filesystem access controls.

The compiler writes named role agents with pinned model and effort, a separate
verified-code-edit role, and a named escalation role. A `PreToolUse` hook
checks explicit `Agent` model overrides and action gates on shell and file
tools; `PreModelSwitch` checks model allow-list and switches inside an active
agent. The hook classifies commands locally, including `+refspec` pushes,
outside deletes through `~`, `$HOME`, `%USERPROFILE%`, separate `rm -r -f`
flags, and long options. Its local decision log contains only a timestamp,
rule name, and action. Set `AGENT_CONSOLE_HOME` if this log should live under a
different private home. Hooks do not use the network.

Claude Code documents [project settings and precedence](https://code.claude.com/docs/en/settings),
[project agent frontmatter including `model` and `effort`](https://code.claude.com/docs/en/sub-agents),
and [hook locations, `PreToolUse`, `PreModelSwitch`, and their JSON decisions](https://code.claude.com/docs/en/hooks).
The documented `Agent` tool input has `subagent_type` and an optional `model`
override. `PreToolUse` can deny or ask for a tool call; current docs also
specify `permissionDecision` of `deny` or `ask` for `PreModelSwitch`. These are
the fields the compiler uses, with no invented settings keys. Hooks cannot
observe every action that a shell command might perform, so native Claude
Code permissions and sandboxing remain in effect.
On malformed hook input or a policy read error, `on_error` applies, defaulting
to `ask`; no raw command or credential text is logged.

Project settings are not managed organization settings. An organization
policy wins in the Agent Console compiler, while Claude Code's own managed
settings continue to take precedence. A later `policy bundle` will use
[Claude Code's managed settings mechanism](https://code.claude.com/docs/en/settings)
for enterprise deployment.

## Later analysis

Compliance readings will reuse the analysis core and accounting conformance
totals. A future v0.4 adapter may receive self-hosted serving metrics from
[NVIDIA Dynamo's documented Prometheus endpoint](https://docs.nvidia.com/dynamo/dev/reference/observability/metrics-catalog)
and evaluate a Modelplane source after its metric contract is verified. This
design does not claim either adapter exists in v0.3.
