import {
  Controller,
  Get,
  INestApplication,
  Module,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { JwtAuthGuard, Roles, RolesGuard } from '../src/auth/auth.guards.js';
import { DEMO_PASSWORD, seed } from '../src/database/seed.js';
import { configureApp } from '../src/setup.js';
import { agentToken, login, sessionCookie } from './auth.js';

// Sessions, chat tokens, logout and roles (docs/ARCHITECTURE.md §11). Real Postgres, reseeded per test.
const SERVICE_TOKEN = process.env.SERVICE_TOKEN!;

/** A staff-only route, so RolesGuard is tested the way real routes will use it. */
@Controller('staff-test')
@UseGuards(JwtAuthGuard, RolesGuard)
class StaffTestController {
  @Get()
  @Roles('SUPPORT', 'ADMIN')
  get() {
    return { ok: true };
  }
}

@Module({ controllers: [StaffTestController] })
class StaffTestModule {}

describe('auth (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let alice: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, StaffTestModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    db = app.get(getDataSourceToken());
    // Log in once: login is rate-limited, and seed() resets IDs and token versions.
    await seed(db);
    alice = await login(app);
  });

  beforeEach(() => seed(db));

  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());
  const asAgent = (req: request.Test, token?: string) => {
    req.set('X-Client', 'ai-agent').set('X-Service-Token', SERVICE_TOKEN);
    return token ? req.auth(token, { type: 'bearer' }) : req;
  };
  const setRole = (role: string) =>
    db.query(`UPDATE users SET role = $1 WHERE email = 'alice@example.com'`, [
      role,
    ]);
  const message = (body: { message: string | string[] }) => body.message;

  describe('session cookie', () => {
    it('login sets an httpOnly cookie and keeps the token out of the body', async () => {
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.com', password: DEMO_PASSWORD })
        .expect(200);
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toMatch(/^session=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\/api\/v1/);
      expect(res.body).not.toHaveProperty('accessToken');
      expect(res.body.user).toMatchObject({ email: 'alice@example.com' });
    });

    it('authenticates with the cookie and needs X-Requested-With to change things', async () => {
      const cookie = `session=${alice}`;
      await http()
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .expect(200)
        .expect((r) => expect(r.body.email).toBe('alice@example.com'));
      await http()
        .post('/api/v1/cart/items')
        .set('Cookie', cookie)
        .send({ productId: 'SHOE-002' })
        .expect(403);
      await http()
        .post('/api/v1/cart/items')
        .set('Cookie', cookie)
        .set('X-Requested-With', 'storefront')
        .send({ productId: 'SHOE-002' })
        .expect(200);
    });

    it('logout revokes every token the shopper holds and clears the cookie', async () => {
      const session = alice;
      const chat = await agentToken(app, session);
      const res = await http()
        .post('/api/v1/auth/logout')
        .set('Cookie', `session=${session}`)
        .set('X-Requested-With', 'storefront')
        .expect(204);
      expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(
        /^session=;/,
      );
      // Bearer use (another device or API client) is revoked too, not just this cookie.
      await http()
        .get('/api/v1/auth/me')
        .auth(session, { type: 'bearer' })
        .expect(401);
      await asAgent(http().get('/api/v1/cart'), chat).expect(401);
      // Logging in again works.
      await http()
        .get('/api/v1/auth/me')
        .auth(await login(app), { type: 'bearer' })
        .expect(200);
    });

    it('logout without a session just clears the cookie', () =>
      http().post('/api/v1/auth/logout').expect(204));

    it('register also starts a cookie session', async () => {
      const res = await http()
        .post('/api/v1/auth/register')
        .send({ email: 'new@example.com', password: 'Password123!', name: 'N' })
        .expect(201);
      await http()
        .get('/api/v1/auth/me')
        .auth(sessionCookie(res), { type: 'bearer' })
        .expect(200);
    });
  });

  describe('chat tokens', () => {
    it('work only from agent-service (with the service token)', async () => {
      const chat = await agentToken(app, alice);
      await asAgent(http().get('/api/v1/cart'), chat).expect(200);
      // From a browser, a stolen chat token is useless.
      await http()
        .get('/api/v1/cart')
        .auth(chat, { type: 'bearer' })
        .expect(401);
    });

    it('agent-service cannot use a full session token', async () => {
      const session = alice;
      await asAgent(http().get('/api/v1/cart'), session).expect(401);
    });

    it('expire after 15 minutes by default', async () => {
      const res = await http()
        .post('/api/v1/auth/agent-token')
        .auth(alice, { type: 'bearer' })
        .expect(200);
      const ttl = new Date(res.body.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(14 * 60_000);
      expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    });

    it('cannot reach routes outside the agent allowlist', async () => {
      const chat = await agentToken(app, alice);
      await asAgent(http().post('/api/v1/cart/items'), chat)
        .send({ productId: 'SHOE-002' })
        .expect(200);
      for (const [method, path] of [
        ['post', '/api/v1/checkout'],
        ['post', '/api/v1/orders/ORD-1003/payment'],
        ['get', '/api/v1/auth/me'],
        ['post', '/api/v1/auth/agent-token'],
        ['post', '/api/v1/auth/logout'],
      ] as const)
        await asAgent(http()[method](path), chat)
          .expect(403)
          .expect((r) =>
            expect(message(r.body)).toBe(
              'This can only be done on the store website, not in chat',
            ),
          );
      // The cart was not checked out.
      const cart = await asAgent(http().get('/api/v1/cart'), chat).expect(200);
      expect(cart.body.itemCount).toBe(1);
    });
  });

  describe('roles', () => {
    it('staff accounts get no chat token, and existing ones stop working', async () => {
      const session = alice;
      const chat = await agentToken(app, session);
      await setRole('SUPPORT');
      await http()
        .post('/api/v1/auth/agent-token')
        .auth(session, { type: 'bearer' })
        .expect(403)
        .expect((r) =>
          expect(message(r.body)).toBe(
            'The assistant is for shopper accounts only',
          ),
        );
      await asAgent(http().get('/api/v1/cart'), chat).expect(403);
    });

    it('@Roles() routes check the current role from the database', async () => {
      const session = alice;
      const staff = () =>
        http().get('/api/v1/staff-test').auth(session, { type: 'bearer' });
      await staff().expect(403);
      await setRole('ADMIN');
      await staff().expect(200);
      await http().get('/api/v1/staff-test').expect(401);
    });
  });
});
