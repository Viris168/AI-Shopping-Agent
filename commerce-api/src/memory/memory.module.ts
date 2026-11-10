import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DataSource, type EntityManager } from 'typeorm';
import {
  AgentAllowed,
  CurrentUser,
  JwtAuthGuard,
  type AuthUser,
} from '../auth/auth.guards.js';
import { AuditWithoutBody } from '../common/agent-audit.interceptor.js';
import { TrustedAgentGuard } from '../conversations/conversations.module.js';
import {
  CONVERSATION_OUTCOMES,
  MEMORY_FACT_KINDS,
  MemoryEpisode,
  MemoryFact,
  MemorySettings,
  type ConversationOutcome,
  type MemoryFactKind,
} from '../database/entities.js';
import { toVectorLiteral } from '../search/embedding.js';
import { EmbeddingService, SearchModule } from '../search/search.module.js';

/** A shopper keeps at most this many facts; the agent should forget or replace, not pile up. */
export const MAX_FACTS = 50;
const RECENT_EPISODES = 3;
const SIMILAR_EPISODES = 3;
// Starting value, not yet tuned on real episodes (cf. FAQ_MIN_SIMILARITY in faq.module.ts).
export const EPISODE_MIN_SIMILARITY = 0.6;

const memoryOff = () =>
  new ForbiddenException('The shopper has not turned on assistant memory');

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class EpisodeEntitiesDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  orders?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  products?: string[];
}

export class RecordEpisodeDto {
  @IsUUID()
  conversationId: string;

  // Masked by agent-service before sending.
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  summary: string;

  @IsOptional()
  @IsIn(CONVERSATION_OUTCOMES)
  outcome?: ConversationOutcome;

  @IsOptional()
  @ValidateNested()
  @Type(() => EpisodeEntitiesDto)
  entities?: EpisodeEntitiesDto;
}

export class SaveFactDto {
  @IsIn(MEMORY_FACT_KINDS)
  kind: MemoryFactKind;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  value: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @IsOptional()
  @IsUUID()
  sourceConversationId?: string;
}

export class MemoryQueryDto {
  // The shopper's first message, to find similar past episodes.
  @IsOptional()
  @IsString()
  @MaxLength(300)
  q?: string;
}

export class SetMemoryDto {
  @IsBoolean()
  enabled: boolean;
}

export interface MemoryView {
  enabled: boolean;
  facts: {
    id: string;
    kind: MemoryFactKind;
    value: string;
    updatedAt: Date;
  }[];
  episodes: {
    id: string;
    conversationId: string;
    summary: string;
    outcome: ConversationOutcome | null;
    entities: EpisodeEntitiesDto;
    createdAt: Date;
  }[];
}

const EPISODE_COLUMNS = [
  'e.id AS "id"',
  'e.conversation_id AS "conversationId"',
  'e.summary AS "summary"',
  'e.outcome AS "outcome"',
  'e.entities AS "entities"',
  'e.created_at AS "createdAt"',
];

/**
 * Long-term agent memory (PLAN-18 step 3). Every query filters by user_id in its WHERE clause
 * (CLAUDE.md rule 2). Off by default: with memory off, reads return nothing and writes fail.
 */
