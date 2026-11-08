import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { DEMO_PASSWORD, seed } from '../src/database/seed.js';
import { configureApp } from '../src/setup.js';

// Integration tests against a real Postgres (shop_test), freshly seeded before each test.
describe('commerce-api (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let aliceToken: string;
  let bobToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(getDataSourceToken());
    // Log in once: login is rate-limited, and seed() keeps the demo user IDs fixed.
    await seed(db);
    aliceToken = await login();
    bobToken = await login('bob@example.com');
  });

  beforeEach(() => seed(db));

  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());
  const login = async (email = 'alice@example.com') =>
    (
      await http()
        .post('/api/v1/auth/login')
        .send({ email, password: DEMO_PASSWORD })
        .expect(200)
    ).body.accessToken as string;
  const as = (token: string) => ({
    get: (path: string) => http().get(path).auth(token, { type: 'bearer' }),
    post: (path: string, body?: object) =>
      http().post(path).auth(token, { type: 'bearer' }).send(body),
    patch: (path: string, body: object) =>
      http().patch(path).auth(token, { type: 'bearer' }).send(body),
    delete: (path: string) =>
      http().delete(path).auth(token, { type: 'bearer' }),
  });
  const message = (body: { message: string | string[] }) => body.message;

  describe('public', () => {
    it('GET /health checks the database', () =>
      http()
        .get('/health')
        .expect(200)
        .expect({ status: 'ok', database: 'up' }));

    it('searches with filters and returns the contract shape', async () => {
      const res = await http()
        .get('/api/v1/products')
        .query({ q: 'waterproof', maxPriceCents: 12000, inStock: 'true' })
        .expect(200);
      expect(res.body.total).toBe(2);
      expect(Object.keys(res.body.items[0]).sort()).toEqual(
        [
          'brand',
          'category',
          'id',
          'imageUrl',
          'inStock',
          'name',
          'price',
          'priceCents',
          'rating',
          'sku',
          'slug',
          'stock',
          'summary',
          'url',
        ].sort(),
      );
    });

    it('needs every search term to match and sorts by price', async () => {
      const res = await http()
        .get('/api/v1/products')
        .query({ q: 'laptop backpacks', sort: 'price_asc' })
        .expect(200);
      expect(res.body.items.map((p: { sku: string }) => p.sku)).toEqual([
        'OUT-003',
        'OUT-002',
      ]);
    });

    it('rejects bad and unknown query parameters', async () => {
      await http()
        .get('/api/v1/products')
        .query({ sort: 'cheapest' })
        .expect(400);
      await http().get('/api/v1/products').query({ limit: 51 }).expect(400);
      await http().get('/api/v1/products').query({ hack: 1 }).expect(400);
    });

    it('finds a product by UUID, slug or SKU', async () => {
      const bySku = await http().get('/api/v1/products/clo-002').expect(200);
      expect(bySku.body).toMatchObject({
        sku: 'CLO-002',
        price: '$79.00',
        priceCents: 7900,
        attributes: { waterproof: 'yes' },
      });
      expect(bySku.body.summary).toBeUndefined();
      await http().get(`/api/v1/products/${bySku.body.id}`).expect(200);
      await http().get('/api/v1/products/packable-rain-jacket').expect(200);
      await http()
        .get('/api/v1/products/nope')
        .expect(404)
        .expect((r) => expect(message(r.body)).toBe('Product not found'));
    });

    it('recommends up to 4 related, in-stock products', async () => {
      const res = await http()
        .get('/api/v1/products/trailrunner-3/recommendations')
        .expect(200);
      expect(res.body.basedOn).toBe('Trailrunner 3 Running Shoes');
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.length).toBeLessThanOrEqual(4);
      for (const p of res.body.items) {
        expect(p.sku).not.toBe('SHOE-001');
        expect(p.inStock).toBe(true);
      }
    });

    it('lists categories', async () => {
      const res = await http().get('/api/v1/categories').expect(200);
      expect(res.body).toContainEqual({ name: 'Shoes', slug: 'shoes' });
    });

    it('searches the FAQ, and returns nothing when nothing matches', async () => {
      const hit = await http()
        .get('/api/v1/faq/search')
        .query({ q: 'How long do refunds take?' })
        .expect(200);
      expect(hit.body.results[0]).toMatchObject({
        topic: 'returns',
        question: 'How long do refunds take?',
      });
      const miss = await http()
        .get('/api/v1/faq/search')
        .query({ q: 'Do you price-match?' })
        .expect(200);
      expect(miss.body.results).toEqual([]);
    });
  });

  describe('auth', () => {
    it('registers, rejects duplicates and logs in case-insensitively', async () => {
      const res = await http()
        .post('/api/v1/auth/register')
        .send({
          email: 'New@Example.com',
          password: 'longenough1',
          name: 'New',
        })
        .expect(201);
      expect(res.body.user).toMatchObject({
        email: 'new@example.com',
        role: 'CUSTOMER',
      });
      await http()
        .post('/api/v1/auth/register')
        .send({ email: 'new@example.com', password: 'longenough1', name: 'X' })
        .expect(409);
      await login('ALICE@example.com');
    });

    it('rejects a wrong password, a missing token and a forged token', async () => {
      await http()
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.com', password: 'wrong' })
        .expect(401);
      await http()
        .get('/api/v1/cart')
        .expect(401)
        .expect((r) => expect(message(r.body)).toBe('Missing bearer token'));
      const token = aliceToken;
      await as(`${token.slice(0, -2)}xx`)
        .get('/api/v1/cart')
        .expect(401)
        .expect((r) =>
          expect(message(r.body)).toBe('Invalid or expired token'),
        );
    });
  });

  describe('cart and checkout', () => {
    it('adds, updates, applies coupons and removes items', async () => {
      const alice = as(aliceToken);
      let res = await alice
        .post('/api/v1/cart/items', { productId: 'SHOE-001', quantity: 2 })
        .expect(200);
      expect(res.body).toMatchObject({ itemCount: 2, subtotalCents: 17998 });

      res = await alice
        .post('/api/v1/cart/coupon', { code: 'welcome10' })
        .expect(200);
      expect(res.body).toMatchObject({
        couponCode: 'WELCOME10',
        discountCents: 1800,
        shippingCents: 0,
        totalCents: 16198,
        total: '$161.98',
      });

      await alice
        .post('/api/v1/cart/coupon', { code: 'OLD2023' })
        .expect(400)
        .expect((r) =>
          expect(message(r.body)).toBe('Coupon is invalid or expired'),
        );

      res = await alice
        .patch('/api/v1/cart/items/SHOE-001', { quantity: 1 })
        .expect(200);
      expect(res.body.itemCount).toBe(1);
      await alice
        .post('/api/v1/cart/coupon', { code: 'SAVE20' })
        .expect(400)
        .expect((r) =>
          expect(message(r.body)).toBe(
            'Coupon requires a subtotal of at least $100.00',
          ),
        );

      res = await alice.delete('/api/v1/cart/items/trailrunner-3').expect(200);
      expect(res.body.itemCount).toBe(0);
      await alice
        .delete('/api/v1/cart/items/SHOE-001')
        .expect(404)
        .expect((r) => expect(message(r.body)).toBe('Item not in cart'));
    });

    it('refuses out-of-stock items and more than in stock', async () => {
      const alice = as(aliceToken);
      await alice
        .post('/api/v1/cart/items', { productId: 'SHOE-003' })
        .expect(400)
        .expect((r) =>
          expect(message(r.body)).toBe(
            '"Summit Waterproof Hiking Boots" is out of stock',
          ),
        );
      await alice
        .post('/api/v1/cart/items', { productId: 'OUT-004', quantity: 8 })
        .expect(400)
        .expect((r) =>
          expect(message(r.body)).toBe(
            'Only 7 of "Two-Person Camping Tent" in stock',
          ),
        );
    });

    it('Pay marks the order PAID, takes stock and empties the cart', async () => {
      const alice = as(aliceToken);
      await alice
        .post('/api/v1/cart/items', { productId: 'CLO-002', quantity: 2 })
        .expect(200);
      await alice
        .post('/api/v1/cart/coupon', { code: 'WELCOME10' })
        .expect(200);

      const order = (await alice.post('/api/v1/checkout').expect(201)).body;
      expect(order).toMatchObject({
        orderNumber: 'ORD-2001',
        status: 'PAID',
        itemCount: 2,
        couponCode: 'WELCOME10',
        totalCents: 14220, // $158.00 - $15.80, free shipping
        items: [
          { name: 'Packable Rain Jacket', quantity: 2, unitPrice: '$79.00' },
        ],
      });

      expect((await http().get('/api/v1/products/CLO-002')).body.stock).toBe(
        13,
      );
      const cart = (await alice.get('/api/v1/cart')).body;
      expect(cart).toMatchObject({ itemCount: 0, couponCode: null });
      expect((await alice.get('/api/v1/orders')).body[0].orderNumber).toBe(
        'ORD-2001',
      );
      await alice
        .post('/api/v1/checkout')
        .expect(400)
        .expect((r) => expect(message(r.body)).toBe('Your cart is empty'));
    });

    it('never oversells when two shoppers buy the last items at once', async () => {
      const alice = as(aliceToken);
      const bob = as(bobToken);
      await alice
        .post('/api/v1/cart/items', { productId: 'OUT-004', quantity: 5 })
        .expect(200);
      await bob
        .post('/api/v1/cart/items', { productId: 'OUT-004', quantity: 5 })
        .expect(200);

      const results = await Promise.all([
        alice.post('/api/v1/checkout'),
        bob.post('/api/v1/checkout'),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 400,
      ]);
      expect((await http().get('/api/v1/products/OUT-004')).body.stock).toBe(2);
    });
  });

  describe('orders and returns', () => {
    it('shows fixtures with tracking and return eligibility', async () => {
      const alice = as(aliceToken);
      const list = (await alice.get('/api/v1/orders').expect(200)).body;
      expect(list.map((o: { orderNumber: string }) => o.orderNumber)).toEqual([
        'ORD-1003',
        'ORD-1002',
        'ORD-1001',
        'ORD-0950',
      ]);
      const delivered = (await alice.get('/api/v1/orders/ord-1001').expect(200))
        .body;
      expect(delivered).toMatchObject({
        status: 'DELIVERED',
        carrier: 'UPS',
        returnEligible: true,
        itemCount: 3,
      });
      expect(delivered.trackingUrl).toContain('ups.com');
      expect(
        (await alice.get('/api/v1/orders/ORD-0950')).body.returnEligible,
      ).toBe(false);
    });

    it("hides other shoppers' orders behind the same 404", async () => {
      const bob = as(bobToken);
      await bob
        .get('/api/v1/orders/ORD-1001')
        .expect(404)
        .expect((r) => expect(message(r.body)).toBe('Order not found'));
      await bob.get('/api/v1/orders/ORD-9999').expect(404);
      const alice = as(aliceToken);
      const item = (await alice.get('/api/v1/orders/ORD-1001')).body.items[0];
      await bob
        .post('/api/v1/returns', {
          orderNumber: 'ORD-1001',
          reason: 'not mine',
          items: [{ orderItemId: item.orderItemId, quantity: 1 }],
        })
        .expect(404);
    });

    it('creates one return per order and enforces the rules', async () => {
      const alice = as(aliceToken);
      const order = (await alice.get('/api/v1/orders/ORD-1001')).body;
      const shirt = order.items.find(
        (i: { name: string }) => i.name === 'Merino Crew T-Shirt',
      );
      const ret = (body: object) =>
        alice.post('/api/v1/returns', {
          orderNumber: 'ORD-1001',
          reason: 'Too small',
          ...body,
        });

      await ret({ items: [{ orderItemId: shirt.orderItemId, quantity: 3 }] })
        .expect(400)
        .expect((r) =>
          expect(message(r.body)).toBe('Quantity exceeds purchased amount'),
        );
      const created = await ret({
        items: [{ orderItemId: shirt.orderItemId, quantity: 2 }],
      }).expect(201);
      expect(created.body).toMatchObject({ status: 'REQUESTED' });
      await ret({ items: [{ orderItemId: shirt.orderItemId, quantity: 1 }] })
        .expect(400)
        .expect((r) =>
          expect(message(r.body)).toBe(
            'A return is already open for this order',
          ),
        );

      const closed = (await alice.get('/api/v1/orders/ORD-0950')).body;
      await alice
        .post('/api/v1/returns', {
          orderNumber: 'ORD-0950',
          reason: 'late',
          items: [{ orderItemId: closed.items[0].orderItemId, quantity: 1 }],
        })
        .expect(400)
        .expect((r) =>
          expect(message(r.body)).toBe('The 30-day return window has closed'),
        );
    });
  });

  describe('support and audit', () => {
    it('needs an email from guests and uses the account email otherwise', async () => {
      await http()
        .post('/api/v1/support/tickets')
        .send({ subject: 'Help', summary: 'Guest' })
        .expect(400);
      const res = await as(aliceToken)
        .post('/api/v1/support/tickets', {
          subject: 'Help',
          summary: 'Where is my order?',
          priority: 'urgent',
        })
        .expect(201);
      expect(res.body).toMatchObject({
        status: 'OPEN',
        expectedResponse: 'within 2 hours',
      });
    });

    it('logs agent mutations with the conversation id', async () => {
      const token = aliceToken;
      await http()
        .post('/api/v1/cart/items')
        .auth(token, { type: 'bearer' })
        .set('X-Client', 'ai-agent')
        .set('X-Service-Token', process.env.SERVICE_TOKEN!)
        .set('X-Conversation-Id', 'conv-42')
        .send({ productId: 'SHOE-002' })
        .expect(200);
      await expect
        .poll(() =>
          db.query(`SELECT action, conversation_id FROM agent_action_logs`),
        )
        .toEqual([{ action: 'POST /cart/items', conversation_id: 'conv-42' }]);
    });
  });
});
