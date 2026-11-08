"""FastAPI app and routes (ARCHITECTURE.md §4.2)."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Path, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from redis.asyncio import Redis

from app.actions import ActionStore
from app.auth import Auth, get_auth
from app.commerce_client import CommerceClient
from app.config import Settings, get_settings
from app.guardrails import RateLimiter, TokenBudget, check_message
from app.llm import LLM
from app.loop import Agent
from app.masking import MaskingFilter, mask
from app.sessions import SessionStore
from app.sse import Emit, sse_response
from app.tools.registry import build_registry

log = logging.getLogger("agent")

CONVERSATION_ID = r"^[A-Za-z0-9-]{1,64}$"
ACTION_ID = r"^[A-Za-z0-9_-]{1,64}$"


@asynccontextmanager
async def services(settings: Settings, redis: Redis) -> AsyncIterator[Agent]:
    """Build the agent and its clients. Shared by the app and the eval runner."""
    client = CommerceClient(settings)
    try:
        yield Agent(
            settings=settings,
            llm=LLM(settings),
            registry=build_registry(),
            sessions=SessionStore(redis, settings.session_ttl_s, settings.window_messages),
            actions=ActionStore(redis, settings.action_ttl_s),
            budget=TokenBudget(redis, settings.token_budget, settings.session_ttl_s),
            client=client,
        )
    finally:
        await client.aclose()


def _configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.addFilter(MaskingFilter())
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    _configure_logging()
    settings = get_settings()
    if settings.service_token is None or not settings.service_token.get_secret_value():
        log.warning("SERVICE_TOKEN is not set; commerce-api will reject every tool call (403)")
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    try:
        async with services(settings, redis) as agent:
            app.state.agent = agent
            app.state.redis = redis
            app.state.limiter = RateLimiter(redis, settings.rate_limit_per_min)
            yield
    finally:
        await redis.aclose()


app = FastAPI(title="agent-service", version="0.1.0", lifespan=lifespan)
_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origin_list,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


def get_agent(request: Request) -> Agent:
    agent: Agent = request.app.state.agent
    return agent


def require_enabled(settings: Annotated[Settings, Depends(get_settings)]) -> None:
    if not settings.agent_enabled:
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

    async def run(emit: Emit) -> None:
        message_id = f"{session.id}:{len(session.messages)}"
        emit("meta", {"conversationId": session.id, "messageId": message_id})
        await agent.run_turn(session, message, auth, emit)

    return sse_response(run, timeout_s=settings.turn_timeout_s)


@app.post("/v1/actions/{action_id}/confirm", dependencies=[Depends(require_enabled)])
async def confirm_action(
    action_id: ActionId, request: Request, auth: AuthDep, agent: AgentDep, settings: SettingsDep
) -> StreamingResponse:
    await _rate_limit(request, auth)
    action = await agent.actions.take(action_id, auth)
    if action is None:
        raise HTTPException(409, "This action has expired or was already handled.")

    async def run(emit: Emit) -> None:
        emit("meta", {"conversationId": action.conversation_id, "messageId": action.id})
        await agent.confirm(action, auth, emit)

    return sse_response(run, timeout_s=settings.turn_timeout_s)


@app.post("/v1/actions/{action_id}/cancel", status_code=204)
async def cancel_action(action_id: ActionId, auth: AuthDep, agent: AgentDep) -> Response:
    action = await agent.actions.take(action_id, auth)
    if action is not None:
        await agent.cancel(action)
    return Response(status_code=204)


@app.post("/v1/feedback", status_code=204)
async def feedback(body: FeedbackRequest, auth: AuthDep) -> Response:
    # TODO: persist with the conversations table (ARCHITECTURE.md §5.2).
    log.info("feedback %s", mask(body.model_dump() | {"userId": auth.user_id}))
    return Response(status_code=204)


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
