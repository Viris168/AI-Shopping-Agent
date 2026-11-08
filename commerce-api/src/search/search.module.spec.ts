import type { Embedder } from './embedding.js';
import { EmbeddingService } from './search.module.js';

/**
 * Stands in for the model: resolves `[length]` after `delayMs`, or fails. The warm-up query
 * always succeeds at once, so `delayMs` and `fail` only affect shopper queries.
 */
function fakeEmbedder({ delayMs = 0, fail = false, failLoad = false } = {}) {
  const fake = {
    calls: 0,
    load: vi.fn(() =>
      failLoad ? Promise.reject(new Error('no model')) : Promise.resolve(),
    ),
    embedQuery: vi.fn(async (text: string) => {
      if (text === 'warm up') return [0];
      fake.calls++;
      await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw new Error('boom');
      return [text.length];
    }),
  };
  return fake;
}

async function readyService(embedder: ReturnType<typeof fakeEmbedder>) {
  const service = new EmbeddingService(embedder as unknown as Embedder);
  await service.warmUp();
  return service;
}

describe('EmbeddingService', () => {
  afterEach(() => {
    delete process.env.SEARCH_HYBRID;
  });

  it('returns null and starts loading while the model is not ready', async () => {
    const embedder = fakeEmbedder();
    const service = new EmbeddingService(embedder as unknown as Embedder);
    expect(await service.embedQuery('boots')).toBeNull();
    expect(embedder.load).toHaveBeenCalledOnce();
    await service.warmUp();
    expect(await service.embedQuery('boots')).toEqual([5]);
  });

  it('runs one warm-up query before it reports ready', async () => {
    const embedder = fakeEmbedder();
    await readyService(embedder);
    expect(embedder.embedQuery).toHaveBeenCalledWith('warm up');
  });

  it('caches by normalized query', async () => {
    const embedder = fakeEmbedder();
    const service = await readyService(embedder);
    expect(await service.embedQuery('Boots ')).toEqual([5]);
    expect(await service.embedQuery('boots')).toEqual([5]);
    expect(embedder.calls).toBe(1);
  });

  it('returns null when switched off, without loading the model', async () => {
    process.env.SEARCH_HYBRID = 'false';
    const embedder = fakeEmbedder();
    const service = new EmbeddingService(embedder as unknown as Embedder);
    await service.warmUp();
    expect(await service.embedQuery('boots')).toBeNull();
    expect(embedder.load).not.toHaveBeenCalled();
  });

  it('returns null when embedding is too slow or fails', async () => {
    const slow = await readyService(fakeEmbedder({ delayMs: 1000 }));
    expect(await slow.embedQuery('boots')).toBeNull();
    const failing = await readyService(fakeEmbedder({ fail: true }));
    expect(await failing.embedQuery('boots')).toBeNull();
  });

  it('does not retry a failed load on every query', async () => {
    const embedder = fakeEmbedder({ failLoad: true });
    const service = new EmbeddingService(embedder as unknown as Embedder);
    await service.warmUp();
    await service.embedQuery('a');
    await service.embedQuery('b');
    expect(embedder.load).toHaveBeenCalledOnce();
  });
});
