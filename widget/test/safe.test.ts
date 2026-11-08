import { describe, expect, it } from 'vitest';
import { LinkPolicy, linkify } from '../src/safe';

const policy = new LinkPolicy(['shop.test', 'ups.com']);

describe('LinkPolicy', () => {
  it.each([
    ['https://shop.test/checkout', true],
    ['https://www.shop.test/p/1', true],
    ['https://www.ups.com/track?n=1', true],
    ['http://shop.test/x', false],
    ['https://evil-shop.test/x', false],
    ['https://shop.test.evil.com/x', false],
    ['javascript:alert(1)', false],
    ['data:text/html,hi', false],
    ['http://localhost:3001/checkout', false],
  ])('%s → %s', (url, ok) => {
    expect(policy.safeUrl(url) !== null).toBe(ok);
  });

  it('allows plain http only for localhost hosts on the list', () => {
    expect(new LinkPolicy(['localhost']).safeUrl('http://localhost:3001/checkout')).not.toBeNull();
  });
});

describe('linkify', () => {
  it('links allowed URLs only and never parses HTML', () => {
    const div = document.createElement('div');
    div.append(
      linkify('See https://shop.test/p/1. Not https://evil.com/x <img src=x onerror=alert(1)>', policy),
    );
    const links = div.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://shop.test/p/1');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(div.querySelector('img')).toBeNull();
    expect(div.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
