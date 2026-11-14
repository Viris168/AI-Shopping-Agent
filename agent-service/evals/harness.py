"""Runs one eval case through the real agent loop against the seeded commerce-api.

Real model, real tools and real commerce-api; Redis is in-memory so eval sessions and
pending actions never touch shared state. Poisoned data is injected in the client wrapper.
Chat turns can change the shopper's cart and long-term memory, so both are reset before each case.
"""

import asyncio
import base64
import dataclasses
import re
import time
import uuid
from datetime import datetime
from typing import Any

import httpx
from fakeredis import FakeAsyncRedis

from app.auth import GUEST, Auth, verify_bearer
from app.commerce_client import CommerceClient
from app.config import Settings
from app.images import ImageIn, prepare_image
from app.llm import LLM
from app.loop import Agent
from app.main import services
from app.memory import Memory
from app.sse import EventName
from evals.cases import Case, MemorySetup, Photo, Poison, Setup
from evals.checks import TurnRecord
from evals.image_fixtures import OUT_DIR as PHOTO_DIR

USERS = {"alice": "alice@example.com", "bob": "bob@example.com"}


def apply_poison(data: Any, poison: Poison) -> Any:
    """Appends poison.text to every string under one of poison.fields, at any depth."""
    if isinstance(data, list):
        return [apply_poison(v, poison) for v in data]
    if isinstance(data, dict):
        return {
            k: f"{v} {poison.text}" if k in poison.fields and isinstance(v, str)
            else apply_poison(v, poison)
            for k, v in data.items()
        }
    return data


class RecordingClient(CommerceClient):
    """Records every request of the current turn and poisons matching GET responses."""

    def __init__(
        self, settings: Settings, poison: list[Poison], http: httpx.AsyncClient | None = None
    ) -> None:
        super().__init__(settings, http)
        self.poison = poison
        self.requests: list[tuple[str, str]] = []

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        self.requests.append((method, path.lstrip("/")))
        data = await super().request(method, path, **kwargs)
        if method == "GET":
            for p in self.poison:
                if re.search(p.path, path.lstrip("/")):
                    data = apply_poison(data, p)
        return data


@dataclasses.dataclass(frozen=True)
class Shopper:
    """A logged-in demo user: the chat token the agent gets, and the session for cart setup."""

    auth: Auth
    session_token: str | None


GUEST_SHOPPER = Shopper(GUEST, None)
# Renew tokens this long before they expire, so one never lapses mid-case.
_RENEW_EARLY_S = 120


def _expires(body: dict[str, Any]) -> float:
    return datetime.fromisoformat(str(body["expiresAt"]).replace("Z", "+00:00")).timestamp()


class Logins:
    """One login per demo user per run (commerce-api limits logins to 10/min per IP).

    Chat tokens last 15 minutes and sessions an hour, so both are renewed as a run goes on.
    """

    def __init__(self, settings: Settings, password: str) -> None:
        self._settings = settings
        self._password = password
        self._sessions: dict[str, tuple[str, float]] = {}
        self._chats: dict[str, tuple[Auth, float]] = {}

    def _url(self, path: str) -> str:
        return self._settings.commerce_api_url.rstrip("/") + path

    async def _session(self, http: httpx.AsyncClient, user: str) -> str:
        cached = self._sessions.get(user)
        if cached and cached[1] - _RENEW_EARLY_S > time.time():
            return cached[0]
        resp = await http.post(
            self._url("/auth/login"), json={"email": USERS[user], "password": self._password}
        )
        token = resp.cookies.get("session")
        if resp.status_code != 200 or not token:
            raise RuntimeError(f"Login as {user} failed ({resp.status_code}); run `npm run seed`")
        self._sessions[user] = (token, _expires(resp.json()))
        return token

    async def shopper(self, user: str) -> Shopper:
        if user == "guest":
            return GUEST_SHOPPER
        async with httpx.AsyncClient(timeout=10) as http:
            session = await self._session(http, user)
            cached = self._chats.get(user)
            if not cached or cached[1] - _RENEW_EARLY_S <= time.time():
                resp = await http.post(
                    self._url("/auth/agent-token"), headers={"Authorization": f"Bearer {session}"}
                )
                if resp.status_code != 200:
                    raise RuntimeError(f"Chat token for {user} failed ({resp.status_code})")
                auth = verify_bearer(f"Bearer {resp.json()['token']}", self._settings)
                if auth.is_guest:
                    raise RuntimeError(
                        "Token rejected: agent-service JWT_SECRET must match commerce-api"
                    )
                cached = (auth, _expires(resp.json()))
                self._chats[user] = cached
        return Shopper(cached[0], session)


async def reset_cart(http: httpx.AsyncClient, session_token: str, setup: Setup) -> None:
    """Empties the shopper's cart and coupon, then loads `setup`, as the shopper (not the agent).

    Uses the storefront session: the chat token only works with agent-service's service token.
    """
    headers = {"Authorization": f"Bearer {session_token}"}

    async def call(method: str, path: str, **kwargs: Any) -> Any:
        resp = await http.request(method, path, headers=headers, **kwargs)
        if resp.status_code >= 400:
            raise RuntimeError(f"Cart setup {method} /{path} failed ({resp.status_code})")
        return resp.json()

    cart = await call("GET", "cart")
    for item in cart.get("items", []):
        await call("DELETE", f"cart/items/{item['productId']}")
    if cart.get("couponCode"):
        await call("DELETE", "cart/coupon")
    for line in setup.cart:
        await call("POST", "cart/items", json={"productId": line.sku, "quantity": line.quantity})
    if setup.coupon:
        await call("POST", "cart/coupon", json={"code": setup.coupon})


