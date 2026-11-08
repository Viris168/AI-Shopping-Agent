"""Tools, registry and commerce-api client, against an in-process commerce-api."""

from typing import Any

import httpx
import pytest

from app.auth import GUEST, Auth
from app.commerce_client import ApiError, CommerceClient
from app.tools.registry import LOGIN_REQUIRED, Registry, ToolContext, build_registry
from tests.fakes import FakeApi, settings

ALICE = Auth(user_id="u-alice", name="Alice", token="tok-alice")
REGISTRY = build_registry()
READ_ONLY = {"search_products", "get_product", "get_recommendations", "list_categories",
             "search_faq", "view_cart", "list_orders", "get_order"}

JACKET = {
    "id": "p1", "slug": "rain-jacket", "name": "Rain Jacket", "brand": "Acme",
    "category": "outerwear", "price": "$79.00", "priceCents": 7900, "inStock": True,
    "stock": 4, "rating": 4.5, "description": "Waterproof. " * 50, "images": ["a.jpg"],
}
CART = {
    "itemCount": 1, "couponCode": None, "subtotal": "$79.00", "subtotalCents": 7900,
    "discount": "$0.00", "shipping": "$5.00", "total": "$84.00", "totalCents": 8400,
    "freeShippingRemaining": "$21.00",
    "items": [{"productId": "p1", "name": "Rain Jacket", "quantity": 1, "unitPrice": "$79.00",
               "unitPriceCents": 7900, "lineTotal": "$79.00", "inStock": True}],
}
ORDER = {
    "orderNumber": "ORD-1001", "status": "delivered", "placedAt": "2026-10-20", "total": "$84.00",
    "itemCount": 1, "carrier": "UPS", "trackingNumber": "1Z", "shippedAt": "2026-10-21",
    "deliveredAt": "2026-10-24", "returnEligible": True, "returnDeadline": "2026-11-23",
    "subtotal": "$79.00", "discount": "$0.00", "shipping": "$5.00", "couponCode": None,
    "shippingAddress": {"line1": "1 Main St"},
    "items": [{"orderItemId": "oi1", "productId": "p1", "name": "Rain Jacket", "quantity": 1,
               "unitPrice": "$79.00", "unitPriceCents": 7900}],
    "returns": [],
}


async def run(name: str, args: dict[str, Any], api: FakeApi, auth: Auth = ALICE) -> Any:
    tool = REGISTRY.get(name)
    assert tool is not None
    client = CommerceClient(settings(), api.http())
    try:
        return await tool.run(args, ToolContext(auth, "conv-1", client, settings()))
    finally:
        await client.aclose()


# --- registry --------------------------------------------------------------------

def test_guests_only_see_tools_that_need_no_login() -> None:
    guest = {t["name"] for t in REGISTRY.schemas(GUEST)}
    assert guest == {"search_products", "get_product", "get_recommendations",
                     "list_categories", "search_faq", "create_support_ticket"}
    assert guest < {t["name"] for t in REGISTRY.schemas(ALICE)}


def test_read_only_tools_are_not_confirm_first_and_writes_to_staff_are() -> None:
    for name in READ_ONLY:
        tool = REGISTRY.get(name)
        assert tool is not None and not tool.confirm, name
    for name in ("create_return", "create_support_ticket"):
        tool = REGISTRY.get(name)
        assert tool is not None and tool.confirm, name


def test_schema_order_is_stable_and_names_are_unique() -> None:
    assert REGISTRY.schemas(ALICE) == build_registry().schemas(ALICE)
    tool = REGISTRY.get("view_cart")
    assert tool is not None
    with pytest.raises(ValueError, match="duplicate"):
        Registry([tool, tool])


def test_schemas_have_no_titles_and_forbid_extra_fields() -> None:
    for schema in REGISTRY.schemas(ALICE):
        assert "title" not in schema["input_schema"]
        assert schema["input_schema"].get("additionalProperties") is False, schema["name"]


# --- validation and errors -------------------------------------------------------

async def test_login_only_tool_returns_login_required_for_guests_without_calling_api() -> None:
    api = FakeApi()
    out = await run("view_cart", {}, api, auth=GUEST)
    assert out.for_model == LOGIN_REQUIRED and out.is_error
    assert api.requests == []


