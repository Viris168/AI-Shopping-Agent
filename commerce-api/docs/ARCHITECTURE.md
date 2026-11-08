# Architecture — Commerce API

| | |
|---|---|
| Last updated | 2026-11-08 |
| Short version | [ARCHITECTURE-ESSENTIAL.md](./ARCHITECTURE-ESSENTIAL.md) |
| Agent contract | [AGENT.md](./AGENT.md) |

## 1. Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js ≥ 20 (22 in production) |
| Framework | NestJS 12 (`@nestjs/platform-express`) |
| ORM / DB | TypeORM 1.x, PostgreSQL (with `pg_trgm`) |
| Auth | `@nestjs/jwt`, bcryptjs |
| Validation | class-validator, class-transformer |
| Security | helmet, CORS allowlist, `@nestjs/throttler` |
| Logging | nestjs-pino (pino-pretty in dev) |
| Docs | `@nestjs/swagger` at `/docs` |

## 2. Where it sits

```mermaid
flowchart LR
  SF[Storefront] -->|JWT or guest| API
  AG[agent-service] -->|shopper JWT<br/>X-Client: ai-agent<br/>X-Conversation-Id<br/>X-Service-Token| API
  subgraph API[commerce-api]
    direction TB
    MW[helmet · CORS · throttler] --> G[guards] --> V[ValidationPipe] --> C[controllers] --> S[services] --> ORM[TypeORM]
    C -.-> AU[AgentAuditInterceptor]
  end
  ORM --> PG[(PostgreSQL)]
  AU --> PG
```

## 3. Source layout

```
commerce-api/
├── src/
│   ├── main.ts                    bootstrap: helmet, CORS, prefix api/v1, ValidationPipe, Swagger, shutdown hooks
│   ├── app.module.ts              Config, Logger, Throttler, all feature modules, global guard + interceptor
│   ├── auth/                      controller, service, DTOs, JwtAuthGuard, OptionalJwtAuthGuard, @CurrentUser
│   ├── products/                  controller, service, DTO (search, detail, recommendations, categories)
│   ├── cart/                      controller, service, DTOs (cart, coupon, checkout)
│   ├── orders/orders.module.ts    controller + service in one file
│   ├── returns/returns.module.ts
│   ├── faq/faq.module.ts
│   ├── support/support.module.ts
│   ├── health/health.module.ts
│   ├── common/
│   │   ├── agent-audit.interceptor.ts
│   │   └── money.ts
│   └── database/
│       ├── entities.ts            all entities + ENTITIES array
│       ├── data-source.ts         options + CLI DataSource
│       ├── database.module.ts     TypeOrmModule (global)
│       ├── seed.ts
│       └── migrations/            Init, SearchIndexes
├── docs/                          this folder
└── dist/                          build output
```

Convention: small features keep controller + service + DTOs + module in one `*.module.ts`; larger ones split files.

## 4. Request pipeline

1. **helmet** — security headers.
2. **CORS** — origins from `CORS_ORIGINS` (comma-separated), credentials allowed.
3. **Global prefix** — `api/v1` for everything except `/health`.
4. **ServiceTokenMiddleware** — sets `req.isTrustedAgent` when `X-Service-Token` matches `SERVICE_TOKEN`; `X-Client: ai-agent` without it → 403.
5. **UserThrottlerGuard** (global) — keyed by verified JWT `sub`, else trusted-agent conversation, else IP; default `RATE_LIMIT_PER_MIN` (120) per 60 s; stricter on register (5) and login (10); `/health` skipped.
6. **Route guards** — `JwtAuthGuard` (401 if missing/invalid) or `OptionalJwtAuthGuard` (guest allowed). Both verify issuer `commerce-api` and set `req.user`.
7. **ValidationPipe** — `whitelist`, `forbidNonWhitelisted`, `transform`. Unknown fields → 400.
8. **IdempotencyInterceptor** (returns, tickets, checkout) — replays stored responses for a repeated `Idempotency-Key`.
9. **Controller → service** — business rules; ownership in queries.
10. **AgentAuditInterceptor** (global) — for trusted agent POST/PATCH/PUT/DELETE, inserts into `agent_action_logs` with `status` and `error`, successes and failures.
11. **pino-http** — request logs, `authorization` and `x-service-token` headers redacted.

## 5. Authentication and authorization

