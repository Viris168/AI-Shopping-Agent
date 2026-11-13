"""Settings from the environment (and `.env` in development)."""

from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Same fallback commerce-api uses outside production (commerce-api/src/auth/jwt.config.ts).
DEV_JWT_SECRET = "dev-only-change-me"  # noqa: S105 - public dev fallback, rejected in production


class ModelPrice(BaseModel):
    """USD per million tokens."""

    input: float = Field(ge=0)
    cache_read: float = Field(ge=0)
    output: float = Field(ge=0)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"

    # Model access: DeepSeek through its Anthropic-compatible API, so the Anthropic SDK and
    # message format stay as they are. ANTHROPIC_API_KEY holds the DeepSeek key.
    # Set ANTHROPIC_BASE_URL empty (and Claude model IDs) to call Anthropic directly.
    anthropic_api_key: SecretStr | None = None
    anthropic_base_url: str | None = "https://api.deepseek.com/anthropic"
    model_main: str = "deepseek-v4-pro"
    model_fast: str = "deepseek-flash"
    claude_effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    max_output_tokens: int = 1024
    # Cost estimates (app/usage.py, PLAN-19 M2), keyed by model ID, from the provider's pricing
    # page. JSON in MODEL_PRICES. A model without a price is counted in tokens only.
    model_prices: dict[str, ModelPrice] = Field(default_factory=dict)
    model_timeout_s: float = 30

    # commerce-api
    commerce_api_url: str = "http://localhost:3000/api/v1"
    commerce_timeout_s: float = 10
    service_token: SecretStr | None = None
    jwt_secret: SecretStr = SecretStr(DEV_JWT_SECRET)
    jwt_issuer: str = "commerce-api"

    redis_url: str = "redis://localhost:6379/0"
    # Public tool results in Redis (app/cache.py). Redis flag:cache_enabled can also turn it off.
    cache_enabled: bool = True
    # Long-term memory (app/memory.py, PLAN-18). Off until rolled out; shoppers must also opt in.
    # Redis flag:memory_enabled can turn it off at runtime.
    memory_enabled: bool = False
    # Task playbooks in the prompt (app/playbooks.py, PLAN-18 M7). A prompt change: switch on after
    # the golden and red-team suites pass with it.
    playbooks_enabled: bool = False

    store_name: str = "our store"
    storefront_url: str = "http://localhost:8080"
    # Hosts (and their subdomains) replies may link to, besides STOREFRONT_URL's. Comma-separated.
    # Any other link the model writes is removed (app/guardrails.py OutputGuard).
    link_hosts: str = ""
    return_window_days: int = 30
    # IANA zone the store runs in (e.g. "America/New_York"). "Today" in the prompt and the order
    # dates the model sees are in it, and the widget formats card dates in it, so the reply and
    # the card agree on a deadline's date.
    store_tz: str = "UTC"

    # Limits (AGENT.md §6)
    max_tool_rounds: int = 6
    turn_timeout_s: float = 45
    max_message_chars: int = 2000
    rate_limit_per_min: int = 20
    token_budget: int = 300_000
    # Per shopper (per IP for guests) per UTC day, across conversations, so a new conversation
    # doesn't reset spending. Guests behind one IP share it. 0 turns it off.
    daily_token_budget: int = Field(1_000_000, ge=0)
    # How long a confirm/cancel waits for a running turn on the same conversation to finish.
    lock_wait_s: float = 10
    # History: past 2× this many messages, the oldest half folds into the summary. The model
    # gets every message since the last fold (so between this and 2× this).
    window_messages: int = 20
    session_ttl_s: int = 24 * 3600
    action_ttl_s: int = 600

    cors_origins: str = "http://localhost:5173"

    # Kill switch and rollout (ARCHITECTURE.md §7, §12). Redis keys flag:agent_enabled and
    # flag:rollout_percent override these at runtime without a redeploy.
    agent_enabled: bool = True
    rollout_percent: int = Field(100, ge=0, le=100)

    # Telemetry (app/telemetry.py). Unset endpoint → no export. DEPLOY_ENV names the
    # environment in traces and metrics (staging and production both run APP_ENV=production).
    deploy_env: str | None = None
    otel_exporter_otlp_endpoint: str | None = None
    otel_exporter_otlp_headers: SecretStr | None = None
    trace_sample_ratio: float = Field(1.0, ge=0, le=1)

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.store_tz)

    @property
    def link_host_list(self) -> list[str]:
        store = urlsplit(self.storefront_url).hostname
        extra = [h.strip().lower() for h in self.link_hosts.split(",") if h.strip()]
        return [h for h in (store, *extra) if h]

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @model_validator(mode="after")
    def _known_time_zone(self) -> "Settings":
        try:
            ZoneInfo(self.store_tz)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"STORE_TZ {self.store_tz!r} is not an IANA time zone") from exc
        return self

    @model_validator(mode="after")
    def _production_secrets(self) -> "Settings":
        if self.app_env == "production":
            secret = self.jwt_secret.get_secret_value()
            if secret == DEV_JWT_SECRET or len(secret) < 32:
                raise ValueError("JWT_SECRET must be set to at least 32 characters in production")
            if self.service_token is None or len(self.service_token.get_secret_value()) < 32:
                raise ValueError("SERVICE_TOKEN must be at least 32 characters in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
