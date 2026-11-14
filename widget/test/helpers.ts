import { vi } from 'vitest';

export function sse(...events: [string, unknown][]): string {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

/** A fetch mock that answers each call with the next queued response. */
export function mockFetch(...responses: (Response | (() => Response) | Error)[]) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export const sseResponse = (body: string) =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

export const jsonResponse = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(k: string) { return this.data.get(k) ?? null; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  removeItem(k: string) { this.data.delete(k); }
  setItem(k: string, v: string) { this.data.set(k, v); }
}
