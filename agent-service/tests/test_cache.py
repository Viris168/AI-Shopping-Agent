"""Redis cache for public tool results (app/cache.py)."""

from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fakeredis import FakeAsyncRedis
from pydantic import BaseModel

from app.auth import GUEST, Auth
from app.cache import GENERATION, ToolCache
from app.commerce_client import CommerceClient
from app.tools.registry import Tool, ToolContext, ToolOutput, build_registry
from tests.fakes import FakeApi, settings

REGISTRY = build_registry()
ALICE = Auth(user_id="u-alice", name="Alice", token="tok-alice")
JACKET = {"id": "p1", "slug": "rain-jacket", "name": "Rain Jacket", "price": "$79.00",
          "inStock": True, "stock": 4}
FAQ = {"results": [{"topic": "returns", "question": "What is your return policy?",
                    "answer": "30 days."}]}


@pytest.fixture
async def redis() -> AsyncIterator[FakeAsyncRedis]:
    r = FakeAsyncRedis(decode_responses=True)
    yield r
    await r.aclose()


async def run(name: str, args: dict[str, Any], api: FakeApi, cache: ToolCache | None,
              auth: Auth = GUEST) -> ToolOutput:
    tool = REGISTRY.get(name)
    assert tool is not None
    client = CommerceClient(settings(), api.http())
    try:
        return await tool.run(args, ToolContext(auth, "conv-1", client, settings(), cache=cache))
    finally:
        await client.aclose()


async def test_repeat_call_is_served_from_cache(redis: FakeAsyncRedis) -> None:
    api = FakeApi({"GET products": {"total": 1, "items": [JACKET]}})
    cache = ToolCache(redis)
    first = await run("search_products", {"q": "rain jacket"}, api, cache)
    second = await run("search_products", {"q": "rain jacket"}, api, cache)
    assert api.calls == ["GET products"]
    assert second.for_model == first.for_model
    assert second.card == first.card and second.card is not None
    assert not second.is_error


async def test_free_text_is_normalised_but_filters_are_not(redis: FakeAsyncRedis) -> None:
    api = FakeApi({"GET products": {"total": 1, "items": [JACKET]}})
    cache = ToolCache(redis)
    await run("search_products", {"q": "rain jacket"}, api, cache)
    await run("search_products", {"q": "  Rain   JACKET "}, api, cache)
    assert len(api.calls) == 1
    await run("search_products", {"q": "rain jacket", "inStock": True}, api, cache)
    assert len(api.calls) == 2


async def test_cached_results_are_shared_between_guests_and_shoppers(
    redis: FakeAsyncRedis,
) -> None:
    api = FakeApi({"GET faq/search": FAQ})
    cache = ToolCache(redis)
    await run("search_faq", {"q": "return policy"}, api, cache, auth=GUEST)
    out = await run("search_faq", {"q": "return policy"}, api, cache, auth=ALICE)
    assert len(api.calls) == 1
    assert out.for_model["results"][0]["answer"] == "30 days."


async def test_ttl_is_short_for_products_and_longer_for_faq(redis: FakeAsyncRedis) -> None:
    api = FakeApi({"GET products/rain-jacket": JACKET, "GET faq/search": FAQ})
    cache = ToolCache(redis)
    await run("get_product", {"idOrSlug": "rain-jacket"}, api, cache)
    await run("search_faq", {"q": "returns"}, api, cache)
    keys = [key async for key in redis.scan_iter("cache:tool:*")]
    ttls = {key.split(":")[3]: await redis.ttl(key) for key in keys}
    assert 0 < ttls["get_product"] <= 60
    assert 60 < ttls["search_faq"] <= 600


async def test_errors_are_not_cached(redis: FakeAsyncRedis) -> None:
    responses = [httpx.Response(404, json={"message": "Product not found"}),
                 httpx.Response(200, json=JACKET)]
    api = FakeApi({"GET products/rain-jacket": lambda _: responses.pop(0)})
    cache = ToolCache(redis)
    first = await run("get_product", {"idOrSlug": "rain-jacket"}, api, cache)
    second = await run("get_product", {"idOrSlug": "rain-jacket"}, api, cache)
    assert first.is_error and not second.is_error
    assert len(api.calls) == 2


async def test_empty_results_are_not_cached(redis: FakeAsyncRedis) -> None:
    api = FakeApi({"GET faq/search": {"results": []}})
    cache = ToolCache(redis)
    await run("search_faq", {"q": "price match"}, api, cache)
    await run("search_faq", {"q": "price match"}, api, cache)
    assert len(api.calls) == 2


async def test_redis_flag_turns_the_cache_off(redis: FakeAsyncRedis) -> None:
    api = FakeApi({"GET faq/search": FAQ})
    cache = ToolCache(redis)
    await run("search_faq", {"q": "returns"}, api, cache)
    await redis.set("flag:cache_enabled", "0")
    await run("search_faq", {"q": "returns"}, api, cache)
    assert len(api.calls) == 2


async def test_setting_turns_the_cache_off(redis: FakeAsyncRedis) -> None:
    api = FakeApi({"GET faq/search": FAQ})
    cache = ToolCache(redis, enabled=False)
    await run("search_faq", {"q": "returns"}, api, cache)
    await run("search_faq", {"q": "returns"}, api, cache)
    assert len(api.calls) == 2
    assert [k async for k in redis.scan_iter("cache:tool:*")] == []


async def test_bumping_the_generation_drops_everything(redis: FakeAsyncRedis) -> None:
    api = FakeApi({"GET faq/search": FAQ})
    cache = ToolCache(redis)
    await run("search_faq", {"q": "returns"}, api, cache)
    await redis.incr(GENERATION)
    await run("search_faq", {"q": "returns"}, api, cache)
    assert len(api.calls) == 2


class BrokenRedis:
    async def mget(self, *_: Any) -> Any:
        raise ConnectionError("redis down")


async def test_redis_failure_falls_back_to_the_api() -> None:
    api = FakeApi({"GET faq/search": FAQ})
    cache = ToolCache(BrokenRedis())  # type: ignore[arg-type]
    out = await run("search_faq", {"q": "returns"}, api, cache)
    assert out.for_model["results"] and len(api.calls) == 1


def test_only_public_read_only_tools_are_cached() -> None:
    cached = {t.name for t in REGISTRY.for_auth(ALICE) if t.cache_ttl_s is not None}
    assert cached == {"search_products", "get_product", "get_recommendations",
                      "list_categories", "search_faq"}
    for name in cached:
        tool = REGISTRY.get(name)
        assert tool is not None and not tool.requires_auth and not tool.confirm


class _Args(BaseModel):
    pass


async def _handler(_: Any, __: ToolContext) -> ToolOutput:
    return ToolOutput({})


@pytest.mark.parametrize(("requires_auth", "confirm"), [(True, False), (False, True)])
def test_login_only_or_confirm_tools_cannot_be_cached(requires_auth: bool, confirm: bool) -> None:
    with pytest.raises(ValueError, match="only public read-only tools"):
        Tool("view_orders", "x", _Args, _handler, requires_auth=requires_auth, confirm=confirm,
             cache_ttl_s=60)