@Injectable()
export class MemoryService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly embeddings: EmbeddingService,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    const row = await this.db
      .getRepository(MemorySettings)
      .findOne({ where: { userId }, select: { enabled: true } });
    return row?.enabled ?? false;
  }

  /** Facts, the last few episodes, and earlier ones similar to `q`. */
  async get(userId: string, q?: string): Promise<MemoryView> {
    if (!(await this.isEnabled(userId)))
      return { enabled: false, facts: [], episodes: [] };
    return { enabled: true, ...(await this.list(userId, q)) };
  }

  /** Everything, for the shopper's account page (also when memory is off: there's nothing). */
  async all(userId: string): Promise<MemoryView> {
    const enabled = await this.isEnabled(userId);
    return { enabled, ...(await this.list(userId, undefined, true)) };
  }

  private async list(userId: string, q?: string, everything = false) {
    const facts = await this.db
      .getRepository(MemoryFact)
      .createQueryBuilder('f')
      .select(['f.id', 'f.kind', 'f.value', 'f.updatedAt'])
      .where('f.user_id = :userId', { userId })
      .orderBy('f.updated_at', 'DESC')
      .getMany();

    const episodes = this.db
      .getRepository(MemoryEpisode)
      .createQueryBuilder('e')
      .select(EPISODE_COLUMNS)
      .where('e.user_id = :userId', { userId })
      .orderBy('e.created_at', 'DESC');
    if (!everything) episodes.limit(RECENT_EPISODES);
    const recent = await episodes.getRawMany<MemoryView['episodes'][number]>();

    const similar =
      q && !everything ? await this.similar(userId, q, recent) : [];
    return {
      facts: facts.map(({ id, kind, value, updatedAt }) => ({
        id,
        kind,
        value,
        updatedAt,
      })),
      episodes: [...recent, ...similar],
    };
  }

  private async similar(
    userId: string,
    q: string,
    exclude: { id: string }[],
  ): Promise<MemoryView['episodes']> {
    const embedding = await this.embeddings.embedQuery(q);
    if (!embedding) return [];
    const qb = this.db
      .getRepository(MemoryEpisode)
      .createQueryBuilder('e')
      .select(EPISODE_COLUMNS)
      .where('e.user_id = :userId', { userId })
      .andWhere('e.embedding IS NOT NULL')
      .andWhere('1 - (e.embedding <=> CAST(:embedding AS vector)) >= :min', {
        embedding: toVectorLiteral(embedding),
        min: EPISODE_MIN_SIMILARITY,
      })
      .orderBy('e.embedding <=> CAST(:embedding AS vector)', 'ASC')
      .limit(SIMILAR_EPISODES);
    if (exclude.length)
      qb.andWhere('e.id NOT IN (:...exclude)', {
        exclude: exclude.map((e) => e.id),
      });
    return qb.getRawMany();
  }

  /** One episode per conversation; a later call for the same conversation replaces it. */
  async recordEpisode(userId: string, dto: RecordEpisodeDto): Promise<void> {
    if (!(await this.isEnabled(userId))) throw memoryOff();
    const embedding = await this.embeddings.embedDocument(dto.summary);
    await this.db.transaction(async (m) => {
      await this.lockEnabled(m, userId);
      await m.query(
        `INSERT INTO "memory_episodes"
         ("user_id", "conversation_id", "summary", "outcome", "entities", "embedding")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector)
       ON CONFLICT ("user_id", "conversation_id") DO UPDATE SET
         "summary" = EXCLUDED."summary",
         "outcome" = EXCLUDED."outcome",
         "entities" = EXCLUDED."entities",
         "embedding" = EXCLUDED."embedding"`,
        [
          userId,
          dto.conversationId,
          dto.summary,
          dto.outcome ?? null,
          JSON.stringify({
            orders: dto.entities?.orders ?? [],
            products: dto.entities?.products ?? [],
          }),
          embedding ? toVectorLiteral(embedding) : null,
        ],
      );
    });
  }

  /** Upsert by (kind, value ignoring case and spaces). */
  async saveFact(userId: string, dto: SaveFactDto): Promise<{ id: string }> {
    const valueKey = dto.value.toLowerCase().replace(/\s+/g, ' ');
    return this.db.transaction(async (m) => {
      await this.lockEnabled(m, userId);
      const [{ count }]: { count: number }[] = await m.query(
        `SELECT count(*)::int AS count FROM "memory_facts"
         WHERE "user_id" = $1 AND NOT ("kind" = $2 AND "value_key" = $3)`,
        [userId, dto.kind, valueKey],
      );
      if (count >= MAX_FACTS)
        throw new BadRequestException(
          `The assistant can remember up to ${MAX_FACTS} things. Forget some first.`,
        );
      const [row]: { id: string }[] = await m.query(
        `INSERT INTO "memory_facts"
           ("user_id", "kind", "value", "value_key", "confidence", "source_conversation_id")
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ("user_id", "kind", "value_key") DO UPDATE SET
           "value" = EXCLUDED."value",
           "confidence" = EXCLUDED."confidence",
           "source_conversation_id" = EXCLUDED."source_conversation_id",
           "updated_at" = now()
         RETURNING "id"`,
        [
          userId,
          dto.kind,
          dto.value,
          valueKey,
          dto.confidence ?? 1,
          dto.sourceConversationId ?? null,
        ],
      );
      return { id: row.id };
    });
  }

  async deleteFact(userId: string, id: string): Promise<void> {
    const result = await this.db
      .getRepository(MemoryFact)
      .delete({ id, userId });
    if (!result.affected)
      throw new NotFoundException('That memory was not found');
  }

  /** Turning memory off also deletes everything remembered. */
  async setEnabled(userId: string, enabled: boolean): Promise<MemoryView> {
    await this.db.transaction(async (m) => {
      await m.query(
        `INSERT INTO "memory_settings" ("user_id", "enabled") VALUES ($1, $2)
         ON CONFLICT ("user_id") DO UPDATE SET "enabled" = EXCLUDED."enabled", "updated_at" = now()`,
        [userId, enabled],
      );
      if (!enabled) await this.wipeWith(m, userId);
    });
    return this.all(userId);
  }

  async wipe(userId: string): Promise<void> {
    await this.db.transaction((m) => this.wipeWith(m, userId));
  }

  private async wipeWith(m: EntityManager, userId: string) {
    await m.delete(MemoryFact, { userId });
    await m.delete(MemoryEpisode, { userId });
  }

  /**
   * Locks the shopper's settings row for the transaction, so a write can't land after memory
   * was switched off (and wiped), and two fact writes can't both pass MAX_FACTS.
   */
  private async lockEnabled(m: EntityManager, userId: string) {
    const rows: { enabled: boolean }[] = await m.query(
      `SELECT "enabled" FROM "memory_settings" WHERE "user_id" = $1 FOR UPDATE`,
      [userId],
    );
    if (!rows[0]?.enabled) throw memoryOff();
  }
}

