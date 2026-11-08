import { Injectable, Logger, Module } from '@nestjs/common';
import { Embedder } from './embedding.js';

const CACHE_SIZE = 500;
const QUERY_TIMEOUT_MS = 300;
const RETRY_LOAD_MS = 60_000;

/**
 * Query embeddings for hybrid search. Never throws: `null` means "search by keyword only"
 * (hybrid switched off, model still loading or failed, or too slow).
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  // Map keeps insertion order, so the first key is the least recently used.
  private readonly cache = new Map<string, number[]>();
  private ready = false;
  private loading?: Promise<void>;

  constructor(private readonly embedder: Embedder) {}

  get enabled(): boolean {
    return process.env.SEARCH_HYBRID !== 'false';
  }

  /** Starts loading the model in the background; queries before it is ready go keyword-only. */
  warmUp(): void {
    if (!this.enabled || this.ready || this.loading) return;
    this.loading = this.embedder.load().then(
      () => {
        this.ready = true;
      },
      (err: unknown) => {
        this.logger.warn(
          `Embedding model failed to load; search is keyword-only: ${String(err)}`,
        );
        // Try again on a later query, at most once a minute.
        setTimeout(() => (this.loading = undefined), RETRY_LOAD_MS).unref();
      },
    );
  }

  async embedQuery(text: string): Promise<number[] | null> {
    if (!this.enabled) return null;
    const key = text.trim().toLowerCase();
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    if (!this.ready) {
      this.warmUp();
      return null;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), QUERY_TIMEOUT_MS);
    });
    try {
      const vector = await Promise.race([
        this.embedder.embedQuery(key),
        timeout,
      ]);
      if (!vector) {
        this.logger.warn('Query embedding timed out; keyword-only search');
        return null;
      }
      this.cache.set(key, vector);
      if (this.cache.size > CACHE_SIZE)
        this.cache.delete(this.cache.keys().next().value!);
      return vector;
    } catch (err) {
      // Never log the query itself: shoppers type personal details into search.
      this.logger.warn(`Query embedding failed: ${String(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

@Module({
  providers: [
    { provide: Embedder, useValue: new Embedder() },
    EmbeddingService,
  ],
  exports: [EmbeddingService],
})
export class SearchModule {}
