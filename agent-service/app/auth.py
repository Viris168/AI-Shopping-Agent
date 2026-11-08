"""Verify the shopper's chat token issued by commerce-api. Invalid or missing → guest.

The widget gets a short-lived chat token (audience "agent") from the store, never the
shopper's session. commerce-api accepts it only alongside our X-Service-Token and only on
the routes the tools use, so the token is worth little if it leaks.
"""

from dataclasses import dataclass, field
from typing import Annotated

import jwt
from fastapi import Depends, Header

from app.config import Settings, get_settings


@dataclass(frozen=True)
class Auth:
    user_id: str | None = None
    name: str | None = None
    # Forwarded to commerce-api as-is; never logged or persisted.
    token: str | None = field(default=None, repr=False)

    @property
    def is_guest(self) -> bool:
        return self.user_id is None


GUEST = Auth()

# Must match AGENT_AUDIENCE in commerce-api/src/auth/jwt.config.ts.
AGENT_AUDIENCE = "agent"


def verify_bearer(authorization: str | None, settings: Settings) -> Auth:
    if not authorization:
        return GUEST
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return GUEST
    token = token.strip()
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret.get_secret_value(),
            algorithms=["HS256"],
            issuer=settings.jwt_issuer,
            audience=AGENT_AUDIENCE,
            options={"require": ["sub", "exp", "iss", "aud"]},
        )
    except jwt.PyJWTError:
        return GUEST
    # commerce-api only issues chat tokens to shoppers and re-checks the role on every call;
    # staff permissions never reach the model (CLAUDE.md rule 1).
    if claims.get("role") != "CUSTOMER":
        return GUEST
    name = claims.get("name")
    return Auth(
        user_id=str(claims["sub"]), name=name if isinstance(name, str) else None, token=token
    )


def get_auth(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
) -> Auth:
    return verify_bearer(authorization, settings)
