import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

// Run as a separate step (docker compose run / Kubernetes Job), NOT on app startup:
// with N replicas starting together, schema changes must happen exactly once, before rollout.
const config = loadConfig();
const db = createPool(config.DATABASE_URL, 2);
try {
  const { applied, skipped } = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date', `(already applied: ${skipped})`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
