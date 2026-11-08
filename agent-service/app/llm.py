"""Claude client: model routing, prompt caching, streaming. All model calls go through here."""

import json
from collections.abc import Callable
from typing import Any

from anthropic import AsyncAnthropic
from anthropic.types import Message, MessageParam

from app.config import Settings
from app.masking import mask_text

SUMMARY_PROMPT = (
    "Summarise this shopping-assistant conversation for the assistant's own memory. "
    "Keep order numbers, product IDs, cart changes, open questions and pending decisions. "
    "Do not include email addresses, phone numbers or addresses. Max 150 words.\n\n"
    "Previous summary:\n{previous}\n\nConversation:\n{transcript}"
)


class LLM:
    def __init__(self, settings: Settings, client: AsyncAnthropic | None = None) -> None:
        self._s = settings
        key = settings.anthropic_api_key
        self._client = client or AsyncAnthropic(
            api_key=key.get_secret_value() if key else None,
            timeout=settings.model_timeout_s,
            max_retries=2,
        )

    async def stream(
        self,
        *,
        system: list[dict[str, Any]],
        messages: list[MessageParam],
        tools: list[dict[str, Any]],
        on_text: Callable[[str], None],
    ) -> Message:
        """One main-model call, streaming text deltas. Returns the complete message.

        Caching: tools render before system, so the breakpoint on the static system
        block caches tools + static prompt. Put per-request text after it.
        """
        kwargs: dict[str, Any] = {
            "model": self._s.model_main,
            "max_tokens": self._s.max_output_tokens,
            "system": system,
            "messages": messages,
            "tools": tools,
        }
        if self._s.claude_effort:
            kwargs["output_config"] = {"effort": self._s.claude_effort}
        async with self._client.messages.stream(**kwargs) as stream:
            async for event in stream:
                if event.type == "text":
                    on_text(event.text)
            return await stream.get_final_message()

    async def summarise(self, previous: str | None, messages: list[dict[str, Any]]) -> str:
        transcript = mask_text(json.dumps(messages, ensure_ascii=False))[:60_000]
        resp = await self._client.messages.create(
            model=self._s.model_fast,
            max_tokens=512,
            messages=[{"role": "user", "content": SUMMARY_PROMPT.format(
                previous=previous or "(none)", transcript=transcript
            )}],
        )
        return "".join(b.text for b in resp.content if b.type == "text").strip()

    async def complete_fast(self, prompt: str, max_tokens: int = 256) -> str:
        """Small one-shot call on the fast model (eval grading, ticket summaries)."""
        resp = await self._client.messages.create(
            model=self._s.model_fast,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(b.text for b in resp.content if b.type == "text").strip()
