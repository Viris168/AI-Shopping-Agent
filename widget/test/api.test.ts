import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ChatApi, parseSse } from '../src/api';
import { jsonResponse, mockFetch, sse, sseResponse } from './helpers';

afterEach(() => vi.unstubAllGlobals());

function chunked(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

describe('parseSse', () => {
  it('handles events split across chunks, CRLF and multi-line data', async () => {
    const events = [];
    for await (const e of parseSse(
      chunked('event: meta\ndata: {"conversa', 'tionId":"c1"}\n\n', 'event: text_delta\r\ndata: {"text":\r\ndata: "hi"}\r\n\r\n', 'data: {"x":1}\n\n'),
    )) events.push(e);
    expect(events).toEqual([
      { event: 'meta', data: { conversationId: 'c1' } },
      { event: 'text_delta', data: { text: 'hi' } },
      { event: 'message', data: { x: 1 } },
    ]);
  });
});

describe('ChatApi', () => {
  it('sends the token and the body, and omits a null conversationId', async () => {
    const fetch = mockFetch(sseResponse(sse(['done', {}])));
    const api = new ChatApi('https://chat.test', async () => 'jwt-1');
    for await (const _ of api.chat({ conversationId: null, message: 'hi', locale: 'en' })) void _;
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://chat.test/v1/chat');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
    expect(JSON.parse(init.body as string)).toEqual({ message: 'hi', locale: 'en' });
    expect(init.credentials).toBe('omit');
  });

  it('retries network and gateway errors before the stream starts', async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(new TypeError('offline'), jsonResponse(502), sseResponse(sse(['done', {}])));
    const api = new ChatApi('https://chat.test');
    const run = (async () => {
      for await (const _ of api.confirm('a1')) void _;
    })();
    await vi.runAllTimersAsync();
    await run;
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('does not retry client errors', async () => {
    const fetch = mockFetch(jsonResponse(429, { detail: 'slow down' }));
    const api = new ChatApi('https://chat.test');
    await expect(api.cancel('a1')).rejects.toEqual(new ApiError(429, 'slow down'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
