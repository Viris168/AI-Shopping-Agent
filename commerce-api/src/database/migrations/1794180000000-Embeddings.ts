import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * pgvector columns for hybrid search (bge-small-en-v1.5, 384 dims; src/search/embedding.ts).
 * Filled by `npm run embed`. No ANN index: the tables are small enough that an exact scan wins;
 * add HNSW once a table passes ~10k rows.
 */
export class Embeddings1794180000000 implements MigrationInterface {
  name = 'Embeddings1794180000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    for (const table of ['products', 'faq_articles']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD "embedding" vector(384), ADD "embedding_hash" character varying(64)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The extension stays: something else may use it.
    for (const table of ['faq_articles', 'products']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN "embedding_hash", DROP COLUMN "embedding"`,
      );
    }
  }
}
