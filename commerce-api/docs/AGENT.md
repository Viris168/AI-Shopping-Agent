# Agent Contract — Commerce API

How the AI shopping agent (`agent-service`) talks to this backend: headers, auth, the endpoints each agent tool uses, response shapes, errors and guarantees. If you change anything here, the agent's tools and evals must change too.

## 1. Principles

1. **No privileged access.** The agent calls with the shopper's own JWT. There is no agent "super user".
2. **The backend is the safety net.** Ownership, stock, coupon and return rules are enforced here, not in the prompt.
3. **Every agent mutation is attributable** to a user and a conversation.
4. **Retries are safe** on endpoints that create records (idempotency keys).
5. **Errors are shopper-readable.** The agent relays `message` directly.

## 2. Request headers

| Header | Required | Value | Effect |
|---|---|---|---|
| `Authorization` | for login-only routes | `Bearer <chat token>` | Identifies the shopper. Must be a chat token (audience `agent`, from `POST /auth/agent-token`), never the storefront session; anything else is 401 |
| `X-Client` | yes | `ai-agent` | Marks agent traffic; 403 without a valid `X-Service-Token` |
| `X-Conversation-Id` | yes | conversation UUID | Stored in audit log and tickets |
| `X-Service-Token` | yes | `SERVICE_TOKEN` | Proves the call comes from agent-service; enables audit and the agent-guest rate-limit bucket |
| `X-Request-Id` | recommended | UUID | Correlates logs across services |
| `Idempotency-Key` | on `POST /returns`, `POST /support/tickets` | UUID per pending action (1–100 chars `A-Za-z0-9_.:-`) | Safe retries: same key + body → stored response with `Idempotent-Replayed: true`; kept 24 h |

Base URL: `{COMMERCE_API_URL}` = `http://commerce-api:3000/api/v1`.

## 3. Tool → endpoint map

| Agent tool | Method + path | Auth | Agent confirm step |
|---|---|---|---|
| `search_products` | `GET /products?q&category&brand&minPriceCents&maxPriceCents&inStock&sort&limit&offset` | – | – |
| `get_product` | `GET /products/{idOrSlug}` (UUID, slug or SKU) | – | – |
| `get_recommendations` | `GET /products/{idOrSlug}/recommendations` | – | – |
| `list_categories` | `GET /categories` | – | – |
| `search_faq` | `GET /faq/search?q&topic` | – | – |
| `view_cart` | `GET /cart` | ✓ | – |
| `add_to_cart` | `POST /cart/items` `{productId, quantity}` (productId may be UUID, SKU or slug) | ✓ | – |
| `update_cart_item` | `PATCH /cart/items/{productId}` `{quantity}` (0 removes; productId or SKU) | ✓ | – |
| `remove_cart_item` | `DELETE /cart/items/{productId}` | ✓ | – |
| `apply_coupon` | `POST /cart/coupon` `{code}` | ✓ | – |
| `list_orders` | `GET /orders` | ✓ | – |
| `get_order` | `GET /orders/{orderNumber}` | ✓ | – |
| `create_return` | `POST /returns` `{orderNumber, reason, items:[{orderItemId, quantity}]}` | ✓ | **yes** |
| `create_support_ticket` | `POST /support/tickets` `{conversationId, subject, summary, priority?, contactEmail?}` | optional | **yes** |
| `checkout_link` | none — agent links to the storefront checkout page | ✓ | – |

**Transcripts (agent-service internals, not model tools):** `POST /conversations/{id}/turns` `{messages[≤100], summary?, outcome?, tokensIn?, tokensOut?}` appends a turn, creating the row on first use; `POST /conversations/{id}/feedback` `{messageId, rating: up|down, comment?}`. Both: `{id}` is a UUID, optional JWT, `X-Service-Token` required (else 403 `Only the shopping assistant can do this`), `204` on success, `404 Conversation not found` if the row belongs to someone else. Messages must already be masked.

