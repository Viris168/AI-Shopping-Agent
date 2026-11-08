# CLAUDE.md — commerce-api

Guidance for Claude (and other AI coding assistants) working in this backend.

## What this is

The store's backend and system of record: NestJS 12, TypeORM 1.x, PostgreSQL, TypeScript. It serves the storefront and the AI shopping agent through `/api/v1`. The agent calls it with the shopper's own JWT, so this service is the safety net for everything the agent does.

Docs (read before larger changes):
- [docs/ARCHITECTURE-ESSENTIAL.md](./docs/ARCHITECTURE-ESSENTIAL.md) — one page, read first
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — pipeline, data model, rules, planned changes
- [docs/AGENT.md](./docs/AGENT.md) — the contract with the AI agent
- [docs/PRD.md](./docs/PRD.md) — requirements and milestones

## Commands

```bash
cp .env.example .env              # first time; set JWT_SECRET
npm install
npm run migration:run             # apply migrations (needs Postgres at DATABASE_URL)
npm run seed                      # demo data; alice@example.com / Password123!
npm run start:dev                 # http://localhost:3000 · Swagger /docs · /health
npm run build                     # compile to dist/
npm start                         # run dist/main.js
npm run migration:generate        # after editing src/database/entities.ts
npm run migration:run:prod        # production migrations from dist/
```

Local Postgres:

```bash
# Port 5433 so it doesn't clash with a system Postgres on 5432. Tests use a separate shop_test database.
docker run -d --name shop-db -p 127.0.0.1:5433:5432 -e POSTGRES_USER=shop -e POSTGRES_PASSWORD=shop -e POSTGRES_DB=shop -v shop-db-data:/var/lib/postgresql/data postgres:16
```

Always run `npm run build` after changes; it is the type check.

## Layout

```
src/
├── main.ts            helmet, CORS, prefix api/v1, ValidationPipe, Swagger
├── app.module.ts      modules + ServiceTokenMiddleware + global UserThrottlerGuard + AgentAuditInterceptor
├── auth/              JWT guards, @CurrentUser, register/login/me
├── products/  cart/   split files (controller, service, dto, module)
├── orders/ returns/ faq/ support/ health/   single *.module.ts files
├── common/            audit + idempotency interceptors, service-token middleware, user throttler, money.ts
└── database/          entities.ts, data-source.ts, migrations/, seed.ts
```

## Rules (do not break)

1. **Ownership in the query.** User-scoped reads/writes put `userId` in the `where` clause (see `OrdersService.get`). Never load by ID and check ownership afterwards. Not found and not yours both → 404.
2. **No privileged agent access.** Don't add endpoints or credentials that let the agent act beyond the shopper's JWT.
3. **Money is integer cents.** Store and compute in cents; format with `formatMoney` only in DTOs. Return both formatted and cents values.
4. **Migrations only.** `synchronize` stays `false`. Every entity change ships with a migration in `src/database/migrations/`. Never edit an applied migration.
5. **Validate everything.** Every body/query is a DTO with class-validator and explicit limits. The global pipe forbids unknown fields.
6. **Readable errors.** Throw Nest exceptions with messages a shopper can understand — the agent shows them verbatim.
7. **Keep the audit.** Don't bypass or weaken `AgentAuditInterceptor`; agent mutations must be logged.
8. **Stock changes are atomic.** Use conditional updates inside transactions (see `CartService.checkout`).
9. **Secrets stay out.** Never commit or print `.env`; never log tokens (pino redacts `authorization` and `x-service-token`).
10. **Agent contract.** Changing a route, DTO or error message used by the agent means updating `docs/AGENT.md` in the same change.

## Conventions

- Small features: controller + service + DTOs + module in one `<feature>.module.ts`. Split into files once it grows (as in `cart/`, `products/`).
- New entities go in `src/database/entities.ts` and the `ENTITIES` array.
- New migrations must also be added to `src/database/migrations/index.ts` (explicit list, no glob).
- Use `JwtAuthGuard` for login-only routes, `OptionalJwtAuthGuard` when guests are allowed, `@CurrentUser()` to read the user.
- Swagger: `@ApiTags` on controllers, `@ApiBearerAuth()` where JWT is used.
- Prefer query builders with named parameters; never interpolate user input into SQL.
- Column names snake_case in DB (`@Column({ name: 'price_cents' })`), camelCase in TS.

## Adding an endpoint

1. DTO with tight validation.
2. Service method with ownership in the query and clear exceptions.
3. Controller with the right guard and Swagger decorators.
4. Register in the feature module (and `AppModule` if new).
5. Migration if the schema changed.
6. Integration test, including a cross-user access case.
7. If the agent uses it: update `docs/AGENT.md` (tool map, response shape, errors); add `Idempotency-Key` support if it creates records.

## Seed fixtures

`ORD-1001` delivered (returnable) · `ORD-1002` shipped · `ORD-1003` processing · `ORD-0950` delivered 65 days ago (window closed) · coupons `WELCOME10`, `SAVE20` (min $100), `OLD2023` (expired).

## Known gaps (current work)

- No `conversations` table (§11.6)
- Demo checkout: no payment provider, `POST /checkout` marks the order PAID immediately (§11.7)
- No Dockerfile or CI yet

## When unsure

Choose the smaller, safer change. If a request conflicts with the rules above, stop and ask.
