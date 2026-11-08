import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import type { AgentRequest } from '../common/service-token.middleware.js';
import { type Role, User } from '../database/entities.js';
import {
  AGENT_AUDIENCE,
  JWT_ISSUER,
  SESSION_AUDIENCE,
  SESSION_COOKIE,
} from './jwt.config.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  ver: number;
  name: string;
  role: Role;
}

type AuthedRequest = AgentRequest & { user?: AuthUser };

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : null;
}

function cookie(req: Request, name: string): string | null {
  for (const part of req.headers.cookie?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name)
      return decodeURIComponent(part.slice(eq + 1).trim()) || null;
  }
  return null;
}

/**
 * The caller's token and the audience it must have. agent-service sends a chat token as a
 * bearer header; browsers send the session cookie; API clients may send a session token as
 * a bearer header. Shared with UserThrottlerGuard.
 */
export function credentials(
  req: AgentRequest,
): { token: string; audience: string; fromCookie: boolean } | null {
  if (req.isTrustedAgent) {
    const token = bearer(req);
    return token
      ? { token, audience: AGENT_AUDIENCE, fromCookie: false }
      : null;
  }
  const header = bearer(req);
  if (header)
    return { token: header, audience: SESSION_AUDIENCE, fromCookie: false };
  const session = cookie(req, SESSION_COOKIE);
  return session
    ? { token: session, audience: SESSION_AUDIENCE, fromCookie: true }
    : null;
}

const AGENT_ALLOWED = 'agentAllowed';
/** Lets agent-service (chat tokens) call this route. Everything else is storefront-only. */
export const AgentAllowed = () => SetMetadata(AGENT_ALLOWED, true);

const ROLES = 'roles';
/** Staff-only route: use with JwtAuthGuard and RolesGuard. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// @Injectable here so the constructor parameters are resolved for subclasses.
@Injectable()
abstract class BaseJwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  protected abstract readonly required: boolean;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const allowed = this.reflector.getAllAndOverride<boolean>(AGENT_ALLOWED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (req.isTrustedAgent && !allowed)
      throw new ForbiddenException(
        'This can only be done on the store website, not in chat',
      );

    const found = credentials(req);
    if (!found) {
      if (this.required)
        throw new UnauthorizedException('Missing bearer token');
      return true;
    }
    // Cookies ride along on cross-site requests; a custom header can't be sent cross-origin
    // without passing CORS, so requiring one stops CSRF.
    if (
      found.fromCookie &&
      !SAFE_METHODS.has(req.method) &&
      !req.headers['x-requested-with']
    )
      throw new ForbiddenException('Missing X-Requested-With header');

    // A bad token is always an error, even where guests are allowed, so expired sessions are noticed.
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(found.token, {
        issuer: JWT_ISSUER,
        audience: found.audience,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    // Role and name come from the database, so logout and role changes apply at once.
    const user = await this.users.findOne({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        tokenVersion: true,
      },
    });
    if (!user || user.tokenVersion !== payload.ver)
      throw new UnauthorizedException('Invalid or expired token');
    // Staff accounts never lend their permissions to the model (CLAUDE.md rule 1).
    if (req.isTrustedAgent && user.role !== 'CUSTOMER')
      throw new ForbiddenException(
        'The assistant is for shopper accounts only',
      );
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
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

/** 403 unless req.user has one of the @Roles(). Runs after JwtAuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    // No @Roles() means a misconfigured route: fail closed.
    const user = context.switchToHttp().getRequest<AuthedRequest>().user;
    if (!roles?.length || !user || !roles.includes(user.role))
      throw new ForbiddenException('You don’t have access to this');
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthUser | undefined =>
    context.switchToHttp().getRequest<AuthedRequest>().user,
);
