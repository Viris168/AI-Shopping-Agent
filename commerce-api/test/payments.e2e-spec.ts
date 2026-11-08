import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import Stripe from 'stripe';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { DEMO_PASSWORD, seed } from '../src/database/seed.js';
import { StockReleaseJob } from '../src/orders/stock-release.job.js';
import { PaymentsService } from '../src/payments/payments.module.js';
import { configureApp } from '../src/setup.js';

// Stripe Checkout + stock release (docs/ARCHITECTURE.md §11.7). Stripe's API is stubbed;
// webhooks are signed for real with a test secret. Real Postgres (shop_test), reseeded per test.
const WEBHOOK_SECRET = 'whsec_test_secret_for_e2e_only';
const SESSION_ID = 'cs_test_e2e_1';
const stripe = new Stripe('sk_test_e2e_dummy');

describe('payments (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let payments: PaymentsService;
  let token: string;

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_e2e_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: true,
    });
    configureApp(app);
    await app.init();
    db = app.get(getDataSourceToken());
    payments = app.get(PaymentsService);
    await seed(db);
    token = (
      await http()
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.com', password: DEMO_PASSWORD })
        .expect(200)
    ).body.accessToken;
  });

  beforeEach(async () => {
    await seed(db);
    vi.restoreAllMocks();
    vi.spyOn(payments, 'createSession').mockResolvedValue({
      id: SESSION_ID,
      url: 'https://checkout.stripe.com/c/pay/cs_test_e2e_1',
    });
  });

  afterAll(async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const authed = (req: request.Test) => req.auth(token, { type: 'bearer' });
  const stock = async (sku = 'CLO-002') =>
    (await http().get(`/api/v1/products/${sku}`)).body.stock as number;
  const order = async (orderNumber: string) =>
    (await authed(http().get(`/api/v1/orders/${orderNumber}`)).expect(200))
      .body;
  const cart = async () =>
    (await authed(http().get('/api/v1/cart')).expect(200)).body;

  /** Adds 2× CLO-002 and checks out; returns the checkout response. */
  async function checkout() {
    await authed(http().post('/api/v1/cart/items'))
      .send({ productId: 'CLO-002', quantity: 2 })
      .expect(200);
    return (await authed(http().post('/api/v1/checkout')).expect(201)).body;
  }

  async function orderRow(orderNumber: string) {
    const [row] = await db.query(
      `SELECT id, total_cents FROM orders WHERE order_number = $1`,
      [orderNumber],
    );
    return row as { id: string; total_cents: number };
  }

  function sessionFor(
    row: { id: string; total_cents: number },
    over: Partial<Stripe.Checkout.Session> = {},
  ) {
    return {
      id: SESSION_ID,
      object: 'checkout.session',
      client_reference_id: row.id,
      metadata: { orderId: row.id },
      amount_total: row.total_cents,
      status: 'complete',
      payment_status: 'paid',
      ...over,
    } as Stripe.Checkout.Session;
  }

  function webhook(
    type: string,
    object: Stripe.Checkout.Session,
    id = 'evt_test_1',
  ) {
    const payload = JSON.stringify({
      id,
      object: 'event',
      type,
      data: { object },
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });
    return http()
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature)
      .send(payload);
  }

  it('checkout holds stock in a PENDING order and returns the payment page', async () => {
    const body = await checkout();
    expect(body.status).toBe('PENDING');
    expect(body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(await stock()).toBe(13);
    expect((await cart()).items).toHaveLength(0);
  });

  it('rejects webhooks with a bad signature', async () => {
    await http()
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1,v1=deadbeef')
      .send({ id: 'evt_forged', type: 'checkout.session.completed' })
      .expect(400);
  });

  it('marks the order PAID once, however often Stripe redelivers', async () => {
    const { orderNumber } = await checkout();
    const row = await orderRow(orderNumber);
    for (let i = 0; i < 2; i++)
      await webhook('checkout.session.completed', sessionFor(row)).expect(200);
    expect((await order(orderNumber)).status).toBe('PAID');
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM payment_events`,
    );
    expect(n).toBe(1);
  });

  it('ignores a payment for a different amount', async () => {
    const { orderNumber } = await checkout();
    const row = await orderRow(orderNumber);
    await webhook(
      'checkout.session.completed',
      sessionFor(row, { amount_total: 1 }),
    ).expect(200);
    expect((await order(orderNumber)).status).toBe('PENDING');
  });

  it('releases stock when the session expires', async () => {
    const { orderNumber } = await checkout();
    const row = await orderRow(orderNumber);
    await webhook(
      'checkout.session.expired',
      sessionFor(row, { status: 'expired', payment_status: 'unpaid' }),
    ).expect(200);
    expect((await order(orderNumber)).status).toBe('CANCELLED');
    expect(await stock()).toBe(15);
  });

  it('undoes the order and refills the cart when Stripe is down', async () => {
    vi.spyOn(payments, 'createSession').mockRejectedValue(
      new Error('connect ETIMEDOUT'),
    );
    await authed(http().post('/api/v1/cart/items'))
      .send({ productId: 'CLO-002', quantity: 2 })
      .expect(200);
    const res = await authed(http().post('/api/v1/checkout')).expect(503);
    expect(res.body.message).toMatch(/cart is unchanged/);
    expect(await stock()).toBe(15);
    const items = (await cart()).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sku: 'CLO-002', quantity: 2 });
  });

  describe('resume payment', () => {
    const SERVICE_TOKEN = process.env.SERVICE_TOKEN!;
    const resume = (orderNumber: string) =>
      authed(http().post(`/api/v1/orders/${orderNumber}/payment`));
    const retrieve = () =>
      vi.spyOn(
        (payments as unknown as { stripe: Stripe }).stripe.checkout.sessions,
        'retrieve',
      );

    it('hands back the open payment page', async () => {
      const { orderNumber } = await checkout();
      retrieve().mockResolvedValue({
        status: 'open',
        url: 'https://checkout.stripe.com/c/pay/cs_test_e2e_1',
      } as never);
      const res = await resume(orderNumber).expect(200);
      expect(res.body).toEqual({
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_e2e_1',
      });
    });

    it("is not found for someone else's order", async () => {
      const { orderNumber } = await checkout();
      const bob = (
        await http()
          .post('/api/v1/auth/login')
          .send({ email: 'bob@example.com', password: DEMO_PASSWORD })
          .expect(200)
      ).body.accessToken;
      await http()
        .post(`/api/v1/orders/${orderNumber}/payment`)
        .auth(bob, { type: 'bearer' })
        .expect(404);
    });

    it('is off-limits to the agent', async () => {
      const { orderNumber } = await checkout();
      await resume(orderNumber)
        .set('X-Client', 'ai-agent')
        .set('X-Service-Token', SERVICE_TOKEN)
        .expect(403);
    });

    it('cancels and refills the cart once the link has expired', async () => {
      const { orderNumber } = await checkout();
      retrieve().mockResolvedValue({ status: 'expired', url: null } as never);
      vi.spyOn(payments, 'closeSession').mockResolvedValue({ state: 'closed' });
      const res = await resume(orderNumber).expect(409);
      expect(res.body.message).toMatch(/back in your cart/);
      expect((await order(orderNumber)).status).toBe('CANCELLED');
      expect(await stock()).toBe(15);
      expect((await cart()).items[0]).toMatchObject({
        sku: 'CLO-002',
        quantity: 2,
      });
      // Not PENDING any more.
      await resume(orderNumber).expect(409);
    });

    it('settles a session that was paid after all', async () => {
      const { orderNumber } = await checkout();
      const row = await orderRow(orderNumber);
      retrieve().mockResolvedValue({ status: 'complete', url: null } as never);
      vi.spyOn(payments, 'closeSession').mockResolvedValue({
        state: 'paid',
        session: sessionFor(row),
      });
      const res = await resume(orderNumber).expect(409);
      expect(res.body.message).toBe('This order is already paid');
      expect((await order(orderNumber)).status).toBe('PAID');
    });
  });

  describe('stock-release job', () => {
    const backdate = (orderNumber: string) =>
      db.query(
        `UPDATE orders SET created_at = now() - interval '31 minutes' WHERE order_number = $1`,
        [orderNumber],
      );

    it('cancels unpaid orders after 30 minutes and restores stock', async () => {
      const close = vi
        .spyOn(payments, 'closeSession')
        .mockResolvedValue({ state: 'closed' });
      const fresh = await checkout();
      const job = app.get(StockReleaseJob);
      expect(await job.run()).toBe(0); // too new
      await backdate(fresh.orderNumber);
      expect(await job.run()).toBe(1);
      expect(close).toHaveBeenCalledWith(SESSION_ID);
      expect((await order(fresh.orderNumber)).status).toBe('CANCELLED');
      expect(await stock()).toBe(15);
      expect(await job.run()).toBe(0); // nothing left to do
    });

    it('marks the order PAID if the shopper paid but the webhook was lost', async () => {
      const { orderNumber } = await checkout();
      const row = await orderRow(orderNumber);
      vi.spyOn(payments, 'closeSession').mockResolvedValue({
        state: 'paid',
        session: sessionFor(row),
      });
      await backdate(orderNumber);
      expect(await app.get(StockReleaseJob).run()).toBe(0);
      expect((await order(orderNumber)).status).toBe('PAID');
      expect(await stock()).toBe(13);
    });
  });
});
