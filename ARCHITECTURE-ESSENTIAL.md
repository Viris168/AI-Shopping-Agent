# Architecture — Essentials

One-page version of [ARCHITECTURE.md](./ARCHITECTURE.md). Read this first.

## The shape

```
Browser                      Cloud
┌──────────────┐  SSE+JWT   ┌──────────────────┐  tools   ┌────────────┐
│ Chat widget  │──────────▶ │  agent-service   │───────▶ │ Claude API │
│ (script tag) │            │  FastAPI + loop  │          └────────────┘
└──────────────┘            │  confirm gate    │── Redis (sessions, actions, limits)
       │ browse/checkout    └────────┬─────────┘
       ▼                             │ chat token + X-Client: ai-agent
┌──────────────┐                     ▼
│  Storefront  │──────────▶ ┌──────────────────┐
└──────────────┘            │  commerce-api    │── PostgreSQL
                            │  (NestJS, built) │
                            └──────────────────┘
```

| Part | Status | Job |
|---|---|---|
| `commerce-api/` | Built | Source of truth. Products, cart, orders, returns, FAQ, tickets, audit log |
| `agent-service/` | To build | Claude tool loop, 15 tools, confirm gate, sessions, guardrails |
| `widget/` | To build | One-script-tag chat UI with cards and confirm buttons |

## Five rules that hold the design together

1. **The agent has no special access.** It calls `commerce-api` with the shopper's short-lived chat token (15 min, customers only), which works only with agent-service's service token and only on the tool routes. The storefront session stays in an httpOnly cookie. The API's ownership checks protect data even if the model is tricked.
2. **Facts come from tools.** Prices, stock, order status, policies and dates are never generated from memory.
3. **Risky actions need a human click.** `create_return` and `create_support_ticket` become pending actions; only `POST /v1/actions/{id}/confirm` runs them.
4. **The agent never takes payment.** It links to the storefront checkout; it never calls `POST /checkout` or `POST /orders/{n}/payment`.
5. **Everything is traceable.** Every agent mutation is in `agent_action_logs`; every turn is traced with its conversation ID.

## Tools → API

| Tool | Route | Login | Confirm |
|---|---|---|---|
| search_products / get_product / get_recommendations / list_categories | `GET /products…`, `/categories` | – | – |
| search_faq | `GET /faq/search` | – | – |
| view_cart / add_to_cart / update_cart_item / remove_cart_item / apply_coupon | `/cart…` | ✓ | – |
| list_orders / get_order | `GET /orders…` | ✓ | – |
| create_return | `POST /returns` | ✓ | ✓ |
| create_support_ticket | `POST /support/tickets` | – | ✓ |
| checkout_link | none (storefront URL) | ✓ | – |
| forget_memory (only with `MEMORY_ENABLED`) | `DELETE /memory/facts/{id}` | ✓ | – |

## Must-fix in commerce-api before launch

- Rate limit by user, not IP (agent traffic shares one IP bucket today)
- Verify `X-Service-Token` before trusting `X-Client: ai-agent`
- Audit failed agent calls; alert on audit failures
- `Idempotency-Key` on returns and tickets

## Limits

10 s per API call · 30 s per model call · 45 s per turn · 6 tool rounds · 2,000 chars per message · 2 min per dictation (mic, PLAN-21) · 20 messages/min · confirm expires in 10 min · session 24 h · transcripts 90 days.

## Models

`claude-sonnet-5` runs the loop. `claude-haiku-4-5` handles summaries, ticket text and eval grading. Prompt caching on the system prompt and tools.
