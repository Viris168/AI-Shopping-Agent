import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.guards.js';
import { AgentActionLog } from '../database/entities.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
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

/**
 * Logs every successful agent mutation (`X-Client: ai-agent`) to agent_action_logs.
 * Known gap (ARCHITECTURE.md §11.2–11.3): the header isn't verified yet and failures aren't logged.
 */
@Injectable()
export class AgentAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AgentAuditInterceptor.name);

  constructor(
    @InjectRepository(AgentActionLog)
    private readonly logs: Repository<AgentActionLog>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    if (req.headers['x-client'] !== 'ai-agent' || !MUTATING.has(req.method))
      return next.handle();

    return next.handle().pipe(
      tap(() => {
        const route = String(req.route?.path ?? req.path).replace(
          /^\/api\/v1/,
          '',
        );
        const conversationId = req.headers['x-conversation-id'];
        const entry = this.logs.create({
          userId: req.user?.id ?? null,
          conversationId:
            typeof conversationId === 'string'
              ? conversationId.slice(0, 64)
              : null,
          action: `${req.method} ${route}`.slice(0, 120),
          payload: redact({ params: req.params, body: req.body }) as Record<
            string,
            unknown
          >,
        });
        void this.logs
          .save(entry)
          .catch((err: unknown) =>
            this.logger.error(`Audit insert failed: ${String(err)}`),
          );
      }),
    );
  }
}
