import { describe, expect, it } from 'vitest';
import { storeTimeZone } from '../src/format';

describe('storeTimeZone', () => {
  it('keeps a zone the browser knows and drops anything else', () => {
    expect(storeTimeZone('Asia/Bangkok')).toBe('Asia/Bangkok');
    expect(storeTimeZone('Mars/Olympus')).toBeUndefined();
    expect(storeTimeZone(undefined)).toBeUndefined();
    expect(storeTimeZone('')).toBeUndefined();
  });
});
