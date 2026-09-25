# Optional local interop

`--interop` enables three local-only paths on the console's loopback port:

| Path | Method | Data |
| --- | --- | --- |
| `/metrics` | GET | Prometheus 0.0.4 text with transcript 24-hour gauges and separate optional-source gauges |
| `/v1/metrics` | POST | Claude Code OTLP/HTTP JSON metric export |
| `/ingest/gateway/kong`, `/ingest/gateway/litellm` | POST | Prometheus text from the named gateway |

**Read and ingest use separate bearer credentials.** `/metrics` requires the
`read` scope; both POST endpoints require `ingest`. Browser sign-in cookies,
the raw console key, and credentials for the wrong scope receive `401`.
Print the credential on the console's own computer as the user that runs it:

```sh
node bin/agent-console.mjs metrics-token --scope read
node bin/agent-console.mjs metrics-token --scope ingest
```

Use the console's same `--state-dir` if configured. `--json` supports tooling;
treat its output as a password. The credentials are domain-separated HMACs
under `admin.key`, compared in constant time. They do not reveal the key.
To revoke a credential and print its replacement:

```sh
node bin/agent-console.mjs metrics-token --scope ingest --rotate
```

Rotation takes effect on the next request without restarting the console.
Update the corresponding exporter or scraper with the replacement. The other
scope and browser sessions remain valid. Corrupt rotation state refuses
access. Protect the state directory: deleting generation files restores the
initial credential, so file deletion is not a revocation procedure.
Existing integrations that used the old read credential for POST must switch
to `--scope ingest`. Replacing the console key invalidates both scopes on
restart and also ends browser sessions. A demo prints only its read token,
marks `/metrics` with `# DEMO` and `agent_console_demo 1`, and refuses ingest.
The POST paths also require
`X-Agent-Console-Interop: 1`, reject browser `Origin` headers, and accept at
most 256 KB per request. All paths are bound to
the console's existing `127.0.0.1` listener. Nothing is installed, sent, or
scraped by Agent Console itself. `--demo` shows generated telemetry but never
accepts ingest. Turning off `--interop` removes the paths and panel in a
normal run. No telemetry enters the reporter's join/report protocol.

## Claude Code as a second live source

Start Agent Console with `--interop`, then launch Claude Code with its
documented OpenTelemetry exporter directed at this local endpoint:

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=none
export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:6787/v1/metrics
# The token from metrics-token --scope ingest; the space after Bearer is written %20.
export OTEL_EXPORTER_OTLP_METRICS_HEADERS='X-Agent-Console-Interop=1,Authorization=Bearer%20<token>'
claude
```

Use the actual console port if it is not 6787. Claude Code exports metrics
every 60 seconds by default; `OTEL_METRIC_EXPORT_INTERVAL=10000` asks for a
10-second interval. The receiver accepts only delta
`claude_code.token.usage` sum data points with `model` and `type` (input,
output, cacheRead or cacheCreation). OTLP protobuf and gRPC are not supported
by this dependency-free local adapter; select `http/json`. See
[Claude Code Monitoring](https://code.claude.com/docs/en/monitoring-usage) and
[the OTLP/HTTP specification](https://opentelemetry.io/docs/specs/otlp/),
checked 24 September 2026. Without the ingest token the endpoint answers `401`
and accepts nothing.

The adapter ignores user, repository, session, prompt and tool attributes,
keeps only count, model ID, timestamp and a salted series hash in bounded
memory, and deduplicates retries. It never stores a raw OTLP body. The panel
labels the last 24 hours of received delta tokens and **does not add them to
transcript totals**, because both can describe the same API request.

## Gateway token shape

The gateway endpoints accept Prometheus exposition lines for the following
documented counter families; comments and unrelated metrics are ignored.
The local adapter discards all labels except `model` or `ai_model`, the token
type, and a salted hash of the series for deduplication. Send the text with
`Content-Type: text/plain`, `X-Agent-Console-Interop: 1`, and
`Authorization: Bearer <token>` using the `ingest` credential.
Each endpoint
accepts up to 1,000 matching series per request.

| Source | Metric and labels accepted | Projection |
| --- | --- | --- |
| Kong AI Gateway | `ai_llm_tokens_total{ai_model="...",token_type="prompt_tokens"}` and `completion_tokens` | Input and output cumulative counters |
| LiteLLM | `litellm_input_tokens_metric_total{model="..."}` and `litellm_output_tokens_metric_total{model="..."}` | Input and output cumulative counters |
| LiteLLM | `litellm_input_cached_tokens_metric_total` and `litellm_input_cache_creation_tokens_metric_total` with `model` | Cache detail when available |

Gateway readings are **latest cumulative snapshots**, not a 24-hour spend
window. The displayed total is input plus output; Kong's documented
`total_tokens` series is ignored to avoid counting it twice. LiteLLM cache
detail is a subset of input. These readings remain separate from Claude Code telemetry and
transcripts; sources can overlap. The exact names and token type labels come
from [Kong AI Gateway's metrics reference](https://developer.konghq.com/ai-gateway/monitor-ai-llm-metrics/)
and [LiteLLM's Prometheus reference](https://docs.litellm.ai/docs/proxy/prometheus),
checked 24 September 2026. Gateway enforcement and budgets are outside this
local adapter.

## Prometheus and Grafana

Prometheus scrapes `http://127.0.0.1:6787/metrics` from the same machine
with the read token (`metrics-token --scope read`) as its bearer credential, kept in a file only its user
can read:

```yaml
scrape_configs:
  - job_name: agent-console
    static_configs: [{ targets: ["127.0.0.1:6787"] }]
    authorization: { type: Bearer, credentials_file: /path/to/agent-console-scrape-token }
```
Only aggregate token counts and the fixed `kind`/`source` labels leave the
console in that response. The endpoint is deliberately not on the reporting
port and is off unless `--interop` is passed. Import
[the Grafana dashboard](grafana-agent-console.json) and select the Prometheus
data source. A remote scraper needs its own secure tunnel to the local port;
Agent Console does not expose metrics on the network.
