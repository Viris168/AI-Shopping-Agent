import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { credentials } from '../auth/auth.guards.js';
import { JWT_ISSUER } from '../auth/jwt.config.js';

/**
 * Rate-limits per shopper instead of per IP (docs/ARCHITECTURE.md §11.1), so all agent
 * traffic from agent-service doesn't share one bucket. The token is verified here too:
 * an unverified `sub` would let anyone pick a fresh bucket per request.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
  ) {
    super(options, storage, reflector);
  }

  protected override async getTracker(
    req: Record<string, any>,
  ): Promise<string> {
    const sub = await this.verifiedSub(req);
    if (sub) return `user:${sub}`;
    const conversationId = req.headers?.['x-conversation-id'];
    if (req.isTrustedAgent && typeof conversationId === 'string')
      return `agent-guest:${conversationId.slice(0, 64)}`;
    return `ip:${req.ip}`;
  }

  private async verifiedSub(req: Record<string, any>): Promise<string | null> {
    const found = credentials(req as Parameters<typeof credentials>[0]);
    if (!found) return null;
    try {
      const p = await this.jwt.verifyAsync<{ sub: string }>(found.token, {
        issuer: JWT_ISSUER,
        audience: found.audience,
      });
      return p.sub;
    } catch {
      return null; // the route guard reports the bad token
    }
  }
}