- Passwords: bcrypt cost 12. Emails lower-cased.
- JWTs: HS256, issuer `commerce-api`, payload `{ sub, ver, name, role }` (no email: tokens reach the browser). Two audiences:
  - `storefront` — the shopper's session, expiry `JWT_EXPIRES_IN` (1 h). Login/register set it as an httpOnly, `SameSite=Lax` cookie `session` (`Secure` in production, path `/api/v1`); it is not in the response body. API clients may send it as `Authorization: Bearer`.
  - `agent` — chat token from `POST /auth/agent-token` (JWT, `CUSTOMER` only, else 403), expiry `AGENT_TOKEN_EXPIRES_IN` (15 min). Accepted **only** with a valid `X-Service-Token`, and agent traffic accepts **only** this audience.
- CSRF: cookie-authenticated `POST/PATCH/PUT/DELETE` need an `X-Requested-With` header (403 otherwise). Cross-origin pages can't send it without passing the CORS allowlist.
- Revocation: `users.token_version` is signed into every token as `ver`. `POST /auth/logout` bumps it, which revokes every session and chat token the shopper holds, on every device, and clears the cookie. The guards load the user on each request, so the role, name and version are always current.
- Agent allowlist: with a service token, `JwtAuthGuard`/`OptionalJwtAuthGuard` return 403 `This can only be done on the store website, not in chat` unless the route has `@AgentAllowed()` (cart, `GET /orders`, `GET /orders/:n`, `POST /returns`, `POST /support/tickets`, conversations). `POST /checkout` and `POST /orders/:n/payment` are not allowed. Agent traffic for a non-`CUSTOMER` user is rejected (403).
- Roles: `CUSTOMER` (default), `SUPPORT`, `ADMIN`. Staff routes use `@UseGuards(JwtAuthGuard, RolesGuard)` with `@Roles(...)`; `RolesGuard` fails closed when `@Roles()` is missing. No staff routes yet.
- **Ownership rule:** user-scoped queries include `userId` in the `where` clause (`orders`, `returns`, `cart`). A wrong order number and someone else's order both return 404 — no existence leak.
- The agent uses the shopper's JWT; there is no privileged agent credential.

## 6. Data model

```mermaid
erDiagram
  users ||--o| carts : has
  carts ||--o{ cart_items : contains
  products ||--o{ cart_items : in
  categories ||--o{ products : groups
  users ||--o{ orders : places
  orders ||--o{ order_items : contains
  products ||--o{ order_items : snapshot
  orders ||--o{ return_requests : has
  users ||--o{ support_tickets : opens
  users ||--o{ agent_action_logs : subject
  coupons }o--o{ carts : "applied by code"
```

| Table | Key fields | Notes |
|---|---|---|
| users | email (unique), password_hash, role | |
| categories | name, slug (unique) | |
| products | sku, slug (unique), price_cents, stock, tags[], attributes jsonb, rating, is_active | idx (is_active, price_cents); trigram on name/description; GIN on tags |
| carts | user_id (unique), coupon_code | created with `ON CONFLICT DO NOTHING` |
| cart_items | (cart_id, product_id) unique, quantity | |
| coupons | code, percent_off / amount_off_cents, min_subtotal_cents, expires_at, is_active | |
| orders | order_number (unique), status, *_cents, shipping_address jsonb, carrier, tracking_number, shipped_at, delivered_at | idx (user_id, created_at) |
| order_items | name_snapshot, unit_price_cents, quantity | price/name frozen at purchase |
| return_requests | order_id, user_id, reason, items jsonb, status | |
| faq_articles | topic, question, answer | GIN full-text index |
| support_tickets | user_id null, conversation_id, subject, summary, priority, status | |
| agent_action_logs | user_id, conversation_id (idx), action, payload jsonb, status, error | |
| idempotency_keys | key, user_id, route, request_hash, response jsonb, status_code | unique (user_id, key) NULLS NOT DISTINCT; 24 h TTL |

Status enums:
- Order: `PENDING → PAID → PROCESSING → SHIPPED → DELIVERED`, or `CANCELLED` / `REFUNDED`
- Return: `REQUESTED → APPROVED | REJECTED → RECEIVED → REFUNDED`
- Ticket: `OPEN → ASSIGNED → RESOLVED`

Money is always integer cents; `formatMoney(cents, currency)` formats at the edge. DTOs return both `price` (formatted) and `priceCents`.

## 7. Business rules

