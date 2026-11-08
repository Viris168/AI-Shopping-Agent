import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AgentAllowed,
  CurrentUser,
  JwtAuthGuard,
  type AuthUser,
} from '../auth/auth.guards.js';
import { formatMoney } from '../common/money.js';
import type { AgentRequest } from '../common/service-token.middleware.js';
import { Order } from '../database/entities.js';
import {
  PaymentsModule,
  PaymentsService,
} from '../payments/payments.module.js';
import { StockReleaseJob } from './stock-release.job.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const returnWindowDays = () =>
  Number(process.env.RETURN_WINDOW_DAYS ?? 30);

/** Last moment a return can be started, or null if the order isn't delivered. */
export function returnDeadline(order: Order): Date | null {
  if (order.status !== 'DELIVERED' || !order.deliveredAt) return null;
  return new Date(order.deliveredAt.getTime() + returnWindowDays() * DAY_MS);
}

// Carriers' public tracking pages. Their hosts must be in the widget's data-link-domains,
// or the widget drops the link (widget/src/safe.ts).
const TRACKING_URLS: Partial<Record<string, (n: string) => string>> = {
  UPS: (n) => `https://www.ups.com/track?loc=en_US&tracknum=${n}`,
  FEDEX: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  DHL: (n) =>
    `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}`,
};

// Spellings seen in carrier feeds and admin entry, after stripping spaces, dots and dashes.
const CARRIER_ALIASES: Record<string, string> = {
  UNITEDPARCELSERVICE: 'UPS',
  FEDERALEXPRESS: 'FEDEX',
  UNITEDSTATESPOSTALSERVICE: 'USPS',
  DHLEXPRESS: 'DHL',
};

// Every supported carrier uses letters and digits only; anything else is a data-entry error.
const TRACKING_NUMBER = /^[A-Z0-9]{8,40}$/;

export function trackingUrl(
  carrier: string | null,
  trackingNumber: string | null,
): string | null {
  if (!carrier || !trackingNumber) return null;
  const key = carrier.toUpperCase().replace(/[\s.-]/g, '');
  const build = TRACKING_URLS[CARRIER_ALIASES[key] ?? key];
  const number = trackingNumber.toUpperCase().replace(/\s/g, '');
  return build && TRACKING_NUMBER.test(number) ? build(number) : null;
}

// Shapes from docs/AGENT.md §4. `items` must be loaded.
function toSummary(o: Order, now = new Date()) {
  const deadline = returnDeadline(o);
  return {
    orderNumber: o.orderNumber,
    status: o.status,
    placedAt: o.createdAt,
    total: formatMoney(o.totalCents),
    totalCents: o.totalCents,
    itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
    carrier: o.carrier,
    trackingNumber: o.trackingNumber,
    trackingUrl: trackingUrl(o.carrier, o.trackingNumber),
    shippedAt: o.shippedAt,
    deliveredAt: o.deliveredAt,
    returnEligible: deadline !== null && deadline > now,
    returnDeadline: deadline,
  };
}

function toDetail(o: Order) {
  return {
    ...toSummary(o),
    couponCode: o.couponCode,
    subtotal: formatMoney(o.subtotalCents),
    discount: formatMoney(o.discountCents),
    shipping: formatMoney(o.shippingCents),
    items: o.items.map((i) => ({
      orderItemId: i.id,
      productId: i.productId,
      name: i.nameSnapshot,
      quantity: i.quantity,
      unitPrice: formatMoney(i.unitPriceCents),
      unitPriceCents: i.unitPriceCents,
    })),
    returns: (o.returns ?? []).map((r) => ({
      returnId: r.id,
      status: r.status,
      createdAt: r.createdAt,
    })),
  };
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  async list(userId: string) {
    const orders = await this.orders.find({
      where: { userId },
      relations: { items: true },
      order: { createdAt: 'DESC' },
      take: 20,
    });
    return orders.map((o) => toSummary(o));
  }

  async get(userId: string, orderNumber: string) {
    // Ownership in the query: someone else's order is "not found", same as a missing one.
    const order = await this.orders.findOne({
      where: { userId, orderNumber: orderNumber.trim().toUpperCase() },
      relations: { items: true, returns: true },
      order: { items: { nameSnapshot: 'ASC' }, returns: { createdAt: 'ASC' } },
    });
    if (!order) throw new NotFoundException('Order not found');
    return toDetail(order);
  }
}

@ApiTags('orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
  ) {}

  @Get()
  @AgentAllowed()
  list(@CurrentUser() user: AuthUser) {
    return this.orders.list(user.id);
  }

  @Get(':orderNumber')
  @AgentAllowed()
  get(
    @CurrentUser() user: AuthUser,
    @Param('orderNumber') orderNumber: string,
  ) {
    return this.orders.get(user.id, orderNumber);
  }

  /** Storefront only, like POST /checkout: the agent never handles payment (docs/AGENT.md §3). */
  @Post(':orderNumber/payment')
  @HttpCode(200)
  resumePayment(
    @CurrentUser() user: AuthUser,
    @Param('orderNumber') orderNumber: string,
    @Req() req: AgentRequest,
  ) {
    if (req.isTrustedAgent)
      throw new ForbiddenException('Payment happens on the checkout page');
    return this.payments.resumeSession(user.id, orderNumber);
  }
}

@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController],
  providers: [OrdersService, StockReleaseJob],
  exports: [OrdersService],
})
export class OrdersModule {}
