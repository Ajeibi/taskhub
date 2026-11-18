import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { testPool } from './helpers.js';

describe('migration runner', () => {
  const db = testPool();
  afterAll(() => db.end());

  it('is idempotent: running again applies nothing', async () => {
    const result = await migrate(db);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it('refuses to run if an already-applied migration was edited', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    const { rows } = await db.query<{ version: string }>('SELECT version FROM schema_migrations LIMIT 1');
    await writeFile(path.join(dir, rows[0]!.version), 'SELECT 1; -- tampered');
    await expect(migrate(db, dir)).rejects.toThrow(/modified after being applied/);
  });
});
