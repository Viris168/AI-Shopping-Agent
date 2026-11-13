import { describe, expect, it } from 'vitest';
import { createI18n } from '../src/i18n';

describe('i18n dates', () => {
  // 18:00 UTC on Dec 1 is already Dec 2 in Bangkok and still Dec 1 in New York.
  const deadline = '2026-12-01T18:00:00.000Z';

  it("shows calendar dates in the store's time zone, whatever the shopper's is", () => {
    expect(createI18n('en', 'Asia/Bangkok').date(deadline)).toBe('Dec 2, 2026');
    expect(createI18n('en', 'America/New_York').date(deadline)).toBe('Dec 1, 2026');
  });

  it('leaves odd input blank', () => {
    expect(createI18n('en', 'UTC').date('not a date')).toBe('');
    expect(createI18n('en', 'UTC').date(null)).toBe('');
  });
});
