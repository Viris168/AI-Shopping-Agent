import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { seed } from '../src/database/seed.js';
import { configureApp } from '../src/setup.js';
import { agentToken, login as loginAs } from './auth.js';

// Agent readiness (docs/ARCHITECTURE.md §11.1–11.4): service token, audit failures,
// idempotency keys and per-user throttling. Real Postgres (shop_test), reseeded per test.
const SERVICE_TOKEN = process.env.SERVICE_TOKEN!;

async function createApp() {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}

describe('agent hardening (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let aliceToken: string;
  let bobToken: string;
  let aliceAgent: string;

  beforeAll(async () => {
    app = await createApp();
    db = app.get(getDataSourceToken());
    await seed(db);
    aliceToken = await login();
    bobToken = await login('bob@example.com');
    aliceAgent = await agentToken(app, aliceToken);
  });

  beforeEach(() => seed(db));

  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());
  const login = (email?: string) => loginAs(app, email);
  const agent = (token?: string) => {
    const post = (path: string, body?: object) => {
      const req = http()
        .post(path)
        .set('X-Client', 'ai-agent')
        .set('X-Service-Token', SERVICE_TOKEN)
        .set('X-Conversation-Id', 'conv-7');
      return (token ? req.auth(token, { type: 'bearer' }) : req).send(body);
    };
    return { post };
  };
  const message = (body: { message: string | string[] }) => body.message;
  const audit = () =>
    db.query(
      `SELECT action, status, error, conversation_id FROM agent_action_logs ORDER BY created_at`,
    );

  describe('service token', () => {
    it('rejects X-Client: ai-agent without a valid token', async () => {
      for (const token of [undefined, 'wrong', `${SERVICE_TOKEN}x`]) {
        const req = http()
          .post('/api/v1/cart/items')
          .auth(aliceToken, { type: 'bearer' })
          .set('X-Client', 'ai-agent');
        if (token) req.set('X-Service-Token', token);
        await req
          .send({ productId: 'SHOE-002' })
          .expect(403)
          .expect((r) =>
            expect(message(r.body)).toBe(
              'Agent requests need a valid service token',
            ),
          );
      }
      expect(
        (await http().get('/api/v1/cart').auth(aliceToken, { type: 'bearer' }))
          .body.itemCount,
      ).toBe(0);
      expect(await audit()).toEqual([]);
    });

    it('accepts agent traffic with the token, and audits only that', async () => {
      await agent(aliceAgent)
        .post('/api/v1/cart/items', { productId: 'SHOE-002' })
        .expect(200);
      // A storefront mutation (no agent headers) isn't audited.
      await http()
        .post('/api/v1/cart/items')
        .auth(aliceToken, { type: 'bearer' })
        .send({ productId: 'SHOE-001' })
        .expect(200);
      await expect.poll(audit).toEqual([
        {
          action: 'POST /cart/items',
          status: 200,
          error: null,
          conversation_id: 'conv-7',
        },
      ]);
    });
  });

  describe('audit', () => {
    it('logs failed agent mutations with status and message', async () => {
      await agent(aliceAgent)
        .post('/api/v1/cart/items', { productId: 'SHOE-003' })
        .expect(400);
      await agent(aliceAgent)
        .post('/api/v1/returns', {
          orderNumber: 'ORD-9999',
          reason: 'x',
          items: [{ orderItemId: randomUUID(), quantity: 1 }],
        })
        .expect(404);
      await expect.poll(audit).toEqual([
        {
          action: 'POST /cart/items',
          status: 400,
          error: '"Summit Waterproof Hiking Boots" is out of stock',
          conversation_id: 'conv-7',
        },
        {
          action: 'POST /returns',
          status: 404,
          error: 'Order not found',
          conversation_id: 'conv-7',
        },
      ]);
    });
  });

  describe('idempotency', () => {
    const returnBody = async (quantity = 1) => {
      const order = (
        await http()
          .get('/api/v1/orders/ORD-1001')
          .auth(aliceToken, { type: 'bearer' })
      ).body;
      const shirt = order.items.find(
        (i: { name: string }) => i.name === 'Merino Crew T-Shirt',
      );
      return {
        orderNumber: 'ORD-1001',
        reason: 'Too small',
        items: [{ orderItemId: shirt.orderItemId, quantity }],
      };
    };
    const createReturn = (key: string, body: object, token = aliceToken) =>
      http()
        .post('/api/v1/returns')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', key)
        .send(body);
    const count = async (table: string) =>
      Number((await db.query(`SELECT count(*) FROM ${table}`))[0].count);

    it('replays the stored response for a retried return', async () => {
      const key = randomUUID();
      const body = await returnBody();
      const first = await createReturn(key, body).expect(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      // Same body with keys in a different order still matches.
      const retry = await createReturn(key, {
        items: body.items,
        reason: body.reason,
        orderNumber: body.orderNumber,
      }).expect(201);
      expect(retry.body).toEqual(first.body);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(await count('return_requests')).toBe(1);
    });

    it('rejects a reused key with a different body', async () => {
      const key = randomUUID();
      await createReturn(key, await returnBody(1)).expect(201);
      await createReturn(key, await returnBody(2))
        .expect(422)
        .expect((r) =>
          expect(message(r.body)).toBe(
            'This Idempotency-Key was already used for a different request',
          ),
        );
    });

    it('frees the key when the request fails, so it can be retried', async () => {
      const key = randomUUID();
      await createReturn(key, await returnBody(3)).expect(400);
      await createReturn(key, await returnBody(2)).expect(201);
      expect(await count('return_requests')).toBe(1);
    });

    it('scopes keys per user', async () => {
      const key = randomUUID();
      const body = await returnBody();
      await createReturn(key, body).expect(201);
      // Bob reusing Alice's key gets his own result, not Alice's stored response.
      await createReturn(key, body, bobToken)
        .expect(404)
        .expect((r) => expect(message(r.body)).toBe('Order not found'));
    });

    it('lets concurrent duplicates create only one return', async () => {
      const key = randomUUID();
      const body = await returnBody();
      const results = await Promise.all([
        createReturn(key, body),
        createReturn(key, body),
      ]);
      expect(results.map((r) => r.status)).toContain(201);
      for (const r of results) expect([201, 409]).toContain(r.status);
      expect(await count('return_requests')).toBe(1);
    });

    it('expires keys after 24 hours', async () => {
      const key = randomUUID();
      await createReturn(key, await returnBody(1)).expect(201);
      await db.query(
        `UPDATE idempotency_keys SET created_at = now() - interval '25 hours'`,
      );
      await db.query(`UPDATE return_requests SET status = 'REJECTED'`);
      await createReturn(key, await returnBody(2)).expect(201);
      expect(await count('return_requests')).toBe(2);
    });

    it('rejects malformed keys', async () => {
      await createReturn('has spaces', await returnBody()).expect(400);
      await createReturn('x'.repeat(101), await returnBody()).expect(400);
      expect(await count('return_requests')).toBe(0);
    });

    it('covers guest support tickets', async () => {
      const key = randomUUID();
      const ticket = () =>
        http()
          .post('/api/v1/support/tickets')
          .set('Idempotency-Key', key)
          .send({
            subject: 'Help',
            summary: 'Guest',
            contactEmail: 'guest@example.com',
          });
      const first = await ticket().expect(201);
      const retry = await ticket().expect(201);
      expect(retry.body.ticketId).toBe(first.body.ticketId);
      expect(await count('support_tickets')).toBe(1);
    });

    it('covers checkout: one order, stock taken once', async () => {
      const key = randomUUID();
      await http()
        .post('/api/v1/cart/items')
        .auth(aliceToken, { type: 'bearer' })
        .send({ productId: 'CLO-002', quantity: 2 })
        .expect(200);
      const pay = () =>
        http()
          .post('/api/v1/checkout')
          .auth(aliceToken, { type: 'bearer' })
          .set('Idempotency-Key', key);
      const first = await pay().expect(201);
      const retry = await pay().expect(201);
      expect(retry.body.orderNumber).toBe(first.body.orderNumber);
      expect((await http().get('/api/v1/products/CLO-002')).body.stock).toBe(
        13,
      );
      // Without the key, a second checkout is a new request (and the cart is empty).
      await http()
        .post('/api/v1/checkout')
        .auth(aliceToken, { type: 'bearer' })
        .expect(400);
    });
  });
});

