"""FastAPI app and routes (ARCHITECTURE.md §4.2)."""

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
from app.actions import ActionStore
from app.auth import Auth, get_auth
from app.cache import ToolCache
from app.commerce_client import ApiError, CommerceClient
from app.config import Settings, get_settings
from app.guardrails import RateLimiter, TokenBudget, check_message
from app.llm import LLM
from app.loop import Agent
from app.masking import MaskingFilter
from app.memory import Memory
from app.routing import Router
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


@asynccontextmanager
async def services(settings: Settings, redis: Redis) -> AsyncIterator[Agent]:
    """Build the agent and its clients. Shared by the app and the eval runner."""
    client = CommerceClient(settings)
    try:
        yield Agent(
            settings=settings,
            llm=LLM(settings),
            registry=build_registry(memory=settings.memory_enabled),
            sessions=SessionStore(redis, settings.session_ttl_s, settings.window_messages),
            actions=ActionStore(redis, settings.action_ttl_s),
            budget=TokenBudget(redis, settings.token_budget, settings.session_ttl_s),
            client=client,
            transcripts=TranscriptStore(client),
            cache=ToolCache(redis, settings.cache_enabled),
            memory=Memory(settings, client, redis) if settings.memory_enabled else None,
            router=Router(settings, redis) if settings.model_routing_enabled else None,
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
    expose_headers=["X-Request-Id"],
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


class FeedbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversationId: str = Field(pattern=CONVERSATION_ID)
    messageId: str = Field(max_length=64)
    rating: Literal["up", "down"]
    comment: str | None = Field(None, max_length=1000)


async def _rate_limit(request: Request, auth: Auth) -> None:
    ip = request.client.host if request.client else None
    await request.app.state.limiter.hit(auth.user_id, ip)


@app.post("/v1/chat", dependencies=[Depends(require_enabled)])
async def chat(
    body: ChatRequest, request: Request, auth: AuthDep, agent: AgentDep, settings: SettingsDep
) -> StreamingResponse:
    message = check_message(body.message, settings)
    await _rate_limit(request, auth)
    session = await agent.sessions.load(body.conversationId, auth)
    if not session.messages:
        telemetry.conversations.add(1)

    async def run(emit: Emit) -> None:
        message_id = f"{session.id}:{len(session.messages)}"
        emit("meta", {"conversationId": session.id, "messageId": message_id})
        await agent.run_turn(session, message, auth, emit)

    return sse_response(run, timeout_s=settings.turn_timeout_s, route="chat")


@app.post("/v1/actions/{action_id}/confirm", dependencies=[Depends(require_enabled)])
async def confirm_action(
    action_id: ActionId, request: Request, auth: AuthDep, agent: AgentDep, settings: SettingsDep
) -> StreamingResponse:
    await _rate_limit(request, auth)
    action = await agent.actions.take(action_id, auth)
    if action is None:
        telemetry.actions.add(1, {"tool": "unknown", "result": "expired"})
        raise HTTPException(409, "This action has expired or was already handled.")

    async def run(emit: Emit) -> None:
        emit("meta", {"conversationId": action.conversation_id, "messageId": action.id})
        await agent.confirm(action, auth, emit)

    return sse_response(run, timeout_s=settings.turn_timeout_s, route="confirm")


@app.post("/v1/actions/{action_id}/cancel", status_code=204)
async def cancel_action(action_id: ActionId, auth: AuthDep, agent: AgentDep) -> Response:
    action = await agent.actions.take(action_id, auth)
    if action is not None:
        await agent.cancel(action, auth)
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
    return {"enabled": enabled, "rolloutPercent": rollout}


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
