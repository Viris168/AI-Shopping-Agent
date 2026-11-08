import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { embedAll } from '../src/database/embed.js';
import { seed } from '../src/database/seed.js';
import { EmbeddingService } from '../src/search/search.module.js';
import { configureApp } from '../src/setup.js';

/**
 * Retrieval quality of hybrid search with the real embedding model, no LLM. Casual wording
 * must find the right row; questions the store doesn't cover must not gain results.
 * Calibrates FAQ_MIN_SIMILARITY (src/faq/faq.module.ts).
 */
describe('hybrid search (e2e, real model)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.SEARCH_HYBRID = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const db = app.get<DataSource>(getDataSourceToken());
    await seed(db);
    await embedAll(db);
    await app.get(EmbeddingService).warmUp();
  }, 120_000);

  afterAll(async () => {
    process.env.SEARCH_HYBRID = 'false';
    await app.close();
  });

  const faq = async (q: string) =>
    (
      await request(app.getHttpServer())
        .get('/api/v1/faq/search')
        .query({ q })
        .expect(200)
    ).body.results as { question: string }[];

  const keywordOnly = async <T>(fn: () => Promise<T>): Promise<T> => {
    process.env.SEARCH_HYBRID = 'false';
    try {
      return await fn();
    } finally {
      process.env.SEARCH_HYBRID = 'true';
    }
  };

  describe('FAQ', () => {
    // Casual wording → the FAQ that answers it, ranked first.
    it.each([
      ['can I send stuff back', 'What is your return policy?'],
      ['when do I get my money back', 'How long do refunds take?'],
      ['my parcel is taking forever', 'How long does shipping take?'],
      ['can you deliver to Germany', 'Do you ship internationally?'],
      ['forgot my login', 'How do I reset my password?'],
      ['can I pay with PayPal', 'Which payment methods do you accept?'],
      [
        'I ordered the wrong size, can I fix it',
        'Can I change or cancel my order?',
      ],
      [
        "What's the warranty on headphones?",
        'Do products come with a warranty?',
      ],
      ['Do you ship to the UK?', 'Do you ship internationally?'],
    ])('finds "%s"', async (q, expected) => {
      expect((await faq(q))[0]?.question).toBe(expected);
    });

    it.each([
      ['How long do refunds take?'],
      ['How do I reset my password?'],
      ['What is your return policy?'],
    ])('keeps the exact question first: "%s"', async (q) => {
      expect((await faq(q))[0].question).toBe(q);
    });

    // The vector leg must add nothing here: same results as keyword search alone
    // (usually none, so the agent says it isn't sure and offers a person).
    it.each([
      ['Do you price-match?'],
      ['Do you have a physical store I can visit?'],
      ['Do you offer student discounts?'],
      ['What are your customer support hours?'],
      ['do you have a loyalty program'],
      ['do you have a phone number'],
      ['what is the weather tomorrow'],
    ])('adds nothing for "%s"', async (q) => {
      const hybrid = await faq(q);
      expect(hybrid).toEqual(await keywordOnly(() => faq(q)));
    });

    it('returns nothing for "Do you price-match?" (AGENT.md example)', async () => {
      expect(await faq('Do you price-match?')).toEqual([]);
    });

    it('falls back to keyword search when switched off', async () => {
      expect(
        (await keywordOnly(() => faq('can I send stuff back'))).map(
          (r) => r.question,
        ),
      ).not.toContain('What is your return policy?');
    });
  });
});
