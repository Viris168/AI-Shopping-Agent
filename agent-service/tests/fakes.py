"""Test doubles: a scripted model and an in-process commerce-api."""

import json
from collections.abc import Callable
from typing import Any

import httpx
from anthropic.types import Message, TextBlock, ToolUseBlock, Usage

from app.config import Settings

API_BASE = "http://api/api/v1/"


def settings(**overrides: Any) -> Settings:
    return Settings(_env_file=None, service_token="t" * 32, **overrides)


def text(value: str) -> TextBlock:
    return TextBlock(type="text", text=value)


def tool_use(name: str, args: dict[str, Any], call_id: str = "t1") -> ToolUseBlock:
    return ToolUseBlock(id=call_id, type="tool_use", name=name, input=args)


def message(*content: TextBlock | ToolUseBlock, stop_reason: str | None = None) -> Message:
    return Message(
        id="msg", type="message", role="assistant", model="fake", content=list(content),
        stop_reason=stop_reason
        or ("tool_use" if isinstance(content[-1], ToolUseBlock) else "end_turn"),
        usage=Usage(input_tokens=1, output_tokens=1),
    )


class FakeLLM:
    """Plays scripted responses and keeps every request, so tests can see the model's input."""

    def __init__(self, *responses: Message) -> None:
        self.responses = list(responses)
        self.calls: list[list[Any]] = []
        self.systems: list[list[dict[str, Any]]] = []

    async def stream(self, *, system: list[dict[str, Any]], messages: list[Any],
                     on_text: Callable[[str], None], **_: Any) -> Message:
        self.systems.append(system)
        self.calls.append(json.loads(json.dumps(messages)))
        resp = self.responses.pop(0)
        for block in resp.content:
            if isinstance(block, TextBlock):
                on_text(block.text)
        return resp

    async def summarise(self, previous: str | None, messages: list[Any]) -> str:
        return ""


Route = Callable[[httpx.Request], httpx.Response]


class FakeApi:
    """Maps "METHOD path" (relative to /api/v1/) to a JSON body or handler; records requests."""

    def __init__(self, routes: dict[str, Any] | None = None) -> None:
        self.routes = routes or {}
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.raw_path.decode().split("?")[0].removeprefix("/api/v1/")
        route = self.routes.get(f"{request.method} {path}")
        if route is None:
            return httpx.Response(404, json={"message": "Not found"})
        if callable(route):
            response: httpx.Response = route(request)
            return response
        return httpx.Response(200, json=route)

    @property
    def calls(self) -> list[str]:
        return [
            f"{r.method} {r.url.raw_path.decode().split('?')[0].removeprefix('/api/v1/')}"
            for r in self.requests
        ]

    def http(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=API_BASE, transport=httpx.MockTransport(self))
