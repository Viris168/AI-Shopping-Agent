import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-user token version, so logout revokes issued tokens (auth/auth.guards.ts). */
export class TokenVersion1794190000000 implements MigrationInterface {
  name = 'TokenVersion1794190000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "token_version" integer NOT NULL DEFAULT '0'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "token_version"`);
  }
}
