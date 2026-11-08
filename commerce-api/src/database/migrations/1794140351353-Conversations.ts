import { MigrationInterface, QueryRunner } from 'typeorm';

/** Transcript storage for support and evals (docs/ARCHITECTURE.md §5.2). */
export class Conversations1794140351353 implements MigrationInterface {
  name = 'Conversations1794140351353';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "conversations" ("id" uuid NOT NULL, "user_id" uuid, "messages" jsonb NOT NULL DEFAULT '[]', "summary" text, "outcome" character varying(16), "tokens_in" integer NOT NULL DEFAULT '0', "tokens_out" integer NOT NULL DEFAULT '0', "feedback" jsonb NOT NULL DEFAULT '[]', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ee34f4f7ced4ec8681f26bf04ef" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3a9ae579e61e81cc0e989afeb4" ON "conversations" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7018433f850e2836a7d9df1b9d" ON "conversations" ("updated_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD CONSTRAINT "FK_3a9ae579e61e81cc0e989afeb4a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_3a9ae579e61e81cc0e989afeb4a"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_7018433f850e2836a7d9df1b9d"`);
    await queryRunner.query(`DROP INDEX "IDX_3a9ae579e61e81cc0e989afeb4"`);
    await queryRunner.query(`DROP TABLE "conversations"`);
  }
}
