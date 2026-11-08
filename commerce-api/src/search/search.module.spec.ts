import type { Embedder } from './embedding.js';
import { EmbeddingService } from './search.module.js';

/** Stands in for the model: resolves `[length]` after `delayMs`, or fails. */
function fakeEmbedder({ delayMs = 0, fail = false, failLoad = false } = {}) {
  const fake = {
    calls: 0,
    load: vi.fn(() =>
      failLoad ? Promise.reject(new Error('no model')) : Promise.resolve(),
    ),
    embedQuery: vi.fn(async (text: string) => {
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
  service.warmUp();
  await new Promise((r) => setTimeout(r, 0));
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
    await new Promise((r) => setTimeout(r, 0));
    expect(await service.embedQuery('boots')).toEqual([5]);
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
    service.warmUp();
    expect(await service.embedQuery('boots')).toBeNull();
    expect(embedder.load).not.toHaveBeenCalled();
  });

  it('returns null when embedding is too slow or fails', async () => {
    expect(
      await (
        await readyService(fakeEmbedder({ delayMs: 1000 }))
      ).embedQuery('boots'),
    ).toBeNull();
    expect(
      await (
        await readyService(fakeEmbedder({ fail: true }))
      ).embedQuery('boots'),
    ).toBeNull();
  });

  it('does not retry a failed load on every query', async () => {
    const embedder = fakeEmbedder({ failLoad: true });
    const service = new EmbeddingService(embedder as unknown as Embedder);
    await service.embedQuery('a');
    await new Promise((r) => setTimeout(r, 0));
    await service.embedQuery('b');
    expect(embedder.load).toHaveBeenCalledOnce();
  });
});
