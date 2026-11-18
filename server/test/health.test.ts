import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { pino } from 'pino';
import { createApp } from '../src/app.js';
import { testConfig, testPool, testUrl } from './helpers.js';

const logger = pino({ level: 'silent' });

describe('health endpoints', () => {
  const db = testPool();
  afterAll(() => db.end());

  it('liveness responds without needing the database', async () => {
    // Pool pointing at nothing: liveness must still be OK.
    const dead = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 300 });
    dead.on('error', () => {});
    const res = await request(createApp({ db: dead, logger, config: testConfig() })).get('/healthz');
    expect(res.status).toBe(200);
    await dead.end();
  });

  it('readiness is 200 when the database is reachable', async () => {
    const res = await request(createApp({ db, logger, config: testConfig() })).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('readiness is 503 when the database is unreachable', async () => {
    const dead = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 300 });
    dead.on('error', () => {});
    const res = await request(createApp({ db: dead, logger, config: testConfig() })).get('/readyz');
    expect(res.status).toBe(503);
    await dead.end();
  });

  it('unknown routes return a structured 404 and malformed JSON a 400', async () => {
    const app = createApp({ db, logger, config: testConfig() });
    const notFound = await request(app).get('/nope');
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe('not_found');
    const bad = await request(app).post('/nope').set('content-type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(createApp({ db, logger, config: testConfig() })).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(testUrl()).toContain('taskhub_test'); // guard: never run against the dev database
  });
});

describe('metrics', () => {
  const db = testPool();
  afterAll(() => db.end());

  it('records latency by route PATTERN (not raw url) and exposes DB pool gauges', async () => {
    const app = createApp({ db, logger, config: testConfig() });
    await db.query('TRUNCATE users CASCADE');
    const reg = await request(app).post('/api/auth/register').send({ email: 'm@example.com', name: 'M', password: 'correct horse battery' });
    const auth = { authorization: `Bearer ${reg.body.accessToken}` };
    await request(app).get('/api/tasks/11111111-1111-4111-8111-111111111111').set(auth); // 404, route matched
    await request(app).get('/api/tasks/22222222-2222-4222-8222-222222222222').set(auth);
    await request(app).get('/definitely/not/a/route');
    const text = await (app.locals.metricsRegistry as import('prom-client').Registry).metrics();
    expect(text).toMatch(/http_request_duration_seconds_count\{method="GET",route="\/api\/tasks\/:id",status="404"\} 2/);
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain('1111-4111'); // ids must never become label values
    expect(text).toContain('db_pool_clients_waiting');
    expect(text).toContain('process_cpu_user_seconds_total');
  });
});
