// Entry point for the TypeORM CLI (migration:run / migration:generate). The app uses options.ts.
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './options.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: use the real environment.
}

export default new DataSource(dataSourceOptions());
