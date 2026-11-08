import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import type { Response } from 'express';
import { Observable, tap } from 'rxjs';
import { Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.guards.js';
import { AgentActionLog } from '../database/entities.js';
import type { AgentRequest } from './service-token.middleware.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const OMIT_BODY = 'agentAudit:omitBody';

/**
 * Still audited, but the row keeps only the route params, not the body. For bulky
 * non-commerce writes (transcripts) that would otherwise copy into every audit row.
 */
export const AuditWithoutBody = () => SetMetadata(OMIT_BODY, true);
const SECRET_KEYS = /password|token|secret/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEYS.test(k) ? '[redacted]' : redact(v),
      ]),
    );
  return value;
}

function errorDetails(err: unknown): { status: number; error: string } {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? body.message
        : err.message;
    return {
      status: err.getStatus(),
      error: (Array.isArray(message)
        ? message.join('; ')
        : String(message)
      ).slice(0, 500),
    };
  }
  return { status: 500, error: 'Internal server error' };
}

/**
 * Logs every agent mutation, successful or not, to agent_action_logs (docs/ARCHITECTURE.md §11.3).
 * Only trusted agent traffic counts: ServiceTokenMiddleware sets `isTrustedAgent` after
 * checking `X-Service-Token`, and rejects `X-Client: ai-agent` without it.
 */
@Injectable()
export class AgentAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AgentAuditInterceptor.name);

  constructor(
    @InjectRepository(AgentActionLog)
    private readonly logs: Repository<AgentActionLog>,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<AgentRequest & { user?: AuthUser }>();
    if (!req.isTrustedAgent || !MUTATING.has(req.method)) return next.handle();
    const omitBody = this.reflector.getAllAndOverride<boolean>(OMIT_BODY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return next.handle().pipe(
      tap({
        next: () =>
          this.record(
            req,
            http.getResponse<Response>().statusCode,
            null,
            omitBody,
          ),
        error: (err: unknown) => {
          const { status, error } = errorDetails(err);
          this.record(req, status, error, omitBody);
        },
      }),
    );
  }

  private record(
    req: AgentRequest & { user?: AuthUser },
    status: number,
    error: string | null,
    omitBody = false,
  ) {
    const route = String(req.route?.path ?? req.path).replace(/^\/api\/v1/, '');
    const conversationId = req.headers['x-conversation-id'];
    const entry = this.logs.create({
      userId: req.user?.id ?? null,
      conversationId:
        typeof conversationId === 'string' ? conversationId.slice(0, 64) : null,
      action: `${req.method} ${route}`.slice(0, 120),
      payload: redact(
        omitBody
          ? { params: req.params }
          : { params: req.params, body: req.body },
      ) as Record<string, unknown>,
      status,
      error,
    });
    // The response is already decided; a lost audit row must be loud (alert: audit insert failures > 0).
    this.logs
      .save(entry)
      .catch((err: unknown) =>
        this.logger.error(
          `audit_insert_failed ${entry.action}: ${String(err)}`,
        ),
      );
  }
}
