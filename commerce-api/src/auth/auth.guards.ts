import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { Role } from '../database/entities.js';
import { JWT_ISSUER } from './jwt.config.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: Role;
}

type AuthedRequest = Request & { user?: AuthUser };

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : null;
}

// @Injectable here so the JwtService constructor parameter is resolved for subclasses.
@Injectable()
abstract class BaseJwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  protected abstract readonly required: boolean;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    if (!token) {
      if (this.required)
        throw new UnauthorizedException('Missing bearer token');
      return true;
    }
    // A bad token is always an error, even where guests are allowed, so expired sessions are noticed.
    try {
      const p = await this.jwt.verifyAsync<JwtPayload>(token, {
        issuer: JWT_ISSUER,
      });
      req.user = { id: p.sub, email: p.email, name: p.name, role: p.role };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return true;
  }
}

/** 401 unless a valid shopper token is sent. */
@Injectable()
export class JwtAuthGuard extends BaseJwtGuard {
  protected readonly required = true;
}

/** Guests allowed; sets req.user when a valid token is sent. */
@Injectable()
export class OptionalJwtAuthGuard extends BaseJwtGuard {
  protected readonly required = false;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthUser | undefined =>
    context.switchToHttp().getRequest<AuthedRequest>().user,
);
