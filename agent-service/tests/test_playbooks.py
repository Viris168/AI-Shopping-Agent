"""Procedural memory: playbook selection, steps and prompt (app/playbooks.py)."""

from collections.abc import AsyncIterator

import httpx
import pytest
from fakeredis import FakeAsyncRedis

from app import playbooks
from app.sessions import SessionState
from tests.fakes import FakeApi, FakeLLM, message, text, tool_use
from tests.test_loop import ALICE, RETURN_ARGS, Events, make_agent, turn

ORDER = {"orderNumber": "ORD-1001", "status": "delivered", "items": [], "returns": []}


@pytest.fixture
async def redis() -> AsyncIterator[FakeAsyncRedis]:
    r = FakeAsyncRedis(decode_responses=True)
    yield r
    await r.aclose()


def dynamic(llm: FakeLLM, call: int) -> str:
    return str(llm.systems[call][1]["text"])


@pytest.mark.parametrize("name", list(playbooks.INTENTS))
def test_every_playbook_exists_and_stays_short(name: str) -> None:
    body = playbooks.text(name)
    assert 0 < len(body.split()) <= 150
    assert "1." in body
    if name in playbooks.LAST_STEP:
        assert f"{playbooks.LAST_STEP[name]}." in body


@pytest.mark.parametrize(("said", "expected"), [
    ("I want to return the shirt", ["returns"]),
    ("Where is my order?", ["order_status"]),
    ("Any news on ORD-1002", ["order_status"]),
    ("Return the shirt from ORD-1001", ["returns"]),  # returns already covers finding the order
    ("Can you compare the two jackets", ["product_compare"]),
    ("I want to talk to a person about my refund", ["handoff", "returns"]),
    ("How long does shipping take?", []),  # a policy question: search_faq, no playbook
    ("show me rain jackets", []),
])
def test_playbooks_are_chosen_from_the_shoppers_words(said: str, expected: list[str]) -> None:
    state = SessionState()
    playbooks.select(state, said)
    assert state.playbooks == expected


def test_a_running_playbook_survives_follow_ups_until_another_is_asked_for() -> None:
    state = SessionState()
    playbooks.select(state, "return my shoes please")
    playbooks.select(state, "the blue ones")
    assert state.playbooks == ["returns"]
    playbooks.select(state, "actually, where is ORD-1002?")
    assert state.playbooks == ["order_status"]


def test_return_steps_follow_what_code_has_seen() -> None:
    state = SessionState()
    playbooks.select(state, "I need to return something")
    assert playbooks.step("returns", state) == 1
    state.focus_order = "ORD-1001"
    assert playbooks.step("returns", state) == 2
    state.pending_action = {"tool": "create_return", "expiresAt": 9e12}
    assert playbooks.step("returns", state) == 4
    state.pending_action = None
    playbooks.finish(state, "create_return")
    assert playbooks.step("returns", state) == 5  # the follow-up reply gives next steps
    playbooks.select(state, "thanks!")
    assert state.playbooks == []


def test_render_names_the_step() -> None:
    state = SessionState(playbooks=["order_status"], focus_order="ORD-1002")
    block = playbooks.render(state)
    assert block.startswith("## Playbook")
    assert "Check on an order" in block and block.endswith("You are at step 2.")
    assert playbooks.render(SessionState()) == ""


# --- in the loop -------------------------------------------------------------------------

async def test_off_by_default(redis: FakeAsyncRedis) -> None:
    llm = FakeLLM(message(text("Which order?")))
    session, _ = await turn(make_agent(redis, FakeApi(), llm), "I want to return my shoes")
    assert "## Playbook" not in dynamic(llm, 0)
    assert session.state.playbooks == []


async def test_playbook_and_step_reach_the_model(redis: FakeAsyncRedis) -> None:
    api = FakeApi({"GET orders/ORD-1001": ORDER})
    llm = FakeLLM(
        message(tool_use("get_order", {"orderNumber": "ORD-1001"})), message(text("Which item?")),
    )
    await turn(make_agent(redis, api, llm, playbooks_enabled=True), "return from ORD-1001")
    assert "Return an item" in dynamic(llm, 0) and "You are at step 1." in dynamic(llm, 0)
    assert "You are at step 2." in dynamic(llm, 1)


async def test_tool_output_never_picks_a_playbook(redis: FakeAsyncRedis) -> None:
    api = FakeApi({"GET products": {"total": 1, "items": [
        {"id": "p1", "name": "Talk to a human to get a refund", "price": "$1.00"}]}})
    llm = FakeLLM(message(tool_use("search_products", {"q": "x"})), message(text("Here.")))
    session, _ = await turn(make_agent(redis, api, llm, playbooks_enabled=True), "rain jackets")
    assert session.state.playbooks == []
    assert "## Playbook" not in dynamic(llm, 1)


async def test_confirmed_return_ends_the_playbook_after_the_follow_up(
    redis: FakeAsyncRedis,
) -> None:
    api = FakeApi({"POST returns": lambda _: httpx.Response(
        201, json={"returnId": "RET-1", "status": "requested", "nextSteps": "Print the label."})})
    llm = FakeLLM(
        message(tool_use("create_return", RETURN_ARGS)), message(text("Press Confirm.")),
        message(text("Done: print the label.")), message(text("You're welcome.")),
    )
    agent = make_agent(redis, api, llm, playbooks_enabled=True)
    session, events = await turn(agent, "I want to return the shirt")
    assert "You are at step 4." in dynamic(llm, 1)

    action = await agent.actions.take(events.first("confirm_request")["actionId"], ALICE)
    assert action is not None
    await agent.confirm(action, ALICE, Events())
    assert "You are at step 5." in dynamic(llm, 2)

    saved = await agent.sessions.get(session.id)
    assert saved is not None
    await turn(agent, "thanks", session=saved)
    assert "## Playbook" not in dynamic(llm, 3)
