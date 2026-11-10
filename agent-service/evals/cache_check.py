"""How the provider counts cache hits (PLAN-19 M2 step 6).

    python -m evals.cache_check

Sends the same long prompt to the main model twice and prints the raw `usage` both times. On
Anthropic's API `input_tokens` excludes cache reads; app/usage.py assumes the same. If the second
call shows `input_tokens` still about as large as the first while `cache_read_input_tokens` rises,
the provider counts cache hits inside `input_tokens`, and `estimate_cost` must subtract them.
Compare the two calls with the charge on the provider's usage page, too.

Costs two small calls on MODEL_MAIN (about 3k input tokens each).
"""

import asyncio
import json

from anthropic import AsyncAnthropic

from app.config import get_settings
from app.llm import NO_THINKING

# Long and fixed, so the second call can hit the prefix cache (providers cache in blocks of
# 64–1024 tokens).
PREFIX = "Reference catalog, ignore unless asked.\n" + "\n".join(
    f"Item {i}: a sturdy everyday product with a plain description number {i}." for i in range(200)
)


async def main() -> None:
    s = get_settings()
    key = s.anthropic_api_key
    client = AsyncAnthropic(api_key=key.get_secret_value() if key else None,
                            base_url=s.anthropic_base_url or None, timeout=s.model_timeout_s)
    for attempt in (1, 2):
        resp = await client.messages.create(
            model=s.model_main, max_tokens=16, thinking=NO_THINKING,
            system=[{"type": "text", "text": PREFIX, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": "Reply with the word OK."}],
        )
        print(f"call {attempt} ({resp.model}):",
              json.dumps(resp.usage.model_dump(exclude_none=True), indent=2))
        await asyncio.sleep(2)  # give the provider's cache a moment


if __name__ == "__main__":
    asyncio.run(main())
