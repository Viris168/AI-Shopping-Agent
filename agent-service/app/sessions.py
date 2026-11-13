"""Conversation sessions in Redis (`sess:{conversationId}`, 24 h, refreshed on every save) with
rolling summaries and structured state, and masked transcripts in commerce-api's `conversations`
table (ARCHITECTURE.md §5.2)."""

import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from anthropic.types import ContentBlock
from redis.asyncio import Redis

from app.auth import Auth
from app.commerce_client import ApiError, CommerceClient, seg
from app.guardrails import code_tokens, defang_control_tags
from app.masking import mask, mask_text
from app.tools.registry import ToolOutput
from app.usage import Counts

log = logging.getLogger(__name__)

Message = dict[str, Any]
Outcome = Literal["resolved", "handoff", "abandoned"]


def _is_tool_result_turn(msg: Message) -> bool:
    content = msg.get("content")
    return (
        msg.get("role") == "user"
        and isinstance(content, list)
        and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
    )


MAX_FOCUS_PRODUCTS = 5
MAX_KNOWN_CODES = 50
# Tool-result fields the store writes itself (no free text): codes in them are real.
_CODE_FIELDS = frozenset({
    "couponCode", "name", "brand", "id", "slug", "productId", "orderNumber", "trackingNumber",
    "attributes",
})
MAX_COMPLETED = 5
_NAME_CHARS = 60
_TOPIC_CHARS = 150


def _collect_codes(value: Any, found: set[str], trusted: bool = False) -> None:
    if isinstance(value, dict):
        for k, v in value.items():
            _collect_codes(v, found, trusted or k in _CODE_FIELDS)
    elif isinstance(value, list):
        for v in value:
            _collect_codes(v, found, trusted)
    elif trusted and isinstance(value, str):
        found |= code_tokens(value)


@dataclass
class SessionState:
    """What the conversation is about, kept outside the message history so summarising can't
    lose it (PLAN-18 step 2). Written by code from successful tool calls, never by the model.
    IDs and names only: prices, stock and status always come from a fresh tool call (rule 5)."""

    focus_order: str | None = None
    # [{"id", "name"}], most recent last
    focus_products: list[dict[str, str]] = field(default_factory=list)
    # {"actionId", "tool", "summary", "expiresAt"} while a Confirm card is open
    pending_action: dict[str, Any] | None = None
    # The shopper's first message (masked, short): what the conversation was about. Long-term
    # memory only; not shown in the prompt (the message itself is in the history or summary).
    topic: str | None = None
    # Confirmed actions, e.g. "create_return: Return 1 item from ORD-1001 (Too small)"
    completed: list[str] = field(default_factory=list)
    # Active playbooks (app/playbooks.py), chosen in code from the shopper's messages.
    playbooks: list[str] = field(default_factory=list)
    # Playbooks whose task a confirmed action just completed (dropped on the next message).
    playbooks_done: list[str] = field(default_factory=list)
    # Coupon-shaped words the store vouched for (applied codes, model numbers in product names):
    # the only ones a reply may contain (guardrails.OutputGuard). Upper-cased.
    known_codes: list[str] = field(default_factory=list)

    def note_topic(self, text: str) -> None:
        if self.topic is None:
            self.topic = " ".join(mask_text(defang_control_tags(text)).split())[:_TOPIC_CHARS]

    def note_completed(self, tool: str, summary: str) -> None:
        entry = f"{tool}: {defang_control_tags(summary)}"[:200]
        self.completed = [*self.completed, entry][-MAX_COMPLETED:]

    def note_codes(self, tool: str, raw: Any, out: ToolOutput) -> None:
        """Remember codes from fields the store fills in itself, never from free text
        (descriptions, FAQ answers, carrier notes), which is where planted instructions live.
        A coupon the store rejected only for the cart's subtotal is a real one."""
        found: set[str] = set()
        if tool == "apply_coupon" and isinstance(raw, dict) and isinstance(raw.get("code"), str):
            error = out.for_model.get("error")
            message = str(error.get("message", "")) if isinstance(error, dict) else ""
            if not out.is_error or (message and "invalid" not in message.lower()):
                found |= code_tokens(raw["code"])
        if not out.is_error:
            _collect_codes(out.for_model, found)
        # In place: a running turn's OutputGuard holds this list.
        self.known_codes.extend(sorted(found - set(self.known_codes)))
        del self.known_codes[:-MAX_KNOWN_CODES]

    def note_tool(self, tool: str, raw: Any, out: ToolOutput) -> None:
        if out.is_error:
            return
        args = raw if isinstance(raw, dict) else {}
        result = out.for_model
        if tool in ("get_order", "create_return"):
            order = result.get("orderNumber") or args.get("orderNumber")
            if isinstance(order, str):
                self.focus_order = order[:40]
        elif tool == "get_product" and isinstance(result.get("id"), str):
            self._focus_product(result["id"], result.get("name"))
        elif tool in ("search_products", "get_recommendations"):
            # The shopper saw these cards, so "that one" may mean any of them; the first card
            # is focused last so it reads as the most recent.
            items = result.get("items")
            shown = [p for p in items if isinstance(p, dict)] if isinstance(items, list) else []
            for p in reversed(shown[:MAX_FOCUS_PRODUCTS]):
                if isinstance(p.get("id"), str):
                    self._focus_product(p["id"], p.get("name"))
        elif tool in ("add_to_cart", "update_cart_item") and isinstance(args.get("productId"), str):
            self._focus_product(args["productId"], None)

    def _focus_product(self, product_id: str, name: Any) -> None:
        old = next((p for p in self.focus_products if p["id"] == product_id), None)
        entry = {"id": product_id[:64]}
        if isinstance(name, str):
            entry["name"] = defang_control_tags(name)[:_NAME_CHARS]
        elif old and "name" in old:
            entry["name"] = old["name"]
        self.focus_products = [p for p in self.focus_products if p["id"] != product_id]
        self.focus_products = [*self.focus_products, entry][-MAX_FOCUS_PRODUCTS:]

    def render(self, now: float | None = None) -> str:
        """Lines for the system prompt, or "" when there is nothing to track."""
        lines = []
        if self.focus_order:
            lines.append(f"Order being discussed: {self.focus_order}")
        if self.focus_products:
            items = ", ".join(
                f"{p['name']} ({p['id']})" if "name" in p else p["id"] for p in self.focus_products
            )
            lines.append(f"Products discussed (oldest first): {items}")
        pending = self.pending_action
        if pending and pending.get("expiresAt", 0) > (now or time.time()):
            lines.append(
                f"Waiting for the shopper to press Confirm: {pending['tool']} "
                f"({defang_control_tags(str(pending.get('summary', '')))})"
            )
        return "\n".join(lines)


