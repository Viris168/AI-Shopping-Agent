"""FastAPI app and routes (ARCHITECTURE.md §4.2)."""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Path, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from redis.asyncio import Redis

from app import telemetry
from app.actions import ActionStore, PendingAction
from app.auth import Auth, get_auth
from app.cache import ToolCache
from app.commerce_client import ApiError, CommerceClient
from app.config import Settings, get_settings
from app.guardrails import (
    PHOTOS_OFF,
    ImageLimiter,
    RateLimiter,
    TokenBudget,
    budget_subject,
    check_message,
    photo_error,
)
from app.images import ImageIn, prepare_image
from app.llm import LLM
from app.loop import Agent
from app.masking import MaskingFilter
from app.memory import Memory
from app.sessions import SessionStore, TranscriptStore
from app.sse import Emit, sse_response
from app.tools.registry import build_registry

log = logging.getLogger("agent")

CONVERSATION_ID = r"^[A-Za-z0-9-]{1,64}$"
ACTION_ID = r"^[A-Za-z0-9_-]{1,64}$"

# Runtime flags (infra/monitoring/README.md#kill-switch). `SET flag:agent_enabled 0` turns the
# assistant off on every replica at once; `SET flag:rollout_percent 25` moves the rollout.
FLAG_ENABLED = "flag:agent_enabled"
FLAG_ROLLOUT = "flag:rollout_percent"
# `SET flag:images_enabled 0` turns photos off without a redeploy (IMAGES_ENABLED turns them on).
FLAG_IMAGES = "flag:images_enabled"
FLAG_IMAGES_ROLLOUT = "flag:images_rollout_percent"


@asynccontextmanager
async def services(settings: Settings, redis: Redis) -> AsyncIterator[Agent]:
    """Build the agent and its clients. Shared by the app and the eval runner."""
    client = CommerceClient(settings)
    try:
        yield Agent(
            settings=settings,
            llm=LLM(settings),
            registry=build_registry(memory=settings.memory_enabled),
            sessions=SessionStore(
                redis, settings.session_ttl_s, settings.window_messages,
                lock_ttl_s=int(settings.turn_timeout_s) + 15,
            ),
            actions=ActionStore(redis, settings.action_ttl_s),
            budget=TokenBudget(
                redis, settings.token_budget, settings.session_ttl_s, settings.daily_token_budget
            ),
            client=client,
            transcripts=TranscriptStore(client),
            cache=ToolCache(redis, settings.cache_enabled),
            memory=Memory(settings, client, redis) if settings.memory_enabled else None,
        )
    finally:
        await client.aclose()


def _configure_logging(settings: Settings) -> None:
    handler = logging.StreamHandler()
    handler.addFilter(MaskingFilter())
    production = settings.app_env == "production"
    handler.setFormatter(telemetry.JsonFormatter() if production else telemetry.TextFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    _configure_logging(settings)
    shutdown_telemetry = telemetry.setup(settings)
    if settings.service_token is None or not settings.service_token.get_secret_value():
        log.warning("SERVICE_TOKEN is not set; commerce-api will reject every tool call (403)")
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    try:
        async with services(settings, redis) as agent:
            app.state.agent = agent
            app.state.redis = redis
            app.state.limiter = RateLimiter(redis, settings.rate_limit_per_min)
            app.state.images = ImageLimiter(
                redis, settings.image_daily_limit, settings.image_daily_limit_guest
            )
            yield
            await agent.drain()  # finish memory writes before the client closes
    finally:
        await redis.aclose()
        shutdown_telemetry()


app = FastAPI(title="agent-service", version="0.1.0", lifespan=lifespan)
_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origin_list,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-Request-Id", "X-Limit"],
)
app.add_middleware(telemetry.RequestIdMiddleware)  # outermost: wraps CORS and every route


def get_agent(request: Request) -> Agent:
    agent: Agent = request.app.state.agent
    return agent


async def read_flags(request: Request, settings: Settings) -> tuple[bool, int]:
    """(enabled, rollout percent). AGENT_ENABLED=false can't be overridden; Redis can only
    turn the assistant off or move the rollout. If Redis is down, the env values hold."""
    enabled, rollout = settings.agent_enabled, settings.rollout_percent
    try:
        raw_enabled, raw_rollout = await request.app.state.redis.mget(FLAG_ENABLED, FLAG_ROLLOUT)
    except Exception:
        log.warning("flags unreadable from redis; using AGENT_ENABLED/ROLLOUT_PERCENT")
        return enabled, rollout
    if raw_enabled is not None and raw_enabled.strip().lower() in ("0", "false", "off"):
        enabled = False
    if raw_rollout is not None and raw_rollout.strip().isdigit():
        rollout = min(int(raw_rollout), 100)
    return enabled, rollout if enabled else 0