| Rule | Where |
|---|---|
| Product search: terms (stopwords removed, max 8, naive singular) must each match name/description/brand/category/tags | `ProductsService.search` |
| Recommendations: same category or shared tag, in stock, price 0.5×–1.8×, top rated, 4 items | `ProductsService.recommendations` |
| Add to cart: total quantity ≤ stock; quantity 1–20 per call | `CartService.addItem` |
| Coupon: active, not expired, subtotal ≥ minimum | `CartService.applyCoupon` |
| Shipping: free if subtotal after discount ≥ $50, else $5.99 | `CartService.summarize` |
| Checkout (demo, no payment): cart row locked, conditional stock decrement per item in one transaction; order saved as PAID; cart and coupon cleared | `CartService.checkout` |
| Return eligibility: DELIVERED, within `RETURN_WINDOW_DAYS` (30) of `delivered_at` | `OrdersService.toDto`, `ReturnsService.create` |
| Return creation: items belong to order, qty ≤ purchased, no open (REQUESTED/APPROVED) return | `ReturnsService.create` |
| FAQ: words ≥ 3 chars OR-ed into `to_tsquery`; question weighted A, answer C; top 3 | `FaqService.search` |
| Ticket response time: high/urgent "within 2 hours", else "within 24 hours" | `SupportService.create` |

## 8. Errors

Nest exceptions with human-readable messages (shown to shoppers by the agent):

| Status | Example |
|---|---|
| 400 | `Only 3 of "Trail Runner X" in stock` · `Coupon is invalid or expired` · `The 30-day return window has closed` |
| 401 | `Missing bearer token` · `Invalid or expired token` |
| 404 | `Order not found` · `Product not found` · `Item not in cart` |
| 409 | `Email already registered` |
| 429 | Throttler limit reached |

## 9. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | pino-pretty off in production |
| `PORT` | `3000` | |
| `DATABASE_URL` | `postgresql://shop:shop@localhost:5433/shop` | |
| `DB_POOL_SIZE` | `10` | pg pool |
| `DB_LOGGING` | `false` | SQL logs |
| `RUN_MIGRATIONS_ON_BOOT` | `false` | keep false in production; use pre-deploy job |
| `JWT_SECRET` | dev fallback | **must be set in production** (see §11) |
| `JWT_EXPIRES_IN` | `1h` | storefront session (cookie) lifetime |
| `AGENT_TOKEN_EXPIRES_IN` | `15m` | chat token lifetime |
| `SERVICE_TOKEN` | — | shared with agent-service; **must be set (32+ chars) in production**; unset → agent requests 403 |
| `TRUST_PROXY` | — | proxy hop count behind a load balancer, so `req.ip` is the client |
| `CORS_ORIGINS` | `http://localhost:8080` | add widget/agent origins as needed |
| `STOREFRONT_URL` | `http://localhost:8080` | product and checkout links |
| `RATE_LIMIT_PER_MIN` | `120` | default throttle |
| `RETURN_WINDOW_DAYS` | `30` | |
| `LOG_LEVEL` | `info` | |

## 10. Deployment

- Build: `npm run build` → `dist/`. Run: `node dist/main.js`.
- Migrations: `npm run migration:run:prod` as a pre-deploy job.
- Container: Node 22 slim, non-root user, `npm ci --omit=dev`, `HEALTHCHECK` on `/health`.
- ≥ 2 replicas behind a load balancer; `enableShutdownHooks` drains on SIGTERM.
- Secrets from the platform secret manager; `.env` is local only.

## 11. Planned changes (agent readiness)

### 11.1 Per-user throttling

Done (`src/common/user-throttler.guard.ts`). The JWT is verified in the guard rather than decoded, so a forged `sub` can't get a fresh bucket. Set `TRUST_PROXY` behind a load balancer.

Problem: throttling keys on IP; every agent request comes from the agent-service IPs, so all shoppers share one bucket.

```ts
// src/common/user-throttler.guard.ts
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const auth = req.headers?.authorization ?? '';
    const sub = decodeSubUnverified(auth);          // cheap decode; real verification happens in route guards
    if (sub) return `user:${sub}`;
    if (req.isTrustedAgent) return `agent-guest:${req.headers['x-conversation-id'] ?? req.ip}`;
    return `ip:${req.ip}`;
  }
}
```

Replace `ThrottlerGuard` with `UserThrottlerGuard` in `APP_GUARD`. Set `app.set('trust proxy', 1)` behind a load balancer.

### 11.2 Service token

Done (`src/common/service-token.middleware.ts`). Production refuses to start without a 32+ character `SERVICE_TOKEN`.

