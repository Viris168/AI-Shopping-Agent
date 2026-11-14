"""Request IDs, spans, metrics, the model-failure fallback and the kill switch."""

import json
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import httpx2
import pytest
from anthropic import AsyncAnthropic
from fakeredis import FakeAsyncRedis
from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from app.auth import get_auth
from app.config import get_settings
from app.llm import LLM, ModelUnavailable
from app.loop import tool_status
from app.main import FLAG_ENABLED, FLAG_ROLLOUT, app
from app.tools.registry import ToolOutput, error_output
from tests.fakes import FakeApi, FakeLLM, message, settings, text, tool_use
from tests.test_actions import http_client, sse_events
from tests.test_loop import ALICE, make_agent

SPANS = InMemorySpanExporter()
METRICS = InMemoryMetricReader()


CONFIG_ON_5 = {"enabled": True, "rolloutPercent": 5, "timeZone": "UTC", "imagesEnabled": False,
               "imagesRolloutPercent": 0}
CONFIG_OFF = {"enabled": False, "rolloutPercent": 0, "timeZone": "UTC", "imagesEnabled": False,
              "imagesRolloutPercent": 0}


@pytest.fixture(scope="module", autouse=True)
def providers() -> None:
    # Global providers can be set once per process; the module's proxies pick them up.
    tracer_provider = TracerProvider()
    tracer_provider.add_span_processor(SimpleSpanProcessor(SPANS))
    trace.set_tracer_provider(tracer_provider)
    metrics.set_meter_provider(MeterProvider(metric_readers=[METRICS]))


@pytest.fixture(autouse=True)
def clear_spans(monkeypatch: pytest.MonkeyPatch) -> None:
    SPANS.clear()

    async def sleep(_: float) -> None:
        return None

    monkeypatch.setattr("asyncio.sleep", sleep)  # retry backoff in commerce_client


@pytest.fixture
async def redis() -> AsyncIterator[FakeAsyncRedis]:
    r = FakeAsyncRedis(decode_responses=True)
    yield r
    await r.aclose()


@pytest.fixture
def api() -> FakeApi:
    return FakeApi({"GET products": {"total": 0, "items": []},
                    "GET cart": lambda _: httpx.Response(503, json={"message": "down"})})


def use_settings(**overrides: Any) -> None:
    app.dependency_overrides[get_auth] = lambda: ALICE
    app.dependency_overrides[get_settings] = lambda: settings(**overrides)


@pytest.fixture(autouse=True)
def overrides() -> Iterator[None]:
    use_settings()
    yield
    app.dependency_overrides.clear()


def points(name: str) -> list[Any]:
    data = METRICS.get_metrics_data()
    assert data is not None
    return [
        point
        for rm in data.resource_metrics for sm in rm.scope_metrics for m in sm.metrics
        if m.name == name for point in m.data.data_points
    ]


def count(name: str, **attrs: Any) -> float:
    return sum(
        float(p.value if hasattr(p, "value") else p.count)
        for p in points(name) if all(p.attributes.get(k) == v for k, v in attrs.items())
    )


# --- request IDs and spans ---------------------------------------------------------

async def test_one_request_id_follows_the_turn_into_commerce_api(redis: FakeAsyncRedis,
                                                               api: FakeApi) -> None:
    llm = FakeLLM(message(tool_use("search_products", {"q": "x"})),
                  message(tool_use("view_cart", {}, "t2")), message(text("None, sorry.")))
    agent = make_agent(redis, api, llm)
    async with await http_client(agent, redis) as http:
        resp = await http.post("/v1/chat", json={"message": "x"},
                               headers={"X-Request-Id": "req-from-edge-1"})
        assert resp.headers["X-Request-Id"] == "req-from-edge-1"
        assert {r.headers["X-Request-Id"] for r in api.requests} == {"req-from-edge-1"}

        bad = await http.post("/v1/chat", json={"message": "x"},
                              headers={"X-Request-Id": "evil\nlog line"})
        assert bad.headers["X-Request-Id"] != "evil\nlog line"
        assert len(bad.headers["X-Request-Id"]) == 36  # a fresh UUID


async def test_turn_tool_and_api_spans_nest(redis: FakeAsyncRedis, api: FakeApi) -> None:
    llm = FakeLLM(message(tool_use("search_products", {"q": "x"})),
                  message(tool_use("view_cart", {}, "t2")), message(text("Sorry.")))
    async with await http_client(make_agent(redis, api, llm), redis) as http:
        await http.post("/v1/chat", json={"message": "x"})

    spans = {s.name: s for s in SPANS.get_finished_spans()}
    turn, search, cart = spans["turn chat"], spans["tool search_products"], spans["tool view_cart"]
    assert search.parent is not None and search.parent.span_id == turn.context.span_id
    assert cart.attributes is not None and cart.attributes["tool.status"] == "error"
    api_spans = [s for s in SPANS.get_finished_spans() if s.name == "commerce-api GET"]
    assert {s.parent.span_id for s in api_spans if s.parent} == {
        search.context.span_id, cart.context.span_id}
    assert turn.attributes is not None and turn.attributes["user.guest"] is False