async def images_active(request: Request, settings: Settings) -> bool:
    """IMAGES_ENABLED, unless Redis `flag:images_enabled 0` turns photos off everywhere."""
    if not settings.images_enabled:
        return False
    try:
        raw = await request.app.state.redis.get(FLAG_IMAGES)
    except Exception:
        log.warning("images flag unreadable from redis; using IMAGES_ENABLED")
        return True
    return not (isinstance(raw, str) and raw.strip().lower() in ("0", "false", "off"))


async def images_rollout(request: Request, settings: Settings) -> int:
    """IMAGES_ROLLOUT_PERCENT, unless Redis flag:images_rollout_percent moves it."""
    try:
        raw = await request.app.state.redis.get(FLAG_IMAGES_ROLLOUT)
    except Exception:
        return settings.images_rollout_percent
    if isinstance(raw, str) and raw.strip().isdigit():
        return min(int(raw), 100)
    return settings.images_rollout_percent


async def require_enabled(
    request: Request, settings: Annotated[Settings, Depends(get_settings)]
) -> None:
    enabled, _ = await read_flags(request, settings)
    if not enabled:
        telemetry.kill_switch_rejections.add(1)
        raise HTTPException(503, "The assistant is unavailable right now.")


AuthDep = Annotated[Auth, Depends(get_auth)]
AgentDep = Annotated[Agent, Depends(get_agent)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
ActionId = Annotated[str, Path(pattern=ACTION_ID)]


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversationId: str | None = Field(None, pattern=CONVERSATION_ID)
    message: str = Field(max_length=20_000)  # hard cap; the friendly 413 is in guardrails
    locale: str | None = Field(None, max_length=16)
    image: ImageIn | None = None  # one photo per message (PLAN-20)


class FeedbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversationId: str = Field(pattern=CONVERSATION_ID)
    messageId: str = Field(max_length=64)
    rating: Literal["up", "down"]
    comment: str | None = Field(None, max_length=1000)


BUSY = "I'm still answering in this conversation. Please wait for that reply, then try again."


def _ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _subject(request: Request, auth: Auth) -> str:
    return budget_subject(auth.user_id, _ip(request))


async def _rate_limit(request: Request, auth: Auth) -> None:
    await request.app.state.limiter.hit(auth.user_id, _ip(request))


async def _lock_for_action(
    agent: Agent, action_id: str, auth: Auth, wait_s: float
) -> tuple[PendingAction, str] | None:
    """Wait for any turn running on the action's conversation, then claim the action.

    The lock comes first, so a Confirm pressed while a reply is still streaming isn't used up
    when it can't run. None when the action is missing, expired, used or not this shopper's;
    429 (the widget keeps the card, so it can be pressed again) when the conversation stays busy.
    """
    peek = await agent.actions.get(action_id)
    if peek is None or not peek.owned_by(auth):
        return None
    token = await agent.sessions.lock(peek.conversation_id, wait_s)
    if token is None:
        raise HTTPException(429, BUSY)
    action = await agent.actions.take(action_id, auth)
    if action is None:
        await agent.sessions.unlock(peek.conversation_id, token)
        return None
    return action, token


@app.post("/v1/chat", dependencies=[Depends(require_enabled)])
async def chat(
    body: ChatRequest, request: Request, auth: AuthDep, agent: AgentDep, settings: SettingsDep
) -> StreamingResponse:
    if body.image is not None and not await images_active(request, settings):
        raise photo_error(403, PHOTOS_OFF)
    message = check_message(body.message, settings, allow_empty=body.image is not None)
    await _rate_limit(request, auth)
    image = None
    if body.image is not None:
        # Checked before it counts against the day's photos; re-encoding is CPU work.
        image = await asyncio.to_thread(prepare_image, body.image, settings)
        await request.app.state.images.hit(_subject(request, auth), auth.is_guest)
    # A new conversation's ID is made here and nobody else has it yet, so it needs no lock.
    lock: tuple[str, str] | None = None
    if body.conversationId:
        token = await agent.sessions.lock(body.conversationId)
        if token is None:
            raise HTTPException(429, BUSY)
        lock = (body.conversationId, token)
    try:
        session = await agent.sessions.load(body.conversationId, auth)
    except BaseException:
        if lock:
            await agent.sessions.unlock(*lock)
        raise
    if not session.messages:
        telemetry.conversations.add(1)
    subject = _subject(request, auth)

    async def run(emit: Emit) -> None:
        try:
            message_id = f"{session.id}:{len(session.messages)}"
            emit("meta", {"conversationId": session.id, "messageId": message_id})
            await agent.run_turn(session, message, auth, emit, subject, image)
        finally:
            if lock:
                await agent.sessions.unlock(*lock)

    return sse_response(run, timeout_s=settings.turn_timeout_s, route="chat")


@app.post("/v1/actions/{action_id}/confirm", dependencies=[Depends(require_enabled)])
async def confirm_action(
    action_id: ActionId, request: Request, auth: AuthDep, agent: AgentDep, settings: SettingsDep
) -> StreamingResponse:
    await _rate_limit(request, auth)
    claimed = await _lock_for_action(agent, action_id, auth, settings.lock_wait_s)
    if claimed is None:
        telemetry.actions.add(1, {"tool": "unknown", "result": "expired"})
        raise HTTPException(409, "This action has expired or was already handled.")
    action, token = claimed
    subject = _subject(request, auth)

    async def run(emit: Emit) -> None:
        try:
            emit("meta", {"conversationId": action.conversation_id, "messageId": action.id})
            await agent.confirm(action, auth, emit, subject)
        finally:
            await agent.sessions.unlock(action.conversation_id, token)

    return sse_response(run, timeout_s=settings.turn_timeout_s, route="confirm")


@app.post("/v1/actions/{action_id}/cancel", status_code=204)
async def cancel_action(
    action_id: ActionId, auth: AuthDep, agent: AgentDep, settings: SettingsDep
) -> Response:
    claimed = await _lock_for_action(agent, action_id, auth, settings.lock_wait_s)
    if claimed is not None:
        action, token = claimed
        try:
            await agent.cancel(action, auth)
        finally:
            await agent.sessions.unlock(action.conversation_id, token)
    return Response(status_code=204)


@app.post("/v1/feedback", status_code=204)
async def feedback(
    body: FeedbackRequest, request: Request, auth: AuthDep, agent: AgentDep
) -> Response:
    await _rate_limit(request, auth)
    if agent.transcripts is None:
        raise HTTPException(503, "Feedback can't be saved right now.")
    try:
        await agent.transcripts.feedback(
            body.conversationId, body.messageId, body.rating, body.comment, auth
        )
    except ApiError as exc:
        if exc.status == 404:
            raise HTTPException(404, "We couldn't find that conversation.") from exc
        log.warning("feedback_save_failed %s: %s", body.conversationId, exc.status)
        raise HTTPException(503, "Feedback can't be saved right now.") from exc
    telemetry.feedback.add(1, {"rating": body.rating})
    return Response(status_code=204)


@app.get("/v1/config")
async def widget_config(
    request: Request, settings: SettingsDep, response: Response
) -> dict[str, Any]:
    """Read by the widget before it mounts: hidden when disabled or outside the rollout."""
    enabled, rollout = await read_flags(request, settings)
    # Short cache: a kill switch reaches every page within a minute.
    response.headers["Cache-Control"] = "public, max-age=60"
    images = enabled and await images_active(request, settings)
    return {
        "enabled": enabled, "rolloutPercent": rollout, "timeZone": settings.store_tz,
        "imagesEnabled": images,
        # The widget shows the photo button only in this share of its buckets. The server
        # still accepts a photo from any browser while photos are on: this is a gradual
        # rollout, not access control.
        "imagesRolloutPercent": await images_rollout(request, settings) if images else 0,
    }


@app.get("/health")
async def health(request: Request, agent: AgentDep) -> dict[str, str]:
    try:
        redis_ok = bool(await request.app.state.redis.ping())
    except Exception:
        redis_ok = False
    api_ok = await agent.client.ping()
    return {
        "status": "ok" if redis_ok and api_ok else "degraded",
        "redis": "ok" if redis_ok else "down",
        "commerceApi": "ok" if api_ok else "down",
    }
