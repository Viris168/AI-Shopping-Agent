import { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1794128955639 implements MigrationInterface {
  name = 'Init1794128955639';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying(254) NOT NULL, "password_hash" character varying(100) NOT NULL, "name" character varying(100) NOT NULL, "role" character varying(20) NOT NULL DEFAULT 'CUSTOMER', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users"  ("email") `,
    );
    await queryRunner.query(
      `CREATE TABLE "categories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(60) NOT NULL, "slug" character varying(60) NOT NULL, CONSTRAINT "PK_24dbc6126a28ff948da33e97d3b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_420d9f679d41281f282f5bc7d0" ON "categories"  ("slug") `,
    );
    await queryRunner.query(
      `CREATE TABLE "products" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "sku" character varying(40) NOT NULL, "slug" character varying(120) NOT NULL, "name" character varying(200) NOT NULL, "brand" character varying(60) NOT NULL, "description" text NOT NULL, "price_cents" integer NOT NULL, "stock" integer NOT NULL DEFAULT '0', "rating" real NOT NULL DEFAULT '0', "tags" text array NOT NULL DEFAULT '{}', "attributes" jsonb NOT NULL DEFAULT '{}', "is_active" boolean NOT NULL DEFAULT true, "category_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_f183285c3c1d60f5198e0a4b96" CHECK ("price_cents" >= 0), CONSTRAINT "CHK_1f5ec29fd762bd3d512d5a0434" CHECK ("stock" >= 0), CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_c44ac33a05b144dd0d9ddcf932" ON "products"  ("sku") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_464f927ae360106b783ed0b410" ON "products"  ("slug") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5b7246644a9c703729a0e89b13" ON "products"  ("is_active", "price_cents") `,
    );
    await queryRunner.query(
      `CREATE TABLE "carts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "coupon_code" character varying(40), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_b5f695a59f5ebb50af3c8160816" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_2ec1c94a977b940d85a4f498ae" ON "carts"  ("user_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "cart_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "cart_id" uuid NOT NULL, "product_id" uuid NOT NULL, "quantity" integer NOT NULL, CONSTRAINT "UQ_dba960dbfd8636893d3c7acb18d" UNIQUE ("cart_id", "product_id"), CONSTRAINT "CHK_66dd42f2aee15437b7ec8caf99" CHECK ("quantity" > 0), CONSTRAINT "PK_6fccf5ec03c172d27a28a82928b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "coupons" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying(40) NOT NULL, "percent_off" integer, "amount_off_cents" integer, "min_subtotal_cents" integer NOT NULL DEFAULT '0', "expires_at" TIMESTAMP WITH TIME ZONE, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_d7ea8864a0150183770f3e9a8cb" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_e025109230e82925843f2a14c4" ON "coupons"  ("code") `,
    );
    await queryRunner.query(
      `CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_number" character varying(20) NOT NULL, "user_id" uuid NOT NULL, "status" character varying(20) NOT NULL, "subtotal_cents" integer NOT NULL, "discount_cents" integer NOT NULL DEFAULT '0', "shipping_cents" integer NOT NULL DEFAULT '0', "total_cents" integer NOT NULL, "coupon_code" character varying(40), "shipping_address" jsonb, "carrier" character varying(40), "tracking_number" character varying(60), "shipped_at" TIMESTAMP WITH TIME ZONE, "delivered_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_75eba1c6b1a66b09f2a97e6927" ON "orders"  ("order_number") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fbfc1475fc6797244d160068cb" ON "orders"  ("user_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "order_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "product_id" uuid, "name_snapshot" character varying(200) NOT NULL, "unit_price_cents" integer NOT NULL, "quantity" integer NOT NULL, CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "return_requests" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "user_id" uuid NOT NULL, "reason" text NOT NULL, "items" jsonb NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'REQUESTED', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_38714de8942bd9bc3a450a06889" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_47fa80a304062cb2e2703f1d62" ON "return_requests"  ("user_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "faq_articles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "topic" character varying(20) NOT NULL, "question" character varying(300) NOT NULL, "answer" text NOT NULL, CONSTRAINT "PK_99b16ca1ec8f9427aa8e0a69ab8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "support_tickets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid, "conversation_id" character varying(64), "contact_email" character varying(254), "subject" character varying(200) NOT NULL, "summary" text NOT NULL, "priority" character varying(10) NOT NULL DEFAULT 'normal', "status" character varying(20) NOT NULL DEFAULT 'OPEN', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_942e8d8f5df86100471d2324643" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0b1eb4f1f984aab3c481c48468" ON "support_tickets"  ("user_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "agent_action_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid, "conversation_id" character varying(64), "action" character varying(120) NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_abf723bacc0d02585f01a04c239" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4ee1f887ff9713eb8ffb71bfd3" ON "agent_action_logs"  ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_eb20a254902bbb70e5e35d6b74" ON "agent_action_logs"  ("conversation_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "FK_9a5f6868c96e0069e699f33e124" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "carts" ADD CONSTRAINT "FK_2ec1c94a977b940d85a4f498aea" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD CONSTRAINT "FK_6385a745d9e12a89b859bb25623" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD CONSTRAINT "FK_30e89257a105eab7648a35c7fce" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_a922b820eeef29ac1c6800e826a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD CONSTRAINT "FK_145532db85752b29c57d2b7b1f1" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD CONSTRAINT "FK_9263386c35b6b242540f9493b00" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "return_requests" ADD CONSTRAINT "FK_c7f39dfc32be2b7be25c139ba04" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "return_requests" ADD CONSTRAINT "FK_47fa80a304062cb2e2703f1d620" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" ADD CONSTRAINT "FK_0b1eb4f1f984aab3c481c48468a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "support_tickets" DROP CONSTRAINT "FK_0b1eb4f1f984aab3c481c48468a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "return_requests" DROP CONSTRAINT "FK_47fa80a304062cb2e2703f1d620"`,
    );
    await queryRunner.query(
      `ALTER TABLE "return_requests" DROP CONSTRAINT "FK_c7f39dfc32be2b7be25c139ba04"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP CONSTRAINT "FK_9263386c35b6b242540f9493b00"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP CONSTRAINT "FK_145532db85752b29c57d2b7b1f1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_a922b820eeef29ac1c6800e826a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP CONSTRAINT "FK_30e89257a105eab7648a35c7fce"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP CONSTRAINT "FK_6385a745d9e12a89b859bb25623"`,
    );
    await queryRunner.query(
      `ALTER TABLE "carts" DROP CONSTRAINT "FK_2ec1c94a977b940d85a4f498aea"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "FK_9a5f6868c96e0069e699f33e124"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_eb20a254902bbb70e5e35d6b74"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_4ee1f887ff9713eb8ffb71bfd3"`,
    );
    await queryRunner.query(`DROP TABLE "agent_action_logs"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0b1eb4f1f984aab3c481c48468"`,
    );
    await queryRunner.query(`DROP TABLE "support_tickets"`);
    await queryRunner.query(`DROP TABLE "faq_articles"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_47fa80a304062cb2e2703f1d62"`,
    );
    await queryRunner.query(`DROP TABLE "return_requests"`);
    await queryRunner.query(`DROP TABLE "order_items"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_fbfc1475fc6797244d160068cb"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_75eba1c6b1a66b09f2a97e6927"`,
    );
    await queryRunner.query(`DROP TABLE "orders"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e025109230e82925843f2a14c4"`,
    );
    await queryRunner.query(`DROP TABLE "coupons"`);
    await queryRunner.query(`DROP TABLE "cart_items"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_2ec1c94a977b940d85a4f498ae"`,
    );
    await queryRunner.query(`DROP TABLE "carts"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5b7246644a9c703729a0e89b13"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_464f927ae360106b783ed0b410"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_c44ac33a05b144dd0d9ddcf932"`,
    );
    await queryRunner.query(`DROP TABLE "products"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_420d9f679d41281f282f5bc7d0"`,
    );
    await queryRunner.query(`DROP TABLE "categories"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"`,
    );
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
