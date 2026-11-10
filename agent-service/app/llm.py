"""Model client (DeepSeek via its Anthropic-compatible API by default): model routing, prompt
caching, streaming. All model calls go through here."""

import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

from anthropic import APIError, APIStatusError, AsyncAnthropic
from anthropic.types import Message, MessageParam, ThinkingConfigDisabledParam
from opentelemetry.trace import Span

from app import telemetry, usage
from app.config import ModelPrice, Settings
from app.masking import mask_text

SUMMARY_PROMPT = (
    "Summarise this shopping-assistant conversation for the assistant's own memory. "
    "Keep order numbers, product IDs, cart changes, open questions and pending decisions. "
    "Do not include email addresses, phone numbers or addresses. Max 150 words.\n\n"
    "Previous summary:\n{previous}\n\nConversation:\n{transcript}"
)

# DeepSeek thinks by default, and thinking counts against max_tokens: a short reply budget can
# be spent before any text (empty replies, empty grader output). Claude is off by default too.
NO_THINKING: ThinkingConfigDisabledParam = {"type": "disabled"}


class ModelUnavailable(Exception):
    """The model API failed after the SDK's own retries. The widget shows its fallback card."""


def _error_type(exc: APIError) -> str:
    if isinstance(exc, APIStatusError):
        return str(exc.status_code)
    return type(exc).__name__


@asynccontextmanager
async def _observed(operation: str, model: str) -> AsyncIterator[Span]:
    """Span + metrics for one model call (GenAI semantic-convention attribute names)."""
    attrs = {"gen_ai.operation.name": operation, "gen_ai.request.model": model}
    watch = telemetry.Stopwatch()
    with telemetry.span(f"{operation} {model}", **attrs) as span:
        try:
            yield span
        except APIError as exc:
            error = _error_type(exc)
            telemetry.mark_error(span, error)
            telemetry.model_calls.add(1, {**attrs, "status": "error", "error.type": error})
            telemetry.model_duration.record(watch.elapsed, {**attrs, "status": "error"})
            raise ModelUnavailable(error) from exc
        telemetry.model_calls.add(1, {**attrs, "status": "ok"})
        telemetry.model_duration.record(watch.elapsed, {**attrs, "status": "ok"})


def _record_usage(
    span: Span, operation: str, purpose: str, resp: Message, price: ModelPrice | None
) -> None:
    """Tokens and estimated cost on the span, the metrics and any open usage tally.
    `purpose` says what the call was for (`chat`, `summarise`, `memory_extract`, `eval_grade`)."""
    u = resp.usage
    cache_read = u.cache_read_input_tokens or 0
    cost = usage.estimate_cost(price, u.input_tokens, cache_read, u.output_tokens)
    span.set_attribute("gen_ai.usage.input_tokens", u.input_tokens)
    span.set_attribute("gen_ai.usage.output_tokens", u.output_tokens)
    span.set_attribute("agent.purpose", purpose)
    if cost is not None:
        span.set_attribute("agent.cost_usd", cost)
    if resp.stop_reason:
        span.set_attribute("gen_ai.response.finish_reasons", [resp.stop_reason])
    attrs = telemetry.grouped({"gen_ai.operation.name": operation,
                               "gen_ai.request.model": resp.model, "agent.purpose": purpose})
    for kind, n in (("input", u.input_tokens), ("output", u.output_tokens),
                    ("cache_read", cache_read)):
        telemetry.model_tokens.add(n, {**attrs, "gen_ai.token.type": kind})
    if cost is not None:
        telemetry.model_cost.add(cost, attrs)
    usage.record(purpose, resp.model, usage.Counts(
        calls=1, input=u.input_tokens, output=u.output_tokens, cache_read=cache_read,
        cost_usd=cost or 0.0, unpriced_calls=int(cost is None),
    ))


class LLM:
    def __init__(self, settings: Settings, client: AsyncAnthropic | None = None) -> None:
        self._s = settings
        key = settings.anthropic_api_key
        self._client = client or AsyncAnthropic(
            api_key=key.get_secret_value() if key else None,
            base_url=settings.anthropic_base_url or None,
            timeout=settings.model_timeout_s,
            max_retries=2,
        )

    def _price(self, requested: str, resp: Message) -> ModelPrice | None:
        """The provider may answer with a dated model ID; fall back to the one we asked for."""
        prices = self._s.model_prices
        return prices.get(resp.model) or prices.get(requested)

    async def stream(
        self,
        *,
        system: list[dict[str, Any]],
        messages: list[MessageParam],
        tools: list[dict[str, Any]],
        on_text: Callable[[str], None],
        fast: bool = False,
    ) -> Message:
        """One chat call, streaming text deltas. Returns the complete message. `fast` uses
        MODEL_FAST instead of MODEL_MAIN (model routing, app/routing.py).

        Caching: tools render before system, so the breakpoint on the static system
        block caches tools + static prompt. Put per-request text after it. DeepSeek ignores
        cache_control and caches prompt prefixes on its own.
        """
        model = self._s.model_fast if fast else self._s.model_main
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": self._s.max_output_tokens,
            "system": system,
            "messages": messages,
            "tools": tools,
            "thinking": NO_THINKING,
        }
        if self._s.claude_effort:
            kwargs["output_config"] = {"effort": self._s.claude_effort}
        async with _observed("chat", model) as span:
            async with self._client.messages.stream(**kwargs) as stream:
                async for event in stream:
                    if event.type == "text":
                        on_text(event.text)
                message = await stream.get_final_message()
            _record_usage(span, "chat", "chat", message, self._price(model, message))
            return message

    async def summarise(self, previous: str | None, messages: list[dict[str, Any]]) -> str:
        transcript = mask_text(json.dumps(messages, ensure_ascii=False))[:60_000]
        async with _observed("summarise", self._s.model_fast) as span:
            resp = await self._client.messages.create(
                model=self._s.model_fast,
                max_tokens=512,
                thinking=NO_THINKING,
                messages=[{"role": "user", "content": SUMMARY_PROMPT.format(
                    previous=previous or "(none)", transcript=transcript
                )}],
            )
            _record_usage(span, "summarise", "summarise", resp,
                          self._price(self._s.model_fast, resp))
        return "".join(b.text for b in resp.content if b.type == "text").strip()

    async def complete_fast(
        self, prompt: str, max_tokens: int = 256, purpose: str = "complete"
    ) -> str:
        """Small one-shot call on the fast model (memory extraction, eval grading). `purpose`
        labels its tokens and cost."""
        async with _observed("complete", self._s.model_fast) as span:
            resp = await self._client.messages.create(
                model=self._s.model_fast,
                max_tokens=max_tokens,
                thinking=NO_THINKING,
                messages=[{"role": "user", "content": prompt}],
            )
            _record_usage(span, "complete", purpose, resp,
                          self._price(self._s.model_fast, resp))
        return "".join(b.text for b in resp.content if b.type == "text").strip()
