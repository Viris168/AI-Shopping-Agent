import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/database/options.js';
import { TEST_DATABASE_URL } from '../vitest.config.e2e.js';

/** Creates the test database if needed and applies all migrations. Never touches the dev DB. */
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name))
    throw new Error(
      `Refusing to use "${name}" for tests: name must contain "test"`,
    );

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const server = await new DataSource({
    type: 'postgres',
    url: admin.toString(),
  }).initialize();
  try {
    const exists = await server.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );
    if (exists.length === 0) await server.query(`CREATE DATABASE "${name}"`);
  } finally {
    await server.destroy();
  }

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const db = await new DataSource(dataSourceOptions()).initialize();
  try {
    await db.runMigrations();
  } finally {
    await db.destroy();
  }
}
