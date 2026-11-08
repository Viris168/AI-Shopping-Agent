import type { DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities.js';
import { MIGRATIONS } from './migrations/index.js';

export const DEFAULT_DATABASE_URL =
  'postgresql://shop:shop@localhost:5433/shop';

/** Read at call time so .env (loaded by ConfigModule or the CLI) is already applied. */
export function dataSourceOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    synchronize: false, // schema changes go through migrations only
    migrationsRun: process.env.RUN_MIGRATIONS_ON_BOOT === 'true',
    logging: process.env.DB_LOGGING === 'true',
    poolSize: Number(process.env.DB_POOL_SIZE ?? 10),
  };
}
