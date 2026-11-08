"""Server-sent events: encoding and running a turn behind a streaming response.

Events (ARCHITECTURE.md §4.2): meta, text_delta, card, confirm_request, handoff, error, done.
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Literal

from fastapi.responses import StreamingResponse

EventName = Literal[
    "meta", "text_delta", "card", "confirm_request", "handoff", "error", "done"
]
Emit = Callable[[EventName, dict[str, Any]], None]

log = logging.getLogger(__name__)


def encode(event: EventName, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'), default=str)}\n\n"


def sse_response(
    run: Callable[[Emit], Awaitable[None]], *, timeout_s: float
) -> StreamingResponse:
    """Run `run(emit)` in a task and stream whatever it emits until it finishes."""
    queue: asyncio.Queue[str | None] = asyncio.Queue()

    def emit(event: EventName, data: dict[str, Any]) -> None:
        queue.put_nowait(encode(event, data))

    async def worker() -> None:
        try:
            async with asyncio.timeout(timeout_s):
                await run(emit)
        except TimeoutError:
            emit("error", {
                "code": "timeout",
                "message": "That took too long. Please try again, or ask for a person.",
                "retryable": True,
            })
            emit("done", {})
        except Exception:
            log.exception("turn failed")
            emit("error", {
                "code": "internal",
                "message": "Something went wrong on our side. Please try again.",
                "retryable": True,
            })
            emit("done", {})
        finally:
            queue.put_nowait(None)

    async def body() -> AsyncIterator[str]:
        task = asyncio.create_task(worker())
        try:
            while (chunk := await queue.get()) is not None:
                yield chunk
        finally:
            if not task.done():
                task.cancel()  # client went away

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
