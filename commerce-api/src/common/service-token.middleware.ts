import { createHash, timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export type AgentRequest = Request & { isTrustedAgent?: boolean };

/** The shared agent-service secret. Production refuses to start without a real one. */
export function serviceToken(): string | null {
  const token = process.env.SERVICE_TOKEN;
  if (process.env.NODE_ENV === 'production' && (!token || token.length < 32))
    throw new Error(
      'SERVICE_TOKEN must be set to at least 32 characters in production',
    );
  return token || null;
}

// Hashing first gives equal-length buffers, so timingSafeEqual never throws or leaks the length.
const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Marks agent-service traffic as trusted when `X-Service-Token` matches SERVICE_TOKEN
 * (docs/ARCHITECTURE.md §11.2). `X-Client: ai-agent` without a valid token is rejected,
 * so the header alone can't fake agent traffic or skip the audit.
 */
@Injectable()
export class ServiceTokenMiddleware implements NestMiddleware {
  private readonly expected = serviceToken();

  use(req: AgentRequest, _res: Response, next: NextFunction) {
    const sent = req.headers['x-service-token'];
    req.isTrustedAgent =
      this.expected !== null &&
      typeof sent === 'string' &&
      timingSafeEqual(digest(sent), digest(this.expected));
    if (req.headers['x-client'] === 'ai-agent' && !req.isTrustedAgent)
      throw new ForbiddenException('Agent requests need a valid service token');
    next();
  }
}
