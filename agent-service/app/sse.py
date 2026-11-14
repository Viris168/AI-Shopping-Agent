"""Server-sent events: encoding and running a turn behind a streaming response.

Events (ARCHITECTURE.md §4.2): meta, text_delta, card, confirm_request, handoff, memory, error,
done.
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Literal

from fastapi.responses import StreamingResponse

from app import telemetry
from app.llm import ModelUnavailable

EventName = Literal[
    "meta", "text_delta", "card", "confirm_request", "handoff", "memory", "error", "done"
]
Emit = Callable[[EventName, dict[str, Any]], None]

log = logging.getLogger(__name__)


def encode(event: EventName, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'), default=str)}\n\n"


def sse_response(
    run: Callable[[Emit], Awaitable[None]], *, timeout_s: float, route: str
) -> StreamingResponse:
    """Run `run(emit)` in a task and stream whatever it emits until it finishes.

    Owns the turn's root span and the turn-level metrics: first-token latency, turn latency,
    error codes and open streams (`route` is the metric label: chat or confirm).
    """
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    watch = telemetry.Stopwatch()
    seen_text = False
    error_code: str | None = None

    def emit(event: EventName, data: dict[str, Any]) -> None:
        nonlocal seen_text, error_code
        if event == "text_delta" and not seen_text:
            seen_text = True
            telemetry.first_token.record(watch.elapsed, {"route": route})
        elif event == "error":
            error_code = str(data.get("code"))
        queue.put_nowait(encode(event, data))

    def fail(code: str, message: str) -> None:
        emit("error", {"code": code, "message": message, "retryable": True})
        emit("done", {})

    async def worker() -> None:
        with telemetry.span(f"turn {route}", route=route) as span:
            cancelled = False
            try:
                async with asyncio.timeout(timeout_s):
                    await run(emit)
            except TimeoutError:
                fail("timeout", "That took too long. Please try again, or ask for a person.")
            except ModelUnavailable:
                log.warning("model unavailable")
                fail("model_unavailable", "The assistant can't answer right now.")
            except asyncio.CancelledError:
                cancelled = True  # the shopper closed the stream; not a server error
                raise
            except Exception:
                log.exception("turn failed")
                fail("internal", "Something went wrong on our side. Please try again.")
            finally:
                queue.put_nowait(None)
                outcome = "cancelled" if cancelled else error_code or "ok"
                if error_code and not cancelled:
                    telemetry.mark_error(span, error_code)
                    telemetry.turn_errors.add(
                        1, telemetry.grouped({"route": route, "error.type": error_code})
                    )
                telemetry.turn_duration.record(watch.elapsed, {"route": route, "outcome": outcome})

    async def body() -> AsyncIterator[str]:
        telemetry.active_streams.add(1, {"route": route})
        task = asyncio.create_task(worker())
        try:
            while (chunk := await queue.get()) is not None:
                yield chunk
        finally:
            telemetry.active_streams.add(-1, {"route": route})
            if not task.done():
                task.cancel()  # client went away

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
