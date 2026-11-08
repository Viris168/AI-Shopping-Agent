import { MigrationInterface, QueryRunner } from 'typeorm';

/** Audit status/error columns and idempotency keys (docs/ARCHITECTURE.md §11.3–11.4). */
export class AgentHardening1794130000000 implements MigrationInterface {
  name = 'AgentHardening1794130000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_action_logs" ADD "status" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_action_logs" ADD "error" character varying(500)`,
    );
    await queryRunner.query(
      `CREATE TABLE "idempotency_keys" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "key" character varying(100) NOT NULL, "user_id" uuid, "route" character varying(120) NOT NULL, "request_hash" character(64) NOT NULL, "response" jsonb, "status_code" integer, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8ad20779ad0411107a56e53d0f6" PRIMARY KEY ("id"))`,
    );
    // NULLS NOT DISTINCT (Postgres 15+): guests share user_id NULL but keys stay unique.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_idempotency_keys_user_key" ON "idempotency_keys" ("user_id", "key") NULLS NOT DISTINCT`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5e72f040fdc5efc8eef52a388c" ON "idempotency_keys" ("created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ADD CONSTRAINT "FK_4d2181624ba2d61e76a07175198" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" DROP CONSTRAINT "FK_4d2181624ba2d61e76a07175198"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_5e72f040fdc5efc8eef52a388c"`);
    await queryRunner.query(`DROP INDEX "UQ_idempotency_keys_user_key"`);
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    await queryRunner.query(
      `ALTER TABLE "agent_action_logs" DROP COLUMN "error"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_action_logs" DROP COLUMN "status"`,
    );
  }
}
