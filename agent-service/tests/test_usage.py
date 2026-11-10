import asyncio
import json

import httpx2
import pytest
from anthropic import AsyncAnthropic

from app import usage
from app.config import ModelPrice
from app.llm import LLM
from tests.fakes import settings

PRICE = ModelPrice(input=2.0, cache_read=0.5, output=8.0)


def model_api(model: str, input_tokens: int, output_tokens: int, cache_read: int = 0) -> LLM:
    """An LLM whose API answers every call with the given usage."""

    def reply(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={
            "id": "msg", "type": "message", "role": "assistant", "model": model,
            "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn",
            "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens,
                      "cache_read_input_tokens": cache_read},
        })

    client = AsyncAnthropic(api_key="k", base_url="http://model", max_retries=0,
                            http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(reply)))
    return LLM(settings(model_fast="fast", model_prices={"fast": PRICE}), client)


def test_cost_is_per_million_tokens_with_cheaper_cache_reads() -> None:
    cost = usage.estimate_cost(PRICE, input_tokens=1_000_000, cache_read=2_000_000,
                               output_tokens=500_000)
    assert cost == pytest.approx(2.0 + 1.0 + 4.0)


def test_unpriced_model_has_no_cost() -> None:
    assert usage.estimate_cost(None, 100, 0, 100) is None


def test_model_prices_parse_from_env_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODEL_PRICES", json.dumps(
        {"fast": {"input": 2, "cache_read": 0.5, "output": 8}}
    ))
    assert settings().model_prices == {"fast": PRICE}


async def test_tally_counts_calls_by_purpose_and_model() -> None:
    llm = model_api("fast", input_tokens=1000, output_tokens=100, cache_read=4000)
    with usage.tracking() as tally:
        await llm.complete_fast("grade this", purpose="eval_grade")
        await llm.complete_fast("grade that", purpose="eval_grade")
        await llm.complete_fast("facts?", purpose="memory_extract")

    grade = tally.by_call[("eval_grade", "fast")]
    assert (grade.calls, grade.input, grade.output, grade.cache_read) == (2, 2000, 200, 8000)
    assert grade.cost_usd == pytest.approx(2 * (1000 * 2.0 + 4000 * 0.5 + 100 * 8.0) / 1e6)
    assert tally.by_call[("memory_extract", "fast")].calls == 1
    assert tally.total.calls == 3
    assert tally.as_dict()["by_call"][0]["purpose"] == "eval_grade"


async def test_dated_model_id_falls_back_to_requested_price() -> None:
    llm = model_api("fast-2026-10-01", input_tokens=1_000_000, output_tokens=0)
    with usage.tracking() as tally:
        await llm.complete_fast("hi")
    assert tally.total.cost_usd == pytest.approx(2.0)
    assert tally.total.unpriced_calls == 0


async def test_unpriced_calls_count_tokens_but_no_cost() -> None:
    llm = model_api("other", input_tokens=10, output_tokens=5)
    llm._s = settings(model_fast="other")  # no prices
    with usage.tracking() as tally:
        await llm.complete_fast("hi")
    assert (tally.total.input, tally.total.cost_usd, tally.total.unpriced_calls) == (10, 0.0, 1)


async def test_tallies_nest_and_include_background_tasks() -> None:
    llm = model_api("fast", input_tokens=10, output_tokens=1)
    with usage.tracking() as run:
        with usage.tracking() as case:
            await asyncio.create_task(llm.complete_fast("in a task"))
        await llm.complete_fast("after the case")
    await llm.complete_fast("outside any tally")
    assert case.total.calls == 1
    assert run.total.calls == 2
