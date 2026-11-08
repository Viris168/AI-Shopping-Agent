export const JWT_ISSUER = 'commerce-api';
const DEV_SECRET = 'dev-only-change-me';

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
