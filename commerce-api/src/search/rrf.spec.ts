import { rrf } from './rrf.js';

describe('rrf', () => {
  it('ranks ids found by both lists above ids found by one', () => {
    expect(
      rrf([
        ['a', 'b'],
        ['c', 'b'],
      ]).map((f) => f.id),
    ).toEqual(['b', 'a', 'c']);
  });

  it('keeps a single list in order, and the first list wins ties', () => {
    expect(rrf([['a', 'b', 'c'], []]).map((f) => f.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(rrf([['a'], ['b']]).map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('scores 1 / (k + rank)', () => {
    expect(rrf([['a'], ['a']], 60)[0].score).toBeCloseTo(2 / 61);
  });

  it('returns nothing for no ids', () => {
    expect(rrf([[], []])).toEqual([]);
  });
});