@dataclass
class Session:
    id: str
    user_id: str | None = None
    messages: list[Message] = field(default_factory=list)
    summary: str | None = None
    outcome: Outcome | None = None
    # messages[:persisted] are already in the transcript.
    persisted: int = 0
    state: SessionState = field(default_factory=SessionState)
    # Long-term memory (app/memory.py): None until loaded on the first signed-in turn.
    memory_enabled: bool | None = None
    memory: dict[str, Any] | None = None
    # Digest of the last episode written, so an unchanged episode isn't written again.
    episode_digest: str | None = None

    def forget_fact(self, fact_id: str) -> None:
        """Drop a fact the shopper just had forgotten from this conversation's copy."""
        if self.memory and isinstance(self.memory.get("facts"), list):
            self.memory["facts"] = [f for f in self.memory["facts"] if f.get("id") != fact_id]

    @classmethod
    def from_json(cls, raw: str | bytes) -> "Session":
        data = json.loads(raw)
        data["state"] = SessionState(**(data.get("state") or {}))
        return cls(**data)

    def _append_user_blocks(self, blocks: list[dict[str, Any]]) -> None:
        # Keep user/assistant alternation: merge into a trailing user turn.
        if self.messages and self.messages[-1]["role"] == "user":
            last = self.messages[-1]
            if isinstance(last["content"], str):
                last["content"] = [{"type": "text", "text": last["content"]}]
            last["content"].extend(blocks)
        else:
            self.messages.append({"role": "user", "content": blocks})

    def append_user(self, text: str) -> None:
        self._append_user_blocks([{"type": "text", "text": defang_control_tags(text)}])

    def append_assistant(self, content: Sequence[ContentBlock]) -> None:
        self.messages.append({
            "role": "assistant",
            "content": [b.model_dump(mode="json", exclude_none=True) for b in content],
        })

    def append_tool_results(self, results: list[dict[str, Any]]) -> None:
        self.messages.append({"role": "user", "content": results})

    def append_event(self, text: str) -> None:
        """Something the shopper did outside the chat (pressed Confirm/Cancel)."""
        self._append_user_blocks([{"type": "text", "text": f"<event>{text}</event>"}])

    def _safe_cut(self, start: int) -> int:
        """First index ≥ start where history can begin: a user turn that isn't tool results."""
        for i in range(max(start, 0), len(self.messages)):
            msg = self.messages[i]
            if msg["role"] == "user" and not _is_tool_result_turn(msg):
                return i
        return len(self.messages)


