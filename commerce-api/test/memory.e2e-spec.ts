import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { ConversationRetentionJob } from '../src/conversations/retention.job.js';
import { seed } from '../src/database/seed.js';
import { MAX_FACTS } from '../src/memory/memory.module.js';
import { EmbeddingService } from '../src/search/search.module.js';
import { configureApp } from '../src/setup.js';
import { agentToken, login as loginAs } from './auth.js';

// Long-term agent memory (PLAN-18 step 3): opt-in, owner-scoped, switched on only by the shopper.
const SERVICE_TOKEN = process.env.SERVICE_TOKEN!;

describe('memory (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let aliceSession: string;
  let bobSession: string;
  let aliceAgent: string;
  let bobAgent: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    db = app.get(getDataSourceToken());
    await seed(db);
    aliceSession = await loginAs(app);
    bobSession = await loginAs(app, 'bob@example.com');
    aliceAgent = await agentToken(app, aliceSession);
    bobAgent = await agentToken(app, bobSession);
  });

  beforeEach(() => seed(db));

  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());
  /** agent-service: chat token + service token. */
  const agent = (method: 'get' | 'post' | 'delete' | 'put', path: string) =>
    http()
      [method](`/api/v1${path}`)
      .set('X-Client', 'ai-agent')
      .set('X-Service-Token', SERVICE_TOKEN);
  /** The storefront account page: session token (bearer here, like an API client). */
  const account = (method: 'get' | 'put' | 'delete', path = '') =>
    http()
      [method](`/api/v1/account/memory${path}`)
      .auth(aliceSession, { type: 'bearer' });
  const enable = (session = aliceSession) =>
    http()
      .put('/api/v1/account/memory')
      .auth(session, { type: 'bearer' })
      .send({ enabled: true })
      .expect(200);
  const fact = (body: object, token = aliceAgent) =>
    agent('post', '/memory/facts').auth(token, { type: 'bearer' }).send(body);
  const episode = (body: object, token = aliceAgent) =>
    agent('post', '/memory/episodes')
      .auth(token, { type: 'bearer' })
      .send(body);
  const read = (token = aliceAgent, q?: string) =>
    agent('get', '/memory')
      .auth(token, { type: 'bearer' })
      .query(q ? { q } : {})
      .expect(200);

  it('is off by default: reads are empty and agent writes are refused', async () => {
    expect((await read()).body).toEqual({
      enabled: false,
      facts: [],
      episodes: [],
    });
    const res = await fact({ kind: 'size', value: 'M' }).expect(403);
    expect(res.body.message).toBe(
      'The shopper has not turned on assistant memory',
    );
    await episode({ conversationId: randomUUID(), summary: 'x' }).expect(403);
  });

  it('only the shopper can switch it on, never the agent', async () => {
    await agent('put', '/account/memory')
      .auth(aliceAgent, { type: 'bearer' })
      .send({ enabled: true })
      .expect(403);
    await agent('put', '/memory')
      .auth(aliceAgent, { type: 'bearer' })
      .send({ enabled: true })
      .expect(404);
    expect((await read()).body.enabled).toBe(false);
  });

  it('stores facts and episodes once on, deduplicating facts by value', async () => {
    await enable();
    const conversationId = randomUUID();
    const first = await fact({
      kind: 'size',
      value: 'Size M',
      confidence: 0.9,
      sourceConversationId: conversationId,
    }).expect(201);
    const again = await fact({ kind: 'size', value: '  size   m ' }).expect(
      201,
    );
    expect(again.body.id).toBe(first.body.id);
    await fact({ kind: 'diet', value: 'Vegan' }).expect(201);
    await episode({
      conversationId,
      summary: 'Started a return for ORD-1001.',
      outcome: 'resolved',
      entities: { orders: ['ORD-1001'] },
    }).expect(204);

    const { body } = await read();
    expect(body.enabled).toBe(true);
    expect(body.facts.map((f: { kind: string }) => f.kind).sort()).toEqual([
      'diet',
      'size',
    ]);
    expect(body.episodes).toEqual([
      expect.objectContaining({
        conversationId,
        summary: 'Started a return for ORD-1001.',
        outcome: 'resolved',
        entities: { orders: ['ORD-1001'], products: [] },
      }),
    ]);
  });

  it('replaces the episode when the same conversation is recorded again', async () => {
    await enable();
    const conversationId = randomUUID();
    await episode({ conversationId, summary: 'First.' }).expect(204);
    await episode({ conversationId, summary: 'Second.' }).expect(204);
    const { body } = await read();
    expect(body.episodes.map((e: { summary: string }) => e.summary)).toEqual([
      'Second.',
    ]);
  });

  it("never shows or deletes another shopper's memory", async () => {
    await enable();
    await enable(bobSession);
    const { body: aliceFact } = await fact({
      kind: 'size',
      value: 'M',
    }).expect(201);
    await episode({ conversationId: randomUUID(), summary: 'Alice only.' });

    const bob = (await read(bobAgent)).body;
    expect(bob.facts).toEqual([]);
    expect(bob.episodes).toEqual([]);

    await agent('delete', `/memory/facts/${aliceFact.id}`)
      .auth(bobAgent, { type: 'bearer' })
      .expect(404);
    await http()
      .delete(`/api/v1/account/memory/facts/${aliceFact.id}`)
      .auth(bobSession, { type: 'bearer' })
      .expect(404);
    expect((await read()).body.facts).toHaveLength(1);
  });

  it('lets the agent forget one fact', async () => {
    await enable();
    const { body } = await fact({ kind: 'size', value: 'M' }).expect(201);
    await agent('delete', `/memory/facts/${body.id}`)
      .auth(aliceAgent, { type: 'bearer' })
      .expect(204);
    expect((await read()).body.facts).toEqual([]);
  });

  it('turning memory off deletes everything; delete-all keeps it on', async () => {
    await enable();
    await fact({ kind: 'size', value: 'M' }).expect(201);
    await episode({ conversationId: randomUUID(), summary: 'x' }).expect(204);

    await account('delete').expect(204);
    let view = (await account('get').expect(200)).body;
    expect(view).toEqual({ enabled: true, facts: [], episodes: [] });

    await fact({ kind: 'size', value: 'M' }).expect(201);
    view = (await account('put').send({ enabled: false }).expect(200)).body;
    expect(view).toEqual({ enabled: false, facts: [], episodes: [] });
    const [{ count }] = await db.query(
      `SELECT (SELECT count(*) FROM memory_facts) + (SELECT count(*) FROM memory_episodes) AS count`,
    );
    expect(Number(count)).toBe(0);
  });

  it('needs login, and the agent needs the service token', async () => {
    await http().get('/api/v1/account/memory').expect(401);
    await agent('get', '/memory').expect(401);
    // A browser holding a chat token but no service token can't use the agent routes.
    await http()
      .get('/api/v1/memory')
      .auth(aliceAgent, { type: 'bearer' })
      .expect((res) => expect([401, 403]).toContain(res.status));
  });

  it('validates input', async () => {
    await enable();
    await fact({ kind: 'price', value: '$5' }).expect(400);
    await fact({ kind: 'size', value: 'x'.repeat(201) }).expect(400);
    await fact({ kind: 'size', value: 'M', admin: true }).expect(400);
    await episode({ conversationId: 'nope', summary: 'x' }).expect(400);
    await episode({
      conversationId: randomUUID(),
      summary: 'x',
      entities: { orders: ['x'.repeat(41)] },
    }).expect(400);
  });

  it(`caps facts at ${MAX_FACTS}`, async () => {
    await enable();
    const userId = (
      await db.query(`SELECT id FROM users WHERE email = 'alice@example.com'`)
    )[0].id;
    await db.query(
      `INSERT INTO memory_facts (user_id, kind, value, value_key)
       SELECT $1, 'other', 'f' || i, 'f' || i FROM generate_series(1, $2) AS i`,
      [userId, MAX_FACTS],
    );
    const res = await fact({ kind: 'size', value: 'M' }).expect(400);
    expect(res.body.message).toContain('Forget some first');
    await fact({ kind: 'other', value: 'F1' }).expect(201); // an update still works
  });

  it('expires episodes after 90 days but keeps facts', async () => {
    await enable();
    await fact({ kind: 'size', value: 'M' }).expect(201);
    const old = randomUUID();
    await episode({ conversationId: old, summary: 'Old.' }).expect(204);
    await episode({ conversationId: randomUUID(), summary: 'New.' }).expect(
      204,
    );
    await db.query(
      `UPDATE memory_episodes SET created_at = now() - interval '91 days'
       WHERE conversation_id = $1`,
      [old],
    );

    expect(await app.get(ConversationRetentionJob).run()).toBe(1);
    const { body } = await read();
    expect(body.episodes.map((e: { summary: string }) => e.summary)).toEqual([
      'New.',
    ]);
    expect(body.facts).toHaveLength(1);
  });

  it('deleting a user deletes their memory (ON DELETE CASCADE)', async () => {
    const rows: { table: string; action: string }[] = await db.query(
      `SELECT conrelid::regclass::text AS table, confdeltype AS action
       FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'users'::regclass
         AND conrelid::regclass::text LIKE 'memory_%'
       ORDER BY 1`,
    );
    expect(rows).toEqual([
      { table: 'memory_episodes', action: 'c' },
      { table: 'memory_facts', action: 'c' },
      { table: 'memory_settings', action: 'c' },
    ]);
  });
  describe('with the embedding model', () => {
    beforeAll(async () => {
      process.env.SEARCH_HYBRID = 'true';
      process.env.SEARCH_EMBED_TIMEOUT_MS = '5000';
      await app.get(EmbeddingService).warmUp();
    }, 120_000);

    afterAll(() => {
      process.env.SEARCH_HYBRID = 'false';
      delete process.env.SEARCH_EMBED_TIMEOUT_MS;
    });

    it("adds older episodes similar to the first message, only the shopper's own", async () => {
      await enable();
      await enable(bobSession);
      await episode({
        conversationId: randomUUID(),
        summary: 'Asked about trail running shoes for muddy hills.',
      }).expect(204);
      await episode(
        {
          conversationId: randomUUID(),
          summary: 'Bob asked about trail shoes too.',
        },
        bobAgent,
      ).expect(204);
      for (const summary of [
        'Asked about the return policy.',
        'Checked where ORD-1002 is.',
        'Applied coupon WELCOME10.',
      ])
        await episode({ conversationId: randomUUID(), summary }).expect(204);
      await db.query(
        `UPDATE memory_episodes SET created_at = now() - interval '10 days'
         WHERE summary LIKE '%muddy%'`,
      );

      const plain = (await read()).body.episodes.map(
        (e: { summary: string }) => e.summary,
      );
      expect(plain).toHaveLength(3);
      expect(plain.join()).not.toContain('muddy');

      const summaries = (
        await read(aliceAgent, 'any shoes good for trails?')
      ).body.episodes.map((e: { summary: string }) => e.summary);
      expect(summaries).toHaveLength(4);
      expect(summaries[3]).toContain('muddy');
      expect(summaries.join()).not.toContain('Bob');
    });
  });
});
