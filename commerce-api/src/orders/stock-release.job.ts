import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  PAYMENT_WINDOW_MINUTES,
  PaymentsService,
  releaseOrder,
} from '../payments/payments.module.js';

// Each order may need a Stripe call, so keep a run short; the rest wait a minute.
const BATCH = 100;
// Any constant works; it only has to match on every replica.
const LOCK_KEY = 7_340_091;

/**
 * Every minute, cancels PENDING orders older than the payment window and restores their stock.
 * The Stripe session is closed first, so a shopper can't pay for an order that was just
 * cancelled; if it turns out to be paid, the order is marked PAID instead.
 * Runs on every replica; the advisory lock lets one of them do the work.
 */
@Injectable()
export class StockReleaseJob {
  private readonly log = new Logger(StockReleaseJob.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly payments: PaymentsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'stock-release' })
  async run(): Promise<number> {
    // Session-level lock, so take and release it on one connection.
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }]: { locked: boolean }[] = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [LOCK_KEY],
      );
      if (!locked) return 0;
      try {
        return await this.releaseStale();
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    } finally {
      await runner.release();
    }
  }

  private async releaseStale(): Promise<number> {
    // Uses the (status, created_at) index.
    const stale: { id: string; payment_session_id: string | null }[] =
      await this.db.query(
        `SELECT "id", "payment_session_id" FROM "orders"
         WHERE "status" = 'PENDING' AND "created_at" < now() - make_interval(mins => $1)
         ORDER BY "created_at" LIMIT $2`,
        [PAYMENT_WINDOW_MINUTES, BATCH],
      );
    let released = 0;
    for (const order of stale) {
      try {
        if (order.payment_session_id) {
          if (!this.payments.enabled) {
            this.log.warn(
              `Order ${order.id} has a payment session but Stripe is not configured; leaving it PENDING`,
            );
            continue;
          }
          const session = await this.payments.closeSession(
            order.payment_session_id,
          );
          if (session.state === 'paid') {
            // The webhook is late or lost; apply the payment now.
            await this.db.transaction((m) =>
              this.payments.markPaid(m, order.id, session.session),
            );
            continue;
          }
          if (session.state === 'processing') continue;
        }
        if (await this.db.transaction((m) => releaseOrder(m, order.id)))
          released++;
      } catch (err) {
        // Stripe or DB hiccup: try this order again next minute.
        this.log.error(
          `stock_release_failed order=${order.id}: ${(err as Error).message}`,
        );
      }
    }
    if (released)
      this.log.log(
        `Cancelled ${released} unpaid orders older than ${PAYMENT_WINDOW_MINUTES} minutes`,
      );
    return released;
  }
}
