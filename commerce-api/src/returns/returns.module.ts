import {
  BadRequestException,
  Body,
  Controller,
  Injectable,
  Module,
  NotFoundException,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DataSource, In } from 'typeorm';
import {
  AgentAllowed,
  CurrentUser,
  JwtAuthGuard,
  type AuthUser,
} from '../auth/auth.guards.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { Order, OrderItem, ReturnRequest } from '../database/entities.js';
import { returnDeadline, returnWindowDays } from '../orders/orders.module.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class ReturnItemDto {
  @IsUUID()
  orderItemId: string;

  @IsInt()
  @Min(1)
  @Max(100)
  quantity: number;
}

export class CreateReturnDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  orderNumber: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[];
}

const NEXT_STEPS =
  'A prepaid return label will be emailed within 24 hours. Refunds are issued 3–5 business days after we receive the item.';

@Injectable()
export class ReturnsService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** Agent-confirmed only (docs/AGENT.md §3). The order row is locked so two requests can't both open a return. */
  create(userId: string, dto: CreateReturnDto) {
    return this.db.transaction(async (m) => {
      const order = await m.findOne(Order, {
        where: { userId, orderNumber: dto.orderNumber.toUpperCase() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (order.status !== 'DELIVERED')
        throw new BadRequestException('Only delivered orders can be returned');
      const deadline = returnDeadline(order);
      if (!deadline || deadline <= new Date())
        throw new BadRequestException(
          `The ${returnWindowDays()}-day return window has closed`,
        );
      const open = await m.existsBy(ReturnRequest, {
        orderId: order.id,
        status: In(['REQUESTED', 'APPROVED']),
      });
      if (open)
        throw new BadRequestException(
          'A return is already open for this order',
        );

      const purchased = new Map(
        (await m.findBy(OrderItem, { orderId: order.id })).map((i) => [
          i.id,
          i,
        ]),
      );
      const seen = new Set<string>();
      for (const item of dto.items) {
        const line = purchased.get(item.orderItemId);
        if (!line)
          throw new BadRequestException(
            `Item ${item.orderItemId} is not part of this order`,
          );
        if (seen.has(item.orderItemId))
          throw new BadRequestException('Each item can only be listed once');
        seen.add(item.orderItemId);
        if (item.quantity > line.quantity)
          throw new BadRequestException('Quantity exceeds purchased amount');
      }

      const saved = await m.save(
        m.create(ReturnRequest, {
          orderId: order.id,
          userId,
          reason: dto.reason,
          items: dto.items.map((i) => ({
            orderItemId: i.orderItemId,
            quantity: i.quantity,
          })),
        }),
      );
      return {
        returnId: saved.id,
        status: saved.status,
        nextSteps: NEXT_STEPS,
      };
    });
  }
}

@ApiTags('returns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('returns')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Post()
  @AgentAllowed()
  @UseInterceptors(IdempotencyInterceptor)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateReturnDto) {
    return this.returns.create(user.id, dto);
  }
}

@Module({ controllers: [ReturnsController], providers: [ReturnsService] })
export class ReturnsModule {}
