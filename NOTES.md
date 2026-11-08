# Notes

## Gate 1 — read-only chat end to end (run 2026-11-08)

Setup: Postgres (`shop-db` on :5433) and Redis from Docker; commerce-api and agent-service
from `.claude/launch.json`; `npm run migration:run && npm run seed`.

No Anthropic credentials on this machine (no `ANTHROPIC_API_KEY`, no `ant auth login` profile),
so the real model was not exercised. `POST /v1/chat` fails at the model call with
"Could not resolve authentication method". Everything else was run for real (agent loop,
tool registry, Redis sessions, `commerce_client`, commerce-api, seeded Postgres), with
`tests/fakes.FakeLLM` scripting the tool calls.

### Conversations

| Conversation | Tool calls | Result |
|---|---|---|
| Guest, product | `search_products` (headphones ≤ $100), `list_categories` | OK. 0 hits is correct (only headphones are $199) |
| Guest, FAQ | `search_faq` (return policy) | OK, 30-day policy returned |
| Guest asks for an order | none offered | OK, order/cart tools are hidden from guests |
| Alice, orders | `get_order` ORD-1002, `list_orders`, `get_order` ORD-0950, `get_order` ORD-9999 | OK. Shipped + tracking; 3 orders; 0950 `returnEligible: false`; 9999 → friendly 404 "Order not found" |

### `X-Client: ai-agent` in commerce-api logs

All 7 agent calls logged `x-client: ai-agent`, `x-conversation-id` and `x-request-id`;
`x-service-token` and `authorization` are `[Redacted]`. agent-service's `/health` ping
(outside `/api/v1`) sends no agent headers, which is intended.

### Problems found

1. **Every tool call returned 403** "Agent requests need a valid service token".
   Neither local `.env` set `SERVICE_TOKEN`. Meanwhile `/health` stayed green, agent-service
   gave no warning, and the error only showed up inside `<tool_result>`.
   *Fixed:* same random token added to `commerce-api/.env` and `agent-service/.env` (local only).
   agent-service now logs a startup warning when the token is missing or empty.
   `agent-service/.env.example` lists it as required.
2. **`agent-service/.env` was committed** (since `dd3245b`, pushed to `origin/main`), including
   a 64-char `JWT_SECRET`. That's the secret commerce-api signs shopper tokens with.
   *Fixed locally:* rotated `JWT_SECRET` in both local `.env` files and ran `git rm --cached
   agent-service/.env` (staged, not committed). *Still open:* the old secret is in git history.
   Rotate it anywhere it was used, and decide whether to rewrite history.
3. **Empty `SERVICE_TOKEN` passed agent-service's production check** (`is None` only).
   *Fixed:* production now requires ≥ 32 chars, same as commerce-api.
4. **No model credentials** for local runs. *Open:* add `ANTHROPIC_API_KEY` to
   `agent-service/.env` (or `ant auth login`). Then rerun these four conversations with the real
   model before step 4. Model behaviour (wording, sign-in prompt for guests, no invented facts)
   is still untested.

### Minor / for later

- Keyword search is literal: "headphones" doesn't match "Wireless Earbuds" ($99). The model has to
  broaden the query itself; worth a golden eval case.
- `/health` reports `commerceApi: ok` even when agent calls would be rejected. Consider having it
  check the token too.

## Gate 2 — eval pass bar (run 2026-11-08/09)

Model: DeepSeek (`deepseek-v4-pro` / `deepseek-flash`) via its Anthropic-compatible API.

| Suite | Result | Bar |
|---|---|---|
| Red team | 49/49 (100%) on the final run; the run before was 48/49 | 100% |
| Golden | 157/166 (95%), three runs in a row | 90% |

CI has not run yet: needs the `ANTHROPIC_API_KEY` secret (DeepSeek key) and `.github/` pushed.

Gotcha: a shell started by Claude Code exports `ANTHROPIC_BASE_URL=https://api.anthropic.com`,
which beats `.env`. Run evals with `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`;
`.claude/launch.json` now unsets it for agent-service.

### Manual widget runs (alice, widget demo page on :5173)

| Run | Result |
|---|---|
| Cart + checkout link | OK after fixing local `agent-service/.env` (`STOREFRONT_URL` was :3001, now :8080). Jacket added, host cart count updated, link → `http://localhost:8080/cart`, no order placed |
| Return on ORD-1001 | OK. Confirm card → `POST /v1/actions/{id}/confirm` → `POST /returns` 201. Nothing created before the button |
| Refused return on ORD-0950 | OK. Explains the 30-day window closed Oct 4; holds when pushed for an exception; offers a person |
| Human handoff | OK. Ticket card right away → confirm → `POST /support/tickets` 201 |

No `POST /checkout` from the agent in any run. Fixtures reseeded afterwards.

### Found in the manual runs (open)

1. Model writes markdown (`**Confirm**`) and the widget shows the asterisks (it renders text as
   text, by design). Prompt should ask for plain text, or the widget should render bold safely.
2. Return deadline: the model says Dec 1 (UTC from `returnDeadline`), the order card says Dec 2
   (local time). Pick one timezone for both.
3. The same product card shows twice when the agent calls `search_products` then `get_product`.
4. The message list once jumped to the top after a reply instead of staying at the newest message.
5. Log masking turns part of the conversation UUID into `[phone]`, so the IDs in logs are unusable.
6. Handoff reply says "I've opened a support request" before Confirm (it then says it isn't sent).
