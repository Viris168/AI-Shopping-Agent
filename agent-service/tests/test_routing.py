"""Model routing (PLAN-19 M5): which model a turn uses, and the one-way move to the main one."""

from collections.abc import AsyncIterator

import pytest
from fakeredis import FakeAsyncRedis

from app import telemetry
from app.loop import Agent
from app.routing import FLAG_PERCENT, FLAG_ROUTING, Router, bucket, route
from app.sessions import Session
from tests.fakes import FakeApi, FakeLLM, message, settings, text, tool_use
from tests.test_loop import api, make_agent, turn  # noqa: F401 - api is a fixture

RETURN_ARGS = {"orderNumber": "ORD-1001", "items": [{"orderItemId": "oi-1", "quantity": 1}],
               "reason": "Too small"}


@pytest.fixture
async def redis() -> AsyncIterator[FakeAsyncRedis]:
    r = FakeAsyncRedis(decode_responses=True)
    yield r
    await r.aclose()


def routed(redis: FakeAsyncRedis, api: FakeApi, llm: FakeLLM) -> Agent:  # noqa: F811
    agent = make_agent(redis, api, llm, model_routing_enabled=True, routing_percent=100)
    agent.router = Router(agent.settings, redis)
    return agent


# --- the rules ---------------------------------------------------------------------

@pytest.mark.parametrize("msg", [
    "hi!", "Do you have rain jackets?", "Where's my order ORD-1002?", "What's in my cart?",
    "How long does shipping take?", "Add the Trailrunner to my cart",
])
def test_simple_turns_start_on_the_fast_model(msg: str) -> None:
    assert route(msg, Session(id="s")) == ("fast", "simple")


@pytest.mark.parametrize("msg, reason", [
    ("I want to return the shoes from ORD-1001", "intent:returns"),
    ("When do I get my refund?", "intent:returns"),
    ("Can I talk to a human?", "intent:handoff"),
    ("Any discounts for me?", "money"),
    ("Apply WELCOME10 please", "money"),
    ("I want 50% off", "money"),
    ("I was charged twice", "money"),
    ("This is ridiculous", "sensitive"),
    ("The heater hurt my hand", "sensitive"),
    ("Forget my shoe size", "sensitive"),
])
def test_turns_that_may_need_the_main_model_start_there(msg: str, reason: str) -> None:
    assert route(msg, Session(id="s")) == ("main", reason)


def test_main_model_is_sticky_and_covers_events_and_open_confirm_cards() -> None:
    assert route("hi", Session(id="s", model_tier="main")) == ("main", "sticky")
    assert route(None, Session(id="s")) == ("main", "event")
    pending = Session(id="s")
    pending.state.pending_action = {"tool": "create_return", "expiresAt": 9e12}
    assert route("ok", pending) == ("main", "pending_confirm")


# --- in the loop -------------------------------------------------------------------

async def test_simple_turn_runs_on_the_fast_model_and_streams_its_reply(
    redis: FakeAsyncRedis, api: FakeApi,  # noqa: F811
) -> None:
    llm = FakeLLM(message(tool_use("search_products", {"q": "jacket"})),
                  message(text("The Rain Jacket is $79.00.")))
    agent = routed(redis, api, llm)
    session, events = await turn(agent, "Do you have rain jackets?")

    assert llm.fast == [True, True]
    assert events.text == "The Rain Jacket is $79.00."
    assert session.model_tier is None


async def test_main_only_tool_from_the_fast_model_is_redone_on_the_main_model(
    redis: FakeAsyncRedis, api: FakeApi,  # noqa: F811
) -> None:
    llm = FakeLLM(
        message(text("Starting your return now."),  # fast: dropped unseen
                tool_use("create_return", RETURN_ARGS)),
        message(tool_use("create_return", RETURN_ARGS, "t2")),  # main, same round
        message(text("Press Confirm on the card to submit it.")),
        message(text("Anything else?")),  # next turn
    )
    agent = routed(redis, api, llm)
    session, events = await turn(agent, "These shoes from ORD-1001 are too small")

    assert llm.fast == [True, False, False]
    assert llm.calls[0] == llm.calls[1]  # the main model got the same request
    assert llm.systems[0] == llm.systems[1] and llm.tools[0] == llm.tools[1]
    sent = events.text
    assert "Starting your return now" not in sent
    assert events.names.count("confirm_request") == 1
    assert session.model_tier == "main"

    await turn(agent, "thanks", session=session)
    assert llm.fast[-1] is False  # sticky


