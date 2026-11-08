import { MigrationInterface, QueryRunner } from 'typeorm';

export class SearchIndexes1794129000000 implements MigrationInterface {
  name = 'SearchIndexes1794129000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    // Product search uses ILIKE '%term%' on these columns.
    await queryRunner.query(
      `CREATE INDEX "IDX_products_name_trgm" ON "products" USING GIN ("name" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_products_description_trgm" ON "products" USING GIN ("description" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_products_tags" ON "products" USING GIN ("tags")`,
    );
    // Must match the expression in FaqService.search exactly to be used.
    await queryRunner.query(
      `CREATE INDEX "IDX_faq_articles_fts" ON "faq_articles" USING GIN ((setweight(to_tsvector('english', "question"), 'A') || setweight(to_tsvector('english', "answer"), 'C')))`,
    );
    // New order numbers: ORD-2001, ORD-2002, … (seed orders use lower numbers).
    await queryRunner.query(
      `CREATE SEQUENCE "order_number_seq" START WITH 2001`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE "order_number_seq"`);
    await queryRunner.query(`DROP INDEX "IDX_faq_articles_fts"`);
    await queryRunner.query(`DROP INDEX "IDX_products_tags"`);
    await queryRunner.query(`DROP INDEX "IDX_products_description_trgm"`);
    await queryRunner.query(`DROP INDEX "IDX_products_name_trgm"`);
  }
}