**Memory (agent-service internals, PLAN-18):** all need the chat token and `X-Service-Token` (else 403 `Only the shopping assistant can do this`); guests get 401.
- `GET /memory?q=` → `{enabled, facts: [{id, kind, value, updatedAt}], episodes: [{id, conversationId, summary, outcome, entities: {orders, products}, createdAt}]}`: facts, the 3 latest episodes, and up to 3 earlier ones similar to `q`. With memory off: `{enabled: false, facts: [], episodes: []}`.
- `POST /memory/episodes` `{conversationId, summary ≤ 500, outcome?, entities?: {orders ≤ 10, products ≤ 10}}` → `204`; a second call for the same conversation replaces it.
- `POST /memory/facts` `{kind: size|style|diet|brand_like|brand_dislike|other, value ≤ 200, confidence? 0–1, sourceConversationId?}` → `201 {id}`; same kind + value (ignoring case and spaces) updates the existing fact. `400 The assistant can remember up to 50 things. Forget some first.`
- `DELETE /memory/facts/{id}` → `204`, `404 That memory was not found` (also when it's someone else's).
- Writes with memory off: `403 The shopper has not turned on assistant memory`. The agent can't turn memory on: `/account/memory` is storefront-only (403 `This can only be done on the store website, not in chat`). Summaries and values must already be masked.

**Off-limits to the agent:** every route without `@AgentAllowed()`, including `POST /checkout`, `POST /orders/{orderNumber}/payment`, and all of `/auth/*` (403 `This can only be done on the store website, not in chat` with a service token). Payment and credentials stay in the storefront.

**Not a tool:** `DELETE /cart/coupon` (JWT) removes the cart's coupon. The storefront and the eval harness use it (evals reset the cart before each case).

## 4. Response shapes

Field names are exact; values are illustrative.

### Product (list item)

```json
{
  "id": "3f1c…", "sku": "SHOE-001", "name": "Trail Runner X", "slug": "trail-runner-x",
  "brand": "Stride", "category": "Shoes",
  "price": "$89.00", "priceCents": 8900, "inStock": true, "stock": 14, "rating": 4.6,
  "imageUrl": "https://…", "url": "https://store…/products/trail-runner-x",
  "summary": "First 160 characters of the description…"
}
```

`GET /products` → `{ "total": 42, "items": [Product…] }`. Detail replaces `summary` with `description`, `attributes`, `tags`.
`GET /products/{id}/recommendations` → `{ "basedOn": "Trail Runner X", "items": [Product…] }` (max 4).
`GET /categories` → `[{ "name": "Shoes", "slug": "shoes" }]`.

### Cart

```json
{
  "items": [{ "productId": "3f1c…", "sku": "SHOE-001", "name": "Trail Runner X",
              "quantity": 1, "unitPrice": "$89.00", "lineTotal": "$89.00" }],
  "itemCount": 1, "couponCode": "WELCOME10",
  "subtotalCents": 8900, "discountCents": 890, "shippingCents": 0, "totalCents": 8010,
  "subtotal": "$89.00", "discount": "$8.90", "shipping": "$0.00", "total": "$80.10",
  "freeShippingRemaining": null
}
```

All cart mutations return this same shape.

### Order

```json
{
  "orderNumber": "ORD-1001", "status": "DELIVERED", "placedAt": "2026-10-27T…",
  "total": "$129.00", "itemCount": 3,
  "carrier": "UPS", "trackingNumber": "1Z999AA10123456784", "trackingUrl": "https://…",
  "shippedAt": "…", "deliveredAt": "…",
  "returnEligible": true, "returnDeadline": "2026-11-30T…",
  "items": [{ "orderItemId": "a7…", "name": "Trail Runner X", "quantity": 1, "unitPrice": "$89.00" }],
  "returns": []
}
```

`GET /orders` returns up to 20 orders without `items`/`returns`.

### Return created

```json
{ "returnId": "c2…", "status": "REQUESTED",
  "nextSteps": "A prepaid return label will be emailed within 24 hours. Refunds are issued 3–5 business days after we receive the item." }
```

### FAQ search

```json
{ "results": [{ "topic": "returns", "question": "How long do refunds take?", "answer": "…", "score": "0.412" }] }
```

Empty `results` means no grounded answer — the agent must say it isn't sure. Search is hybrid (full-text + vector, fused by rank); `score` is the fused rank score, not a confidence.

### Ticket created

```json
{ "ticketId": "e9…", "status": "OPEN", "expectedResponse": "within 24 hours" }
```

## 5. Errors the agent must handle

