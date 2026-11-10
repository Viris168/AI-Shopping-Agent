import { beforeAll, describe, expect, it, vi } from 'vitest';
import { jsonResponse, mockFetch, sse, sseResponse } from './helpers';

let root: ShadowRoot;
const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  window.ShopChat = { getToken: () => 'host-token' };
  const script = document.createElement('script');
  script.dataset.shopchat = '';
  script.dataset.api = 'https://chat.shop.test';
  script.dataset.store = 'test';
  script.dataset.privacyUrl = 'https://evil.example/privacy';
  document.body.append(script);
  const fetch = mockFetch(jsonResponse(200, { enabled: true, rolloutPercent: 100 }));
  await import('../src/index');
  await vi.waitFor(() => expect(document.getElementById('shopchat-root')).not.toBeNull());
  expect(fetch).toHaveBeenCalledWith('https://chat.shop.test/v1/config', { credentials: 'omit' });
  root = document.getElementById('shopchat-root')!.shadowRoot!;
});

describe('widget', () => {
  it('mounts in a shadow root and keeps the host token getter', () => {
    expect(root.querySelector('style')).not.toBeNull();
    expect(typeof window.ShopChat?.open).toBe('function');
    expect(window.ShopChat?.getToken?.()).toBe('host-token');
  });

  it('tells shoppers the chat is stored, and only links privacy pages on allowed hosts', () => {
    const notice = $<HTMLElement>('#shopchat-notice');
    expect(notice.textContent).toContain('90 days');
    expect($('.panel').getAttribute('aria-describedby')).toBe('shopchat-notice');
    expect(notice.querySelector('a')).toBeNull(); // evil.example isn't a store domain
  });

  it('opens and closes from the keyboard, returning focus to the bubble', async () => {
    const bubble = $<HTMLButtonElement>('.bubble');
    const opened = vi.fn();
    window.addEventListener('shopchat:open', opened, { once: true });
    bubble.click();
    expect($<HTMLElement>('.panel').hidden).toBe(false);
    expect(bubble.getAttribute('aria-expanded')).toBe('true');
    expect(opened).toHaveBeenCalled();

    $('.panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($<HTMLElement>('.panel').hidden).toBe(true);
    expect(root.activeElement).toBe(bubble);
  });

  it('renders model output as text, never as HTML, and shows cards', async () => {
    mockFetch(
      sseResponse(
        sse(
          ['meta', { conversationId: 'c1', messageId: 'm1' }],
          ['text_delta', { text: '<img src=x onerror="alert(1)"> Here you go' }],
          ['card', { type: 'product_list', data: { items: [{ id: 'p1', name: 'Rain Jacket', price: '$79.00', inStock: true, stock: 3, url: 'https://evil.com/x', imageUrl: 'https://chat.shop.test/i.jpg' }] } }],
          ['done', {}],
        ),
      ),
    );
    window.ShopChat!.open!();
    const input = $<HTMLTextAreaElement>('textarea');
    input.value = 'jackets?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect($('.product')).not.toBeNull());
    await flush();

    const reply = root.querySelectorAll('.msg-assistant')[0];
    expect(reply.querySelector('.bubble-text img')).toBeNull();
    expect(reply.querySelector('.bubble-text')!.textContent).toContain('<img src=x');
    expect($('.product-name').textContent).toBe('Rain Jacket');
    expect($('.product img')?.getAttribute('src')).toBe('https://chat.shop.test/i.jpg');
    expect(root.querySelector('.product a[href*="evil.com"]')).toBeNull(); // off-domain link dropped
    expect($('.badge').textContent).toBe('Only 3 left');
    expect(root.querySelector('.feedback')).not.toBeNull();
  });

  it('shows the fallback card with a retry when the model is down', async () => {
    mockFetch(sseResponse(sse(['error', { code: 'model_unavailable', message: 'down', retryable: true }], ['done', {}])));
    const input = $<HTMLTextAreaElement>('textarea');
    input.value = 'hello?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect($('.card-fallback')).not.toBeNull());

    const card = $('.card-fallback');
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.querySelector('.card-title')!.textContent).toBe("The assistant isn't available right now");
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Try again']);
    expect(root.querySelector('.card-error')).toBeNull();
  });
  it('says when it uses remembered preferences, linking only to the store', async () => {
    const ask = async (manageUrl: string) => {
      mockFetch(sseResponse(sse(
        ['meta', { conversationId: 'c1', messageId: 'm9' }],
        ['memory', { facts: 1, episodes: 0, manageUrl }],
        ['text_delta', { text: 'Size M again?' }],
        ['done', {}],
      )));
      const input = $<HTMLTextAreaElement>('textarea');
      input.value = 'shoes';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.waitFor(() => expect(root.querySelectorAll('.memory-note').length).toBeGreaterThan(0));
      await flush();
      const notes = root.querySelectorAll<HTMLElement>('.memory-note');
      return notes[notes.length - 1];
    };

    const note = await ask('https://chat.shop.test/account');
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toContain('I remember what you asked me to keep');
    expect(note.querySelector('a')!.getAttribute('href')).toBe('https://chat.shop.test/account');

    const offDomain = await ask('https://evil.example/account');
    expect(offDomain.querySelector('a')).toBeNull();
  });
});