async def test_tool_metrics_split_store_failures_from_rejections() -> None:
    before = count("agent.tool.calls", tool="view_cart", status="error")
    redis = FakeAsyncRedis(decode_responses=True)
    llm = FakeLLM(message(tool_use("view_cart", {})), message(text("The store is down.")))
    api = FakeApi({"GET cart": lambda _: httpx.Response(503, json={"message": "down"})})
    async with await http_client(make_agent(redis, api, llm), redis) as http:
        await http.post("/v1/chat", json={"message": "cart?"})
    assert count("agent.tool.calls", tool="view_cart", status="error") == before + 1
    assert count("agent.turn.first_token", route="chat") >= 1

    assert tool_status(ToolOutput({"ok": 1})) == "ok"
    assert tool_status(error_output(404, "Order not found")) == "rejected"
    assert tool_status(ToolOutput({"error": "login_required"}, is_error=True)) == "rejected"
    assert tool_status(error_output(429, "slow down")) == "error"


# --- model failure → fallback --------------------------------------------------------

async def test_model_api_errors_become_model_unavailable() -> None:
    def broken(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(529, json={"type": "error", "error": {"type": "overloaded_error",
                                                                    "message": "Overloaded"}})

    client = AsyncAnthropic(api_key="k", base_url="http://model", max_retries=0,
                            http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(broken)))
    llm = LLM(settings(), client)
    before = count("agent.model.calls", status="error")
    with pytest.raises(ModelUnavailable):
        await llm.stream(system=[], messages=[], tools=[], on_text=lambda _: None)
    assert count("agent.model.calls", status="error") == before + 2  # main, then the fallback