async def test_invalid_arguments_go_back_to_the_model() -> None:
    api = FakeApi()
    out = await run("search_products", {"limit": 99, "admin": True}, api)
    assert out.is_error and out.for_model["error"]["status"] == 422
    message = out.for_model["error"]["message"]
    assert "limit" in message and "admin" in message
    assert api.requests == []


async def test_api_errors_pass_through_the_shopper_facing_message() -> None:
    api = FakeApi({"GET orders/ORD-9999": lambda _: httpx.Response(
        404, json={"statusCode": 404, "message": "We couldn't find that order"})})
    out = await run("get_order", {"orderNumber": "ORD-9999"}, api)
    assert out.is_error
    assert out.for_model == {"error": {"status": 404, "message": "We couldn't find that order"}}


async def test_expired_token_becomes_login_required() -> None:
    api = FakeApi({"GET cart": lambda _: httpx.Response(401, json={"message": "Unauthorized"})})
    out = await run("view_cart", {}, api)
    assert out.for_model == LOGIN_REQUIRED


# --- catalog ---------------------------------------------------------------------

async def test_search_products_trims_results_and_keeps_the_full_card() -> None:
    api = FakeApi({"GET products": {"total": 1, "items": [JACKET]}})
    out = await run("search_products", {"q": "jacket", "inStock": True, "maxPriceCents": 10000},
                    api)
    item = out.for_model["items"][0]
    assert out.for_model["total"] == 1
    assert set(item) == {"id", "slug", "name", "brand", "category", "price", "inStock",
                         "stock", "rating", "description"}
    assert len(item["description"]) == 300
    assert out.card == {"type": "product_list", "data": {"total": 1, "items": [JACKET]}}
    params = api.requests[0].url.params
    assert params["q"] == "jacket" and params["inStock"] == "true"
    assert params["maxPriceCents"] == "10000" and "category" not in params


async def test_empty_search_has_no_card() -> None:
    out = await run("search_products", {"q": "unicorn"},
                    FakeApi({"GET products": {"total": 0, "items": []}}))
    assert out.for_model == {"total": 0, "items": []} and out.card is None


async def test_get_product_includes_attributes() -> None:
    api = FakeApi({"GET products/rain-jacket": JACKET | {"attributes": {"color": "blue"}}})
    out = await run("get_product", {"idOrSlug": "rain-jacket"}, api)
    assert out.for_model["attributes"] == {"color": "blue"}
    assert "priceCents" not in out.for_model and out.card is not None


async def test_model_supplied_ids_cannot_change_the_route() -> None:
    api = FakeApi()
    await run("get_product", {"idOrSlug": "../orders/ORD-1001"}, api)
    await run("get_order", {"orderNumber": "../../admin?x=1"}, api)
    assert api.calls == ["GET products/..%2Forders%2FORD-1001",
                         "GET orders/..%2F..%2Fadmin%3Fx%3D1"]


async def test_recommendations_and_categories() -> None:
    api = FakeApi({
        "GET products/p1/recommendations": {"basedOn": "p1", "items": [JACKET]},
        "GET categories": [{"slug": "outerwear", "name": "Outerwear"}],
    })
    recs = await run("get_recommendations", {"idOrSlug": "p1"}, api)
    cats = await run("list_categories", {}, api)
    assert recs.for_model["basedOn"] == "p1" and recs.for_model["items"][0]["id"] == "p1"
    assert cats.for_model == {"categories": [{"slug": "outerwear", "name": "Outerwear"}]}


# --- faq -------------------------------------------------------------------------

async def test_search_faq_returns_only_question_and_answer() -> None:
    api = FakeApi({"GET faq/search": {"results": [
        {"id": "f1", "topic": "returns", "question": "Window?", "answer": "30 days.",
         "score": 0.9, "updatedAt": "2026-01-01"},
    ]}})
    out = await run("search_faq", {"q": "return window", "topic": "returns"}, api)
    assert out.for_model == {"results": [
        {"topic": "returns", "question": "Window?", "answer": "30 days."}]}
    assert api.requests[0].url.params["topic"] == "returns"


async def test_search_faq_rejects_unknown_topics() -> None:
    out = await run("search_faq", {"q": "x", "topic": "admin"}, FakeApi())
    assert out.is_error


# --- cart ------------------------------------------------------------------------

async def test_view_cart_gives_the_model_formatted_money_only() -> None:
    out = await run("view_cart", {}, FakeApi({"GET cart": CART}))
    assert out.for_model["total"] == "$84.00"
    assert "Cents" not in str(out.for_model)
    assert out.card == {"type": "cart", "data": CART}


