import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Injectable,
  Logger,
  Module,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Raw, Repository } from 'typeorm';
import {
  CurrentUser,
  OptionalJwtAuthGuard,
  type AuthUser,
} from '../auth/auth.guards.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { SupportTicket, type TicketPriority } from '../database/entities.js';
import { HelpdeskClient, HelpdeskError } from './helpdesk.client.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTicketDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  conversationId?: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  summary: string;

  @IsOptional()
  @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: TicketPriority;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Please enter a valid email address' })
  @MaxLength(254)
  contactEmail?: string;
}

// Backoff 1, 2, 4 … 60 min; 30 attempts is about a day of helpdesk outage.
export const MAX_FORWARD_ATTEMPTS = 30;
export const forwardDelayMs = (attempt: number) =>
  Math.min(60, 2 ** (attempt - 1)) * 60_000;
// A push holds its ticket this long, so another replica's job can't push it at the same time.
const CLAIM_MS = 2 * 60_000;
const BATCH = 50;

/**
 * Pushes saved tickets to the helpdesk. The ticket is already in our database, so a failed
 * push never fails the shopper's request: the retry job tries again with backoff.
 */
@Injectable()
export class TicketForwarder {
  private readonly log = new Logger(TicketForwarder.name);

  constructor(
    @InjectRepository(SupportTicket)
    private readonly tickets: Repository<SupportTicket>,
    private readonly helpdesk: HelpdeskClient,
  ) {}

  /** True if this call pushed the ticket. Safe to call from several replicas at once. */
  async forward(ticketId: string): Promise<boolean> {
    if (!this.helpdesk.enabled) return false;
    // Claim: only one caller gets the row while its push is due.
    const claimed = await this.tickets
      .createQueryBuilder()
      .update(SupportTicket)
      .set({
        nextForwardAt: () =>
          `now() + make_interval(secs => ${CLAIM_MS / 1000})`,
        forwardAttempts: () => 'forward_attempts + 1',
      })
      .where('id = :id AND next_forward_at <= now()', { id: ticketId })
      .execute();
    if (!claimed.affected) return false;
    const ticket = await this.tickets.findOneByOrFail({ id: ticketId });

    try {
      const ref = await this.helpdesk.push(ticket);
      await this.tickets.update(ticket.id, {
        forwardedAt: new Date(),
        nextForwardAt: null,
        helpdeskRef: ref,
        forwardError: null,
      });
      return true;
    } catch (err) {
      const reason =
        err instanceof HelpdeskError ? err.message : 'unexpected error';
      if (!(err instanceof HelpdeskError)) this.log.error(err);
      const giveUp = ticket.forwardAttempts >= MAX_FORWARD_ATTEMPTS;
      await this.tickets.update(ticket.id, {
        nextForwardAt: giveUp
          ? null
          : new Date(Date.now() + forwardDelayMs(ticket.forwardAttempts)),
        forwardError: reason.slice(0, 300),
      });
      // Ticket ID only; the row has the shopper's details. Alert: helpdesk_forward_abandoned.
      if (giveUp)
        this.log.error(
          `helpdesk_forward_abandoned ticket=${ticket.id} after ${ticket.forwardAttempts} attempts: ${reason}`,
        );
      else
        this.log.warn(
          `helpdesk_forward_failed ticket=${ticket.id} attempt=${ticket.forwardAttempts}: ${reason}`,
        );
      return false;
    }
  }

  /** Retries due pushes (new tickets whose first push failed, and backed-off ones). */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'helpdesk-forward' })
  async retryDue(): Promise<number> {
    if (!this.helpdesk.enabled) return 0;
    const due = await this.tickets.find({
      select: { id: true },
      // Database clock, same as the claim in forward(): a JS Date is only ms-precise, so a row
      // made due with now() could look a fraction of a ms in the future and be skipped.
      where: { nextForwardAt: Raw((col) => `${col} <= now()`) },
      order: { nextForwardAt: 'ASC' },
      take: BATCH,
    });
    let pushed = 0;
    for (const { id } of due) if (await this.forward(id)) pushed++;
    return pushed;
  }
}

@Injectable()
export class SupportService {
  private readonly log = new Logger(SupportService.name);

  constructor(
    @InjectRepository(SupportTicket)
    private readonly tickets: Repository<SupportTicket>,
    private readonly forwarder: TicketForwarder,
  ) {}

  /** Agent-confirmed only (docs/AGENT.md §3). Guests must leave an email. */
  async create(
    user: AuthUser | undefined,
    dto: CreateTicketDto,
    headerConversationId?: string,
  ) {
    const contactEmail = dto.contactEmail ?? user?.email ?? null;
    if (!contactEmail)
      throw new BadRequestException(
        'Please provide a contact email so support can reply',
      );
    const priority = dto.priority ?? 'normal';
    const ticket = await this.tickets.save(
      this.tickets.create({
        userId: user?.id ?? null,
        conversationId:
          dto.conversationId ?? headerConversationId?.slice(0, 64) ?? null,
        contactEmail,
        subject: dto.subject,
        summary: dto.summary,
        priority,
      }),
    );
    // Inline so the helpdesk usually has it at once; the retry job covers failures. The ticket
    // is saved either way, so a forwarding error never fails the shopper's request.
    await this.forwarder
      .forward(ticket.id)
      .catch((err: unknown) => this.log.error(err));
    return {
      ticketId: ticket.id,
      status: ticket.status,
      expectedResponse:
        priority === 'high' || priority === 'urgent'
          ? 'within 2 hours'
          : 'within 24 hours',
    };
  }
}

@ApiTags('support')
@UseGuards(OptionalJwtAuthGuard)
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post('tickets')
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @CurrentUser() user: AuthUser | undefined,
    @Body() dto: CreateTicketDto,
    @Headers('x-conversation-id') conversationId?: string,
  ) {
    return this.support.create(user, dto, conversationId);
  }
}

@Module({
  controllers: [SupportController],
  providers: [SupportService, TicketForwarder, HelpdeskClient],
})
export class SupportModule {}
