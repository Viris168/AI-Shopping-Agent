# PRD — Commerce API (backend)

| | |
|---|---|
| Component | `commerce-api/` (NestJS 11, TypeORM, PostgreSQL) |
| Status | Core built; agent-readiness work in progress |
| Last updated | 2026-11-08 |
| Related | [ARCHITECTURE.md](./ARCHITECTURE.md) · [ARCHITECTURE-ESSENTIAL.md](./ARCHITECTURE-ESSENTIAL.md) · [AGENT.md](./AGENT.md) · [../CLAUDE.md](../CLAUDE.md) |

## 1. Summary

`commerce-api` is the store's system of record and the only backend that the storefront and the AI shopping assistant call. It owns users, catalog, carts, orders, returns, FAQ, support tickets and the audit log of agent actions. This PRD covers what the backend must provide so that both humans (via the storefront) and the AI agent (via `agent-service`) can shop safely.

## 2. Problem

The AI assistant needs to read and change store data for shoppers. If it does that through privileged access or loose endpoints, a manipulated model could leak or change other users' data, double-submit actions, or state wrong facts. The backend must make the safe path the only path.

## 3. Goals

1. One clean, versioned REST API (`/api/v1`) serving the storefront and the agent.
2. Ownership enforced on every user-scoped read and write, so a caller only ever sees their own data.
3. Agent actions are identifiable, auditable and replay-safe.
4. Error messages are clear enough to show directly to shoppers.
5. Fair, per-user rate limiting that works when many shoppers arrive through one agent service.

### Non-goals

- Payment processing inside this service (delegated to a payment provider; see §6 F12)
- Admin back-office UI
- Search engine beyond PostgreSQL (until catalog size requires it)

## 4. Consumers

| Consumer | How it calls | Auth |
|---|---|---|
| Storefront (web) | Browser → `/api/v1/*` | Shopper JWT or guest |
| agent-service | Server → `/api/v1/*` on behalf of a shopper | Shopper JWT + `X-Client: ai-agent` + `X-Conversation-Id` + `X-Service-Token` |
| Support staff | Reads tickets and `agent_action_logs` (DB/admin tool for now) | Staff roles (`SUPPORT`, `ADMIN`) |

## 5. Current capabilities (built)

| Area | Endpoints | Notes |
|---|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` | bcrypt (cost 12), JWT 1 h, issuer `commerce-api`; register 5/min, login 10/min |
| Catalog | `GET /products`, `GET /products/:idOrSlug`, `GET /products/:idOrSlug/recommendations`, `GET /categories` | Keyword + filters + sort; lookup by UUID, slug or SKU |
| Cart | `GET /cart`, `POST /cart/items`, `PATCH /cart/items/:productId`, `DELETE /cart/items/:productId`, `POST /cart/coupon` | Stock checks; coupon rules; free shipping ≥ $50 else $5.99 |
| Checkout | `POST /checkout` | Demo: takes stock atomically and saves the order as PAID (no payment provider yet) |
| Orders | `GET /orders`, `GET /orders/:orderNumber` | Last 20; tracking; `returnEligible` + `returnDeadline` |
| Returns | `POST /returns`, `GET /returns` | Delivered only, 30-day window, item/qty checks, one open return per order |
| FAQ | `GET /faq/search?q=&topic=` | PostgreSQL full-text, ranked, top 3 |
| Support | `POST /support/tickets` | Guest or user; priority; expected response time |
| Health | `GET /health` | DB check; not throttled |
| Audit | `AgentAuditInterceptor` | Logs agent mutations to `agent_action_logs` |

## 6. Requirements

### Functional

| ID | Requirement | Status |
|---|---|---|
| F1 | Product search with q, category, brand, price range, in-stock, sort, pagination | Done |
| F2 | Product detail and recommendations by UUID, slug or SKU | Done |
| F3 | Cart CRUD with stock validation and coupon rules | Done |
| F4 | Orders list/detail scoped to the caller, with tracking and return eligibility | Done |
| F5 | Return creation with policy checks and clear errors | Done |
| F6 | FAQ full-text search with topic filter | Done |
| F7 | Support ticket creation for guests and users | Done |
| F8 | Audit log of every agent mutation, including failures | Done |
| F9 | `Idempotency-Key` on `POST /returns`, `POST /support/tickets`, `POST /checkout` | Done |
| F10 | Service-token verification for agent traffic | Done |
| F11 | `conversations` table and endpoints for transcript storage | Done |
| F12 | Payment provider session on checkout (e.g. Stripe Checkout) + webhook to mark PAID | To do |
| F13 | Job to release stock for orders PENDING > 30 min | To do |
| F14 | Real carrier tracking URLs (UPS, FedEx, USPS, DHL) | Done |
| F15 | Ticket forwarding to helpdesk | To do |

### Non-functional

| Area | Requirement |
|---|---|
| Security | Ownership in queries; validation whitelist; helmet; CORS allowlist; secrets required in production (no fallback JWT secret) |
| Rate limiting | Per user (JWT `sub`), fallback per IP; separate quota for verified agent traffic |
| Performance | p95 < 150 ms for reads, < 300 ms for writes at expected peak (excl. network) |
| Availability | Stateless; ≥ 2 replicas; graceful shutdown; `/health` for probes |
| Data | Money as integer cents; migrations only (`synchronize: false`) |
| Observability | Structured pino logs; request ID; auth headers redacted |
| Compatibility | Breaking changes only in a new version prefix (`/api/v2`) |

## 7. Success metrics

| Metric | Target |
|---|---|
| Cross-user data access incidents | 0 |
| Duplicate returns/tickets from retries | 0 |
| Agent mutations missing from audit log | 0 |
| 5xx rate | < 0.5% |
| p95 latency (reads) | < 150 ms |

## 8. Milestones

| Milestone | Target | Scope |
|---|---|---|
| Agent hardening | 12 Nov 2026 | F8, F9, F10, per-user throttling, production secret check |
| Transcripts | 20 Nov 2026 | F11 |
| Production readiness | 5 Dec 2026 | F14, Dockerfile, tests, CI, metrics |
| Payments | Before 100% launch | F12, F13 |
| Helpdesk | 14 Dec 2026 | F15 |

## 9. Open questions

- [ ] Payment provider (Stripe assumed)?
- [ ] Helpdesk for ticket forwarding?
- [ ] Refresh tokens, or keep 1 h access tokens with storefront re-issue?
- [ ] Multi-currency needed at launch? (Currency column exists; formatting assumes `en-US`.)