describe('per-user throttling (e2e)', () => {
  const LIMIT = 5;
  let app: INestApplication<App>;
  let jwt: JwtService;
  const previous = process.env.RATE_LIMIT_PER_MIN;

  // Own app with a low limit, so the main suite's buckets don't interfere.
  beforeAll(async () => {
    process.env.RATE_LIMIT_PER_MIN = String(LIMIT);
    app = await createApp();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    process.env.RATE_LIMIT_PER_MIN = previous;
    await app.close();
  });

  const tokenFor = (sub = randomUUID()) =>
    jwt.signAsync(
      { sub, ver: 0, name: 'T', role: 'CUSTOMER' },
      { audience: 'storefront' },
    );
  const products = (token?: string) => {
    const req = request(app.getHttpServer()).get('/api/v1/products');
    return token ? req.auth(token, { type: 'bearer' }) : req;
  };

  it('gives each shopper their own bucket on a shared IP', async () => {
    const a = await tokenFor();
    const b = await tokenFor();
    for (let i = 0; i < LIMIT; i++) await products(a).expect(200);
    await products(a).expect(429);
    await products(b).expect(200);
  });

  it('falls back to IP for guests and forged tokens; trusted agent guests key by conversation', async () => {
    for (let i = 0; i < LIMIT; i++) await products().expect(200);
    await products().expect(429);
    // A forged token's `sub` can't buy a fresh bucket.
    const forged = await tokenFor();
    await products(`${forged.slice(0, -2)}xx`).expect(429);
    // A real shopper and a verified agent conversation are unaffected.
    await products(await tokenFor()).expect(200);
    await products()
      .set('X-Client', 'ai-agent')
      .set('X-Service-Token', SERVICE_TOKEN)
      .set('X-Conversation-Id', randomUUID())
      .expect(200);
    // Without the service token, X-Conversation-Id doesn't open a bucket.
    await products().set('X-Conversation-Id', randomUUID()).expect(429);
  });
});
