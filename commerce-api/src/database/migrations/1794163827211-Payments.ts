import { MigrationInterface, QueryRunner } from 'typeorm';

/** Stripe payment session on orders and processed webhook events (docs/ARCHITECTURE.md §11.7). */
export class Payments1794163827211 implements MigrationInterface {
  name = 'Payments1794163827211';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "payment_events" ("id" character varying(255) NOT NULL, "type" character varying(100) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9f1d16fc78b33e676940a32e8b5" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "payment_session_id" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "paid_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_9de1349a64a7c4bae541516f96" ON "orders" ("payment_session_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d39dd89d89fe12aa86872b7865" ON "orders" ("status", "created_at") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_d39dd89d89fe12aa86872b7865"`);
    await queryRunner.query(`DROP INDEX "IDX_9de1349a64a7c4bae541516f96"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "paid_at"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "payment_session_id"`,
    );
    await queryRunner.query(`DROP TABLE "payment_events"`);
  }
}
