import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DEMO_PASSWORD } from '../src/database/seed.js';

/** The session token from a login/register response's httpOnly cookie. */
export function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('session='));
  if (!cookie) throw new Error('No session cookie in the response');
  return decodeURIComponent(cookie.slice('session='.length).split(';')[0]);
}

/** Logs in and returns the session token, for use as a bearer header (like an API client). */
export async function login(
  app: INestApplication<App>,
  email = 'alice@example.com',
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: DEMO_PASSWORD })
    .expect(200);
  return sessionCookie(res);
}

/** The short-lived chat token agent-service would receive from the widget. */
export async function agentToken(
  app: INestApplication<App>,
  session: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/agent-token')
    .auth(session, { type: 'bearer' })
    .expect(200);
  return res.body.token as string;
}
