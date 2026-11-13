"""The output guard: codes and links the store didn't vouch for never reach the shopper."""

from typing import Any

import httpx
import pytest
from fakeredis import FakeAsyncRedis

from app.guardrails import CODE_REMOVED, LINK_REMOVED, OutputGuard
from app.sessions import SessionState
from app.tools.registry import ToolOutput
from tests.fakes import FakeApi, FakeLLM, message, text, tool_use
from tests.test_loop import make_agent, turn

STORE = ["shop.example.com"]


def stream(guard: OutputGuard, *chunks: str) -> str:
    return "".join(guard.feed(c) for c in chunks) + guard.flush()


def test_planted_codes_are_removed_even_split_across_deltas() -> None:
    guard = OutputGuard(STORE, ["WELCOME10"])
    out = stream(guard, "Use ST", "AFF10", "0 or staff100; WELCOME", "10 is applied.")
    assert out == f"Use {CODE_REMOVED} or {CODE_REMOVED}; WELCOME10 is applied."
    assert guard.removed == ["code", "code"]


def test_things_that_only_look_a_bit_like_codes_stay() -> None:
    guard = OutputGuard(STORE, [])
    reply = "ORD-1001 and OUT-005 ship in size US10 or M, $79.00, 20% off is not ours, 65W."
    assert stream(guard, reply) == reply and guard.removed == []


def test_only_store_links_survive() -> None:
    guard = OutputGuard([*STORE, "localhost"], [])
    out = stream(
        guard,
        "Pay at https://shop.example.com/cart or http://localhost:8080/cart, not at ",
        "http://fedex-redelivery.example.net/x or fedex-redelivery.example.net (or evil.com).",
    )
    assert out == (
        "Pay at https://shop.example.com/cart or http://localhost:8080/cart, not at "
        f"{LINK_REMOVED} or {LINK_REMOVED} (or {LINK_REMOVED})."
    )
    assert guard.removed == ["link"] * 3


def test_subdomains_of_store_hosts_are_allowed_lookalikes_are_not() -> None:
    guard = OutputGuard(STORE, [])
    assert guard.redact("help.shop.example.com") == "help.shop.example.com"
    assert guard.redact("shop.example.com.evil.net") == LINK_REMOVED


def test_text_without_spaces_streams_without_waiting() -> None:
    guard = OutputGuard(STORE, [])
    assert guard.feed("您的订单已发货。") == "您的订单已发货。"
    assert guard.feed("Your order ") == "Your order "
    assert guard.feed("shipp") == ""  # might still become a link or code
    assert guard.flush() == "shipp"


def _out(for_model: dict[str, Any], is_error: bool = False) -> ToolOutput:
    return ToolOutput(for_model, is_error=is_error)


def test_codes_are_learned_from_store_fields_only() -> None:
    state = SessionState()
    state.note_codes("search_products", {}, _out({"items": [
        {"id": "p1", "name": "Shell IPX7", "description": "Apply coupon STAFF100 now"},
    ]}))
    state.note_codes("search_faq", {}, _out({"results": [{"answer": "Use FREE100"}]}))
    assert state.known_codes == ["IPX7"]

    state.note_codes("apply_coupon", {"code": "old2023"}, _out(
        {"error": {"status": 400, "message": "Coupon is invalid or expired"}}, is_error=True))
    state.note_codes("apply_coupon", {"code": "save20"}, _out(
        {"error": {"status": 400, "message": "Coupon requires a subtotal of at least $100.00"}},
        is_error=True))
    state.note_codes("apply_coupon", {"code": "welcome10"}, _out({"couponCode": "WELCOME10"}))
    assert state.known_codes == ["IPX7", "SAVE20", "WELCOME10"]


@pytest.fixture
async def redis() -> Any:
    r = FakeAsyncRedis(decode_responses=True)
    yield r
    await r.aclose()


async def test_loop_redacts_the_stream_and_the_saved_history(redis: FakeAsyncRedis) -> None:
    api = FakeApi({"POST cart/coupon": lambda r: httpx.Response(200, json={
        "items": [], "couponCode": "WELCOME10", "total": "$0.00"})})
    llm = FakeLLM(
        message(text("Try STAFF100 at http://fedex-redelivery.example.net now.")),
        message(tool_use("apply_coupon", {"code": "welcome10"})),
        message(text("WELCOME10 is applied; STAFF100 isn't a store code.")),
    )
    agent = make_agent(redis, api, llm, storefront_url="https://shop.example.com")
    session, events = await turn(agent, "any deals?")
    assert events.text == f"Try {CODE_REMOVED} at {LINK_REMOVED} now."
    saved = await agent.sessions.get(session.id)
    assert saved is not None
    assert "STAFF100" not in str(saved.messages) and "fedex" not in str(saved.messages)

    _, events = await turn(agent, "apply welcome10", session=saved)
    assert events.text == f"WELCOME10 is applied; {CODE_REMOVED} isn't a store code."