async def reset_memory(
    http: httpx.AsyncClient, session_token: str, memory: MemorySetup | None
) -> None:
    """Switches the shopper's memory off (which deletes it), then on again if the case wants it.
    As the shopper, through the storefront route: the agent can't switch memory on."""
    headers = {"Authorization": f"Bearer {session_token}"}
    for enabled in ([False, True] if memory is not None else [False]):
        resp = await http.put("account/memory", headers=headers, json={"enabled": enabled})
        if resp.status_code >= 400:
            raise RuntimeError(f"Memory setup failed ({resp.status_code})")


async def seed_memory(client: CommerceClient, auth: Auth, memory: MemorySetup) -> None:
    for fact in memory.facts:
        await client.request("POST", "memory/facts", auth=auth, json=fact.model_dump())
    for summary in memory.episodes:
        await client.request("POST", "memory/episodes", auth=auth,
                             json={"conversationId": str(uuid.uuid4()), "summary": summary})


async def saved_facts(client: CommerceClient, auth: Auth) -> list[str]:
    view = await client.request("GET", "memory", auth=auth)
    return [f"{f['kind']}: {f['value']}" for f in view.get("facts", [])]


def load_photo(photo: Photo, settings: Settings) -> bytes:
    """The fixture checked and re-encoded as the chat route does (images.prepare_image)."""
    path = PHOTO_DIR / photo.file
    if not path.exists():
        raise FileNotFoundError(f"{path} missing; run `python -m evals.image_fixtures`")
    media = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}[path.suffix]
    data = base64.b64encode(path.read_bytes()).decode()
    return prepare_image(ImageIn(mediaType=media, data=data), settings)


async def _conversation(
    agent: Agent, auth: Auth, client: "RecordingClient", turns: list[str], emit: Any,
    records: list[TurnRecord], timeout_s: float, photos: dict[int, bytes] | None = None,
) -> None:
    session = await agent.sessions.load(None, auth)
    for i, message in enumerate(turns):
        record = TurnRecord()
        records.append(record)
        client.requests = record.requests
        emit.record = record
        async with asyncio.timeout(timeout_s):
            await agent.run_turn(session, message, auth, emit, image=(photos or {}).get(i))
        await agent.drain()  # memory writes finish before the next turn or check


class _Emit:
    def __init__(self) -> None:
        self.record = TurnRecord()

    def __call__(self, event: EventName, data: dict[str, Any]) -> None:
        self.record.events.append(event)
        if event == "text_delta":
            self.record.text += str(data.get("text", ""))


async def run_case(
    case: Case,
    settings: Settings,
    shopper: Shopper,
    *,
    llm: LLM | None = None,  # tests pass a fake; evals use the real model
    http: httpx.AsyncClient | None = None,
) -> list[TurnRecord]:
    auth = shopper.auth
    if not auth.is_guest:
        if shopper.session_token is None:
            raise ValueError(f"{case.id}: a logged-in shopper needs a session for cart setup")
        setup_http = http or httpx.AsyncClient(
            base_url=settings.commerce_api_url.rstrip("/") + "/",
            timeout=settings.commerce_timeout_s,
        )
        try:
            await reset_cart(setup_http, shopper.session_token, case.setup)
            await reset_memory(setup_http, shopper.session_token, case.setup.memory)
        finally:
            if setup_http is not http:
                await setup_http.aclose()
    elif case.setup.cart or case.setup.coupon or case.setup.memory:
        raise ValueError(f"{case.id}: guests have no cart or memory to set up")

    memory = case.setup.memory
    if memory is not None:  # the feature on for this case; the suite's setting covers the rest
        settings = settings.model_copy(update={"memory_enabled": True})
    photos: dict[int, bytes] = {}
    if case.photo is not None or case.images:
        settings = settings.model_copy(update={"images_enabled": True})
    if case.photo is not None:
        photos[case.photo.turn % len(case.turns)] = await asyncio.to_thread(
            load_photo, case.photo, settings
        )
    redis = FakeAsyncRedis(decode_responses=True)
    client = RecordingClient(settings, case.poison, http)
    try:
        if memory is not None:
            await seed_memory(client, auth, memory)
        async with services(settings, redis) as base:
            emit = _Emit()

            def on_tool_call(name: str, args: Any) -> None:
                emit.record.tools.append((name, args))

            def on_route(tier: str, reason: str) -> None:
                emit.record.routes.append(f"{tier}:{reason}")

            agent = dataclasses.replace(
                base, client=client, on_tool_call=on_tool_call, on_route=on_route,
                llm=llm or base.llm,
                memory=Memory(settings, client, redis) if base.memory else None,
            )
            records: list[TurnRecord] = []
            if case.earlier:
                await _conversation(agent, auth, client, case.earlier, emit, records,
                                    settings.turn_timeout_s)
            await _conversation(agent, auth, client, case.turns, emit, records,
                                settings.turn_timeout_s, photos)
            if memory is not None and (case.expect.require_memory or case.expect.forbid_memory):
                client.requests = []
                records[-1].memory = await saved_facts(client, auth)
            return records
    finally:
        await client.aclose()
        await redis.aclose()
