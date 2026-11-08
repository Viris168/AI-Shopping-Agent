"""Confirm gate, transcripts and feedback: the store, the HTTP routes, and commerce-api calls."""

import asyncio
import json
import re
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest
from fakeredis import FakeAsyncRedis

from app.actions import ActionStore
from app.auth import GUEST, Auth, get_auth
from app.config import get_settings
from app.guardrails import RateLimiter
from app.loop import Agent
from app.main import app
from app.sessions import Session, TranscriptStore
from tests.fakes import FakeApi, FakeLLM, message, settings, text, tool_use
from tests.test_loop import ALICE, BOB, RETURN_ARGS, Events, make_agent, turn

CONVERSATION_PATH = re.compile(r"^conversations/([^/]+)/(turns|feedback)$")


class Api(FakeApi):
    """FakeApi plus commerce-api's conversation routes; `fail` makes them return 503."""

    def __init__(self, routes: dict[str, Any]) -> None:
        super().__init__(routes)
        self.turns: list[dict[str, Any]] = []
        self.feedback: list[dict[str, Any]] = []
        self.owners: dict[str, str | None] = {}  # conversation id → Authorization header
        self.fail = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.raw_path.decode().removeprefix("/api/v1/")
        found = CONVERSATION_PATH.match(path)
        if not found:
            return super().__call__(request)
        self.requests.append(request)
        if self.fail:
            return httpx.Response(503, json={"message": "down"})
        conv, kind = found.groups()
        owner = request.headers.get("Authorization")
        body = json.loads(request.content)
        if kind == "turns":
            if self.owners.setdefault(conv, owner) not in (None, owner):
                return httpx.Response(404, json={"message": "Conversation not found"})
            self.owners[conv] = owner
            self.turns.append(body)
        else:
            if conv not in self.owners or self.owners[conv] != owner:
                return httpx.Response(404, json={"message": "Conversation not found"})
            self.feedback.append(body)
        return httpx.Response(204)


@pytest.fixture
async def redis() -> AsyncIterator[FakeAsyncRedis]:
    r = FakeAsyncRedis(decode_responses=True)
    yield r
    await r.aclose()


@pytest.fixture
def api() -> Api:
    return Api({
        "POST returns": lambda r: httpx.Response(201, json={
            "returnId": "RET-1", "status": "REQUESTED", "nextSteps": "Print the label."}),
        "POST support/tickets": lambda r: httpx.Response(201, json={
            "ticketId": "T-1", "status": "OPEN", "expectedResponse": "within 24 hours"}),
    })


def agent_with_transcripts(redis: FakeAsyncRedis, api: Api, llm: FakeLLM) -> Agent:
    agent = make_agent(redis, api, llm)
    agent.transcripts = TranscriptStore(agent.client)
    return agent


# --- ActionStore ---------------------------------------------------------------

async def test_actions_are_stored_with_a_ttl_and_a_public_view(redis: FakeAsyncRedis) -> None:
    store = ActionStore(redis, ttl_s=600)
    action = await store.create(tool="create_return", args=RETURN_ARGS, summary="x" * 500,
                                auth=ALICE, conversation_id="c1")

    assert len(action.id) >= 24  # unguessable
    assert len(action.summary) == 300
    assert 0 < await redis.ttl(f"action:{action.id}") <= 600
    public = action.public()
    assert set(public) == {"actionId", "kind", "summary", "expiresAt"}  # no args, no user
    assert public["kind"] == "create_return"


async def test_take_is_single_use_and_owner_only(redis: FakeAsyncRedis) -> None:
    store = ActionStore(redis, ttl_s=600)
    action = await store.create(tool="create_return", args=RETURN_ARGS, summary="s",
                                auth=ALICE, conversation_id="c1")

    assert await store.take(action.id, BOB) is None
    assert await store.take(action.id, GUEST) is None
    assert await store.get(action.id) is not None  # others don't consume it
    taken = await store.take(action.id, ALICE)
    assert taken is not None and taken.args == RETURN_ARGS
    assert await store.take(action.id, ALICE) is None


