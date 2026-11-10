"""Poll the model provider's prepaid balance for the low-balance alert (PLAN-19 M7).

DeepSeek is prepaid: at $0 every call fails and shoppers get the fallback card. Its
`GET /user/balance` is free; the result goes to the `agent.provider.balance` gauge, and
AgentProviderBalanceLow fires before it runs out. Anthropic has no such endpoint, so this only
runs with a DeepSeek base URL.
"""

import asyncio
import logging
from urllib.parse import urlsplit

import httpx

from app import telemetry
from app.config import Settings

log = logging.getLogger(__name__)

INTERVAL_S = 900


def balance_url(settings: Settings) -> str | None:
    """DeepSeek's balance endpoint, or None when the provider isn't DeepSeek."""
    base = settings.anthropic_base_url or ""
    parts = urlsplit(base)
    if parts.hostname != "api.deepseek.com":
        return None
    return f"{parts.scheme}://{parts.netloc}/user/balance"


def parse_usd(body: dict[str, object]) -> float | None:
    infos = body.get("balance_infos")
    if not isinstance(infos, list):
        return None
    for info in infos:
        if isinstance(info, dict) and info.get("currency") == "USD":
            try:
                return float(str(info.get("total_balance")))
            except ValueError:
                return None
    return None


async def fetch(settings: Settings, http: httpx.AsyncClient) -> float | None:
    url, key = balance_url(settings), settings.anthropic_api_key
    if url is None or key is None:
        return None
    resp = await http.get(url, headers={"Authorization": f"Bearer {key.get_secret_value()}"})
    resp.raise_for_status()
    return parse_usd(resp.json())


async def poll(settings: Settings) -> None:
    """Runs until cancelled (app lifespan). Failures are logged and retried next interval."""
    async with httpx.AsyncClient(timeout=10) as http:
        while True:
            try:
                usd = await fetch(settings, http)
                if usd is not None:
                    telemetry.set_provider_balance(usd)
            except Exception as exc:  # never let the poller take the app down
                log.warning("provider balance check failed: %s", type(exc).__name__)
            await asyncio.sleep(INTERVAL_S)
