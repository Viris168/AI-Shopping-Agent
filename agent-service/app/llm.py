"""Model client (DeepSeek via its Anthropic-compatible API by default): model routing, prompt
caching, streaming. All model calls go through here."""

import base64
import json
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from functools import cache
from pathlib import Path
from typing import Any

from anthropic import APIError, APIStatusError, AsyncAnthropic
from anthropic.types import Message, MessageParam, ThinkingConfigDisabledParam
from opentelemetry.trace import Span

from app import telemetry, usage
from app.config import ModelPrice, Settings
from app.masking import mask_text

log = logging.getLogger(__name__)

SUMMARY_PROMPT = (
    "Summarise this shopping-assistant conversation for the assistant's own memory. "
    "Keep order numbers, product IDs, cart changes, open questions and pending decisions. "
    "Do not include email addresses, phone numbers or addresses. Max 150 words.\n\n"
    "Previous summary:\n{previous}\n\nConversation:\n{transcript}"
)


@cache
def _describe_prompt() -> str:
    return (Path(__file__).parent / "prompts" / "image_describe.md").read_text(encoding="utf-8")


# DeepSeek thinks by default, and thinking counts against max_tokens: a short reply budget can
# be spent before any text (empty replies, empty grader output). Claude is off by default too.
NO_THINKING: ThinkingConfigDisabledParam = {"type": "disabled"}


class ModelUnavailable(Exception):
    """The model API failed after the SDK's own retries. The widget shows its fallback card.
    `transient`: worth trying another model (overload, rate limit, 5xx, network), unlike a
    bad key, an empty balance or a bad request, which another model on the same account
    won't fix."""

    def __init__(self, error: str, transient: bool = False) -> None:
        super().__init__(error)
        self.transient = transient


def _transient(exc: APIError) -> bool:
    if isinstance(exc, APIStatusError):
        return exc.status_code in (408, 409, 429) or exc.status_code >= 500
    return True  # connection error or timeout


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
            raise ModelUnavailable(error, _transient(exc)) from exc
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

        On MODEL_MAIN; if that fails for a transient reason before any text was sent, the same
        call once on MODEL_FAST, so a provider hiccup costs a slower or plainer reply instead
        of the fallback card. After text has streamed, a retry would repeat it, so it raises.
        A routed (`fast`) call doesn't fall back here: the loop redoes it on MODEL_MAIN.
        """
        sent = False

        def watch(text: str) -> None:
            nonlocal sent
            sent = True
            on_text(text)

        if fast:
            return await self._stream(self._s.model_fast, system, messages, tools, on_text)
        try:
            return await self._stream(self._s.model_main, system, messages, tools, watch)
        except ModelUnavailable as exc:
            fast_model = self._s.model_fast
            if sent or not exc.transient or fast_model == self._s.model_main:
                raise
            log.warning("model_fallback %s -> %s after %s", self._s.model_main, fast_model, exc)
            telemetry.model_fallbacks.add(1, {
                "gen_ai.request.model": self._s.model_main, "error.type": str(exc),
            })
            return await self._stream(fast_model, system, messages, tools, on_text)

    async def _stream(
        self, model: str, system: list[dict[str, Any]], messages: list[MessageParam],
        tools: list[dict[str, Any]], on_text: Callable[[str], None],
    ) -> Message:
        """Caching: tools render before system, so the breakpoint on the static system
        block caches tools + static prompt. Put per-request text after it. DeepSeek ignores
        cache_control and caches prompt prefixes on its own."""
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

    async def describe_image(self, jpeg: bytes) -> tuple[str, int]:
        """The fast model's description of a shopper's photo (app/images.py): its raw reply and
        the tokens it used (for the token budget).
        Only MODEL_FAST: the main model can't see images, so there's no fallback. The photo goes
        to the provider and nowhere else: not on the span, not in logs."""
        model = self._s.model_fast
        async with _observed("describe", model) as span:
            resp = await self._client.with_options(timeout=self._s.image_timeout_s).messages.create(
                model=model,
                max_tokens=700,
                thinking=NO_THINKING,
                system=_describe_prompt(),
                messages=[{"role": "user", "content": [
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/jpeg",
                        "data": base64.b64encode(jpeg).decode(),
                    }},
                    {"type": "text", "text": "Describe this image."},
                ]}],
            )
            _record_usage(span, "describe", "image_describe", resp, self._price(model, resp))
        text = "".join(b.text for b in resp.content if b.type == "text")
        return text, resp.usage.input_tokens + resp.usage.output_tokens

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