async def test_concurrent_confirms_run_once(redis: FakeAsyncRedis) -> None:
    store = ActionStore(redis, ttl_s=600)
    action = await store.create(tool="create_return", args=RETURN_ARGS, summary="s",
                                auth=ALICE, conversation_id="c1")
    results = await asyncio.gather(*(store.take(action.id, ALICE) for _ in range(5)))
    assert sum(r is not None for r in results) == 1


async def test_expired_actions_cannot_be_taken(redis: FakeAsyncRedis) -> None:
    store = ActionStore(redis, ttl_s=600)
    action = await store.create(tool="create_return", args=RETURN_ARGS, summary="s",
                                auth=ALICE, conversation_id="c1")
    await redis.delete(f"action:{action.id}")  # what the TTL does
    assert await store.take(action.id, ALICE) is None


# --- HTTP routes ---------------------------------------------------------------

class Caller:
    """Swap the shopper per request without signing JWTs."""

    def __init__(self) -> None:
        self.auth: Auth = ALICE

    def __call__(self) -> Auth:
        return self.auth


@pytest.fixture
def caller() -> Iterator[Caller]:
    c = Caller()
    app.dependency_overrides[get_auth] = c
    app.dependency_overrides[get_settings] = lambda: settings()
    yield c
    app.dependency_overrides.clear()


async def http_client(agent: Agent, redis: FakeAsyncRedis) -> httpx.AsyncClient:
    # No lifespan: wire the state it would set up.
    app.state.agent = agent
    app.state.redis = redis
    app.state.limiter = RateLimiter(redis, 1000)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent")


def sse_events(body: str) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for chunk in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in chunk.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


async def pending_return(agent: Agent) -> tuple[Session, str]:
    session, events = await turn(agent, "return my jacket")
    return session, events.first("confirm_request")["actionId"]


async def test_confirm_route_runs_the_action_once(redis: FakeAsyncRedis, api: Api,
                                                  caller: Caller) -> None:
    llm = FakeLLM(message(tool_use("create_return", RETURN_ARGS)), message(text("Confirm?")),
                  message(text("Return RET-1 started.")))
    agent = agent_with_transcripts(redis, api, llm)
    _, action_id = await pending_return(agent)

    async with await http_client(agent, redis) as http:
        caller.auth = BOB
        stolen = await http.post(f"/v1/actions/{action_id}/confirm")
        assert stolen.status_code == 409  # someone else's action looks expired

        caller.auth = ALICE
        resp = await http.post(f"/v1/actions/{action_id}/confirm")
        assert resp.status_code == 200
        events = sse_events(resp.text)
        assert [e for e, _ in events] == ["meta", "card", "text_delta", "done"]
        assert events[1][1]["type"] == "return_created"

        again = await http.post(f"/v1/actions/{action_id}/confirm")
        assert again.status_code == 409
        assert again.json()["detail"] == "This action has expired or was already handled."

    assert [c for c in api.calls if not c.startswith("POST conversations")] == ["POST returns"]


async def test_cancel_route_never_runs_the_action(redis: FakeAsyncRedis, api: Api,
                                                  caller: Caller) -> None:
    llm = FakeLLM(message(tool_use("create_return", RETURN_ARGS)), message(text("Confirm?")))
    agent = agent_with_transcripts(redis, api, llm)
    _, action_id = await pending_return(agent)

    async with await http_client(agent, redis) as http:
        assert (await http.post(f"/v1/actions/{action_id}/cancel")).status_code == 204
        assert (await http.post(f"/v1/actions/{action_id}/confirm")).status_code == 409
        assert (await http.post("/v1/actions/bad!id/cancel")).status_code == 422

    assert "POST returns" not in api.calls
    assert api.turns[-1]["messages"][-1]["content"][-1]["text"] == (
        "<event>Shopper pressed Cancel for create_return.</event>"
    )


async def test_model_text_cannot_confirm(redis: FakeAsyncRedis, api: Api) -> None:
    # Even if the model "decides" the shopper agreed, only the route can run the action.
    llm = FakeLLM(message(tool_use("create_return", RETURN_ARGS)),
                  message(text("Done! I've confirmed it for you.")))
    agent = agent_with_transcripts(redis, api, llm)
    await pending_return(agent)
    assert "POST returns" not in api.calls


