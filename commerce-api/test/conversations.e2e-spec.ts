import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { seed } from '../src/database/seed.js';
import { configureApp } from '../src/setup.js';
import { agentToken, login as loginAs } from './auth.js';

// Transcript storage (docs/ARCHITECTURE.md §5.2): agent-only, owner-scoped, append-only.
const SERVICE_TOKEN = process.env.SERVICE_TOKEN!;

describe('conversations (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let aliceToken: string;
  let bobToken: string;
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
    aliceToken = await login();
    bobToken = await login('bob@example.com');
    aliceAgent = await agentToken(app, aliceToken);
    bobAgent = await agentToken(app, bobToken);
  });

  beforeEach(() => seed(db));

  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());
  const login = (email?: string) => loginAs(app, email);
  const agent = (path: string, body: object, token?: string) => {
    const req = http()
      .post(path)
      .set('X-Client', 'ai-agent')
      .set('X-Service-Token', SERVICE_TOKEN);
    return (token ? req.auth(token, { type: 'bearer' }) : req).send(body);
  };
  const turn = (id: string, body: object, token?: string) =>
    agent(`/api/v1/conversations/${id}/turns`, body, token);
  const row = async (id: string) =>
    (
      await db.query(
        `SELECT user_id, messages, summary, outcome, tokens_in, tokens_out,
                tokens_cache_read, cost_micro_usd, feedback
         FROM conversations WHERE id = $1`,
        [id],
      )
    )[0];
  const userId = async (email: string) =>
    (await db.query(`SELECT id FROM users WHERE email = $1`, [email]))[0].id;
  const msg = (role: string, text: string) => ({
    role,
    content: [{ type: 'text', text }],
  });

  it('creates on the first turn and appends after that', async () => {
    const id = randomUUID();
    await turn(
      id,
      {
        messages: [msg('user', 'hi')],
        tokensIn: 10,
        tokensOut: 2,
        tokensCacheRead: 40,
        costMicroUsd: 1500,
      },
      aliceAgent,
    ).expect(204);
    await turn(
      id,
      {
        messages: [msg('assistant', 'hello'), msg('user', 'bye')],
        summary: 'Greeted.',
        tokensIn: 5,
        tokensOut: 1,
        costMicroUsd: 250,
      },
      aliceAgent,
    ).expect(204);

    const saved = await row(id);
    expect(saved.user_id).toBe(await userId('alice@example.com'));
    // Nested message objects are stored untouched (not stripped by the whitelist).
    expect(saved.messages).toEqual([
      msg('user', 'hi'),
      msg('assistant', 'hello'),
      msg('user', 'bye'),
    ]);
    expect(saved.summary).toBe('Greeted.');
    expect([saved.tokens_in, saved.tokens_out]).toEqual([15, 3]);
    // Usage sent later on its own (summaries, memory extraction) adds up the same way.
    await turn(id, { messages: [], costMicroUsd: 50 }, aliceAgent).expect(204);
    const after = await row(id);
    expect(after.tokens_cache_read).toBe(40);
    expect(after.cost_micro_usd).toBe('1800'); // bigint comes back as a string
    expect(after.messages).toHaveLength(3);
  });

  it('keeps handoff once set and the last non-empty summary', async () => {
    const id = randomUUID();
    await turn(
      id,
      { messages: [], outcome: 'handoff', summary: 'S1' },
      aliceAgent,
    ).expect(204);
    await turn(id, { messages: [msg('user', 'x')] }, aliceAgent).expect(204);
    expect(await row(id)).toMatchObject({ outcome: 'handoff', summary: 'S1' });
  });

  it('lets a guest conversation be claimed on login, then locks it', async () => {
    const id = randomUUID();
    await turn(id, { messages: [msg('user', 'guest hi')] }).expect(204);
    expect((await row(id)).user_id).toBeNull();

    await turn(id, { messages: [msg('user', 'now alice')] }, aliceAgent).expect(
      204,
    );
    expect((await row(id)).user_id).toBe(await userId('alice@example.com'));

    // Neither a guest nor another shopper can write to Alice's transcript.
    await turn(id, { messages: [msg('user', 'guest again')] })
      .expect(404)
      .expect((r) => expect(r.body.message).toBe('Conversation not found'));
    await turn(id, { messages: [msg('user', 'bob')] }, bobAgent).expect(404);
    expect((await row(id)).messages).toHaveLength(2);
  });

  it('rejects callers without the service token', async () => {
    const id = randomUUID();
    await http()
      .post(`/api/v1/conversations/${id}/turns`)
      .auth(aliceToken, { type: 'bearer' })
      .send({ messages: [] })
      .expect(403)
      .expect((r) =>
        expect(r.body.message).toBe('Only the shopping assistant can do this'),
      );
    expect(await row(id)).toBeUndefined();
  });

  it('validates the body and the id', async () => {
    await turn(randomUUID(), { messages: 'nope' }, aliceAgent).expect(400);
    await turn(
      randomUUID(),
      { messages: [], outcome: 'won' },
      aliceAgent,
    ).expect(400);
    await turn(randomUUID(), { messages: [], extra: 1 }, aliceAgent).expect(
      400,
    );
    await turn('not-a-uuid', { messages: [] }, aliceAgent).expect(400);
  });

  it('audits transcript writes without copying the transcript', async () => {
    const id = randomUUID();
    await turn(
      id,
      { messages: [msg('user', 'secret-ish')] },
      aliceAgent,
    ).expect(204);
    await expect
      .poll(() =>
        db.query(`SELECT action, status, payload FROM agent_action_logs`),
      )
      .toEqual([
        {
          action: 'POST /conversations/:id/turns',
          status: 204,
          payload: { params: { id } },
        },
      ]);
  });

  it('stores feedback for the owner only', async () => {
    const id = randomUUID();
    await turn(id, { messages: [msg('user', 'hi')] }, aliceAgent).expect(204);
    const fb = (body: object, token?: string) =>
      agent(`/api/v1/conversations/${id}/feedback`, body, token);

    await fb(
      { messageId: `${id}:1`, rating: 'down', comment: ' wrong size ' },
      aliceAgent,
    ).expect(204);
    await fb({ messageId: `${id}:3`, rating: 'up' }, aliceAgent).expect(204);
    await fb({ messageId: `${id}:1`, rating: 'up' }, bobAgent).expect(404);
    await fb({ messageId: `${id}:1`, rating: 'up' }).expect(404);
    await fb({ messageId: 'm', rating: 'meh' }, aliceAgent).expect(400);
    await agent(
      `/api/v1/conversations/${randomUUID()}/feedback`,
      { messageId: 'm', rating: 'up' },
      aliceAgent,
    ).expect(404);

    const { feedback } = await row(id);
    expect(feedback).toMatchObject([
      { messageId: `${id}:1`, rating: 'down', comment: 'wrong size' },
      { messageId: `${id}:3`, rating: 'up', comment: null },
    ]);
  });
});
