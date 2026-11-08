"""Pending actions: the confirm gate for confirm-first tools.

The model's tool call only stores the validated arguments here. The tool runs
from /v1/actions/{id}/confirm, once, for the shopper who owns the action.
"""

import json
import secrets
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from redis.asyncio import Redis

from app.auth import Auth


@dataclass
class PendingAction:
    id: str
    tool: str
    args: dict[str, Any]
    summary: str
    user_id: str | None
    conversation_id: str
    idem_key: str
    expires_at: float

    def public(self) -> dict[str, Any]:
        return {
            "actionId": self.id,
            "kind": self.tool,
            "summary": self.summary,
            "expiresAt": datetime.fromtimestamp(self.expires_at, UTC).isoformat(),
        }

    def owned_by(self, auth: Auth) -> bool:
        return self.user_id == auth.user_id


class ActionStore:
    def __init__(self, redis: Redis, ttl_s: int) -> None:
        self._redis = redis
        self._ttl = ttl_s

    async def create(
        self, *, tool: str, args: dict[str, Any], summary: str, auth: Auth, conversation_id: str
    ) -> PendingAction:
        action = PendingAction(
            id=secrets.token_urlsafe(18),  # unguessable; also the only handle the widget gets
            tool=tool,
            args=args,
            summary=summary[:300],
            user_id=auth.user_id,
            conversation_id=conversation_id,
            idem_key=str(uuid.uuid4()),
            expires_at=time.time() + self._ttl,
        )
        await self._redis.set(f"action:{action.id}", json.dumps(asdict(action)), ex=self._ttl)
        return action

    async def get(self, action_id: str) -> PendingAction | None:
        raw = await self._redis.get(f"action:{action_id}")
        return PendingAction(**json.loads(raw)) if raw else None

    async def take(self, action_id: str, auth: Auth) -> PendingAction | None:
        """Single-use claim. None if missing, expired, already used, or not this shopper's."""
        action = await self.get(action_id)
        if action is None or not action.owned_by(auth):
            return None  # don't consume someone else's action
        raw = await self._redis.getdel(f"action:{action_id}")  # atomic: one confirm wins
        return PendingAction(**json.loads(raw)) if raw else None
