import pg from 'pg';

export const PERF_URL = process.env.PERF_DATABASE_URL ?? 'postgres://taskhub:taskhub@localhost:5432/taskhub_perf';
export const PERF_PASSWORD = 'perf-password-123';

/** Refuse to touch anything that is not clearly a throwaway performance database. */
export function assertPerfDb(url: string): string {
  const name = new URL(url).pathname.slice(1);
  if (!name.includes('perf')) throw new Error(`Refusing to run: database "${name}" does not look like a perf database`);
  return name;
}

/** Creates the perf database if it does not exist (connects to the maintenance DB for that). */
export async function ensurePerfDb(url: string): Promise<void> {
  const name = assertPerfDb(url);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const pool = new pg.Pool({ connectionString: admin.toString(), max: 1 });
  try {
    const { rowCount } = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await pool.query(`CREATE DATABASE ${name}`);
  } finally {
    await pool.end();
  }
}

export const ms = (n: number): string => (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n).toString());
