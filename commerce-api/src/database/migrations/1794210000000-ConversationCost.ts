import { MigrationInterface, QueryRunner } from 'typeorm';

/** Cache-hit tokens and estimated model cost per conversation (PLAN-19 M2). */
export class ConversationCost1794210000000 implements MigrationInterface {
  name = 'ConversationCost1794210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "tokens_cache_read" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "cost_micro_usd" bigint NOT NULL DEFAULT '0'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "cost_micro_usd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "tokens_cache_read"`,
    );
  }
}
