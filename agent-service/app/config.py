"""Settings from the environment (and `.env` in development)."""

from functools import lru_cache
from typing import Literal

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
    # Model routing (app/routing.py, PLAN-19 M5): simple turns on MODEL_FAST. A prompt-path
    # change: switch on after both suites pass with it. Redis flag:model_routing can turn it off.
    model_routing_enabled: bool = False
    # Share of new conversations routed (M6 rollout); the rest are the control group. Redis
    # flag:routing_percent overrides it. Only with MODEL_ROUTING_ENABLED.
    routing_percent: int = Field(0, ge=0, le=100)

    store_name: str = "our store"
    storefront_url: str = "http://localhost:8080"
    return_window_days: int = 30

    # Limits (AGENT.md §6)
    max_tool_rounds: int = 6
    turn_timeout_s: float = 45
    max_message_chars: int = 2000
    rate_limit_per_min: int = 20  # signed-in shoppers
    guest_rate_limit_per_min: int = 10  # guests, per IP
    token_budget: int = 300_000  # per conversation; the backstop when MODEL_PRICES is unset

    # Spend limits (app/limits.py, PLAN-19 M7), in US dollars of estimated model cost
    # (MODEL_PRICES). 0 turns a limit off.
    daily_spend_cap_usd: float = Field(5.0, ge=0)  # whole store; guests pause at 80%
    daily_spend_user_usd: float = Field(0.5, ge=0)  # per signed-in shopper
    daily_spend_guest_usd: float = Field(0.1, ge=0)  # per guest IP
    conversation_spend_usd: float = Field(0.1, ge=0)
    new_conversations_per_hour_user: int = Field(30, ge=0)
    new_conversations_per_hour_guest: int = Field(10, ge=0)
    # Poll the provider's prepaid balance (DeepSeek only) for the low-balance alert.
    provider_balance_check: bool = True
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
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

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
