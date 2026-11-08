"""Conversation sessions in Redis (`sess:{conversationId}`, 24 h) with rolling summaries."""

import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from typing import Any

from anthropic.types import ContentBlock
from redis.asyncio import Redis

from app.auth import Auth

Message = dict[str, Any]


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

    def append_assistant(self, content: list[ContentBlock]) -> None:
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
