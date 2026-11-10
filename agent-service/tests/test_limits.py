"""Spend limits and the provider balance check (PLAN-19 M7)."""

from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from anthropic.types import Message
from fakeredis import FakeAsyncRedis
from fastapi import HTTPException

from app import balance, usage
from app.auth import GUEST, Auth, get_auth
from app.config import get_settings
from app.guardrails import RateLimiter
from app.limits import SpendLimits
from app.main import app
from tests.fakes import FakeApi, FakeLLM, message, settings, text
from tests.test_actions import Caller, http_client
from tests.test_loop import ALICE, make_agent

DAY1 = 1_794_009_600.0  # 2026-11-07 00:00 UTC
DAY2 = DAY1 + 86_400
BOB = Auth(user_id="u-bob", name="Bob", token="tok-bob")


@pytest.fixture
async def redis() -> AsyncIterator[FakeAsyncRedis]:
    r = FakeAsyncRedis(decode_responses=True)
    yield r
    await r.aclose()


def limits(redis: FakeAsyncRedis, **overrides: Any) -> SpendLimits:
    return SpendLimits(settings(**overrides), redis)


# --- the limits --------------------------------------------------------------------

async def test_store_cap_pauses_guests_at_80_percent_then_everyone(redis: FakeAsyncRedis) -> None:
    lim = limits(redis, daily_spend_cap_usd=1.0, daily_spend_user_usd=0, daily_spend_guest_usd=0,
                 conversation_spend_usd=0)
    await lim.add("c1", ALICE, None, 0.79, now=DAY1)
    assert await lim.check_turn("c2", GUEST, "1.2.3.4", now=DAY1) is None

    await lim.add("c1", ALICE, None, 0.01, now=DAY1)  # 80%
    guest = await lim.check_turn("c2", GUEST, "1.2.3.4", now=DAY1)
    assert guest is not None and (guest.limit, guest.status) == ("guests_paused", 429)
    assert await lim.check_turn("c3", BOB, None, now=DAY1) is None
    assert not await lim.store_closed(now=DAY1)

    await lim.add("c1", ALICE, None, 0.2, now=DAY1)  # 100%
    for auth in (BOB, GUEST):
        hit = await lim.check_turn("c4", auth, "1.2.3.4", now=DAY1)
        assert hit is not None and (hit.limit, hit.status) == ("store_daily", 503)
    assert await lim.store_closed(now=DAY1)
    assert await lim.check_turn("c4", BOB, None, now=DAY2) is None  # UTC midnight resets


async def test_daily_limit_is_per_ip_for_guests_and_per_user_when_signed_in(
    redis: FakeAsyncRedis,
) -> None:
    lim = limits(redis, daily_spend_cap_usd=0, daily_spend_guest_usd=0.1,
                 daily_spend_user_usd=0.5, conversation_spend_usd=0)
    for i in range(10):  # a bot spreading spend over many conversations
        await lim.add(f"guest-{i}", GUEST, "1.2.3.4", 0.01, now=DAY1)
    hit = await lim.check_turn("guest-new", GUEST, "1.2.3.4", now=DAY1)
    assert hit is not None and hit.limit == "shopper_daily"
    assert await lim.check_turn("guest-new", GUEST, "5.6.7.8", now=DAY1) is None  # other IP

    await lim.add("a1", ALICE, "1.2.3.4", 0.3, now=DAY1)
    assert await lim.check_turn("a2", ALICE, "1.2.3.4", now=DAY1) is None  # $0.30 < $0.50
    await lim.add("a1", ALICE, "1.2.3.4", 0.2, now=DAY1)
    hit = await lim.check_turn("a2", ALICE, "9.9.9.9", now=DAY1)  # follows the user, not the IP
    assert hit is not None and hit.limit == "shopper_daily"
    assert await lim.check_turn("b1", BOB, "1.2.3.4", now=DAY1) is None


async def test_conversation_limit_and_integer_micro_dollars(redis: FakeAsyncRedis) -> None:
    lim = limits(redis, daily_spend_cap_usd=0, daily_spend_user_usd=0, conversation_spend_usd=0.1)
    await lim.add("c1", ALICE, None, 0.0999994, now=DAY1)
    assert await redis.get("spend:conv:c1") == "99999"
    assert await lim.check_turn("c1", ALICE, None, now=DAY1) is None
    await lim.add("c1", ALICE, None, 0.000001, now=DAY1)
    hit = await lim.check_turn("c1", ALICE, None, now=DAY1)
    assert hit is not None and hit.limit == "conversation"
    assert await lim.check_turn("c2", ALICE, None, now=DAY1) is None

    await lim.add("c3", ALICE, None, 0.0, now=DAY1)  # unpriced: nothing written
    assert await redis.get("spend:conv:c3") is None
    assert 0 < await redis.ttl("spend:2026-11-07:store") <= 2 * 86_400