/** For agent-service only (chat token + service token). It can't switch memory on. */
@ApiTags('memory')
@ApiBearerAuth()
@AgentAllowed()
@UseGuards(TrustedAgentGuard, JwtAuthGuard)
@AuditWithoutBody()
@Controller('memory')
export class AgentMemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get()
  get(@CurrentUser() user: AuthUser, @Query() query: MemoryQueryDto) {
    return this.memory.get(user.id, query.q);
  }

  @Post('episodes')
  @HttpCode(204)
  recordEpisode(@CurrentUser() user: AuthUser, @Body() dto: RecordEpisodeDto) {
    return this.memory.recordEpisode(user.id, dto);
  }

  @Post('facts')
  saveFact(@CurrentUser() user: AuthUser, @Body() dto: SaveFactDto) {
    return this.memory.saveFact(user.id, dto);
  }

  @Delete('facts/:id')
  @HttpCode(204)
  deleteFact(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.memory.deleteFact(user.id, id);
  }
}

/** For the storefront account page (session cookie). Not reachable from chat. */
@ApiTags('memory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('account/memory')
export class AccountMemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.memory.all(user.id);
  }

  @Put()
  set(@CurrentUser() user: AuthUser, @Body() dto: SetMemoryDto) {
    return this.memory.setEnabled(user.id, dto.enabled);
  }

  @Delete()
  @HttpCode(204)
  wipe(@CurrentUser() user: AuthUser) {
    return this.memory.wipe(user.id);
  }

  @Delete('facts/:id')
  @HttpCode(204)
  deleteFact(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.memory.deleteFact(user.id, id);
  }
}

@Module({
  imports: [SearchModule],
  controllers: [AgentMemoryController, AccountMemoryController],
  providers: [MemoryService],
})
export class MemoryModule {}