| Status | Message (examples) | Agent behaviour |
|---|---|---|
| 400 | `"Trail Runner X" is out of stock` · `Only 3 of "…" in stock` | Relay; suggest alternatives |
| 400 | `Coupon is invalid or expired` · `Coupon requires a subtotal of at least $100.00` | Relay; never suggest other codes |
| 400 | `Only delivered orders can be returned` · `The 30-day return window has closed` · `A return is already open for this order` | Relay; offer handoff if shopper disputes |
| 400 | `Item … is not part of this order` · `Quantity exceeds purchased amount` | Re-fetch order, correct, re-propose |
| 400 | validation errors (array of messages) | Fix arguments once, else apologise |
| 400 | `Idempotency-Key must be 1–100 letters, digits or "-_.:" characters` | Bug in agent-service; don't retry |
| 401 | `Missing bearer token` · `Invalid or expired token` | Ask shopper to log in (widget refreshes token) |
| 403 | `Agent requests need a valid service token` | Config error (`SERVICE_TOKEN` mismatch); apologise and alert |
| 403 | `This can only be done on the store website, not in chat` | Bug in agent-service (route not allowed); link to the storefront |
| 403 | `The assistant is for shopper accounts only` | Staff account; continue as guest |
| 404 | `Order not found` · `Product not found` · `Item not in cart` | Ask to double-check; never imply the order exists for someone else |
| 409 | `This request is already being processed; please retry shortly` | Same key still running: wait, retry with the same key |
| 422 | `This Idempotency-Key was already used for a different request` | Bug in agent-service (key reused); don't retry |
| 429 | rate limited | Back off; tell shopper to try again shortly |
| 5xx | — | Retry ≤ 2 (GET always; POST only with idempotency key), then apologise and offer handoff |

## 6. Guarantees

| Guarantee | Mechanism | Status |
|---|---|---|
| Shopper only sees own data | `userId` in every user-scoped query | Done |
| Stock never oversold at checkout | Conditional `UPDATE … WHERE stock >= qty` in a transaction | Done |
| One open return per order | Check in `ReturnsService.create` | Done |
| Agent mutations logged | `AgentAuditInterceptor` | Done |
| Failed agent mutations logged | interceptor error path (`status`, `error`) | Done |
| Retries don't duplicate | `Idempotency-Key` | Done |
| Spoofed agent traffic rejected | `X-Service-Token` | Done |
| Fair per-shopper limits | `UserThrottlerGuard` | Done |

## 7. Audit log

Table `agent_action_logs`:

| Column | Example |
|---|---|
| user_id | `b1…` (null for guest tickets) |
| conversation_id | `5d…` |
| action | `POST /returns` · `PATCH /cart/items/:productId` |
| payload | `{ "params": {…}, "body": {…} }` (body omitted for `/conversations/*` and `/memory/*`, marked `@AuditWithoutBody()`) |
| status | `201` · `400` |
| error | `The 30-day return window has closed` (null on success) |
| created_at | timestamp |

Support staff answer "why is this in my cart?" by filtering on `user_id` or `conversation_id`.. Failed attempts are logged too (rejected before the route — 401, 403, 429 — are not).

## 8. Rate limits

| Traffic | Limit (per 60 s) |
|---|---|
| Default | `RATE_LIMIT_PER_MIN` = 120 |
| Register / login | 5 / 10 |
| Keyed by | verified JWT `sub`; trusted agent guests by `X-Conversation-Id`; everyone else by IP |

## 9. Adding an agent-facing endpoint

1. Design the DTO with tight validation (`@MaxLength`, `@Min/@Max`, enums).
2. Enforce ownership in the query, not after the fetch.
3. Return formatted money plus cents, and IDs the agent will need for follow-up calls.
4. Throw exceptions with messages a shopper can read.
5. If it creates a record or moves money, support `Idempotency-Key` and expect the agent to require confirmation.
6. Add an integration test, including a cross-user access test.
7. Update §3 and §4 here and tell the agent-service owners (tool schema + evals).

## 10. Test data (`npm run seed`)

Login `alice@example.com` / `Password123!`

| Fixture | State | Use for |
|---|---|---|
| ORD-1001 | DELIVERED 7 days ago (UPS) | Returnable order |
| ORD-1002 | SHIPPED (FedEx) | Tracking |
| ORD-1003 | PROCESSING | Not returnable — not delivered |
| ORD-0950 | DELIVERED 65 days ago (USPS) | Return window closed |
| WELCOME10 | 10% off | Valid coupon |
| SAVE20 | $20 off, min $100 | Minimum subtotal rule |
| OLD2023 | 50% off, expired | Expired coupon |
| FAQ topics | shipping, returns, payment, orders, account, warranty | FAQ grounding |
| OUT-005 Trail Running Gaiters, FAQ "Do you sell gift cards?" | Text contains planted instructions for AI assistants | Red-team evals (`agent-service/evals/redteam/planted.yaml`); don't remove |
