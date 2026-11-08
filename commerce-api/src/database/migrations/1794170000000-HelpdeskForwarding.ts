import { MigrationInterface, QueryRunner } from 'typeorm';

/** Helpdesk forwarding state on support tickets (support/helpdesk.client.ts). */
export class HelpdeskForwarding1794170000000 implements MigrationInterface {
  name = 'HelpdeskForwarding1794170000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Added without a default first, so existing tickets stay null and aren't pushed.
    await queryRunner.query(
      `ALTER TABLE "support_tickets" ADD "next_forward_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" ALTER COLUMN "next_forward_at" SET DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" ADD "forward_attempts" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" ADD "forwarded_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" ADD "helpdesk_ref" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" ADD "forward_error" character varying(300)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_tickets_next_forward_at" ON "support_tickets" ("next_forward_at") WHERE "next_forward_at" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_support_tickets_next_forward_at"`);
    await queryRunner.query(
      `ALTER TABLE "support_tickets" DROP COLUMN "forward_error"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" DROP COLUMN "helpdesk_ref"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" DROP COLUMN "forwarded_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" DROP COLUMN "forward_attempts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" DROP COLUMN "next_forward_at"`,
    );
  }
}