async def test_main_model_writes_the_reply_after_order_or_cart_data(
    redis: FakeAsyncRedis,
) -> None:
    orders = FakeApi({"GET orders/ORD-1002": {"orderNumber": "ORD-1002", "status": "SHIPPED"}})
    llm = FakeLLM(message(tool_use("get_order", {"orderNumber": "ORD-1002"})),
                  message(text("It has shipped.")), message(text("Bye!")))
    agent = routed(redis, orders, llm)
    session, events = await turn(agent, "Where's ORD-1002?")

    assert llm.fast == [True, False]  # the fast model picked the tool; main wrote the reply
    assert orders.calls == ["GET orders/ORD-1002"]  # run once, not redone
    assert events.text == "It has shipped."
    assert session.model_tier == "main"
    await turn(agent, "thanks", session=session)
    assert llm.fast[-1] is False


async def test_fast_model_error_falls_back_to_the_main_model(
    redis: FakeAsyncRedis, api: FakeApi,  # noqa: F811
) -> None:
    llm = FakeLLM(message(text("Hello!")))
    llm.fail_fast = True
    agent = routed(redis, api, llm)
    session, events = await turn(agent, "hi")

    assert llm.fast == [False]
    assert events.first("text_delta")["text"] == "Hello!"
    assert session.model_tier == "main"


async def test_routing_off_by_flag_or_config_uses_the_main_model(
    redis: FakeAsyncRedis, api: FakeApi,  # noqa: F811
) -> None:
    llm = FakeLLM(message(text("Hi")), message(text("Hi")))
    await turn(make_agent(redis, api, llm), "hi")  # no router: config off
    await redis.set(FLAG_ROUTING, "0")
    await turn(routed(redis, api, llm), "hi")
    assert llm.fast == [False, False]


async def test_route_is_reported_for_evals(
    redis: FakeAsyncRedis, api: FakeApi,  # noqa: F811
) -> None:
    seen: list[tuple[str, str]] = []
    agent = routed(redis, api, FakeLLM(message(text("Hi"))))
    agent.on_route = lambda tier, reason: seen.append((tier, reason))
    await turn(agent, "hi")
    assert seen == [("fast", "simple")]


# --- rollout groups (M6) --------------------------------------------------------------

async def test_router_needs_the_config_switch(redis: FakeAsyncRedis) -> None:
    off = Router(settings(model_routing_enabled=False, routing_percent=100), redis)
    assert await off.group(Session(id="s")) == "off"


async def test_groups_split_by_percent_and_stay_fixed(redis: FakeAsyncRedis) -> None:
    router = Router(settings(model_routing_enabled=True, routing_percent=30), redis)
    sessions = [Session(id=f"conv-{i}") for i in range(1000)]
    groups = [await router.group(s) for s in sessions]
    assert 250 < groups.count("routed") < 350  # about 30%
    for s, g in zip(sessions, groups, strict=True):
        assert g == ("routed" if bucket(s.id) < 30 else "control")
        assert s.routing_group == g

    await redis.set(FLAG_PERCENT, "100")  # moving the rollout doesn't move open conversations
    assert [await router.group(s) for s in sessions] == groups
    assert await router.group(Session(id="new-conv")) == "routed"


async def test_kill_switch_beats_the_group_without_losing_it(redis: FakeAsyncRedis) -> None:
    router = Router(settings(model_routing_enabled=True, routing_percent=100), redis)
    session = Session(id="s")
    assert await router.group(session) == "routed"
    await redis.set(FLAG_ROUTING, "0")
    assert await router.group(session) == "off"
    await redis.delete(FLAG_ROUTING)
    assert await router.group(session) == "routed"


async def test_control_group_always_uses_the_main_model(
    redis: FakeAsyncRedis, api: FakeApi,  # noqa: F811
) -> None:
    llm = FakeLLM(message(text("Hi")))
    agent = make_agent(redis, api, llm, model_routing_enabled=True, routing_percent=0)
    agent.router = Router(agent.settings, redis)
    session, _ = await turn(agent, "hi")
    assert llm.fast == [False] and session.routing_group == "control"


async def test_metrics_carry_the_group(redis: FakeAsyncRedis, api: FakeApi) -> None:  # noqa: F811
    agent = routed(redis, api, FakeLLM(message(text("Hi"))))
    await turn(agent, "hi")
    assert telemetry.grouped({"a": 1}) == {"a": 1, "agent.routing_group": "routed"}
