# Optional local interop

`--interop` enables three local-only paths on the console's loopback port:

| Path | Method | Data |
| --- | --- | --- |
| `/metrics` | GET | Prometheus 0.0.4 text with transcript 24-hour gauges and separate optional-source gauges |
| `/v1/metrics` | POST | Claude Code OTLP/HTTP JSON metric export |
| `/ingest/gateway/kong`, `/ingest/gateway/litellm` | POST | Prometheus text from the named gateway |

All three paths require `Authorization: Bearer` with this console's `admin.key`
from its state directory. The POST paths additionally require
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
# Supply the Bearer admin key through your secret manager in this header value.
export OTEL_EXPORTER_OTLP_METRICS_HEADERS='X-Agent-Console-Interop=1,Authorization=Bearer <admin-key>'
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
checked 24 September 2026. Keep the key out of shell history and shared
configuration; the placeholder above is not a working credential.

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
`Content-Type: text/plain`, `X-Agent-Console-Interop: 1`, and the Bearer key.
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

Prometheus can scrape `http://127.0.0.1:6787/metrics` from the same machine
using its `authorization` configuration with `type: Bearer` and
`credentials_file` pointing at the console's private `admin.key` file.
Only aggregate token counts and the fixed `kind`/`source` labels leave the
console in that response. The endpoint is deliberately not on the reporting
port and is off unless `--interop` is passed. Import
[the Grafana dashboard](grafana-agent-console.json) and select the Prometheus
data source. A remote scraper needs its own secure tunnel to the local port;
Agent Console does not expose metrics on the network.
