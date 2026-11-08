"""HTTP client for commerce-api. Every agent call goes through here.

Always sends the shopper's own JWT (never a privileged credential), the agent
headers that `AgentAuditInterceptor` keys on, and the incoming request's ID, so commerce-api's
log lines for one chat turn share the agent's `X-Request-Id`.
"""

import asyncio
import logging
from typing import Any
from urllib.parse import quote

import httpx

from app import telemetry
from app.auth import Auth
from app.config import Settings

log = logging.getLogger(__name__)

RETRY_STATUS = {429, 500, 502, 503, 504}
MAX_RETRIES = 2


class ApiError(Exception):
    """A commerce-api error; `message` is written for shoppers and safe to show."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message


def seg(value: str) -> str:
    """Encode one path segment so model-supplied IDs can't change the route (`../orders`)."""
    return quote(value, safe="")


def _error_message(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return "The store couldn't handle that request."
    message = body.get("message") if isinstance(body, dict) else None
    if isinstance(message, list):  # class-validator returns a list
        message = "; ".join(str(m) for m in message)
    return str(message) if message else "The store couldn't handle that request."


class CommerceClient:
    def __init__(self, settings: Settings, http: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._http = http or httpx.AsyncClient(
            base_url=settings.commerce_api_url.rstrip("/") + "/",
            timeout=settings.commerce_timeout_s,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        auth: Auth,
        conversation_id: str | None = None,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        headers = {
            "Accept": "application/json",
            "X-Client": "ai-agent",
            "X-Request-Id": telemetry.request_id(),
        }
        if self._settings.service_token is not None:
            headers["X-Service-Token"] = self._settings.service_token.get_secret_value()
        if auth.token:
            headers["Authorization"] = f"Bearer {auth.token}"
        if conversation_id:
            headers["X-Conversation-Id"] = conversation_id
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        if params:
            params = {k: _query_value(v) for k, v in params.items() if v is not None}

        # Reads are always safe to retry; writes only with an idempotency key.
        retryable = method == "GET" or idempotency_key is not None
        # Span name stays low-cardinality; the path (order numbers, product IDs) is an attribute.
        with telemetry.span(f"commerce-api {method}", **{
            "http.request.method": method, "url.path": path,
        }) as span:
            attempt = 0
            while True:
                try:
                    resp = await self._http.request(
                        method, path.lstrip("/"), headers=headers, params=params, json=json
                    )
                except httpx.TransportError as exc:
                    if retryable and attempt < MAX_RETRIES:
                        attempt += 1
                        await asyncio.sleep(0.25 * 2**attempt)
                        continue
                    log.warning("commerce-api %s %s failed: %s", method, path, type(exc).__name__)
                    telemetry.mark_error(span, type(exc).__name__)
                    raise ApiError(503, "The store is not responding right now.") from exc

                if resp.status_code in RETRY_STATUS and retryable and attempt < MAX_RETRIES:
                    attempt += 1
                    await asyncio.sleep(0.25 * 2**attempt)
                    continue
                span.set_attribute("http.response.status_code", resp.status_code)
                span.set_attribute("http.request.resend_count", attempt)
                if resp.is_error:
                    if resp.status_code >= 500:
                        telemetry.mark_error(span, str(resp.status_code))
                    raise ApiError(resp.status_code, _error_message(resp))
                if resp.status_code == 204 or not resp.content:
                    return None
                return resp.json()

    async def ping(self) -> bool:
        # /health sits outside the /api/v1 prefix (commerce-api/src/setup.ts).
        root = self._settings.commerce_api_url.rstrip("/").removesuffix("/api/v1")
        try:
            resp = await self._http.get(f"{root}/health", timeout=2)
        except httpx.HTTPError:
            return False
        return resp.is_success


def _query_value(value: Any) -> Any:
    if isinstance(value, bool):
        return "true" if value else "false"
    return value
