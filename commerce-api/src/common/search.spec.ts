import { searchTerms } from './search.js';

describe('searchTerms', () => {
  it('drops stopwords and punctuation, singularizes, dedupes', () => {
    expect(searchTerms('Show me some waterproof BOOTS, boots!')).toEqual([
      'waterproof',
      'boot',
    ]);
    expect(searchTerms('batteries for glass')).toEqual(['battery', 'glass']);
  });

  it('keeps at most 8 terms', () => {
    expect(searchTerms('a1 b2 c3 d4 e5 f6 g7 h8 i9 j10')).toHaveLength(8);
  });
});
