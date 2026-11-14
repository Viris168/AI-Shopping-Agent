// Calls to agent-service: POST bodies with SSE responses, parsed from fetch streams.

import type { PhotoUpload } from './photo';

export interface SseEvent {
  event: string;
  data: any;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The `X-Limit` response header: which limit refused the request — "images" (a photo was
     *  refused, not the message) or a spend/rate limit (PLAN-19 M7). */
    readonly limit: string | null = null,
  ) {
    super(message);
  }
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : (blocks.pop() ?? '');
      for (const block of blocks) {
        const event = parseBlock(block);
        if (event) yield event;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

export type TokenGetter = () => Promise<string | null> | string | null;

const RETRY_STATUSES = new Set([502, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ChatApi {
  constructor(
    private readonly base: string,
    private readonly getToken: TokenGetter = () => null,
    private readonly retries = 2,
  ) {}

  /** Fetches the shopper's token ahead of the first message, so opening the chat does the slow
   *  part. Errors are ignored: the first real request asks again. */
  async warmUp(): Promise<void> {
    try {
      await this.getToken();
    } catch {
      // Chat as a guest; request() reports real failures.
    }
  }

  chat(body: {
    conversationId: string | null; message: string; locale: string; image?: PhotoUpload; via?: 'voice';
  }) {
    const { conversationId, ...rest } = body;
    return this.stream('/v1/chat', conversationId ? body : rest);
  }

  confirm(actionId: string) {
    return this.stream(`/v1/actions/${encodeURIComponent(actionId)}/confirm`);
  }

  async cancel(actionId: string): Promise<void> {
    await this.request(`/v1/actions/${encodeURIComponent(actionId)}/cancel`);
  }

  async feedback(body: {
    conversationId: string;
    messageId: string;
    rating: 'up' | 'down';
    via?: 'voice';
  }): Promise<void> {
    await this.request('/v1/feedback', body);
  }

  async *stream(path: string, body?: unknown): AsyncGenerator<SseEvent> {
    const res = await this.request(path, body);
    if (!res.body) throw new ApiError(0, 'Empty response');
    yield* parseSse(res.body);
  }

  /** POST with the shopper's token. Retries network errors and gateway errors before any
   * response has started; a stream that drops midway is the caller's to retry. */
  private async request(path: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.retries;
      let res: Response;
      try {
        const token = await this.getToken();
        res = await fetch(`${this.base}${path}`, {
          method: 'POST',
          credentials: 'omit',
          headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (last) throw err;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.ok) return res;
      if (!RETRY_STATUSES.has(res.status) || last) {
        let detail = '';
        try {
          detail = String((await res.json()).detail ?? '');
        } catch {
          // Not JSON; the status is enough.
        }
        throw new ApiError(res.status, detail, res.headers.get('X-Limit'));
      }
      await sleep(500 * 2 ** attempt);
    }
  }
}