async def test_checkout_link_points_at_the_storefront_without_calling_the_api() -> None:
    api = FakeApi()
    out = await run("checkout_link", {}, api)
    assert out.for_model["url"] == "http://localhost:8080/cart"
    assert api.requests == []


# --- orders ----------------------------------------------------------------------

async def test_list_orders_returns_summaries() -> None:
    out = await run("list_orders", {}, FakeApi({"GET orders": [ORDER]}))
    summary = out.for_model["orders"][0]
    assert summary["orderNumber"] == "ORD-1001" and summary["returnEligible"] is True
    assert "items" not in summary and "shippingAddress" not in summary
    assert out.card is not None and out.card["type"] == "order_list"


async def test_get_order_includes_item_ids_but_not_the_address() -> None:
    out = await run("get_order", {"orderNumber": "ORD-1001"},
                    FakeApi({"GET orders/ORD-1001": ORDER}))
    assert out.for_model["items"] == [{"orderItemId": "oi1", "productId": "p1",
                                       "name": "Rain Jacket", "quantity": 1,
                                       "unitPrice": "$79.00"}]
    assert "shippingAddress" not in out.for_model
    assert out.card == {"type": "order", "data": ORDER}


# --- commerce client -------------------------------------------------------------

async def test_client_sends_the_shopper_jwt_and_agent_headers() -> None:
    api = FakeApi({"GET cart": CART})
    await run("view_cart", {}, api)
    headers = api.requests[0].headers
    assert headers["Authorization"] == "Bearer tok-alice"
    assert headers["X-Client"] == "ai-agent"
    assert headers["X-Conversation-Id"] == "conv-1"
    assert headers["X-Service-Token"] == "t" * 32
    assert headers["X-Request-Id"]


async def test_guest_requests_carry_no_authorization() -> None:
    api = FakeApi({"GET products": {"total": 0, "items": []}})
    await run("search_products", {"q": "x"}, api, auth=GUEST)
    assert "Authorization" not in api.requests[0].headers


@pytest.fixture
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    async def sleep(_: float) -> None:
        return None

    monkeypatch.setattr("asyncio.sleep", sleep)  # retry backoff in commerce_client


@pytest.mark.usefixtures("no_backoff")
async def test_reads_retry_on_5xx_and_then_give_up_with_a_friendly_error() -> None:
    statuses = iter([503, 200])
    api = FakeApi({"GET cart": lambda _: httpx.Response(next(statuses), json=CART)})
    out = await run("view_cart", {}, api)
    assert not out.is_error and len(api.requests) == 2

    down = FakeApi({"GET cart": lambda _: httpx.Response(503, json={})})
    out = await run("view_cart", {}, down)
    assert len(down.requests) == 3
    assert out.for_model["error"]["status"] == 503


@pytest.mark.usefixtures("no_backoff")
async def test_writes_retry_only_with_an_idempotency_key() -> None:
    api = FakeApi({"POST returns": lambda _: httpx.Response(503, json={})})
    client = CommerceClient(settings(), api.http())
    with pytest.raises(ApiError):
        await client.request("POST", "returns", auth=ALICE, json={})
    assert len(api.requests) == 1
    with pytest.raises(ApiError):
        await client.request("POST", "returns", auth=ALICE, json={}, idempotency_key="k1")
    assert len(api.requests) == 4
    assert api.requests[-1].headers["Idempotency-Key"] == "k1"
    await client.aclose()


@pytest.mark.usefixtures("no_backoff")
async def test_transport_errors_become_a_store_unavailable_message() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    http = httpx.AsyncClient(base_url="http://api/", transport=httpx.MockTransport(boom))
    client = CommerceClient(settings(), http)
    with pytest.raises(ApiError) as exc:
        await client.request("GET", "cart", auth=ALICE)
    assert exc.value.status == 503 and "not responding" in exc.value.message
    await client.aclose()


async def test_validation_error_lists_are_joined() -> None:
    api = FakeApi({"POST cart/coupon": lambda _: httpx.Response(
        400, json={"message": ["code must be shorter", "code is required"]})})
    out = await run("apply_coupon", {"code": "X"}, api)
    assert out.for_model["error"]["message"] == "code must be shorter; code is required"

