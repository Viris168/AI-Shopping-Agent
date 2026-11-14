import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DataSource } from 'typeorm';
import {
  AgentAllowed,
  CurrentUser,
  OptionalJwtAuthGuard,
  type AuthUser,
} from '../auth/auth.guards.js';
import { AuditWithoutBody } from '../common/agent-audit.interceptor.js';
import type { AgentRequest } from '../common/service-token.middleware.js';
import {
  CONVERSATION_OUTCOMES,
  Conversation,
  type ConversationFeedback,
  type ConversationOutcome,
  ROUTING_GROUPS,
  type RoutingGroup,
} from '../database/entities.js';
import { ConversationRetentionJob } from './retention.job.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RecordTurnDto {
  // Anthropic message objects, already masked by agent-service; stored as-is.
  @IsArray()
  @ArrayMaxSize(100)
  @IsObject({ each: true })
  messages: Record<string, unknown>[];

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;

  @IsOptional()
  @IsIn(CONVERSATION_OUTCOMES)
  outcome?: ConversationOutcome;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  tokensIn?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  tokensOut?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  tokensCacheRead?: number;

  // Estimated model cost of this turn in millionths of a US dollar.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  costMicroUsd?: number;

  // Model-routing rollout group; kept from the first turn that sends it.
  @IsOptional()
  @IsIn(ROUTING_GROUPS)
  routingGroup?: RoutingGroup;
}

export class FeedbackDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  messageId: string;

  @IsIn(['up', 'down'])
  rating: 'up' | 'down';

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

/** Transcripts are written by agent-service only (valid X-Service-Token), never by browsers. */
@Injectable()
export class TrustedAgentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!context.switchToHttp().getRequest<AgentRequest>().isTrustedAgent)
      throw new ForbiddenException('Only the shopping assistant can do this');
    return true;
  }
}

@Injectable()
export class ConversationsService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /**
   * Appends one turn, creating the row on first use. Ownership is in the upsert's WHERE:
   * a guest row can be claimed by the shopper who logs in, but a shopper's row is never
   * written by a guest or another shopper.
   */
  async recordTurn(id: string, userId: string | null, dto: RecordTurnDto) {
    const rows: { id: string }[] = await this.db.query(
      `INSERT INTO "conversations" AS c
         ("id", "user_id", "messages", "summary", "outcome", "tokens_in", "tokens_out",
          "tokens_cache_read", "cost_micro_usd", "routing_group")
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT ("id") DO UPDATE SET
         "user_id" = EXCLUDED."user_id",
         "messages" = c."messages" || EXCLUDED."messages",
         "summary" = COALESCE(EXCLUDED."summary", c."summary"),
         "outcome" = COALESCE(EXCLUDED."outcome", c."outcome"),
         "tokens_in" = c."tokens_in" + EXCLUDED."tokens_in",
         "tokens_out" = c."tokens_out" + EXCLUDED."tokens_out",
         "tokens_cache_read" = c."tokens_cache_read" + EXCLUDED."tokens_cache_read",
         "cost_micro_usd" = c."cost_micro_usd" + EXCLUDED."cost_micro_usd",
         "routing_group" = COALESCE(c."routing_group", EXCLUDED."routing_group"),
         "updated_at" = now()
       WHERE c."user_id" IS NULL OR c."user_id" = EXCLUDED."user_id"
       RETURNING "id"`,
      [
        id,
        userId,
        JSON.stringify(dto.messages),
        dto.summary ?? null,
        dto.outcome ?? null,
        dto.tokensIn ?? 0,
        dto.tokensOut ?? 0,
        dto.tokensCacheRead ?? 0,
        dto.costMicroUsd ?? 0,
        dto.routingGroup ?? null,
      ],
    );
    if (rows.length === 0)
      throw new NotFoundException('Conversation not found');
  }

  async addFeedback(id: string, userId: string | null, dto: FeedbackDto) {
    const entry: ConversationFeedback = {
      messageId: dto.messageId,
      rating: dto.rating,
      comment: dto.comment || null,
      at: new Date().toISOString(),
    };
    const result = await this.db
      .createQueryBuilder()
      .update(Conversation)
      .set({ feedback: () => `"feedback" || CAST(:entry AS jsonb)` })
      .where(
        'id = :id AND user_id IS NOT DISTINCT FROM CAST(:userId AS uuid)',
        {
          id,
          userId,
        },
      )
      .setParameter('entry', JSON.stringify([entry]))
      .execute();
    if (!result.affected) throw new NotFoundException('Conversation not found');
  }
}

@ApiTags('conversations')
@ApiBearerAuth()
@AgentAllowed()
@UseGuards(TrustedAgentGuard, OptionalJwtAuthGuard)
@AuditWithoutBody()
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post(':id/turns')
  @HttpCode(204)
  recordTurn(
    @CurrentUser() user: AuthUser | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordTurnDto,
  ) {
    return this.conversations.recordTurn(id, user?.id ?? null, dto);
  }

  @Post(':id/feedback')
  @HttpCode(204)
  feedback(
    @CurrentUser() user: AuthUser | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FeedbackDto,
  ) {
    return this.conversations.addFeedback(id, user?.id ?? null, dto);
  }
}

@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationRetentionJob],
})
export class ConversationsModule {}
