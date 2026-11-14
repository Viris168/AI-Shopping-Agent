import { MigrationInterface, QueryRunner } from 'typeorm';

/** Model-routing rollout group per conversation (PLAN-19 M6). */
export class ConversationRoutingGroup1794220000000 implements MigrationInterface {
  name = 'ConversationRoutingGroup1794220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "routing_group" character varying(16)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "routing_group"`,
    );
  }
}
