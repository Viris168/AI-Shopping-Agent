import { createHash } from 'node:crypto';
import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';

/** Must match vector(384) in the Embeddings migration. Changing it re-embeds every row. */
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_DIMS = 384;

// bge models expect this prefix on queries (not on the documents being searched).
const QUERY_PREFIX =
  'Represent this sentence for searching relevant passages: ';

// Production containers get the model at image build (Dockerfile) and never fetch it at runtime.
env.allowRemoteModels = process.env.NODE_ENV !== 'production';

export interface ProductEmbeddingFields {
  category: string;
  brand: string;
  name: string;
  description: string;
  tags: string[];
}

export interface FaqEmbeddingFields {
  topic: string;
  question: string;
  answer: string;
}

/** Context first, like a heading path, so a short description still says what the item is. */
export function productEmbeddingText(p: ProductEmbeddingFields): string {
  const tags = p.tags.length > 0 ? `\nTags: ${p.tags.join(', ')}` : '';
  return `${p.category} > ${p.brand} ${p.name}\n${p.description}${tags}`;
}

export function faqEmbeddingText(f: FaqEmbeddingFields): string {
  return `${f.topic} > ${f.question}\n${f.answer}`;
}

/** Stored next to the vector; a row is re-embedded when its text or the model changes. */
export function embeddingHash(text: string): string {
  return createHash('sha256')
    .update(`${EMBEDDING_MODEL}\n${text}`)
    .digest('hex');
}

/** pgvector's text format: '[0.1,0.2,…]'. */
export function toVectorLiteral(vector: number[]): string {
  return JSON.stringify(vector);
}

/** The model, loaded once. Vectors are unit length, so cosine similarity = dot product. */
export class Embedder {
  private model?: Promise<FeatureExtractionPipeline>;

  load(): Promise<FeatureExtractionPipeline> {
    if (!this.model) {
      this.model = pipeline('feature-extraction', EMBEDDING_MODEL, {
        dtype: 'q8',
      });
      // A failed load (e.g. no network on first run) may be retried later.
      this.model.catch(() => (this.model = undefined));
    }
    return this.model;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const model = await this.load();
    // bge is trained with CLS pooling.
    const output = await model(texts, { pooling: 'cls', normalize: true });
    return output.tolist() as number[][];
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedDocuments([QUERY_PREFIX + text]);
    return vector;
  }
}
