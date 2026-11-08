import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Injectable,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import { Repository } from 'typeorm';
import {
  CurrentUser,
  OptionalJwtAuthGuard,
  type AuthUser,
} from '../auth/auth.guards.js';
import { SupportTicket, type TicketPriority } from '../database/entities.js';

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

@Injectable()
export class SupportService {
  constructor(
    @InjectRepository(SupportTicket)
    private readonly tickets: Repository<SupportTicket>,
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
  create(
    @CurrentUser() user: AuthUser | undefined,
    @Body() dto: CreateTicketDto,
    @Headers('x-conversation-id') conversationId?: string,
  ) {
    return this.support.create(user, dto, conversationId);
  }
}

@Module({ controllers: [SupportController], providers: [SupportService] })
export class SupportModule {}
