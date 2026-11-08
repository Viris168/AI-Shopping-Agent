# ecommerce-ai

Design docs: [PRD.md](PRD.md) · [ARCHITECTURE-ESSENTIAL.md](ARCHITECTURE-ESSENTIAL.md) (read first) · [ARCHITECTURE.md](ARCHITECTURE.md) · [AGENT.md](AGENT.md) · [CLAUDE.md](CLAUDE.md) · [NOTES.md](NOTES.md)

| Part | Stack | Port | State |
|---|---|---|---|
| `agent-service/` | Python 3.12, FastAPI, Anthropic SDK, Redis | 8000 | Built to [AGENT.md](AGENT.md): 15 tools, confirm gate, sessions, guardrails, evals |
| `commerce-api/` | NestJS, TypeORM, PostgreSQL | 3000 | Built to [commerce-api/docs](commerce-api/docs/ARCHITECTURE.md): auth, cart, demo checkout (Pay marks the order PAID), orders, returns, FAQ, support, audit log |
| `storefront/` | React 19, Vite, TypeScript, React Router | 8080 (dev) | Demo shop: search, product pages, login, cart, coupons, Pay, orders, returns, help |
| `widget/` | TypeScript, Vite library mode, Shadow DOM | 5173 (dev) | Built: one script tag, cards, confirm buttons, en/vi, 10.9 KB gzipped |

## Run locally

You need Redis (agent-service won't start without it) and Postgres for commerce-api.

```bash
docker run -d --name shop-db -p 127.0.0.1:5433:5432 -e POSTGRES_USER=shop -e POSTGRES_PASSWORD=shop -e POSTGRES_DB=shop -v shop-db-data:/var/lib/postgresql/data postgres:16
cd commerce-api
cp .env.example .env          # set JWT_SECRET (same value in agent-service/.env)
npm install && npm run migration:run && npm run seed
npm run start:dev             # http://localhost:3000, Swagger at /docs
```

```bash
cd agent-service
cp .env.example .env          # set ANTHROPIC_API_KEY, and JWT_SECRET to match commerce-api
pip install -e ".[dev]"       # or: uv sync --extra dev
uvicorn app.main:app --reload --port 8000
```

```bash
cd storefront && npm install && npm run dev  # shop at http://localhost:8080 (proxies /api to commerce-api)
```

```bash
cd widget && npm install && npm run dev     # demo store page at http://localhost:5173
```

Open http://localhost:5173 and click the bubble, or try the API directly as a guest:

```bash
curl -N -X POST localhost:8000/v1/chat -H 'content-type: application/json' -d '{"message":"Cheapest in-stock backpack?"}'
```

Guests get search, product details, recommendations, categories and FAQ. For cart, orders and returns, log in with `POST /api/v1/auth/login` as `alice@example.com` / `Password123!` and paste the `accessToken` into the widget demo page. `npm run seed` resets all demo data.

## Tests and evals

```bash
cd agent-service && pytest && ruff check . && mypy
cd commerce-api && npm test && npm run test:e2e && npm run lint
cd storefront && npm test && npm run build
cd widget && npm test && npm run build      # build fails if the bundle exceeds 40 KB gzipped
cd agent-service && python -m evals.run --suite golden    # needs the real, seeded commerce-api + API key
cd agent-service && python -m evals.run --suite redteam   # same; see agent-service/evals/README.md
```

## Embedding the widget

```html
<script src="https://chat.yourstore.com/v1/widget.js" data-store="main" async></script>
<script>
  window.ShopChat = { getToken: () => fetch('/session/token').then(r => r.ok ? r.text() : null) };
</script>
```

Optional attributes:
- `data-api`: agent-service URL. Defaults to the script's own origin.
- `data-locale`: `en` or `vi`. Defaults to the page language.
- `data-link-domains`: extra hosts links may point to, such as carrier tracking sites. Only the store's own domains are allowed by default.
- `data-help-url`: the page offered when chat fails.

Theming uses CSS variables on `#shopchat-root`: `--shopchat-accent`, `--shopchat-bg`, `--shopchat-text`, `--shopchat-radius`, `--shopchat-font` and more.

The widget mounts only if agent-service's `GET /v1/config` says the assistant is on and this browser is inside the rollout percentage; staff can preview with `?shopchat=on` ([infra/monitoring](./infra/monitoring/README.md#rollout)). When the model is down or the assistant is switched off mid-chat, it shows a fallback card pointing at `data-help-url`.

The widget fires `shopchat:open`, `shopchat:close` and `shopchat:cart-updated` (with the cart as `detail`) on `window`. It also adds `ShopChat.open()`, `.close()`, `.toggle()` and `.reset()`.

## Where agent-service differs from the docs

| Doc says | Code does | Why |
|---|---|---|
| Transcripts written to Postgres `conversations` (ARCHITECTURE §5.2) | Not written | The table doesn't exist yet (backend Phase 1) |
| Feedback stored | Logged as a masked line only | No store has been decided |
| Haiku writes the ticket summary (ARCHITECTURE §3.3) | The main model writes it in the `create_support_ticket` call | Follows AGENT.md §3.1 |
| `{auth_state}` and `{today}` sit mid-prompt | Login and Context sections go last | Keeps the fixed part cacheable (AGENT.md §2) |
| ~150 golden and ~40 red-team cases | The 13 + 6 examples from AGENT.md §8; 2 red-team cases skipped | The skipped two need poisoned seed data |
| Token budget per conversation | `TOKEN_BUDGET` = 300,000 | No number given; tune after beta |
| Audit insert failure alert (ARCHITECTURE §8) | Rule written (`infra/monitoring/alerts-logs.yaml`), can't fire yet | Needs commerce-api logs shipped to Loki |
