import {
  embeddingHash,
  faqEmbeddingText,
  productEmbeddingText,
  toVectorLiteral,
} from './embedding.js';

describe('embedding texts', () => {
  it('puts the category and brand before the product', () => {
    expect(
      productEmbeddingText({
        category: 'Outdoor',
        brand: 'Peak',
        name: 'Insulated Water Bottle 1L',
        description: 'Keeps drinks hot for 12 hours.',
        tags: ['hiking', 'bottle'],
      }),
    ).toBe(
      'Outdoor > Peak Insulated Water Bottle 1L\nKeeps drinks hot for 12 hours.\nTags: hiking, bottle',
    );
  });

  it('leaves out an empty tag line', () => {
    expect(
      productEmbeddingText({
        category: 'Shoes',
        brand: 'B',
        name: 'N',
        description: 'D',
        tags: [],
      }),
    ).toBe('Shoes > B N\nD');
  });

  it('puts the topic before the FAQ question', () => {
    expect(
      faqEmbeddingText({
        topic: 'returns',
        question: 'What is your return policy?',
        answer: '30 days.',
      }),
    ).toBe('returns > What is your return policy?\n30 days.');
  });
});

describe('embeddingHash', () => {
  it('is stable and changes with the text', () => {
    expect(embeddingHash('a')).toBe(embeddingHash('a'));
    expect(embeddingHash('a')).not.toBe(embeddingHash('b'));
    expect(embeddingHash('a')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('toVectorLiteral', () => {
  it("uses pgvector's text format", () => {
    expect(toVectorLiteral([0.5, -1, 0])).toBe('[0.5,-1,0]');
  });
});
