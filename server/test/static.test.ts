import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testConfig, testPool } from './helpers.js';

describe('serving the built frontend', () => {
  const db = testPool();
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'web-'));
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>TaskHub</title>');
    await writeFile(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    app = createApp({ db, logger: pino({ level: 'silent' }), config: testConfig({ STATIC_DIR: dir }) });
  });
  afterAll(() => db.end());

  it('serves index.html at / and never caches it', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('TaskHub');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('caches fingerprinted assets for a year', async () => {
    const res = await request(app).get('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await request(app).get('/projects/0b2f8f0a-1111-4222-8333-444455556666');
    expect(res.status).toBe(200);
    expect(res.text).toContain('TaskHub');
  });

  it('keeps unknown API paths as JSON 404s, not the HTML page', async () => {
    for (const p of ['/api/nope', '/api']) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
    }
  });

  it('still serves health probes and the real API', async () => {
    expect((await request(app).get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await request(app).get('/api/projects')).status).toBe(401);
  });

  it('does not expose files outside the directory', async () => {
    const res = await request(app).get('/..%2f..%2fetc%2fpasswd');
    expect(res.text).not.toContain('root:');
  });
});
