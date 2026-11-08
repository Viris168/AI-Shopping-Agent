import { pathToFileURL } from 'node:url';
import { DataSource } from 'typeorm';
import {
  Embedder,
  embeddingHash,
  faqEmbeddingText,
  productEmbeddingText,
  toVectorLiteral,
} from '../search/embedding.js';
import { dataSourceOptions } from './options.js';

const BATCH_SIZE = 32;

interface Row {
  id: string;
  text: string;
  hash: string | null;
}

export interface EmbedCounts {
  embedded: number;
  unchanged: number;
}

/**
 * Embeds every product and FAQ whose text changed since it was last embedded (or every row with
 * `force`). Safe to re-run; inactive products are embedded too, so reactivating one needs no step.
 */
export async function embedAll(
  db: DataSource,
  { force = false, embedder = new Embedder() } = {},
): Promise<{ products: EmbedCounts; faq: EmbedCounts }> {
  const products = await db.query<
    {
      id: string;
      category: string;
      brand: string;
      name: string;
      description: string;
      tags: string[];
      hash: string | null;
    }[]
  >(
    `SELECT p.id, c.name AS category, p.brand, p.name, p.description, p.tags,
            p.embedding_hash AS hash
       FROM products p JOIN categories c ON c.id = p.category_id`,
  );
  const faqs = await db.query<
    {
      id: string;
      topic: string;
      question: string;
      answer: string;
      hash: string | null;
    }[]
  >(
    `SELECT id, topic, question, answer, embedding_hash AS hash FROM faq_articles`,
  );

  return {
    products: await embedTable(
      db,
      embedder,
      'products',
      products.map((p) => ({ ...p, text: productEmbeddingText(p) })),
      force,
    ),
    faq: await embedTable(
      db,
      embedder,
      'faq_articles',
      faqs.map((f) => ({ ...f, text: faqEmbeddingText(f) })),
      force,
    ),
  };
}

async function embedTable(
  db: DataSource,
  embedder: Embedder,
  table: 'products' | 'faq_articles',
  rows: Row[],
  force: boolean,
): Promise<EmbedCounts> {
  const stale = rows
    .map((r) => ({ ...r, newHash: embeddingHash(r.text) }))
    .filter((r) => force || r.hash !== r.newHash);

  for (let i = 0; i < stale.length; i += BATCH_SIZE) {
    const batch = stale.slice(i, i + BATCH_SIZE);
    const vectors = await embedder.embedDocuments(batch.map((r) => r.text));
    await db.transaction(async (m) => {
      for (const [j, r] of batch.entries()) {
        await m.query(
          `UPDATE "${table}" SET embedding = $1::vector, embedding_hash = $2 WHERE id = $3`,
          [toVectorLiteral(vectors[j]), r.newHash, r.id],
        );
      }
    });
  }
  return { embedded: stale.length, unchanged: rows.length - stale.length };
}

export function formatCounts(counts: Awaited<ReturnType<typeof embedAll>>) {
  const part = (name: string, c: EmbedCounts) =>
    `${name}: ${c.embedded} embedded, ${c.unchanged} unchanged`;
  return `${part('products', counts.products)} · ${part('faq', counts.faq)}`;
}

// `npm run embed [-- --force]` runs this file directly.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: use the real environment.
  }
  const db = await new DataSource(dataSourceOptions()).initialize();
  try {
    const counts = await embedAll(db, {
      force: process.argv.includes('--force'),
    });
    console.log(formatCounts(counts));
  } finally {
    await db.destroy();
  }
}
