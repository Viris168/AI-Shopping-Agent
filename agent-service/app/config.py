"""Settings from the environment (and `.env` in development)."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Same fallback commerce-api uses outside production (commerce-api/src/auth/jwt.config.ts).
DEV_JWT_SECRET = "dev-only-change-me"  # noqa: S105 - public dev fallback, rejected in production


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"

    # Model access. No key → the SDK falls back to an `ant auth login` profile.
    anthropic_api_key: SecretStr | None = None
    model_main: str = "claude-sonnet-5"
    model_fast: str = "claude-haiku-4-5"
    claude_effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    max_output_tokens: int = 1024
    model_timeout_s: float = 30

    # commerce-api
    commerce_api_url: str = "http://localhost:3000/api/v1"
    commerce_timeout_s: float = 10
    service_token: SecretStr | None = None
    jwt_secret: SecretStr = SecretStr(DEV_JWT_SECRET)
    jwt_issuer: str = "commerce-api"

    redis_url: str = "redis://localhost:6379/0"

    store_name: str = "our store"
    storefront_url: str = "http://localhost:8080"
    return_window_days: int = 30

    # Limits (AGENT.md §6)
    max_tool_rounds: int = 6
    turn_timeout_s: float = 45
    max_message_chars: int = 2000
    rate_limit_per_min: int = 20
    token_budget: int = 300_000
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
