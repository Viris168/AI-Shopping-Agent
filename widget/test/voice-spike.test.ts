import { describe, expect, it } from 'vitest';
import { PHRASES } from '../spike/phrases';
import { loosen, normalize, score, wordErrorRate } from '../spike/score';

const phrase = (id: string) => PHRASES.find((p) => p.id === id)!;

describe('voice spike scoring (PLAN-21 M0)', () => {
  it('normalizes punctuation, case and thousands separators', () => {
    expect(normalize('Where is ORD-1001?')).toBe('where is ord 1001');
    expect(normalize('dưới 5.000.000 đồng')).toBe('dưới 5000000 đồng');
    expect(loosen('Đơn hàng ORD 1001')).toBe('donhangord1001');
  });

  it('grades a perfect transcript exact', () => {
    const s = score(phrase('en-02'), 'Where is my order ORD-1001?');
    expect(s).toEqual({ grade: 'exact', missed: [], wer: 0 });
  });

  it('accepts other spellings of a key term', () => {
    expect(score(phrase('en-04'), 'please apply the coupon save 20').grade).toBe('exact');
    expect(score(phrase('en-10'), 'my city walk sneakers arrived damaged can I talk to a person').grade).toBe('exact');
  });

  it('grades lost accents or split codes as close', () => {
    expect(score(phrase('vi-01'), 'don hang ORD 1001 cua toi dang o dau').grade).toBe('close');
    expect(score(phrase('en-02'), 'where is my order or d1001').grade).toBe('close');
  });

  it('grades a missing key term wrong and names it', () => {
    const s = score(phrase('en-05'), 'is the welcome code still valid');
    expect(s.grade).toBe('wrong');
    expect(s.missed).toEqual(['welcome10']);
  });

  it('matches whole words in exact mode', () => {
    // "42" inside "420" is not the size the shopper said.
    expect(score(phrase('en-01'), 'do you have the trailrunner 3 running shoes in size 420').grade).not.toBe('exact');
  });

  it('computes word error rate', () => {
    expect(wordErrorRate('a b c d', 'a b c d')).toBe(0);
    expect(wordErrorRate('a b c d', 'a x c')).toBe(0.5);
  });

  it('has 10 phrases per language with unique ids', () => {
    expect(PHRASES.filter((p) => p.lang === 'en-US')).toHaveLength(10);
    expect(PHRASES.filter((p) => p.lang === 'vi-VN')).toHaveLength(10);
    expect(new Set(PHRASES.map((p) => p.id)).size).toBe(PHRASES.length);
  });
});
