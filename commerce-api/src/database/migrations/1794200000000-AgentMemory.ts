import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Long-term agent memory (PLAN-18 step 3): consent, episodes (vector(384), same model as hybrid
 * search) and facts. Every row belongs to one user and goes when the user does.
 */
export class AgentMemory1794200000000 implements MigrationInterface {
  name = 'AgentMemory1794200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "memory_settings" ("user_id" uuid NOT NULL, "enabled" boolean NOT NULL DEFAULT false, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_44086f5992e84963c465688c2d3" PRIMARY KEY ("user_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "memory_episodes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "conversation_id" uuid NOT NULL, "summary" character varying(500) NOT NULL, "outcome" character varying(16), "entities" jsonb NOT NULL DEFAULT '{}', "embedding" vector(384), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_5d6989c44505aae52a96de35ccf" UNIQUE ("user_id", "conversation_id"), CONSTRAINT "PK_ac057077b800a3b7dfc8d78014b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_30f1f61698840db39612663f4d" ON "memory_episodes" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a62df936f9731372cd7af9a698" ON "memory_episodes" ("created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "memory_facts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "kind" character varying(20) NOT NULL, "value" character varying(200) NOT NULL, "value_key" character varying(200) NOT NULL, "source_conversation_id" uuid, "confidence" real NOT NULL DEFAULT '1', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_6a271502d7553553d66281e454f" UNIQUE ("user_id", "kind", "value_key"), CONSTRAINT "PK_09d59687671e9d1faca69c664b5" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_34c451790213256b8b0c6b9b62" ON "memory_facts" ("user_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "memory_settings" ADD CONSTRAINT "FK_44086f5992e84963c465688c2d3" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "memory_episodes" ADD CONSTRAINT "FK_30f1f61698840db39612663f4d6" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "memory_facts" ADD CONSTRAINT "FK_34c451790213256b8b0c6b9b62c" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "memory_facts"`);
    await queryRunner.query(`DROP TABLE "memory_episodes"`);
    await queryRunner.query(`DROP TABLE "memory_settings"`);
  }
}
