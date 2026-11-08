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
    const sub = await this.verifiedSub(req.headers?.authorization);
    if (sub) return `user:${sub}`;
    const conversationId = req.headers?.['x-conversation-id'];
    if (req.isTrustedAgent && typeof conversationId === 'string')
      return `agent-guest:${conversationId.slice(0, 64)}`;
    return `ip:${req.ip}`;
  }

  private async verifiedSub(header: unknown): Promise<string | null> {
    if (typeof header !== 'string') return null;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
    try {
      const p = await this.jwt.verifyAsync<{ sub: string }>(token.trim(), {
        issuer: JWT_ISSUER,
      });
      return p.sub;
    } catch {
      return null; // the route guard reports the bad token
    }
  }
}
