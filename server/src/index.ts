import { createServer } from 'node:http';
import type { Registry } from 'prom-client';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV);
const db = createPool(config.DATABASE_URL, config.DB_POOL_MAX);
const app = createApp({ db, logger, config });

const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'server listening'));

// Metrics on a separate internal port: scraped inside the cluster, not exposed by the Service/Ingress.
const registry = app.locals.metricsRegistry as Registry;
const metricsServer = config.METRICS_PORT
  ? createServer((req, res) => {
      if (req.url !== '/metrics') { res.statusCode = 404; res.end(); return; }
      registry.metrics().then(
        (body) => { res.setHeader('content-type', registry.contentType); res.end(body); },
        () => { res.statusCode = 500; res.end(); },
      );
    }).listen(config.METRICS_PORT, () => logger.info({ port: config.METRICS_PORT }, 'metrics listening'))
  : null;

// Graceful shutdown: Kubernetes sends SIGTERM, waits terminationGracePeriodSeconds, then SIGKILL.
// Stop accepting connections, let in-flight requests finish, then close the DB pool.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    logger.error('forced exit after timeout');
    process.exit(1);
  }, 10_000);
  force.unref();
  metricsServer?.close();
  server.close(() => {
    db.end()
      .catch((err) => logger.error({ err }, 'error closing pool'))
      .finally(() => process.exit(0));
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
