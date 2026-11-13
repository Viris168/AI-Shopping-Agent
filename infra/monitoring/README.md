# Monitoring, alerts and the kill switch

agent-service sends traces and metrics over **OTLP/HTTP** (`app/telemetry.py`). Nothing here is
tied to one vendor. The files assume a Prometheus-compatible metrics store and Grafana, e.g.
**Grafana Cloud** (free tier is enough for staging and the first rollout steps), or a
self-hosted OpenTelemetry Collector → Prometheus/Tempo.

| File | What |
|---|---|
| `dashboard.json` | Grafana dashboard "Shopping assistant": the ARCHITECTURE.md §8 metrics |
| `alerts.yaml` | Prometheus/Mimir alert rules: tool errors, first-token latency, model errors, failing turns |
| `alerts-logs.yaml` | Loki rule: commerce-api audit insert failures (needs log shipping, see [Logs](#logs)) |

Verified against Prometheus 3.5 with its OTLP receiver: `promtool check rules` passes, and every
dashboard and alert query returns data from real agent-service exports.

## Setup

1. **Grafana Cloud stack** (or your own backend). Under *Connections → OpenTelemetry (OTLP)*, note
   the endpoint (`https://otlp-gateway-<region>.grafana.net/otlp`), the instance ID, and create
   an access token with `metrics:write` and `traces:write`.
2. **GitHub Environment** (each of `staging`, `production`): re-run
   `infra/setup-github-env.sh <env>` and fill in the monitoring step, or set them yourself:
   ```bash
   gh variable set OTEL_EXPORTER_OTLP_ENDPOINT --env staging --body https://otlp-gateway-<region>.grafana.net/otlp
   gh secret set OTEL_EXPORTER_OTLP_HEADERS --env staging   # Authorization=Basic%20<base64 of instanceId:token>
   ```
   The next deploy passes them to agent-service. Empty endpoint → nothing is exported.
3. **Dashboard**: Grafana → *Dashboards → New → Import* → upload `dashboard.json` → pick the
   Prometheus data source. The *Environment* picker lists `staging/agent-service` and
   `production/agent-service` (the `job` label is `DEPLOY_ENV/agent-service`).
4. **Alerts**: `mimirtool rules load alerts.yaml` (address and token for your Grafana Cloud
   Prometheus), or *Alerting → Alert rules → Import*. Then route `severity=page` to whoever is on
   call and `severity=warning` to a channel. Check that a test notification arrives.
5. **Verify the alerts** before the 5% step (rollout exit gate "alerts verified"): on staging,
   stop commerce-api for 10 minutes while chatting (→ `AgentToolErrorRateHigh`), and set a wrong
   `ANTHROPIC_API_KEY` (→ `AgentModelErrorSpike`, fallback card in the widget).

Locally, any OTLP collector works, e.g. `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. Logs
are text in development and JSON (with `request_id` and `trace_id`) when `APP_ENV=production`.

## What gets measured

| Metric (Prometheus name) | Labels | Meaning |
|---|---|---|
| `agent_turn_first_token_seconds` | `route` | Request → first text_delta |
| `agent_turn_duration_seconds` | `route`, `outcome` | Request → done; `outcome` is ok, an error code, or cancelled |
| `agent_turn_errors_total` | `route`, `error_type` | `model_unavailable` (fallback card), `timeout`, `internal` |
| `agent_streams_active` | `route` | Open SSE streams |
| `agent_model_calls_total`, `agent_model_duration_seconds` | `gen_ai_operation_name`, `gen_ai_request_model`, `status`, `error_type` | One model API call (after the SDK's 2 retries) |
| `agent_model_fallbacks_total` | `gen_ai_request_model`, `error_type` | Chat calls retried on `MODEL_FAST` after `MODEL_MAIN` failed (transient errors only) |
| `agent_model_tokens_total` | `gen_ai_token_type` (input, output, cache_read), `gen_ai_operation_name`, `gen_ai_request_model`, `agent_purpose` (chat, summarise, memory_extract, eval_grade, complete) | Tokens |
| `agent_model_cost_USD_total` | `gen_ai_operation_name`, `gen_ai_request_model`, `agent_purpose` | Estimated cost from `MODEL_PRICES`; models without a price are left out |
| `agent_tool_calls_total`, `agent_tool_duration_seconds` | `tool`, `status` | `ok`; `rejected` (login, not found, bad input: expected); `error` (store 5xx/429/unreachable) |
| `agent_conversations_total` | — | New conversations |
| `agent_handoffs_total` | — | Support tickets created |
| `agent_actions_total` | `tool`, `result` | Confirm cards: requested, confirmed, failed, cancelled, expired |
| `agent_feedback_total` | `rating` | Thumbs up/down |
| `agent_disabled_rejections_total` | — | Requests refused by the kill switch |
| `agent_output_suspect_replies_total` | — | Replies with a price or % no tool or shopper message gave that turn |
| `agent_output_redactions_total` | `kind` (code, link) | Unconfirmed coupon codes and off-store links removed from replies |

**Cost row** (dashboard): spend, cost per conversation and cache hit ratio for the selected
range, then cost per hour by purpose and by model, tokens by purpose, and the cache hit ratio over
time. Cost is an estimate from agent-service's `MODEL_PRICES`; models without a price are left out
of cost but still count in tokens. Eval runs usually don't export metrics: their usage is in the
eval report instead (`evals/README.md`).

Traces: one root span per turn (`turn chat`, `turn confirm`) with `conversation.id`, then a span
per model call (`chat <model>`, token counts), per tool (`tool <name>`) and per commerce-api
request (`commerce-api GET`). Spans carry no message text or personal data.

**Request IDs.** Every agent-service response has `X-Request-Id`, and every commerce-api call in
that turn sends the same ID. commerce-api logs it as `req.id` and echoes it back. To follow one
turn: search both services' logs for the ID, or open the trace from a log line's `trace_id`.

## Kill switch

Turning the assistant off makes `/v1/chat` and `/v1/actions/*/confirm` answer `503` (the open
widget shows its fallback card), and `/v1/config` reports `enabled: false`, so the widget stops
appearing on page loads within a minute. Pending confirm cards can't be confirmed.

**Instant, no deploy**: set the Redis flag (all replicas, takes effect on the next request):

```bash
ssh <vm> 'cd ~/shop && docker compose exec redis redis-cli SET flag:agent_enabled 0'
```

With managed Redis, run `redis-cli -u "$REDIS_URL" SET flag:agent_enabled 0` from anywhere that
can reach it. Turn it back on with `DEL flag:agent_enabled`.

**Durable**: set the GitHub Environment variable `AGENT_ENABLED=false` and redeploy. Redis can't
turn on an assistant that `AGENT_ENABLED` turned off.

## Tool cache

agent-service caches public tool results (product search and details, categories, FAQ) in Redis:
60 s for products, 10 min for FAQ and categories. Logged-in tools (cart, orders, returns) are never
cached. Hits and misses are in `agent_tool_cache_total` (`tool`, `result`).

| Need | Command |
|---|---|
| Turn the cache off | `SET flag:cache_enabled 0` (back on: `DEL flag:cache_enabled`) |
| Drop every cached result (e.g. after re-seeding or a price change) | `INCR cache:tool:gen` |
| Off durably | `CACHE_ENABLED=false` and redeploy |

## Rollout

`/v1/config` also carries `rolloutPercent`. Each browser picks a fixed bucket 0–99 and sees the
widget if its bucket is below the percentage, so raising it only ever adds shoppers.

| Step (ARCHITECTURE.md §12) | Setting |
|---|---|
| Staff | `0`; staff open the store with `?shopchat=on` once (`?shopchat=off` to undo) |
| 5% / 25% / 100% | `SET flag:rollout_percent 5` (then 25, 100) |

The `ROLLOUT_PERCENT` variable sets the value after a deploy (unset: production 0, staging 100).
The Redis flag wins while it exists; `DEL flag:rollout_percent` goes back to the variable. Before
each step, check the dashboard: tool errors < 5%, handoff and thumbs-up rates steady.

At the end of a step's watch window, `infra/rollout-check.sh <user@vm> [days]` checks the gate:
tool error rate (with `PROM_URL`/`PROM_AUTH`, else read the dashboard), no return filed against
another shopper's order, no agent action logged for a different shopper than the conversation's,
no duplicate returns. It also downloads a sample of masked transcripts (thumbs-down and handoffs
first) to a private temp dir; add the failures to `agent-service/evals/golden/`. Exit 0 = passed,
1 = failed (roll back), 2 = error rate not checked. It never changes the flag.

## Runbooks

### Tool errors

`AgentToolErrorRateHigh`: over 5% of tool calls hit a store failure. On the dashboard, *Tool
error rate* by tool shows whether it's one route or all of them. All of them → commerce-api or
its database is down (`docker compose logs commerce-api`, `/health`). One tool → that route's
logs in commerce-api, by request ID. If shoppers are getting nowhere, use the kill switch.

### Slow first token

`AgentFirstTokenSlow`: p95 over 4 s. Compare *Model call duration* (provider slow → nothing to
fix locally; consider the kill switch if it's very slow) with *Tool duration* (a slow store
call before the first reply).

### Model errors

`AgentModelErrorSpike`: over 10% of model calls fail after retries; shoppers see the fallback
card. `error_type` tells you which: `401`/`403` → key revoked or wrong (`ANTHROPIC_API_KEY`);
`429` → rate or spend limit; `5xx`/`529` → provider outage (status page);
`APIConnectionError`/`APITimeoutError` → network. Transient failures before any text are
retried once on `MODEL_FAST` (`agent_model_fallbacks_total`), so shoppers may get plainer
replies rather than the card; if both models fail, both count here. Long outage: switch the
assistant off.

### Failing turns

`AgentTurnsFailing`: timeouts or crashes. `internal` → the traceback is in agent-service's logs
(`turn failed`). `timeout` → a turn hit `TURN_TIMEOUT_S`; check model and tool durations.

### Suspect facts

`AgentSuspectFacts`: over 5% of replies in an hour quote a price or percentage that no tool
result (or the shopper's own message) gave that turn. Search agent-service logs for
`suspect_fact` to see the values. A few are harmless (a price from an earlier turn). A jump
right after a deploy usually means a prompt or model change: run the golden and red-team evals
on it, and roll back if prices look invented.

### Audit insert failures

`CommerceAuditInsertFailed`: an agent change happened, but its `agent_action_logs` row didn't save.
The log line names the action. Check the database (disk, connections), then record the missed
actions by hand from commerce-api's request logs.

### Helpdesk forwarding

`HelpdeskForwardFailing` / `HelpdeskForwardAbandoned`: support tickets are saved in
commerce-api but aren't reaching the helpdesk webhook (`HELPDESK_URL`). Shoppers still get a
ticket ID; nothing is lost while retries continue (every minute, backoff up to 1 h, 30 attempts
≈ a day). The log line has the ticket ID and the status or timeout, never the body. `responded
401`/`403` → `HELPDESK_TOKEN` wrong or rotated; `5xx`/timeout → the helpdesk or its webhook is
down. Pending and abandoned tickets:

```sql
SELECT id, created_at, forward_attempts, forward_error, next_forward_at
FROM support_tickets WHERE forwarded_at IS NULL AND created_at > now() - interval '7 days';
```

After fixing the cause, requeue abandoned ones with
`UPDATE support_tickets SET next_forward_at = now(), forward_attempts = 0 WHERE forwarded_at IS NULL AND next_forward_at IS NULL AND forward_attempts > 0;`
(the next run within a minute pushes them; the helpdesk gets the same `Idempotency-Key`).

## Logs

commerce-api's audit failures are only in its logs, so that alert needs the containers' logs in
Loki. On the VM, run Grafana Alloy (or any Docker log shipper) reading the `shop` project's
containers and labelling them `service_name=<compose service>`. This repo doesn't ship that
agent yet; until it does, `CommerceAuditInsertFailed` can't fire. Check by hand with
`docker compose logs commerce-api | grep audit_insert_failed`.
