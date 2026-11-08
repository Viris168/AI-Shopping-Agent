import {
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Embedder } from './embedding.js';

const CACHE_SIZE = 500;
const QUERY_TIMEOUT_MS = 300;
const RETRY_LOAD_MS = 60_000;

/**
 * Query embeddings for hybrid search. Never throws: `null` means "search by keyword only"
 * (hybrid switched off, model still loading or failed, or too slow).
 */
@Injectable()
export class EmbeddingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EmbeddingService.name);
  // Map keeps insertion order, so the first key is the least recently used.
  private readonly cache = new Map<string, number[]>();
  private ready = false;
  private loading?: Promise<void>;

  constructor(private readonly embedder: Embedder) {}

  get enabled(): boolean {
    return process.env.SEARCH_HYBRID !== 'false';
  }

  onApplicationBootstrap() {
    void this.warmUp();
  }

  /**
   * Starts loading the model in the background; queries before it is ready go keyword-only.
   * Resolves once loaded (or failed). One throwaway query first, so the first shopper's
   * query isn't the slow first inference.
   */
  warmUp(): Promise<void> {
    if (!this.enabled || this.ready) return Promise.resolve();
    this.loading ??= this.embedder
      .load()
      .then(() => this.embedder.embedQuery('warm up'))
      .then(
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
    return this.loading;
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
      void this.warmUp();
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

/** Rows without a vector are found by keyword only; say so at startup (run `npm run embed`). */
@Injectable()
export class EmbeddingCoverageCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(EmbeddingCoverageCheck.name);

  constructor(
    private readonly db: DataSource,
    private readonly embeddings: EmbeddingService,
  ) {}

  async onApplicationBootstrap() {
    if (!this.embeddings.enabled) return;
    try {
      const [row] = await this.db.query<{ products: number; faq: number }[]>(
        `SELECT (SELECT count(*) FROM products WHERE is_active AND embedding IS NULL)::int AS products,
                (SELECT count(*) FROM faq_articles WHERE embedding IS NULL)::int AS faq`,
      );
      if (row.products > 0 || row.faq > 0)
        this.logger.warn(
          `Missing search embeddings (${row.products} products, ${row.faq} FAQs); those rows are found by keyword only. Run: npm run embed`,
        );
    } catch (err) {
      this.logger.warn(`Embedding coverage check failed: ${String(err)}`);
    }
  }
}

@Module({
  providers: [
    { provide: Embedder, useValue: new Embedder() },
    EmbeddingService,
    EmbeddingCoverageCheck,
  ],
  exports: [EmbeddingService],
})
export class SearchModule {}
