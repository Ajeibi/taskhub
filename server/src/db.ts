import pg from 'pg';

export type Db = pg.Pool;

export function createPool(connectionString: string, max: number): Db {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000, // fail fast instead of queueing forever when the DB is down
    statement_timeout: 15_000, // a runaway query must not hold a connection indefinitely
  });
  // An idle client erroring (DB restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
}

/**
 * Run `fn` inside a transaction. Commits on success, rolls back on any thrown error.
 * Every multi-statement business operation goes through this so partial writes are impossible.
 */
export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
