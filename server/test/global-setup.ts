import pg from 'pg';
import { migrate } from '../src/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://taskhub:taskhub@localhost:5432/taskhub_test';

// Runs once before all tests: rebuild the schema from scratch using the REAL migrations,
// so tests exercise exactly what production will run.
export default async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  } finally {
    await pool.end();
  }
  process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
}
