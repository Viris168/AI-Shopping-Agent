"""Conversation sessions in Redis (`sess:{conversationId}`, 24 h) with rolling summaries,
and masked transcripts in commerce-api's `conversations` table (ARCHITECTURE.md §5.2)."""

import json
import logging
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from anthropic.types import ContentBlock
from redis.asyncio import Redis

from app.auth import Auth
from app.commerce_client import ApiError, CommerceClient, seg
from app.masking import mask, mask_text

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


@dataclass
class Session:
    id: str
    user_id: str | None = None
    messages: list[Message] = field(default_factory=list)
    summary: str | None = None
    outcome: Outcome | None = None
    # messages[:persisted] are already in the transcript.
    persisted: int = 0

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
        self._append_user_blocks([{"type": "text", "text": text}])

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

    def window(self, size: int) -> list[Message]:
        cut = self._safe_cut(len(self.messages) - size) if len(self.messages) > size else 0
        return self.messages[cut:]


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
                session = Session(**json.loads(raw))
                if session.user_id is None and auth.user_id:
                    session.user_id = auth.user_id  # guest logged in mid-conversation
                if session.user_id == auth.user_id:
                    return session
        return Session(id=str(uuid.uuid4()), user_id=auth.user_id)

    async def get(self, conversation_id: str) -> Session | None:
        raw = await self._redis.get(f"sess:{conversation_id}")
        return Session(**json.loads(raw)) if raw else None

    async def save(self, session: Session) -> None:
        await self._redis.set(f"sess:{session.id}", json.dumps(asdict(session)), ex=self._ttl)

    async def maybe_summarise(self, session: Session, summarise: Summarise) -> None:
        """Past 2× the window, fold the oldest half into the rolling summary."""
        if len(session.messages) <= self._window * 2:
            return
        cut = session._safe_cut(len(session.messages) // 2)
        if cut >= len(session.messages):
            return
        session.summary = await summarise(session.summary, session.messages[:cut])
        session.messages = session.messages[cut:]
        session.persisted = max(session.persisted - cut, 0)


TRANSCRIPT_BATCH = 100  # commerce-api's per-request cap


class TranscriptStore:
    """Appends each turn's new messages, masked, to commerce-api. Best effort: a failed save
    is logged and the messages go with the next turn; it never fails the shopper's turn."""

    def __init__(self, client: CommerceClient) -> None:
        self._client = client

    async def record(self, session: Session, auth: Auth, usage: dict[str, int]) -> None:
        new = session.messages[session.persisted:]
        tokens = {"tokensIn": usage.get("input_tokens", 0),
                  "tokensOut": usage.get("output_tokens", 0)}
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
