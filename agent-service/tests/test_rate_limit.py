"""Per-minute rate limit: counts in a fixed window that always expires."""

import pytest
from fakeredis import FakeAsyncRedis
from fastapi import HTTPException

from app.guardrails import RateLimiter


async def test_blocks_over_the_limit_and_window_expires() -> None:
    redis = FakeAsyncRedis()
    limiter = RateLimiter(redis, 2)
    await limiter.hit(None, "1.2.3.4")
    await limiter.hit(None, "1.2.3.4")
    with pytest.raises(HTTPException) as err:
        await limiter.hit(None, "1.2.3.4")
    assert err.value.status_code == 429
    # Other guests and signed-in shoppers have their own buckets.
    await limiter.hit(None, "5.6.7.8")
    await limiter.hit("u1", "1.2.3.4")
    # The window is fixed: later hits don't push the expiry out.
    assert 0 < await redis.ttl("rl:ip:1.2.3.4") <= 60


async def test_new_counter_is_created_with_its_ttl() -> None:
    redis = FakeAsyncRedis()
    await RateLimiter(redis, 5).hit("u2", None)
    assert await redis.ttl("rl:user:u2") > 0
