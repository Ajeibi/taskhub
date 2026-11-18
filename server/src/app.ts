import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { AppError, notFound } from './errors.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { projectsRouter } from './modules/projects/projects.routes.js';
import { projectTasksRouter, tasksRouter } from './modules/tasks/tasks.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

export interface AppDeps {
  db: Db;
  logger: Logger;
  config: Config;
}

export function createApp({ db, logger, config }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind an ingress/load balancer; needed later for correct client IPs in rate limiting.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      // Correlate a request across logs; honour an upstream id if the ingress set one.
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' }, // probes are noise
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  // Liveness: "is the process responsive?" Must NOT touch the DB, otherwise a DB outage
  // would make Kubernetes restart every healthy pod and make things worse.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: "should this pod receive traffic?" Fails when the DB is unreachable, so the
  // Service stops routing to the pod without killing it.
  app.get('/readyz', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use('/api/auth', authRouter(db, config));
  app.use('/api/users', usersRouter(db, config));
  app.use('/api/projects/:projectId/tasks', projectTasksRouter(db, config));
  app.use('/api/projects', projectsRouter(db, config));
  app.use('/api/tasks', tasksRouter(db, config));

  app.use((_req, _res, next) => next(notFound('Route')));

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    // Malformed JSON body etc. from express.json
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON body' } });
      return;
    }
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
  };
  app.use(errorHandler);

  return app;
}
