import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { seed } from '../src/database/seed.js';
import { configureApp } from '../src/setup.js';
import {
  MAX_FORWARD_ATTEMPTS,
  TicketForwarder,
} from '../src/support/support.module.js';

// Ticket forwarding to the helpdesk webhook. The helpdesk is a local HTTP server.
type Received = { headers: IncomingMessage['headers']; body: any };

describe('helpdesk forwarding (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let forwarder: TicketForwarder;
  let helpdesk: Server;
  let received: Received[];
  let respond: { status: number; body?: object };

  beforeAll(async () => {
    helpdesk = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(raw) });
        res.writeHead(respond.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respond.body ?? {}));
      });
    });
    await new Promise<void>((r) => helpdesk.listen(0, '127.0.0.1', r));
    const { port } = helpdesk.address() as AddressInfo;
    process.env.HELPDESK_URL = `http://127.0.0.1:${port}/tickets`;
    process.env.HELPDESK_TOKEN = 'helpdesk-test-token';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    db = app.get(getDataSourceToken());
    forwarder = app.get(TicketForwarder);
  });

  beforeEach(async () => {
    await seed(db);
    received = [];
    respond = { status: 201, body: { id: 'HD-42' } };
  });

  afterAll(async () => {
    delete process.env.HELPDESK_URL;
    delete process.env.HELPDESK_TOKEN;
    await app.close();
    await new Promise((r) => helpdesk.close(r));
  });

  const http = () => request(app.getHttpServer());
  const createTicket = () =>
    http()
      .post('/api/v1/support/tickets')
      .send({
        subject: 'Parcel missing',
        summary: 'Shopper says ORD-1002 never arrived',
        priority: 'high',
        contactEmail: 'guest@example.com',
      })
      .expect(201);
  const row = async (id: string) =>
    (
      await db.query(
        `SELECT next_forward_at, forward_attempts, forwarded_at, helpdesk_ref, forward_error
         FROM support_tickets WHERE id = $1`,
        [id],
      )
    )[0];
  const makeDue = (id: string) =>
    db.query(
      `UPDATE support_tickets SET next_forward_at = now() WHERE id = $1`,
      [id],
    );

  it('pushes a new ticket straight away', async () => {
    const { body } = await createTicket();
    expect(received).toHaveLength(1);
    expect(received[0].headers.authorization).toBe(
      'Bearer helpdesk-test-token',
    );
    expect(received[0].headers['idempotency-key']).toBe(body.ticketId);
    expect(received[0].body).toMatchObject({
      id: body.ticketId,
      source: 'ai-assistant',
      subject: 'Parcel missing',
      priority: 'high',
      contactEmail: 'guest@example.com',
    });
    expect(await row(body.ticketId)).toMatchObject({
      next_forward_at: null,
      forward_attempts: 1,
      helpdesk_ref: 'HD-42',
      forward_error: null,
    });
    expect((await row(body.ticketId)).forwarded_at).not.toBeNull();

    // Already forwarded: the retry job leaves it alone.
    expect(await forwarder.retryDue()).toBe(0);
    expect(received).toHaveLength(1);
  });

  it('still creates the ticket when the helpdesk is down, then retries', async () => {
    respond = { status: 503 };
    const { body } = await createTicket();
    let state = await row(body.ticketId);
    expect(state).toMatchObject({
      forwarded_at: null,
      forward_attempts: 1,
      forward_error: 'responded 503',
    });
    expect(new Date(state.next_forward_at).getTime()).toBeGreaterThan(
      Date.now(),
    );

    // Not due yet: nothing is sent.
    expect(await forwarder.retryDue()).toBe(0);
    expect(received).toHaveLength(1);

    respond = { status: 200, body: { ticketId: 981 } };
    await makeDue(body.ticketId);
    expect(await forwarder.retryDue()).toBe(1);
    expect(received).toHaveLength(2);
    // Same key on the retry, so the helpdesk can drop a duplicate.
    expect(received[1].headers['idempotency-key']).toBe(body.ticketId);
    state = await row(body.ticketId);
    expect(state).toMatchObject({
      next_forward_at: null,
      forward_attempts: 2,
      helpdesk_ref: '981',
      forward_error: null,
    });
  });

  it('pushes a ticket once when two replicas retry at the same time', async () => {
    respond = { status: 500 };
    const { body } = await createTicket();
    respond = { status: 201 };
    await makeDue(body.ticketId);
    const results = await Promise.all([
      forwarder.forward(body.ticketId),
      forwarder.forward(body.ticketId),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(received).toHaveLength(2);
  });

  it(`gives up after ${MAX_FORWARD_ATTEMPTS} attempts`, async () => {
    respond = { status: 500 };
    const { body } = await createTicket();
    await db.query(
      `UPDATE support_tickets SET forward_attempts = $2, next_forward_at = now() WHERE id = $1`,
      [body.ticketId, MAX_FORWARD_ATTEMPTS - 1],
    );
    expect(await forwarder.retryDue()).toBe(0);
    expect(await row(body.ticketId)).toMatchObject({
      next_forward_at: null,
      forwarded_at: null,
      forward_attempts: MAX_FORWARD_ATTEMPTS,
    });
    expect(await forwarder.retryDue()).toBe(0);
    expect(received).toHaveLength(2);
  });
});
