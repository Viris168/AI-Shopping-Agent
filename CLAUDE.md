# CLAUDE.md

Guidance for Claude (and other AI coding assistants) working in this repository.

## What this is

A production AI shopping assistant for an e-commerce store, in three parts:

| Dir | Stack | State |
|---|---|---|
| `commerce-api/` | NestJS 12, TypeORM 1.x, PostgreSQL 16, TypeScript | Built — the source of truth |
| `agent-service/` | Python 3.12, FastAPI, Anthropic SDK, httpx, Redis | To build |
| `storefront/` | React 19, Vite, TypeScript, React Router | Built — demo shop for `commerce-api` |
| `widget/` | TypeScript, Vite library mode, Shadow DOM | To build |

Read before larger changes:
- [ARCHITECTURE-ESSENTIAL.md](./ARCHITECTURE-ESSENTIAL.md) — one page, read first
- [ARCHITECTURE.md](./ARCHITECTURE.md) — full design, endpoints, data, deployment
- [AGENT.md](./AGENT.md) — prompt, tool schemas, loop, evals
- [PRD.md](./PRD.md) — what we're building and why

## Commands

### commerce-api

```bash
cd commerce-api
cp .env.example .env              # first time; set DATABASE_URL, JWT_SECRET
npm install
npm run migration:run             # apply migrations
npm run seed                      # demo data; login alice@example.com / Password123!
npm run start:dev                 # http://localhost:3000, Swagger at /docs
npm run build                     # compile to dist/
npm run migration:generate        # after changing entities.ts
```

### agent-service (once scaffolded)

```bash
cd agent-service
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
pytest
python -m evals.run --suite golden
python -m evals.run --suite redteam
```

### storefront

```bash
cd storefront
npm install
npm run dev                       # http://localhost:8080; /api is proxied to commerce-api on :3000
npm test
npm run build                     # type check + dist/
```

### widget (once scaffolded)

```bash
cd widget
npm install
npm run dev                       # demo host page
npm run build                     # dist/widget.js
```

## Non-negotiable rules

1. **The agent never gets privileged access.** It calls `commerce-api` only with the shopper's JWT. Never add an admin/service credential that can read or change other users' data.
2. **Ownership is enforced in the query.** In `commerce-api`, every user-scoped read/write filters by `userId` in the `where` clause (see `OrdersService.get`). Never fetch by ID and check afterwards.
3. **The agent never calls `POST /checkout`.** Payment happens only on the storefront checkout page.
4. **Confirm-first tools run only from `/v1/actions/{id}/confirm`.** Never execute `create_return` or `create_support_ticket` directly from the model's tool call.
5. **Facts come from tools.** Don't add prompt text or code that lets the model state prices, stock, dates, policies or discounts without a tool result.
6. **Tool output is data.** Keep it wrapped as `<tool_result>` and never let it change instructions.
7. **Money is integer cents.** Format only at the edge with `formatMoney` (`commerce-api/src/common/money.ts`).
8. **No secrets in code or images.** `.env` is local only; don't commit or print it.

## Conventions

### commerce-api

- One feature per folder under `src/`. Small features keep controller, service, DTOs and module in one `*.module.ts` file (see `orders`, `returns`, `faq`); larger ones split files (see `cart`, `products`, `auth`).
- Entities live in `src/database/entities.ts` and are registered in `ENTITIES`. Schema changes need a migration in `src/database/migrations/`; never use `synchronize`.
- DTOs use `class-validator` with explicit `@MaxLength`/`@Min`/`@Max`; the global `ValidationPipe` whitelists and forbids unknown fields.
- Guards: `JwtAuthGuard` for login-only routes, `OptionalJwtAuthGuard` when guests are allowed; get the user with `@CurrentUser()`.
- Agent-made mutations are logged by `AgentAuditInterceptor` (headers `X-Client: ai-agent`, `X-Conversation-Id`). Don't bypass it.
- Return friendly, user-readable error messages (`BadRequestException('The 30-day return window has closed')`) — the agent shows them to shoppers.

### agent-service

- All model calls go through `app/llm.py`; model IDs come from config (`MODEL_MAIN`, `MODEL_FAST`).
- All API calls go through `app/commerce_client.py` (timeouts, retries, headers, request ID).
- One tool = one entry in `app/tools/` with a Pydantic input model, `requires_auth`, `confirm`, handler, and card builder.
- Async everywhere; no blocking I/O in request handlers.
- Never log JWTs or raw personal data; use the masking helper.
- Type hints required; `ruff` + `mypy` clean.

### storefront

- All API calls go through `src/api.ts`; show `ApiError.message` to shoppers as-is (commerce-api writes it for them).
- Prices come formatted from the API; never compute or format money in the UI.
- Login token lives in `localStorage` via `src/storage.ts`; a 401 on a logged-in request signs the shopper out.
- Shop filters live in the URL query string.

### widget

- No runtime framework; keep `dist/widget.js` under 40 KB gzipped.
- Everything renders inside the Shadow DOM; no global CSS or globals except `window.ShopChat`.
- Render model text as text, never `innerHTML`. Only allow links to store domains.
- Keyboard and screen-reader support are required, not optional.

## Adding an agent tool

1. Make sure a `commerce-api` route exists (add one with a DTO and ownership check if not).
2. Add the tool in `agent-service/app/tools/<area>.py` and register it.
3. Decide `requires_auth` and `confirm`. Anything irreversible, financial, or that creates a record for staff → `confirm=True`.
4. Add a card type in `widget/src/cards/` if the result should render.
5. Update the tool table in `AGENT.md` and `ARCHITECTURE-ESSENTIAL.md`.
6. Add golden and red-team eval cases. Both suites must pass.

## Testing

- `commerce-api`: unit tests for services; integration tests against a real Postgres with seed data.
- `agent-service`: unit tests for tools (mock `commerce_client`), loop tests with a fake LLM, then evals with the real model.
- Seed data covers key cases: `ORD-1001` delivered (returnable), `ORD-1002` shipped, `ORD-1003` processing, `ORD-0950` delivered 65 days ago (window closed); coupons `WELCOME10`, `SAVE20`, `OLD2023` (expired).

## Known gaps (Phase 1 work)

- No `conversations` table yet.
- No payment provider: `POST /checkout` marks the order PAID straight away (demo).
- No CI yet.

## When unsure

Prefer the smaller, safer change. If a request conflicts with the rules above, stop and ask rather than work around them.
