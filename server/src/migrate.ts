import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

// Works from both src/ (tsx) and dist/ (compiled): migrations live in server/migrations.
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Arbitrary constant. Postgres advisory locks serialise concurrent migrators, so two pods
// (or a Job plus a developer) starting at once cannot apply the same migration twice.
const LOCK_KEY = 727_001;

export interface MigrationResult {
  applied: string[];
  skipped: number;
}

export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const client = await db.connect();
  const applied: string[] = [];
  let skipped = 0;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = done.get(file);
      if (existing !== undefined) {
        // Editing an applied migration is a bug: environments would silently diverge.
        if (existing !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        skipped++;
        continue;
      }
      try {
        await client.query('BEGIN'); // DDL is transactional in Postgres: all-or-nothing per migration
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
