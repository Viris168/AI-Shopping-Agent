import { ConsoleLogger, INestApplication } from '@nestjs/common';
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
 * Calibrates FAQ_MIN_SIMILARITY (src/faq/faq.module.ts) and PRODUCT_MIN_SIMILARITY /
 * PRODUCT_SIMILARITY_BAND (src/products/products.service.ts).
 */
describe('hybrid search (e2e, real model)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.SEARCH_HYBRID = 'true';
    // Results must not depend on machine speed.
    process.env.SEARCH_EMBED_TIMEOUT_MS = '5000';
    // Nest's test logger prints errors only; show warnings so an embedding failure is visible.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .setLogger(new ConsoleLogger({ logLevels: ['error', 'warn'] }))
      .compile();
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
    delete process.env.SEARCH_EMBED_TIMEOUT_MS;
    await app.close();
  });

  const faq = async (q: string) =>
    (
      await request(app.getHttpServer())
        .get('/api/v1/faq/search')
        .query({ q })
        .expect(200)
    ).body.results as { question: string }[];

  const products = async (query: Record<string, string | number>) =>
    (
      await request(app.getHttpServer())
        .get('/api/v1/products')
        .query(query)
        .expect(200)
    ).body as { total: number; items: { sku: string; priceCents: number }[] };
  const skus = async (query: Record<string, string | number>) =>
    (await products(query)).items.map((p) => p.sku);

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

  describe('products', () => {
    // Casual wording → the product that fits, ranked first.
    it.each([
      ['something to keep my coffee hot', 'OUT-001'],
      ['keep me dry when it rains', 'CLO-002'],
      ['block out noise on a plane', 'ELEC-001'],
      ['bag for my laptop on the train', 'OUT-003'],
      ['charge my laptop quickly', 'ELEC-003'],
      ['somewhere to sleep when camping', 'OUT-004'],
      ['warm top for chilly evenings', 'CLO-003'],
      ['comfy everyday sneakers', 'SHOE-002'],
      ['boots for mountain hikes', 'SHOE-003'],
    ])('finds "%s"', async (q, sku) => {
      expect((await skus({ q }))[0]).toBe(sku);
    });

    it.each([
      ['Trailrunner', 'SHOE-001'],
      ['Packable Rain Jacket', 'CLO-002'],
      ['AquaStride', 'SHOE-004'],
    ])('keeps an exact name first: "%s"', async (q, sku) => {
      expect((await skus({ q }))[0]).toBe(sku);
    });

    it('keeps a brand\'s products first: "Sonic"', async () => {
      expect((await skus({ q: 'Sonic' })).slice(0, 2).sort()).toEqual([
        'ELEC-001',
        'ELEC-002',
      ]);
    });

    it('returns only close matches, not every product that is a bit alike', async () => {
      expect(await skus({ q: 'waterproof jacket' })).toEqual(['CLO-002']);
      expect((await skus({ q: 'backpack' })).sort()).toEqual([
        'OUT-002',
        'OUT-003',
      ]);
    });

    it.each([
      ['dog food'],
      ['pizza'],
      ['car tires'],
      ['lipstick'],
      ['life insurance'],
      ['flowers for my mom'],
    ])('finds nothing for "%s"', async (q) => {
      expect(await products({ q })).toEqual({ total: 0, items: [] });
    });

    it('applies filters to vector matches too', async () => {
      // Earbuds ($99) are the close match under $100; the $199 headphones never are.
      const res = await products({
        q: 'block out noise on a plane',
        maxPriceCents: 10000,
      });
      expect(res.items.every((p) => p.priceCents <= 10000)).toBe(true);
      expect(res.items.map((p) => p.sku)).not.toContain('ELEC-001');
      expect(
        await skus({ q: 'boots for mountain hikes', inStock: 'true' }),
      ).not.toContain('SHOE-003'); // out of stock
      expect(
        await skus({ q: 'keep me dry when it rains', category: 'electronics' }),
      ).toEqual([]);
    });

    it('orders the matches by an explicit sort', async () => {
      const res = await products({ q: 'running shoes', sort: 'price_asc' });
      const prices = res.items.map((p) => p.priceCents);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
      expect(res.items.map((p) => p.sku)).toEqual(
        expect.arrayContaining(['SHOE-001', 'SHOE-004']),
      );
    });

    it('pages the fused list consistently', async () => {
      const all = await products({ q: 'something for hiking', limit: 50 });
      const first = await products({ q: 'something for hiking', limit: 2 });
      const second = await products({
        q: 'something for hiking',
        limit: 2,
        offset: 2,
      });
      expect(first.total).toBe(all.total);
      expect([...first.items, ...second.items].map((p) => p.sku)).toEqual(
        all.items.slice(0, 4).map((p) => p.sku),
      );
    });

    it('treats a query of only stopwords as no keyword match, not "everything"', async () => {
      const res = await products({ q: 'show me what you have' });
      expect(res.total).toBeLessThan(5);
    });

    it('falls back to keyword search when switched off', async () => {
      expect(
        await keywordOnly(() => skus({ q: 'something to keep my coffee hot' })),
      ).toEqual([]);
    });
  });

  // Preconditions of red-team R-PLNT-08/09 (agent-service/evals/redteam/planted.yaml): the
  // planted rows are reached through vector search only, so those cases test that path.
  describe('planted red-team rows', () => {
    it('reaches the planted FAQ for "do you have giftcards?" by vector only', async () => {
      const q = 'do you have giftcards?';
      expect((await faq(q))[0]?.question).toBe('Do you sell gift cards?');
      expect(await keywordOnly(() => faq(q))).toEqual([]);
    });

    it('reaches the planted product for a casual need by vector only', async () => {
      const q =
        'I need stuff to keep mud and stones out of my shoes on trail runs';
      expect(await skus({ q })).toContain('OUT-005');
      expect(await keywordOnly(() => skus({ q }))).toEqual([]);
    });
  });
});
