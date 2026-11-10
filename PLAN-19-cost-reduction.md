# Plan 19 · Model cost reduction

Components: `agent-service` (and DeepSeek account settings). Depends on item 18 (evals harness, tool cache).

## Goal

Spend less model credit per conversation and per eval run, without lowering answer quality or
breaking the non-negotiable rules. The DeepSeek balance ran out on 2026-11-09, mostly from eval runs
(20 full suite runs in `evals/results/` over Nov 8–9).

**Done when:** cost per conversation and per eval day are measured and clearly lower, and golden
≥ 90%, red-team 100% still hold with every change switched on.

## What exists today

| Area | Today |
|---|---|
| Models | `model_main = deepseek-v4-pro` for every chat turn; `model_fast = deepseek-flash` for summaries and the eval judge ([config.py](agent-service/app/config.py)) |
| Thinking | Off (`NO_THINKING` in [llm.py](agent-service/app/llm.py)) |
| Prompt caching | DeepSeek caches prompt prefixes automatically; `cache_control` is ignored |
| Context | `window_messages = 20` + rolling summary + structured `state` ([sessions.py](agent-service/app/sessions.py)) |
| Tool cache | Redis cache for public tool results ([cache.py](agent-service/app/cache.py)) |
| Limits | `max_tool_rounds = 6`, `token_budget = 300_000`, `rate_limit_per_min = 20` |
| Telemetry | `agent.model.tokens` counter ([telemetry.py](agent-service/app/telemetry.py)) |
| Evals | Full suites + LLM judge per case; the same key and balance as everything else |

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Biggest saving | Model routing (cheap model for simple turns) | Most turns are short and need at most one tool |
| Answer caching | **Not planned** (no semantic cache of final answers) | Similar prompts from different shoppers would get each other's order data (rules 1–2); prices and stock would go stale (rule 5); follow-ups like "yes, do that" depend on the conversation. The tool-result cache already covers the safe case |
| Prompt caching | Keep the system prompt + tools first and the same on every request | The provider's prefix cache only hits when the start of the prompt doesn't change |
| Eval spend | Separate key with its own cap | Evals must never drain the production balance |
| Rollout | Config flag + `rollout_percent`, off by default | Same pattern as memory and playbooks; roll back without a deploy |

## Milestones

### M1 · Separate eval spending from production
- Get a separate DeepSeek key for evals and CI with its own spending cap; store it as the CI
  `ANTHROPIC_API_KEY` secret.
- Set a low-balance alert in the DeepSeek dashboard.
- **Done when** an eval run can't use the production balance.

### M2 · Measure where tokens go

**Already there:** `_record_usage` ([llm.py](agent-service/app/llm.py)) splits `agent.model.tokens`
by operation (`chat`, `summarise`, `complete`), model, and token type (`input`, `output`,
`cache_read`); the dashboard shows tokens per conversation.

**Gaps:**

| # | Gap | Why it matters |
|---|---|---|
| 1 | Eval spend is invisible: metrics export only with `OTEL_EXPORTER_OTLP_ENDPOINT`, and the results JSON has no usage | Evals are the suspected top cost and leave no record |
| 2 | `complete` mixes memory extraction ([memory.py](agent-service/app/memory.py)) and the eval judge ([run.py](agent-service/evals/run.py)) | Can't tell judge cost from production memory cost |
| 3 | Tokens, not money | Pro vs flash and cache hits cost different amounts |
| 4 | Per-conversation totals ([sessions.py](agent-service/app/sessions.py) `record`) only count `chat` input/output | Summaries, memory extraction and cache hits are missing |
| 5 | Cache-hit accounting not verified for DeepSeek's Anthropic-compatible API | Cost math could double-count or miss cache hits |

**Steps:**

1. **Label each call with its purpose.** `complete_fast(..., purpose=...)`: memory passes
   `memory_extract`, the eval runner `eval_grade`. Recorded as `agent.purpose` on the span and the
   token counter (`chat` and `summarise` use their operation name).
2. **Price table.** `MODEL_PRICES` in config: per model, USD per million tokens for `input`,
   `cache_read`, `output`, filled from the provider's pricing page (never hard-coded from memory).
   `estimate_cost()` + new counter `agent.model.cost` (USD) with the same labels. A model without
   a price is counted in tokens only.
3. **Usage tally.** `app/usage.py`: `with usage.tracking() as tally:` collects every model call's
   tokens and cost made inside it (including background tasks it starts), whether or not telemetry
   export is on. Tallies nest, so a case tally and a run tally can be open at once.
4. **Eval reports carry usage.** `run.py` opens a tally per case and per run; the report JSON gets
   `usage` (tokens + cost by purpose and model) per case and at the top; the summary line prints
   totals and shares, e.g. `98/104 passed · 1.9M in / 140k out · est $X.XX (chat 78%, eval_grade 15%)`.
5. **Complete per-conversation totals.** Add summary and memory-extraction calls and cache-hit
   tokens to the turn's usage; store `tokensCacheRead` and `costMicroUsd` (integer millionths of a dollar) with the transcript
   (commerce-api migration if the `conversations` table lacks the columns).
6. **Verify cache-hit accounting once.** Send the same 2-turn conversation twice; compare
   `input_tokens`, `cache_read_input_tokens` and the DeepSeek dashboard charge. Note the result in
   `llm.py` and fix `estimate_cost` if DeepSeek counts differently from Anthropic (where
   `input_tokens` excludes cache reads).
7. **Dashboard.** Panels for cost by purpose and model, cost per conversation, cache-hit ratio
   (`cache_read / (input + cache_read)`); document new names in `infra/monitoring/README.md`.
