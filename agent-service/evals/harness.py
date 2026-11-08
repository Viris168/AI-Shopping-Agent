"""Runs one eval case through the real agent loop against the seeded commerce-api.

Real model, real tools and real commerce-api; Redis is in-memory so eval sessions and
pending actions never touch shared state. Poisoned data is injected in the client wrapper.
The shopper's cart is the only state chat turns can change, so it is reset before each case.
"""

import asyncio
import dataclasses
import re
from typing import Any

import httpx
from fakeredis import FakeAsyncRedis

from app.auth import GUEST, Auth, verify_bearer
from app.commerce_client import CommerceClient
from app.config import Settings
from app.llm import LLM
from app.main import services
from app.sse import EventName
from evals.cases import Case, Poison, Setup
from evals.checks import TurnRecord

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


class Logins:
    """One login per demo user per run: commerce-api limits logins to 10/min per IP."""

    def __init__(self, settings: Settings, password: str) -> None:
        self._settings = settings
        self._password = password
        self._cache: dict[str, Auth] = {}

    async def auth(self, user: str) -> Auth:
        if user == "guest":
            return GUEST
        if user not in self._cache:
            url = self._settings.commerce_api_url.rstrip("/") + "/auth/login"
            async with httpx.AsyncClient(timeout=10) as http:
                resp = await http.post(url, json={"email": USERS[user], "password": self._password})
            if resp.status_code != 200:
                raise RuntimeError(
                    f"Login as {user} failed ({resp.status_code}); run `npm run seed`"
                )
            auth = verify_bearer(f"Bearer {resp.json()['accessToken']}", self._settings)
            if auth.is_guest:
                raise RuntimeError(
                    "Token rejected: agent-service JWT_SECRET must match commerce-api"
                )
            self._cache[user] = auth
        return self._cache[user]


async def reset_cart(http: httpx.AsyncClient, auth: Auth, setup: Setup) -> None:
    """Empties the shopper's cart and coupon, then loads `setup`, as the shopper (not the agent)."""
    headers = {"Authorization": f"Bearer {auth.token}"}

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


async def run_case(
    case: Case,
    settings: Settings,
    auth: Auth,
    *,
    llm: LLM | None = None,  # tests pass a fake; evals use the real model
    http: httpx.AsyncClient | None = None,
) -> list[TurnRecord]:
    if not auth.is_guest:
        setup_http = http or httpx.AsyncClient(
            base_url=settings.commerce_api_url.rstrip("/") + "/",
            timeout=settings.commerce_timeout_s,
        )
        try:
            await reset_cart(setup_http, auth, case.setup)
        finally:
            if setup_http is not http:
                await setup_http.aclose()
    elif case.setup.cart or case.setup.coupon:
        raise ValueError(f"{case.id}: guests have no cart to set up")

    redis = FakeAsyncRedis(decode_responses=True)
    client = RecordingClient(settings, case.poison, http)
    try:
        async with services(settings, redis) as base:
            records: list[TurnRecord] = []
            current = TurnRecord()

            def on_tool_call(name: str, args: Any) -> None:
                current.tools.append((name, args))

            def emit(event: EventName, data: dict[str, Any]) -> None:
                current.events.append(event)
                if event == "text_delta":
                    current.text += str(data.get("text", ""))

            agent = dataclasses.replace(
                base, client=client, on_tool_call=on_tool_call, llm=llm or base.llm
            )
            session = await agent.sessions.load(None, auth)
            for message in case.turns:
                current = TurnRecord()
                client.requests = current.requests
                async with asyncio.timeout(settings.turn_timeout_s):
                    await agent.run_turn(session, message, auth, emit)
                records.append(current)
            return records
    finally:
        await client.aclose()
        await redis.aclose()