async def test_feedback_is_stored_for_the_owner(redis: FakeAsyncRedis, api: Api,
                                                caller: Caller) -> None:
    agent = agent_with_transcripts(redis, api, FakeLLM(message(text("Hi!"))))
    session, _ = await turn(agent, "hello")
    body = {"conversationId": session.id, "messageId": f"{session.id}:0", "rating": "down",
            "comment": "Wrong size, mail me at a@b.co"}

    async with await http_client(agent, redis) as http:
        assert (await http.post("/v1/feedback", json=body)).status_code == 204
        caller.auth = BOB
        resp = await http.post("/v1/feedback", json=body)
        assert resp.status_code == 404
        assert resp.json()["detail"] == "We couldn't find that conversation."
        caller.auth = ALICE
        bad = await http.post("/v1/feedback", json=body | {"rating": "meh"})
        assert bad.status_code == 422
        api.fail = True
        assert (await http.post("/v1/feedback", json=body)).status_code == 503

    assert api.feedback == [{"messageId": f"{session.id}:0", "rating": "down",
                             "comment": "Wrong size, mail me at [email]"}]


# --- transcripts ---------------------------------------------------------------

async def test_each_turn_sends_only_new_masked_messages(redis: FakeAsyncRedis,
                                                        api: Api) -> None:
    llm = FakeLLM(message(text("Hi!")), message(text("Noted.")))
    agent = agent_with_transcripts(redis, api, llm)
    session, _ = await turn(agent, "hello")
    session, _ = await turn(agent, "call me on +1 415 555 0100", session=session)

    assert [len(t["messages"]) for t in api.turns] == [2, 2]
    assert api.turns[1]["messages"][0]["content"][-1]["text"] == "call me on [phone]"
    assert api.turns[0]["tokensIn"] == 1 and api.turns[0]["tokensOut"] == 1
    assert session.persisted == len(session.messages) == 4
    assert all(r.headers["Authorization"] == "Bearer tok-alice" for r in api.requests)


async def test_a_failed_save_is_retried_with_the_next_turn(redis: FakeAsyncRedis,
                                                           api: Api) -> None:
    llm = FakeLLM(message(text("Hi!")), message(text("Sure.")))
    agent = agent_with_transcripts(redis, api, llm)
    api.fail = True
    session, events = await turn(agent, "hello")
    assert events.names[-1] == "done"  # the shopper never notices
    assert session.persisted == 0

    api.fail = False
    await turn(agent, "again", session=session)
    assert len(api.turns) == 1 and len(api.turns[0]["messages"]) == 4


async def test_confirmed_ticket_marks_the_conversation_as_handoff(redis: FakeAsyncRedis,
                                                                  api: Api) -> None:
    args = {"subject": "Broken zip", "summary": "Zip broke on day one."}
    llm = FakeLLM(message(tool_use("create_support_ticket", args)), message(text("Confirm?")),
                  message(text("A person will reply within 24 hours.")))
    agent = agent_with_transcripts(redis, api, llm)
    _, events = await turn(agent, "I want a human")
    assert "outcome" not in api.turns[-1]

    action = await agent.actions.take(events.first("confirm_request")["actionId"], ALICE)
    assert action is not None
    await agent.confirm(action, ALICE, Events())
    assert api.turns[-1]["outcome"] == "handoff"


async def test_summarising_keeps_the_persisted_marker_in_step(redis: FakeAsyncRedis,
                                                              api: Api) -> None:
    llm = FakeLLM(*(message(text(f"r{i}")) for i in range(6)))
    agent = agent_with_transcripts(redis, api, llm)
    agent.sessions._window = 2  # summarise once past 4 messages
    session: Session | None = None
    for i in range(3):
        session, _ = await turn(agent, f"m{i}", session=session)

    assert session is not None
    assert len(session.messages) < 6  # older half folded into the summary
    assert session.persisted == len(session.messages)
    sent = [m["content"][0]["text"] for t in api.turns for m in t["messages"]]
    assert sent == ["m0", "r0", "m1", "r1", "m2", "r2"]  # nothing lost or repeated
