import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Post,
  type RawBodyRequest,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import Stripe from 'stripe';
import { DataSource, EntityManager } from 'typeorm';
import { MAX_QTY_PER_ITEM } from '../cart/cart.dto.js';
import {
  Cart,
  Order,
  OrderItem,
  PaymentEvent,
  Product,
} from '../database/entities.js';

/** How long a PENDING order holds its stock while the shopper pays (docs/ARCHITECTURE.md §11.7). */
export const PAYMENT_WINDOW_MINUTES = 30;

/**
 * Stripe keys, read at call time. Both or neither: with neither, checkout stays the demo
 * (orders saved as PAID); a secret key without a webhook secret would leave every order PENDING.
 */
export function stripeConfig(): {
  secretKey: string;
  webhookSecret: string;
} | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey && !webhookSecret) return null;
  if (!secretKey || !webhookSecret)
    throw new Error(
      'Set both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, or neither',
    );
  return { secretKey, webhookSecret };
}

/**
 * Cancels a PENDING order and puts its stock back, in the caller's transaction.
 * The conditional update means a concurrent payment or a second release is a no-op.
 * `restoreCart` puts the items back in the shopper's cart (checkout failed before payment).
 * Returns false if the order was no longer PENDING.
 */
export async function releaseOrder(
  m: EntityManager,
  orderId: string,
  { restoreCart = false } = {},
): Promise<boolean> {
  const cancelled = await m
    .createQueryBuilder()
    .update(Order)
    .set({ status: 'CANCELLED' })
    .where("id = :id AND status = 'PENDING'", { id: orderId })
    .returning(['userId', 'couponCode'])
    .execute();
  if (!cancelled.affected) return false;
  const { user_id: userId, coupon_code: couponCode } = cancelled.raw[0] as {
    user_id: string;
    coupon_code: string | null;
  };

  const items = await m.find(OrderItem, { where: { orderId } });
  // Same order as checkout takes stock, so the two can't deadlock on product rows.
  const restock = items
    .filter((i): i is OrderItem & { productId: string } => i.productId !== null)
    .sort((a, b) => a.productId.localeCompare(b.productId));
  for (const item of restock) {
    await m
      .createQueryBuilder()
      .update(Product)
      .set({ stock: () => 'stock + :qty' })
      .where('id = :id', { id: item.productId, qty: item.quantity })
      .execute();
  }

  if (restoreCart) {
    const cart = await m.findOneByOrFail(Cart, { userId });
    for (const item of restock) {
      await m.query(
        `INSERT INTO "cart_items" ("cart_id", "product_id", "quantity") VALUES ($1, $2, $3)
         ON CONFLICT ("cart_id", "product_id")
         DO UPDATE SET "quantity" = LEAST("cart_items"."quantity" + EXCLUDED."quantity", $4)`,
        [cart.id, item.productId, item.quantity, MAX_QTY_PER_ITEM],
      );
    }
    if (couponCode && !cart.couponCode)
      await m.update(Cart, { id: cart.id }, { couponCode });
  }
  return true;
}

export interface SessionOrder {
  id: string;
  orderNumber: string;
  totalCents: number;
  itemNames: string[];
}

/** What a session means for its order once the payment window is over. */
export type ClosedSession =
  | { state: 'paid'; session: Stripe.Checkout.Session }
  | { state: 'processing' } // completed, payment still clearing
  | { state: 'closed' }; // expired; can no longer be paid

const orderIdOf = (s: Stripe.Checkout.Session) =>
  s.metadata?.orderId ?? s.client_reference_id;

/**
 * Stripe Checkout: checkout creates a hosted payment page for a PENDING order; the webhook
 * marks it PAID. Payment methods come from the Stripe account settings; delayed ones (bank
 * debits) keep the order PENDING until async_payment_succeeded/_failed arrives.
 * The amount is the order total commerce-api priced, as one line.
 */
