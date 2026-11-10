# PRD — AI Shopping Assistant

| | |
|---|---|
| Status | Draft |
| Last updated | 2026-11-08 |
| Target launch | 2026-12-18 (100% of visitors) |
| Related | [ARCHITECTURE.md](./ARCHITECTURE.md) · [AGENT.md](./AGENT.md) · [CLAUDE.md](./CLAUDE.md) |

## 1. Summary

An AI chat assistant on the storefront. It helps shoppers find products, manage their cart, track orders, start returns and get policy answers. When it can't help, it hands off to a human. It runs on the existing `commerce-api` and never takes payment itself.

## 2. Problem

- Shoppers leave when they can't quickly find the right product or a policy answer.
- "Where is my order?" and "How do I return this?" make up most support contacts, and the answers already exist in our data.
- Support staff spend time on questions the system could answer from order and FAQ data.

## 3. Goals and non-goals

### Goals

1. Resolve common questions (order status, returns, policies, product discovery) without a human.
2. Make shopping easier by letting the assistant search, compare and add items to the cart.
3. Hand off cleanly to a human, with the full context, when the assistant can't help.
4. Be safe: never act without the shopper's authority, never invent facts, and log every action.

### Non-goals (v1)

- Taking payment or completing checkout inside the chat
- Live human chat inside the widget (handoff creates a ticket instead)
- Voice, email or social-media channels
- Admin or staff-facing agent features
- Personalised marketing or proactive outreach

## 4. Users

| User | Needs |
|---|---|
| Guest shopper | Product discovery, policy answers, contact support |
| Logged-in shopper | Everything above, plus cart, order tracking and returns |
| Support agent | Clear handoff tickets; an audit trail of what the bot did |
| Store operator | Metrics, cost control, ability to switch the bot off instantly |

## 5. User stories

### Discovery

- As a shopper, I can describe what I want in plain words ("waterproof running shoes under $120") and get matching products with price, stock and rating.
- As a shopper, I can ask for alternatives or similar items to a product.
- As a shopper, I can add a suggested product to my cart from the chat.

### Cart

- As a logged-in shopper, I can view, change quantities, remove items and apply a coupon by chatting.
- As a logged-in shopper, I get a "Review and pay" button that takes me to the normal checkout page.

### Orders and returns

- As a logged-in shopper, I can ask "where is my order?" and see status, carrier and a tracking link.
- As a logged-in shopper, I can start a return for a delivered order inside the return window, after confirming the items and reason.
- As a shopper, I'm told clearly why a return isn't possible (not delivered, window closed, already open).

### Policies and help

- As any shopper, I get answers about shipping, returns and payments grounded in the store's FAQ.
- As any shopper, I can ask for a human at any time and get a ticket with an expected response time.

## 6. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| F1 | Chat widget embeddable with one script tag, on desktop and mobile | Must |
| F2 | Streaming replies (first token visible in under 2 s typical) | Must |
| F3 | Product search with filters (category, brand, price, in stock, sort) | Must |
| F4 | Product details and recommendations | Must |
| F5 | Cart view, add, update, remove, apply coupon (logged-in only) | Must |
| F6 | Order list and order detail with tracking (logged-in only) | Must |
| F7 | Create return, only after an explicit Confirm click | Must |
| F8 | FAQ-grounded policy answers; say "I'm not sure" when FAQ has no match | Must |
| F9 | Human handoff that creates a support ticket with a summary | Must |
| F10 | Guests see only the features that need no login, and are prompted to log in otherwise | Must |
| F11 | Conversation survives page navigation within a session | Must |
| F12 | Rich cards: product carousel, cart summary, order status, confirm, ticket | Must |
| F13 | Thumbs up/down on replies | Should |
| F14 | Replies in the shopper's language | Should |
| F15 | Quick-reply chips on open | Could |

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Latency | p95 time to first token < 4 s at expected peak |
| Availability | Chat failure never breaks the storefront; a fallback card links to order tracking and contact form |
| Security | Agent acts only with the shopper's own JWT; no admin credentials in the agent service |
| Safety | No invented prices, stock, dates, discounts or policies; prompt-injection resistant |
| Auditability | Every state-changing agent action logged with user and conversation ID |
| Privacy | Personal data masked in logs and traces; transcripts kept 90 days. Assistant memory (PLAN-18) is opt-in per shopper, shown and deletable on the account page, never holds payment details, addresses or prices; chat notes kept 90 days, preferences until deleted. Privacy-notice wording to be signed off before rollout |
| Accessibility | WCAG 2.1 AA; full keyboard support; screen-reader announcements |
| Performance | Widget bundle < 40 KB gzipped; no layout shift on host page |
| Cost | Tokens per conversation tracked; per-conversation budget enforced |
| Control | Feature flag for % rollout and instant kill switch |

## 8. Success metrics

Baselines are measured during staff dogfood. Targets are confirmed after the 5% stage.

| Metric | Definition | Initial target |
|---|---|---|
| Containment rate | Conversations resolved without handoff | ≥ 60% |
| Order-status deflection | Drop in "where is my order" tickets | ≥ 40% |
| CSAT | Thumbs-up share of rated replies | ≥ 80% |
| Chat-assisted add-to-cart | Share of chats with ≥ 1 add-to-cart | Track; set after beta |
| Tool error rate | Failed tool calls / all tool calls | < 5% |
| Hallucination rate | Eval failures for invented facts | 0 in red-team set |
| Cost per conversation | Model spend / conversations | Set after beta |

## 9. Scope by phase

| Phase | Dates | Scope |
|---|---|---|
| 1 · Foundations | 9–15 Nov | API hardening; agent skeleton with read-only tools |
| 2 · Full agent and widget | 16–29 Nov | Cart, return and ticket tools with confirm; widget; evals in CI |
| 3 · Production readiness | 30 Nov–6 Dec | Infra, CI/CD, observability, load test, privacy notice |
| 4 · Rollout | 7–18 Dec | Staff → 5% → 25% → 100%; helpdesk integration |

Exit gates per phase are listed in [ARCHITECTURE.md §12](./ARCHITECTURE.md#12-rollout-plan).

## 10. Dependencies

- `commerce-api` fixes: per-user rate limiting, service token, failure auditing, idempotency keys
- Anthropic API account and key
- Storefront endpoint that returns the shopper's JWT to the widget (`/session/token`)
- Helpdesk choice for ticket handoff

## 11. Risks

| Risk | Mitigation |
|---|---|
| Wrong price, stock or policy stated | Facts only from tools; FAQ grounding; evals |
| Prompt injection via product or FAQ text | Shopper-scoped token; confirm on click; tool output treated as data |
| All agent traffic throttled by shared IP limit | Per-user throttling (Phase 1) |
| Model API outage | Timeouts, fallback card, kill switch |
| Keyword search misses casually worded questions | Hybrid search (pgvector + keyword, RRF) for products and FAQ; similarity floors keep off-topic questions empty; monitor handoffs |
| Cost growth | Prompt caching, summarisation, budgets, alerts |

## 12. Open questions

- [x] Which helpdesk receives handoff tickets? A generic JSON webhook (`HELPDESK_URL`); any helpdesk plugs in through Zapier/Make or a small adapter.
- [ ] Which languages and markets at launch?
- [ ] Live human chat in v2, or ticket-only long term?
- [ ] Data-retention requirements beyond 90 days (legal/regional)?