async def test_new_conversations_per_hour(redis: FakeAsyncRedis) -> None:
    lim = limits(redis, new_conversations_per_hour_guest=3, new_conversations_per_hour_user=5)
    hits = [await lim.new_conversation(GUEST, "1.2.3.4", now=DAY1) for _ in range(4)]
    assert hits[:3] == [None, None, None] and hits[3] is not None
    assert hits[3].limit == "new_chats"
    assert await lim.new_conversation(GUEST, "1.2.3.4", now=DAY1 + 3600) is None  # next hour
    assert [await lim.new_conversation(ALICE, None, now=DAY1) for _ in range(5)] == [None] * 5


async def test_limits_set_to_zero_are_off(redis: FakeAsyncRedis) -> None:
    lim = limits(redis, daily_spend_cap_usd=0, daily_spend_user_usd=0, daily_spend_guest_usd=0,
                 conversation_spend_usd=0, new_conversations_per_hour_guest=0)
    await lim.add("c1", GUEST, "1.2.3.4", 100.0, now=DAY1)
    assert await lim.check_turn("c1", GUEST, "1.2.3.4", now=DAY1) is None
    assert await lim.new_conversation(GUEST, "1.2.3.4", now=DAY1) is None
    assert not await lim.store_closed(now=DAY1)


async def test_redis_failure_lets_turns_through() -> None:
    class Down:
        def __getattr__(self, _: str) -> Any:
            async def fail(*_: Any, **__: Any) -> None:
                raise ConnectionError("redis down")
            return fail

    lim = SpendLimits(settings(), Down())  # type: ignore[arg-type]
    assert await lim.check_turn("c1", GUEST, "1.2.3.4") is None
    assert await lim.new_conversation(GUEST, "1.2.3.4") is None
    assert not await lim.store_closed()


async def test_guests_get_a_lower_message_rate(redis: FakeAsyncRedis) -> None:
    limiter = RateLimiter(redis, 3, 1)
    await limiter.hit(None, "1.2.3.4")
    with pytest.raises(HTTPException) as exc:
        await limiter.hit(None, "1.2.3.4")
    assert exc.value.status_code == 429
    for _ in range(3):
        await limiter.hit("u-alice", None)


# --- over HTTP ---------------------------------------------------------------------

@pytest.fixture
def caller() -> Iterator[Caller]:
    c = Caller()
    app.dependency_overrides[get_auth] = c
    app.dependency_overrides[get_settings] = lambda: settings()
    yield c
    app.dependency_overrides.clear()


class PricedLLM(FakeLLM):
    """Each chat call costs $0.04."""

    async def stream(self, **kwargs: Any) -> Message:
        resp = await super().stream(**kwargs)
        usage.record("chat", "priced", usage.Counts(calls=1, cost_usd=0.04))
        return resp


async def test_chat_records_spend_and_refuses_with_x_limit(
    redis: FakeAsyncRedis, caller: Caller,
) -> None:
    llm = PricedLLM(*[message(text("Hi")) for _ in range(3)])
    agent = make_agent(redis, FakeApi(), llm, daily_spend_user_usd=0.1, conversation_spend_usd=0)
    async with await http_client(agent, redis) as http:
        for _ in range(3):  # $0.04, $0.08, then $0.12 ≥ $0.10
            assert (await http.post("/v1/chat", json={"message": "hi"})).status_code == 200
        resp = await http.post("/v1/chat", json={"message": "hi"})

    assert resp.status_code == 429
    assert resp.headers["X-Limit"] == "shopper_daily"
    assert "today's limit" in resp.json()["detail"]
    assert len(llm.calls) == 3  # refused before any model call


async def test_too_many_new_chats_are_refused(redis: FakeAsyncRedis, caller: Caller) -> None:
    caller.auth = GUEST
    llm = FakeLLM(*[message(text("Hi")) for _ in range(2)])
    agent = make_agent(redis, FakeApi(), llm, new_conversations_per_hour_guest=2)
    async with await http_client(agent, redis) as http:
        codes = [(await http.post("/v1/chat", json={"message": "hi"})).status_code
                 for _ in range(3)]
    assert codes == [200, 200, 429]


async def test_config_hides_the_widget_once_the_store_cap_is_used(
    redis: FakeAsyncRedis, caller: Caller,
) -> None:
    agent = make_agent(redis, FakeApi(), FakeLLM(), daily_spend_cap_usd=1.0)
    async with await http_client(agent, redis) as http:
        assert (await http.get("/v1/config")).json()["enabled"] is True
        store: SpendLimits = app.state.limits
        await store.add("c1", ALICE, None, 1.0)
        assert (await http.get("/v1/config")).json()["enabled"] is False


# --- provider balance ----------------------------------------------------------------

def test_balance_check_only_for_deepseek() -> None:
    deepseek = settings(anthropic_base_url="https://api.deepseek.com/anthropic")
    assert balance.balance_url(deepseek) == "https://api.deepseek.com/user/balance"
    assert balance.balance_url(settings(anthropic_base_url="")) is None
    assert balance.balance_url(settings(anthropic_base_url="https://example.com/x")) is None


def test_balance_parses_the_usd_entry() -> None:
    body = {"is_available": True, "balance_infos": [
        {"currency": "CNY", "total_balance": "9.00"},
        {"currency": "USD", "total_balance": "0.57"}]}
    assert balance.parse_usd(body) == 0.57
    assert balance.parse_usd({"balance_infos": []}) is None
    assert balance.parse_usd({}) is None