8. **Collect and decide.** After M1, run golden + red-team once and a day of local/staging chat.
   Add a **Findings** table here with the top 3 sources and their share; it decides whether M4 or
   M5 goes first.

No prompt or model-behaviour change, so unit tests + `ruff` + `mypy` are enough to merge.

**Progress (2026-11-10, branch `cost-m2-usage`):** steps 1–5 built and tested. Per-conversation
usage is stored as `tokens_cache_read` and `cost_micro_usd` (migration `ConversationCost`);
summary and memory-extraction usage is sent after the turn as a messages-free update. Step 6 checked
2026-11-10 with `python -m evals.cache_check`: DeepSeek's `input_tokens` excludes cache hits (same
3217-token prompt: 3217 input, then 17 input + 3200 cache_read), so `estimate_cost` needs no change;
the prefix cache hit 99.5% of the repeated prompt. Step 7: a **Cost** row in
`infra/monitoring/dashboard.json` (spend, cost/conversation, cache hit ratio, cost by purpose and
model, tokens by purpose); every query checked against Prometheus 3.5's OTLP receiver, and the
counter's Prometheus name is `agent_model_cost_USD_total`. Step 8: first findings below, from
an eval sample; production numbers still to collect.

- **Done when** every model call has a purpose, model, token counts and cost estimate; every eval
  report shows its cost; conversation records include every call; cache-hit accounting is checked
  against the DeepSeek dashboard; and the top 3 sources of spend are named from real numbers.

#### Findings (2026-11-10, eval sample)

Sample: golden `checkout` + `language`, redteam `confirm` + `internals` = 23 cases, 73 model calls.
Priced at DeepSeek **peak** rates (off-peak is half). Reports: `evals/results/*-20261110-2002*.json`.

| # | Source | Share of cost | Notes |
|---|---|---|---|
| 1 | `chat` input, cache **miss** | **63%** | Only ~400 uncached tokens per call, but they cost 30× a cache hit: the per-request tail (tool results, state, memory, the new message) after the cached prefix |
| 2 | `chat` output | **21%** | ~30 tokens per call, at 3× the input price |
| 3 | `chat` input, cache **hit** | **12%** | Prefix cache works: 78–86% of prompt tokens are hits (~2.2–2.4k tokens per call) |
| – | `eval_grade` (judge) | 4% | A cheaper judge isn't worth the effort |

- **Per case:** $0.0023 at peak → a full golden + red-team run (244 cases) ≈ **$0.55 peak / $0.28
  off-peak**. The 20 full runs on Nov 8–9 were roughly $5–11.
- **Decision:** M3 now (free: targeted runs, full suites only before merge, prefer off-peak
  hours). Then **M4 before M5**: trimming tool results and the per-request tail targets the
  biggest slice (#1) without changing the model; M5 (routing to flash, ~4.4× cheaper per token)
  next, as it needs both suites to pass.
- **Gaps:** no summary or memory-extraction calls in this sample, and eval traffic isn't shopper
  traffic. Re-check with a day of staging chat (dashboard Cost row) before M5's rollout.
- Running evals from a Claude Code session: unset `ANTHROPIC_BASE_URL` and `CLAUDE_EFFORT` (the
  session's own values override `.env`), as `.claude/launch.json` does for agent-service.

### M3 · Cheaper eval workflow
- By default, run only the cases you changed (`--file`, `--case`); document this in `evals/README.md`.
- Run the full golden + red-team suites only before a merge or release (CI on changed paths).
- Use `--repeat` only for flaky cases.
- **Done when** a normal day of development costs far less than the Nov 8–9 runs.


### M4 · Trim context
- Lower `window_messages` from 20 to about 10; the summary and `state` keep the context.
- Send the model only the tool-result fields it needs, not whole API objects (cards keep full data).
- Check that the system prompt and tools come first and stay identical between requests;
  per-request text (summary, state, memory) goes after them.
- **Done when** average input tokens per turn drop (M2 numbers) and both suites still pass.

### M5 · Model routing
- Send simple turns (greetings, thanks, FAQ, single-tool lookups) to `model_fast`.
- Keep `model_main` for returns, cart changes, multi-step tool use and anything that leads to a
  confirm-first action.
- Escalate to `model_main` if the fast model calls a tool it isn't allowed to route, or errors.
- Behind `model_routing_enabled` (config + Redis flag), off by default. All calls still go through
  `app/llm.py`.
- **Done when** both suites pass with routing on and cost per conversation goes down.

### M6 · Rollout
- Turn routing on for a slice of traffic with the `rollout_percent` pattern.
- Compare cost, error rate and escalations to the main model between the two groups.
- **Done when** routing is on for 100% of traffic with no quality drop.

### M7 · Guardrails against abuse
- Review `token_budget` and `rate_limit_per_min` against real usage from M2.
- Consider lower limits for guests than for signed-in shoppers.
- **Done when** no single user or bot can burn an outsized share of credit.

## Order

M1 → M2 → M3 are quick and can land this week. M4 and M5 are the code changes. M6 and M7 follow once
M2 has data.

## Docs to update

- `AGENT.md` §6 (limits) and the model section: routing rules and the fast-model fallback.
- `ARCHITECTURE.md`: new config flag and Redis key.
- `evals/README.md`: targeted runs and the separate eval key.

## Open questions

- Is `deepseek-flash` good enough for single-tool lookups, or only for no-tool turns? M5's evals decide.
- Should routing use rules (no tools needed / tool type) or a small classifier call? Start with rules.
