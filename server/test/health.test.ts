import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { pino } from 'pino';
import { createApp } from '../src/app.js';
import { testPool, testUrl } from './helpers.js';

const logger = pino({ level: 'silent' });

describe('health endpoints', () => {
  const db = testPool();
  afterAll(() => db.end());

  it('liveness responds without needing the database', async () => {
    // Pool pointing at nothing: liveness must still be OK.
    const dead = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 300 });
    dead.on('error', () => {});
    const res = await request(createApp({ db: dead, logger })).get('/healthz');
    expect(res.status).toBe(200);
    await dead.end();
  });

  it('readiness is 200 when the database is reachable', async () => {
    const res = await request(createApp({ db, logger })).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('readiness is 503 when the database is unreachable', async () => {
    const dead = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 300 });
    dead.on('error', () => {});
    const res = await request(createApp({ db: dead, logger })).get('/readyz');
    expect(res.status).toBe(503);
    await dead.end();
  });

  it('unknown routes return a structured 404 and malformed JSON a 400', async () => {
    const app = createApp({ db, logger });
    const notFound = await request(app).get('/nope');
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe('not_found');
    const bad = await request(app).post('/nope').set('content-type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(createApp({ db, logger })).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(testUrl()).toContain('taskhub_test'); // guard: never run against the dev database
  });
});