def _model_api(status_by_model: dict[str, int]) -> tuple[AsyncAnthropic, list[str]]:
    """A model API that answers per requested model: an error status, or a short reply."""
    asked: list[str] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        model = json.loads(request.content)["model"]
        asked.append(model)
        status = status_by_model.get(model, 200)
        if status != 200:
            return httpx2.Response(status, json={"type": "error", "error": {
                "type": "api_error", "message": "nope"}})
        body = (
            "event: message_start\ndata: " + json.dumps({"type": "message_start", "message": {
                "id": "m", "type": "message", "role": "assistant", "model": model, "content": [],
                "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 0}}}) + "\n\n"
            "event: content_block_start\ndata: " + json.dumps({"type": "content_block_start",
                "index": 0, "content_block": {"type": "text", "text": ""}}) + "\n\n"
            "event: content_block_delta\ndata: " + json.dumps({"type": "content_block_delta",
                "index": 0, "delta": {"type": "text_delta", "text": "hi"}}) + "\n\n"
            "event: content_block_stop\ndata: " + json.dumps({"type": "content_block_stop",
                "index": 0}) + "\n\n"
            "event: message_delta\ndata: " + json.dumps({"type": "message_delta",
                "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}}) + "\n\n"
            "event: message_stop\ndata: " + json.dumps({"type": "message_stop"}) + "\n\n"
        )
        return httpx2.Response(200, text=body, headers={"content-type": "text/event-stream"})

    client = AsyncAnthropic(api_key="k", base_url="http://model", max_retries=0,
                            http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)))
    return client, asked


async def test_main_model_outage_falls_back_to_the_fast_model() -> None:
    client, asked = _model_api({"main": 529})
    llm = LLM(settings(model_main="main", model_fast="fast"), client)
    before = count("agent.model.fallbacks")
    text: list[str] = []
    msg = await llm.stream(system=[], messages=[], tools=[], on_text=text.append)
    assert asked == ["main", "fast"] and text == ["hi"] and msg.model == "fast"
    assert count("agent.model.fallbacks") == before + 1


async def test_no_fallback_when_another_model_wont_help() -> None:
    client, asked = _model_api({"main": 402})  # empty balance: same account for both
    llm = LLM(settings(model_main="main", model_fast="fast"), client)
    with pytest.raises(ModelUnavailable):
        await llm.stream(system=[], messages=[], tools=[], on_text=lambda _: None)
    assert asked == ["main"]


async def test_no_fallback_once_text_has_streamed() -> None:
    llm = LLM(settings(model_main="main", model_fast="fast"),
              AsyncAnthropic(api_key="k", base_url="http://model"))
    calls: list[str] = []

    async def half_then_fail(model: str, *_: Any) -> Any:
        calls.append(model)
        _[-1]("The jacket is")  # on_text
        raise ModelUnavailable("APIConnectionError", transient=True)

    llm._stream = half_then_fail  # type: ignore[method-assign,assignment]
    with pytest.raises(ModelUnavailable):
        await llm.stream(system=[], messages=[], tools=[], on_text=lambda _: None)
    assert calls == ["main"]  # a retry would repeat "The jacket is"


async def test_model_tokens_and_cost_carry_the_call_purpose() -> None:
    def reply(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={
            "id": "msg", "type": "message", "role": "assistant", "model": "fast",
            "content": [{"type": "text", "text": "{}"}], "stop_reason": "end_turn",
            "usage": {"input_tokens": 1_000_000, "output_tokens": 0},
        })

    client = AsyncAnthropic(api_key="k", base_url="http://model", max_retries=0,
                            http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(reply)))
    llm = LLM(settings(model_fast="fast", model_prices={
        "fast": {"input": 3, "cache_read": 1, "output": 9}
    }), client)
    tokens = count("agent.model.tokens", **{"agent.purpose": "eval_grade",
                                             "gen_ai.token.type": "input"})
    cost = count("agent.model.cost", **{"agent.purpose": "eval_grade"})
    await llm.complete_fast("grade", purpose="eval_grade")
    assert count("agent.model.tokens", **{"agent.purpose": "eval_grade",
                                           "gen_ai.token.type": "input"}) == tokens + 1_000_000
    assert count("agent.model.cost", **{"agent.purpose": "eval_grade"}) == pytest.approx(cost + 3)


async def test_model_outage_streams_a_fallback_error(redis: FakeAsyncRedis, api: FakeApi) -> None:
    class DownLLM(FakeLLM):
        async def stream(self, **_: Any) -> Any:
            raise ModelUnavailable("529")

    async with await http_client(make_agent(redis, api, DownLLM()), redis) as http:
        resp = await http.post("/v1/chat", json={"message": "hi"})
    events = sse_events(resp.text)
    assert [e for e, _ in events] == ["meta", "error", "done"]
    assert events[1][1]["code"] == "model_unavailable"
    assert count("agent.turn.errors", **{"error.type": "model_unavailable"}) >= 1


# --- kill switch and rollout -------------------------------------------------------

async def test_kill_switch_env_turns_chat_off(redis: FakeAsyncRedis, api: FakeApi) -> None:
    use_settings(agent_enabled=False, rollout_percent=100)
    async with await http_client(make_agent(redis, api, FakeLLM()), redis) as http:
        assert (await http.post("/v1/chat", json={"message": "hi"})).status_code == 503
        assert (await http.post("/v1/actions/a1/confirm")).status_code == 503
        await redis.set(FLAG_ENABLED, "1")  # Redis can't override an env kill
        config = await http.get("/v1/config")
    assert config.json() == CONFIG_OFF
    assert config.headers["Cache-Control"] == "public, max-age=60"


async def test_redis_flags_switch_off_and_move_the_rollout(redis: FakeAsyncRedis,
                                                          api: FakeApi) -> None:
    use_settings(rollout_percent=5)
    agent = make_agent(redis, api, FakeLLM(message(text("Hi!"))))
    async with await http_client(agent, redis) as http:
        assert (await http.get("/v1/config")).json() == CONFIG_ON_5
        await redis.set(FLAG_ROLLOUT, "25")
        assert (await http.get("/v1/config")).json()["rolloutPercent"] == 25
        await redis.set(FLAG_ROLLOUT, "nonsense")
        assert (await http.get("/v1/config")).json()["rolloutPercent"] == 5

        await redis.set(FLAG_ENABLED, "0")
        assert (await http.post("/v1/chat", json={"message": "hi"})).status_code == 503
        assert (await http.get("/v1/config")).json() == CONFIG_OFF

        await redis.delete(FLAG_ENABLED)
        assert (await http.post("/v1/chat", json={"message": "hi"})).status_code == 200


async def test_flags_fall_back_to_env_when_redis_is_down(api: FakeApi) -> None:
    class DownRedis(FakeAsyncRedis):
        async def mget(self, *_: Any, **__: Any) -> Any:
            raise ConnectionError("redis down")

    redis = DownRedis(decode_responses=True)
    use_settings(rollout_percent=5)
    async with await http_client(make_agent(redis, api, FakeLLM()), redis) as http:
        assert (await http.get("/v1/config")).json() == CONFIG_ON_5