Summarise = Callable[[str | None, list[Message]], Awaitable[str]]


class SessionStore:
    def __init__(self, redis: Redis, ttl_s: int, window: int) -> None:
        self._redis = redis
        self._ttl = ttl_s
        self._window = window

    async def load(self, conversation_id: str | None, auth: Auth) -> Session:
        """Existing session for this shopper, or a fresh one. Never another user's."""
        if conversation_id:
            raw = await self._redis.get(f"sess:{conversation_id}")
            if raw:
                session = Session.from_json(raw)
                if session.user_id is None and auth.user_id:
                    session.user_id = auth.user_id  # guest logged in mid-conversation
                if session.user_id == auth.user_id:
                    return session
        return Session(id=str(uuid.uuid4()), user_id=auth.user_id)

    async def get(self, conversation_id: str) -> Session | None:
        raw = await self._redis.get(f"sess:{conversation_id}")
        return Session.from_json(raw) if raw else None

    async def save(self, session: Session) -> None:
        await self._redis.set(f"sess:{session.id}", json.dumps(asdict(session)), ex=self._ttl)

    async def maybe_summarise(self, session: Session, summarise: Summarise) -> None:
        """Past 2× the window, fold the oldest half into the rolling summary. `state` is kept
        as is, so the order and products in focus survive however the summary is worded.

        The model gets every message since the last fold (PLAN-19 M4): the history then only
        changes at its start here, once per fold, so the provider's prefix cache can reuse it
        on every other call. A window sliding every turn would make the whole history a miss."""
        if len(session.messages) <= self._window * 2:
            return
        cut = session._safe_cut(len(session.messages) // 2)
        if cut >= len(session.messages):
            return
        session.summary = await summarise(session.summary, session.messages[:cut])
        session.messages = session.messages[cut:]
        session.persisted = max(session.persisted - cut, 0)


TRANSCRIPT_BATCH = 100  # commerce-api's per-request cap


def usage_body(spent: Counts) -> dict[str, int]:
    """commerce-api's usage fields; cost as integer millionths of a dollar, like all money."""
    return {"tokensIn": spent.input, "tokensOut": spent.output,
            "tokensCacheRead": spent.cache_read, "costMicroUsd": round(spent.cost_usd * 1e6)}


class TranscriptStore:
    """Appends each turn's new messages, masked, to commerce-api. Best effort: a failed save
    is logged and the messages go with the next turn; it never fails the shopper's turn."""

    def __init__(self, client: CommerceClient) -> None:
        self._client = client

    async def record(self, session: Session, auth: Auth, spent: Counts | None) -> None:
        new = session.messages[session.persisted:]
        tokens = usage_body(spent) if spent else {}
        for start in range(0, max(len(new), 1), TRANSCRIPT_BATCH):
            body: dict[str, Any] = {"messages": mask(new[start:start + TRANSCRIPT_BATCH])}
            if start == 0:
                body |= tokens
                if session.summary:
                    body["summary"] = mask_text(session.summary)[:4000]
                if session.outcome:
                    body["outcome"] = session.outcome
            try:
                await self._client.request(
                    "POST", f"conversations/{seg(session.id)}/turns", auth=auth,
                    conversation_id=session.id, json=body,
                )
            except ApiError as exc:
                log.warning("transcript_save_failed %s: %s", session.id, exc.status)
                return
            session.persisted += len(body["messages"])

    async def add_usage(self, conversation_id: str, auth: Auth, spent: Counts) -> None:
        """Usage from calls made after the turn was recorded (summary, memory extraction).
        Best effort, like `record`; it may run in the background, so it never raises."""
        try:
            await self._client.request(
                "POST", f"conversations/{seg(conversation_id)}/turns", auth=auth,
                conversation_id=conversation_id, json={"messages": [], **usage_body(spent)},
            )
        except ApiError as exc:
            log.warning("usage_save_failed %s: %s", conversation_id, exc.status)
        except Exception:
            log.exception("usage_save_failed %s", conversation_id)

    async def feedback(self, conversation_id: str, message_id: str, rating: str,
                       comment: str | None, auth: Auth) -> None:
        """Raises ApiError (404 when the conversation isn't this shopper's)."""
        body: dict[str, Any] = {"messageId": message_id, "rating": rating}
        if comment:
            body["comment"] = mask_text(comment)
        await self._client.request(
            "POST", f"conversations/{seg(conversation_id)}/feedback", auth=auth,
            conversation_id=conversation_id, json=body,
        )