@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);
  private readonly config = stripeConfig();
  private readonly stripe = this.config
    ? new Stripe(this.config.secretKey, {
        maxNetworkRetries: 2,
        timeout: 10_000,
      })
    : null;

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  get enabled(): boolean {
    return this.stripe !== null;
  }

  /** Returns the hosted page URL. Idempotent per order, so a retried checkout reuses it. */
  async createSession(
    order: SessionOrder,
  ): Promise<{ id: string; url: string }> {
    const stripe = this.client();
    const storefront = process.env.STOREFRONT_URL ?? 'http://localhost:8080';
    const orderPage = `${storefront}/orders/${encodeURIComponent(order.orderNumber)}`;
    const meta = { orderId: order.id, orderNumber: order.orderNumber };
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        client_reference_id: order.id,
        metadata: meta,
        payment_intent_data: { metadata: meta },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: order.totalCents,
              product_data: {
                name: `Order ${order.orderNumber}`,
                description: order.itemNames.join(', ').slice(0, 500),
              },
            },
          },
        ],
        success_url: `${orderPage}?payment=success`,
        cancel_url: `${orderPage}?payment=cancelled`,
        // Stripe's minimum is 30 minutes from creation; the extra minute absorbs clock skew.
        // The stock-release job expires it explicitly before cancelling anyway.
        expires_at:
          Math.floor(Date.now() / 1000) + (PAYMENT_WINDOW_MINUTES + 1) * 60,
      },
      { idempotencyKey: `checkout-session-${order.id}` },
    );
    if (!session.url)
      throw new Error('Stripe returned a session without a URL');
    return { id: session.id, url: session.url };
  }

  /**
   * The shopper left Stripe's page without paying: hand back the same page while the order
   * is inside its payment window. Past the window, or once Stripe has expired the session,
   * the order is settled now instead (paid, or cancelled with its items back in the cart),
   * so a new session is never opened for an order the stock-release job may be cancelling.
   */
  async resumeSession(
    userId: string,
    orderNumber: string,
  ): Promise<{ checkoutUrl: string }> {
    // Ownership in the query: someone else's order is "not found", same as a missing one.
    const order = await this.db.getRepository(Order).findOne({
      where: { userId, orderNumber: orderNumber.trim().toUpperCase() },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'PENDING' || !order.paymentSessionId || !this.stripe)
      throw new ConflictException('This order isn’t waiting for payment');
    const sessionId = order.paymentSessionId;

    try {
      const inWindow =
        Date.now() - order.createdAt.getTime() <
        PAYMENT_WINDOW_MINUTES * 60_000;
      if (inWindow) {
        const session = await this.stripe.checkout.sessions.retrieve(sessionId);
        if (session.status === 'open' && session.url)
          return { checkoutUrl: session.url };
      }
      const closed = await this.closeSession(sessionId);
      if (closed.state === 'paid') {
        await this.db.transaction((m) =>
          this.markPaid(m, order.id, closed.session),
        );
        throw new ConflictException('This order is already paid');
      }
      if (closed.state === 'processing')
        throw new ConflictException(
          'Your payment is still being processed. Check back in a few minutes.',
        );
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      this.log.error(
        `payment_resume_failed order=${order.orderNumber}: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'Payment is unavailable right now. Please try again in a few minutes.',
      );
    }
    const restored = await this.db.transaction((m) =>
      releaseOrder(m, order.id, { restoreCart: true }),
    );
    throw new ConflictException(
      restored
        ? 'This payment link has expired, so the order was cancelled. Its items are back in your cart.'
        : 'This order was cancelled because it wasn’t paid in time.',
    );
  }

  /** Makes sure the session can no longer be paid, and says whether it already was. */
  async closeSession(sessionId: string): Promise<ClosedSession> {
    const stripe = this.client();
    let session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === 'open')
      // Throws if the shopper completed it a moment ago; the job retries next minute.
      session = await stripe.checkout.sessions.expire(sessionId);
    if (session.status !== 'complete') return { state: 'closed' };
    return session.payment_status === 'unpaid'
      ? { state: 'processing' }
      : { state: 'paid', session };
  }

  /**
   * PENDING → PAID, bound to this session and the exact amount we priced.
   * Anything else is logged for staff: a payment for a cancelled order needs a refund.
   */
  async markPaid(
    m: EntityManager,
    orderId: string,
    session: Stripe.Checkout.Session,
  ): Promise<boolean> {
    const paid = await m
      .createQueryBuilder()
      .update(Order)
      .set({ status: 'PAID', paidAt: () => 'now()' })
      .where(
        `id = :id AND status = 'PENDING' AND payment_session_id = :sessionId AND total_cents = :amount`,
        { id: orderId, sessionId: session.id, amount: session.amount_total },
      )
      .execute();
    if (paid.affected) return true;
    const order = await m.findOneBy(Order, { id: orderId });
    if (order?.status !== 'PAID' || order.paymentSessionId !== session.id)
      this.log.error(
        `payment_not_applied order=${orderId} status=${order?.status ?? 'missing'} ` +
          `session=${session.id} amount=${session.amount_total} expected=${order?.totalCents}`,
      );
    return false;
  }

  /** Verifies the signature, then applies the event once (event ID is the dedupe key). */
  async handleWebhook(
    payload: Buffer | undefined,
    signature: string | undefined,
  ) {
    const stripe = this.client();
    let event: Stripe.Event;
    try {
      if (!payload || !signature)
        throw new Error('missing payload or signature');
      event = stripe.webhooks.constructEvent(
        payload,
        signature,
        this.config!.webhookSecret,
      );
    } catch (err) {
      this.log.warn(`webhook_rejected: ${(err as Error).message}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    if (
      event.type !== 'checkout.session.completed' &&
      event.type !== 'checkout.session.async_payment_succeeded' &&
      event.type !== 'checkout.session.async_payment_failed' &&
      event.type !== 'checkout.session.expired'
    )
      return { received: true };
    const session = event.data.object;
    const orderId = orderIdOf(session);
    if (!orderId) {
      this.log.warn(`webhook_without_order event=${event.id}`);
      return { received: true };
    }

    await this.db.transaction(async (m) => {
      const recorded = await m
        .createQueryBuilder()
        .insert()
        .into(PaymentEvent)
        .values({ id: event.id, type: event.type })
        .orIgnore()
        .returning('id')
        .execute();
      // Redelivery: already applied (or still applying, and the insert waited for it).
      if (!(recorded.raw as unknown[]).length) return;

      if (
        event.type === 'checkout.session.expired' ||
        event.type === 'checkout.session.async_payment_failed'
      ) {
        await releaseOrder(m, orderId);
      } else if (session.payment_status !== 'unpaid') {
        await this.markPaid(m, orderId, session);
      }
    });
    return { received: true };
  }

  private client(): Stripe {
    if (!this.stripe) throw new Error('Stripe is not configured');
    return this.stripe;
  }
}

/** Called by Stripe only; authenticated by the signature, not a shopper token. */
@ApiExcludeController()
@SkipThrottle()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    if (!this.payments.enabled)
      throw new BadRequestException('Payments are not configured');
    return this.payments.handleWebhook(req.rawBody, signature);
  }
}

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
