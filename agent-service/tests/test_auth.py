import time
from typing import Any

import jwt

from app.auth import GUEST, verify_bearer
from app.config import Settings

SECRET = "test-secret-at-least-32-characters-long"


def settings() -> Settings:
    return Settings(app_env="test", jwt_secret=SECRET)


def token(**overrides: Any) -> str:
    claims: dict[str, Any] = {
        "sub": "u-alice", "ver": 0, "name": "Alice", "role": "CUSTOMER",
        "iss": "commerce-api", "aud": "agent", "exp": int(time.time()) + 900,
    }
    claims.update(overrides)
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, SECRET, algorithm="HS256")


def test_accepts_a_shopper_chat_token() -> None:
    auth = verify_bearer(f"Bearer {token()}", settings())
    assert (auth.user_id, auth.name) == ("u-alice", "Alice")
    assert auth.token == token()


def test_rejects_session_tokens_and_tokens_without_an_audience() -> None:
    # The shopper's full storefront session must never be handed to the agent.
    assert verify_bearer(f"Bearer {token(aud='storefront')}", settings()) is GUEST
    assert verify_bearer(f"Bearer {token(aud=None)}", settings()) is GUEST


def test_staff_tokens_are_treated_as_guests() -> None:
    for role in ("SUPPORT", "ADMIN", None):
        assert verify_bearer(f"Bearer {token(role=role)}", settings()) is GUEST


def test_rejects_expired_forged_and_malformed_tokens() -> None:
    s = settings()
    assert verify_bearer(f"Bearer {token(exp=int(time.time()) - 1)}", s) is GUEST
    assert verify_bearer(f"Bearer {token(iss='someone-else')}", s) is GUEST
    forged = jwt.encode({"sub": "u-bob", "aud": "agent", "role": "CUSTOMER",
                         "iss": "commerce-api", "exp": int(time.time()) + 900},
                        "wrong-secret-at-least-32-characters", algorithm="HS256")
    assert verify_bearer(f"Bearer {forged}", s) is GUEST
    for header in (None, "", "Basic abc", "Bearer ", "Bearer not-a-jwt"):
        assert verify_bearer(header, s) is GUEST
