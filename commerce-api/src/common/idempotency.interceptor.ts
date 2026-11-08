import { createHash } from 'node:crypto';
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { catchError, concatMap, Observable, of } from 'rxjs';
import { IsNull, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import type { AuthUser } from '../auth/auth.guards.js';
import { IdempotencyKey } from '../database/entities.js';

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const TTL = `interval '24 hours'`;

/** Key order doesn't change the hash, so a re-serialised retry still matches. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

const hashBody = (body: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(body ?? {})))
    .digest('hex');

/**
 * Optional `Idempotency-Key` header for routes that create records (docs/ARCHITECTURE.md §11.4).
 * Same key + same body → the stored response; same key + different body → 422; same key
 * while the first request is still running → 409. Keys are per user and expire after 24 h.
 * Failed requests don't keep their key, so they can be retried.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    @InjectRepository(IdempotencyKey)
    private readonly keys: Repository<IdempotencyKey>,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: AuthUser }>();
    const header = req.headers['idempotency-key'];
    if (header === undefined) return next.handle();
    const key = typeof header === 'string' ? header.trim() : '';
    if (!KEY_PATTERN.test(key))
      throw new BadRequestException(
        'Idempotency-Key must be 1–100 letters, digits or "-_.:" characters',
      );

    const userId = req.user?.id ?? null;
    const route = `${req.method} ${String(req.route?.path ?? req.path)}`.slice(
      0,
      120,
    );
    const requestHash = hashBody(req.body);

    const id = await this.claim(key, userId, route, requestHash);
    if (!id) return this.replay(key, userId, route, requestHash, http);

    return next.handle().pipe(
      catchError(async (err: unknown) => {
        await this.keys.delete(id);
        throw err;
      }),
      concatMap(async (body: unknown) => {
        const statusCode = http.getResponse<Response>().statusCode;
        await this.keys
          // Cast: TypeORM's deep-partial type can't describe an arbitrary jsonb value.
          .update(id, {
            response: body ?? null,
            statusCode,
          } as QueryDeepPartialEntity<IdempotencyKey>)
          .catch((err: unknown) =>
            // A retry will now get 409, which the agent treats as already done.
            this.logger.error(`Idempotency store failed: ${String(err)}`),
          );
        return body;
      }),
    );
  }

  /** Inserts the key as in-progress; returns its id, or null if the key is taken. */
  private async claim(
    key: string,
    userId: string | null,
    route: string,
    requestHash: string,
  ): Promise<string | null> {
    await this.keys
      .createQueryBuilder()
      .delete()
      .where('key = :key', { key })
      .andWhere('user_id IS NOT DISTINCT FROM :userId', { userId })
      .andWhere(`created_at < now() - ${TTL}`)
      .execute();
    const result = await this.keys
      .createQueryBuilder()
      .insert()
      .values({ key, userId, route, requestHash })
      .orIgnore()
      .returning('id')
      .execute();
    const rows = result.raw as { id: string }[];
    return rows[0]?.id ?? null;
  }

  private async replay(
    key: string,
    userId: string | null,
    route: string,
    requestHash: string,
    http: ReturnType<ExecutionContext['switchToHttp']>,
  ): Promise<Observable<unknown>> {
    const existing = await this.keys.findOneBy({
      key,
      userId: userId ?? IsNull(),
    });
    // Deleted between claim and lookup: the first request failed, so this one may retry.
    if (!existing)
      throw new ConflictException(
        'This request is already being processed; please retry shortly',
      );
    if (existing.route !== route || existing.requestHash !== requestHash)
      throw new UnprocessableEntityException(
        'This Idempotency-Key was already used for a different request',
      );
    if (existing.statusCode === null)
      throw new ConflictException(
        'This request is already being processed; please retry shortly',
      );
    const res = http.getResponse<Response>();
    res.status(existing.statusCode);
    res.setHeader('Idempotent-Replayed', 'true');
    return of(existing.response);
  }
}