- New env `SERVICE_TOKEN`. Middleware compares `X-Service-Token` with `crypto.timingSafeEqual`; on success sets `req.isTrustedAgent = true`.
- `AgentAuditInterceptor` records only when `req.isTrustedAgent` (header alone is ignored).
- Requests with `X-Client: ai-agent` but no valid token → 403.

### 11.3 Audit failures

Done. Insert failures are logged as `audit_insert_failed` (no metrics pipeline yet).

Add an `error` handler in the interceptor `tap` that logs the attempt with `status` and `message`; add `status` and `error` columns to `agent_action_logs` (migration). Replace `.catch(() => undefined)` with a logged error and a metric.

### 11.4 Idempotency

Done (`src/common/idempotency.interceptor.ts`). Same key while the first request runs → 409; failed requests release their key. Expired keys are removed lazily on reuse (no purge job yet).

- Table `idempotency_keys (key, user_id, route, request_hash, response jsonb, status_code, created_at)`, unique (user_id, key).
- `IdempotencyInterceptor` on `POST /returns`, `POST /support/tickets`, `POST /checkout`: same key + same body → stored response; same key + different body → 422; keys expire after 24 h.

### 11.5 Production secret check

Done: startup fails when `NODE_ENV=production` and `JWT_SECRET` is missing or shorter than 32 characters. Outside production it falls back to `'dev-only-change-me'` with a warning.

### 11.6 Conversations

Done: entity `Conversation` (id, user_id, messages jsonb, summary, outcome, tokens_in, tokens_out, feedback jsonb, timestamps) + migration `Conversations1794140351353`. `POST /conversations/:id/turns` appends (upsert) and `POST /conversations/:id/feedback` records ratings; both need `X-Service-Token` (`TrustedAgentGuard`) and filter by owner in the query. No read route. `ConversationRetentionJob` (`conversations/retention.job.ts`, `@nestjs/schedule`) deletes rows with `updated_at` older than `CONVERSATION_RETENTION_DAYS` (90) nightly at 03:00, in batches of 1,000 on the `updated_at` index; a Postgres advisory lock keeps it to one replica per run.

### 11.7 Payments and stock release

Done (`src/payments/payments.module.ts`, `src/orders/stock-release.job.ts`, migration `Payments1794163827211`). Without `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` checkout stays the demo (orders saved as `PAID`, `checkoutUrl: null`); setting only one fails startup.

- `POST /checkout` takes stock and saves the order as `PENDING`, then creates a Stripe Checkout Session (one line for the order total, idempotent per order, expires after 31 min) and returns `checkoutUrl`. If Stripe fails, the order is cancelled, stock and cart are restored, and the shopper gets a 503.
- `POST /payments/webhook` (no JWT, signature checked against the raw body, not throttled): `checkout.session.completed` / `async_payment_succeeded` → `PAID` only if the session ID and amount match; `expired` / `async_payment_failed` → cancel and restore stock. Each event ID is stored in `payment_events` in the same transaction, so redeliveries do nothing.
- `POST /orders/:orderNumber/payment` (storefront only; 403 for the agent) returns `{checkoutUrl}` for the shopper's own `PENDING` order while its session is open and within 30 min. Otherwise it settles the order instead: `PAID` if Stripe says it was paid, or cancelled with stock and cart restored (409 with a message). It never opens a second session, so it can't race the job.
- `StockReleaseJob` runs every minute (advisory lock, one replica): `PENDING` orders older than 30 min have their session expired first, then are cancelled and their stock restored in a transaction. A session that turns out to be paid marks the order `PAID` instead. Payments for an order that is no longer `PENDING` are logged as `payment_not_applied` for staff to refund.

### 11.8 Tracking URLs

Map `carrier` → URL template (UPS, FedEx, USPS) in `orders`; unknown carriers return `trackingUrl: null`.

## 12. Testing

| Level | Tool | Scope |
|---|---|---|
| Unit | Vitest + `@nestjs/testing` | services with repository mocks: return rules, coupon rules, shipping math |
| Integration | Vitest + supertest + real Postgres (CI service) | full HTTP flows on seeded data; ownership (user B can't read user A's order) |
| Contract | Snapshot of Swagger JSON | catch breaking changes to agent-facing DTOs |

## 13. Observability

- pino JSON logs with request ID; propagate `X-Request-Id` from agent-service.
- Metrics (to add): request rate/latency/status per route, throttled requests, audit insert failures, checkout failures, DB pool usage.
- Alerts: 5xx > 1% for 5 min; audit insert failures > 0; p95 > 500 ms.
