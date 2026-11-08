# Commerce API — Essentials

One-page version of [ARCHITECTURE.md](./ARCHITECTURE.md).

## What it is

The store's system of record: NestJS 11 + TypeORM + PostgreSQL. Serves the storefront and the AI agent through one REST API at `/api/v1` (Swagger at `/docs`, health at `/health`).

## Request path

```
helmet → CORS → throttler → JWT guard → ValidationPipe → controller → service → TypeORM → Postgres
                                                   └── AgentAuditInterceptor (agent mutations → agent_action_logs)
```

## Endpoints

| Area | Routes | Login |
|---|---|---|
| Auth | `POST /auth/register` · `POST /auth/login` · `GET /auth/me` | me only |
| Catalog | `GET /products` · `GET /products/:idOrSlug` · `GET /products/:idOrSlug/recommendations` · `GET /categories` | – |
| Cart | `GET /cart` · `POST /cart/items` · `PATCH /cart/items/:productId` · `DELETE /cart/items/:productId` · `POST /cart/coupon` | ✓ |
| Checkout | `POST /checkout` | ✓ |
| Orders | `GET /orders` · `GET /orders/:orderNumber` | ✓ |
| Returns | `POST /returns` · `GET /returns` | ✓ |
| FAQ | `GET /faq/search?q=&topic=` | – |
| Support | `POST /support/tickets` | optional |

## Rules that matter

1. **Ownership in the query.** User data is always fetched with `userId` in `where`. Someone else's order = 404.
2. **Money in cents.** Format only at the edge (`formatMoney`).
3. **Migrations only.** `synchronize: false`; schema changes need a migration.
4. **Validated input.** DTOs whitelist fields and cap lengths/ranges.
5. **Readable errors.** Messages are shown to shoppers by the agent.
6. **Agent mutations are audited** (`X-Client: ai-agent`, `X-Conversation-Id`).

## Key numbers

JWT 1 h · rate limit 120/min (register 5, login 10) · return window 30 days · free shipping ≥ $50, else $5.99 · cart qty 1–20 per add · checkout link 30 min · DB pool 10.

## Must-fix before the agent goes live

- [x] Throttle per user, not per IP
- [x] Verify `X-Service-Token` for agent traffic
- [x] Audit failed agent calls; stop swallowing audit errors
- [x] `Idempotency-Key` on returns, tickets, checkout
- [x] Refuse to start in production without a strong `JWT_SECRET`
- [x] Real carrier tracking URLs
- [x] `conversations` table

## Later

Payment provider session + webhook (checkout is a demo that marks orders PAID) · release stock from stale PENDING orders · helpdesk forwarding · pgvector search · tests and CI.
