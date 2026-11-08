export const JWT_ISSUER = 'commerce-api';
const DEV_SECRET = 'dev-only-change-me';

/** Storefront session tokens. Sent as the httpOnly session cookie (or a bearer header by API clients). */
export const SESSION_AUDIENCE = 'storefront';
/** Short-lived chat tokens: only accepted with a valid X-Service-Token, on @AgentAllowed() routes. */
export const AGENT_AUDIENCE = 'agent';

export const SESSION_COOKIE = 'session';

/** The signing secret. Production refuses to start without a real one. */
export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production' && (!secret || secret.length < 32))
    throw new Error(
      'JWT_SECRET must be set to at least 32 characters in production',
    );
  return secret || DEV_SECRET;
}

export function jwtExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN ?? '1h';
}

export function agentTokenExpiresIn(): string {
  return process.env.AGENT_TOKEN_EXPIRES_IN ?? '15m';
}
