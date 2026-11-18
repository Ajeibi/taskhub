import type { RequestHandler } from 'express';
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type { Db } from './db.js';

// UUIDs and plain numbers inside a path
const ID_SEGMENT = /\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)(?=\/|$)/gi;

/**
 * Prometheus metrics. One registry per app instance (tests create many apps in one process).
 * Labels are kept low-cardinality on purpose: the ROUTE PATTERN ("/api/tasks/:id"), never the raw URL,
 * and never user or object ids, otherwise the metric store grows without bound.
 */
export function createMetrics(db: Db): { registry: Registry; middleware: RequestHandler } {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry }); // process CPU/memory, event-loop lag, GC

  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency by route pattern, method and status code',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  // Pool saturation is the first thing to look at when latency climbs: waiting > 0 means requests queue for a connection.
  new Gauge({ name: 'db_pool_connections_total', help: 'Open connections in this pod\'s pool', registers: [registry], collect() { this.set(db.totalCount); } });
  new Gauge({ name: 'db_pool_connections_idle', help: 'Idle connections in this pod\'s pool', registers: [registry], collect() { this.set(db.idleCount); } });
  new Gauge({ name: 'db_pool_clients_waiting', help: 'Requests waiting for a free connection', registers: [registry], collect() { this.set(db.waitingCount); } });

  const middleware: RequestHandler = (req, res, next) => {
    const end = duration.startTimer();
    res.on('finish', () => {
      // Only requests that matched a real route get a path label (404s for random URLs, static files and SPA paths all
      // share "unmatched", so a scanner cannot create unbounded label values). Ids are collapsed to ":id".
      // req.baseUrl is NOT usable here: Express restores it when a router exits, which happens before error responses are written.
      const route = req.route === undefined ? 'unmatched' : req.originalUrl.split('?')[0]!.replace(ID_SEGMENT, '/:id') || '/';
      end({ method: req.method, route, status: res.statusCode });
    });
    next();
  };

  return { registry, middleware };
}
