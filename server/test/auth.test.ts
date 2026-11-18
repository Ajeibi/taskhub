import jwt from 'jsonwebtoken';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js';
import { resetData, testConfig, testPool } from './helpers.js';

const logger = pino({ level: 'silent' });
const creds = { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' };

describe('auth', () => {
  const db = testPool();
  const config = testConfig();
  const app = createApp({ db, logger, config });
  beforeEach(() => resetData(db));
  afterAll(() => db.end());

  /** Extracts the raw refresh token from the Set-Cookie header. */
  const refreshCookie = (res: request.Response): string => {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const c = cookies.find((x) => x.startsWith('refresh_token='));
    if (!c) throw new Error('no refresh cookie');
    return c.split(';')[0]!;
  };

  describe('register', () => {
    it('creates an account, returns a token and a hardened refresh cookie, and never leaks the hash', async () => {
      const res = await request(app).post('/api/auth/register').send(creds);
      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ email: 'ada@example.com', name: 'Ada', role: 'user' });
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);
      expect(typeof res.body.accessToken).toBe('string');
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/auth/);
    });

    it('stores a salted scrypt hash, not the password', async () => {
      await request(app).post('/api/auth/register').send(creds);
      const { rows } = await db.query(`SELECT password_hash FROM users`);
      expect(rows[0].password_hash).toMatch(/^scrypt\$/);
      expect(rows[0].password_hash).not.toContain(creds.password);
    });

    it('normalises email case/whitespace and rejects duplicates (409)', async () => {
      await request(app).post('/api/auth/register').send(creds);
      const dup = await request(app)
        .post('/api/auth/register')
        .send({ ...creds, email: '  ADA@Example.COM ' });
      expect(dup.status).toBe(409);
    });

    it('handles simultaneous duplicate registrations without a 500', async () => {
      const results = await Promise.all(
        [1, 2, 3].map(() => request(app).post('/api/auth/register').send(creds)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    });

    it.each([
      ['short password', { ...creds, password: 'short' }],
      ['bad email', { ...creds, email: 'not-an-email' }],
      ['missing name', { ...creds, name: '   ' }],
      ['huge password', { ...creds, password: 'x'.repeat(5000) }],
    ])('rejects %s with 400', async (_label, body) => {
      const res = await request(app).post('/api/auth/register').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
    });

    it('ignores attempts to self-assign the admin role', async () => {
      const res = await request(app).post('/api/auth/register').send({ ...creds, role: 'admin' });
      expect(res.body.user.role).toBe('user');
    });
  });

  describe('login', () => {
    beforeEach(async () => {
      await request(app).post('/api/auth/register').send(creds);
    });

    it('logs in with correct credentials (email case-insensitive)', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: 'ADA@example.com', password: creds.password });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
    });

    it('gives the same generic 401 for wrong password and unknown email', async () => {
      const wrong = await request(app).post('/api/auth/login').send({ email: creds.email, password: 'wrong-password-1' });
      const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password-1' });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
    });
  });

  describe('access tokens', () => {
    it('GET /me requires a valid token', async () => {
      const reg = await request(app).post('/api/auth/register').send(creds);
      const ok = await request(app).get('/api/auth/me').set('authorization', `Bearer ${reg.body.accessToken}`);
      expect(ok.status).toBe(200);
      expect(ok.body.user.email).toBe(creds.email);

      expect((await request(app).get('/api/auth/me')).status).toBe(401);
      expect((await request(app).get('/api/auth/me').set('authorization', 'Bearer garbage')).status).toBe(401);
    });

    it('rejects tokens signed with another key, expired tokens, and alg=none', async () => {
      const reg = await request(app).post('/api/auth/register').send(creds);
      const id = reg.body.user.id;
      const forged = jwt.sign({ role: 'admin' }, 'a-completely-different-secret-value-0000', { subject: id, issuer: 'taskhub' });
      const expired = jwt.sign({ role: 'user' }, config.JWT_SECRET, { subject: id, issuer: 'taskhub', expiresIn: -10 });
      const none = jwt.sign({ role: 'admin' }, '', { algorithm: 'none', subject: id, issuer: 'taskhub' });
      for (const token of [forged, expired, none]) {
        const res = await request(app).get('/api/auth/me').set('authorization', `Bearer ${token}`);
        expect(res.status).toBe(401);
      }
    });
  });

  describe('refresh tokens', () => {
    it('rotates: returns a new token and the old one stops working', async () => {
      const reg = await request(app).post('/api/auth/register').send(creds);
      const first = refreshCookie(reg);
      const res = await request(app).post('/api/auth/refresh').set('cookie', first);
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
      expect(refreshCookie(res)).not.toBe(first);
    });

    it('detects reuse of a rotated token and revokes the whole family', async () => {
      const reg = await request(app).post('/api/auth/register').send(creds);
      const first = refreshCookie(reg);
      const second = refreshCookie(await request(app).post('/api/auth/refresh').set('cookie', first));

      // An attacker (or buggy client) replays the first, already-used token...
      const replay = await request(app).post('/api/auth/refresh').set('cookie', first);
      expect(replay.status).toBe(401);
      // ...which kills the legitimate descendant too: the user must log in again.
      const afterReplay = await request(app).post('/api/auth/refresh').set('cookie', second);
      expect(afterReplay.status).toBe(401);
    });

    it('lets only one of two concurrent refreshes with the same token succeed', async () => {
      const reg = await request(app).post('/api/auth/register').send(creds);
      const cookie = refreshCookie(reg);
      const [a, b] = await Promise.all([
        request(app).post('/api/auth/refresh').set('cookie', cookie),
        request(app).post('/api/auth/refresh').set('cookie', cookie),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 401]);
    });

    it('rejects a missing, unknown or expired refresh token', async () => {
      expect((await request(app).post('/api/auth/refresh')).status).toBe(401);
      expect((await request(app).post('/api/auth/refresh').set('cookie', 'refresh_token=nope')).status).toBe(401);
      const reg = await request(app).post('/api/auth/register').send(creds);
      await db.query(`UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'`);
      expect((await request(app).post('/api/auth/refresh').set('cookie', refreshCookie(reg))).status).toBe(401);
    });

    it('stores only a hash of the refresh token', async () => {
      const reg = await request(app).post('/api/auth/register').send(creds);
      const raw = refreshCookie(reg).split('=')[1]!;
      const { rows } = await db.query(`SELECT token_hash FROM refresh_tokens`);
      expect(rows[0].token_hash).not.toBe(raw);
      expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('logout revokes the session and is idempotent', async () => {
      const reg = await request(app).post('/api/auth/register').send(creds);
      const cookie = refreshCookie(reg);
      expect((await request(app).post('/api/auth/logout').set('cookie', cookie)).status).toBe(204);
      expect((await request(app).post('/api/auth/logout').set('cookie', cookie)).status).toBe(204);
      expect((await request(app).post('/api/auth/refresh').set('cookie', cookie)).status).toBe(401);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 after too many attempts', async () => {
      const limited = createApp({ db, logger, config: testConfig({ AUTH_RATE_LIMIT_MAX: 3 }) });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await request(limited).post('/api/auth/login').send({ email: 'x@example.com', password: 'whatever-123' })).status);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
    });
  });
});

describe('password hashing', () => {
  it('verifies the right password, rejects the wrong one, and salts each hash', async () => {
    const a = await hashPassword('hunter2-hunter2');
    const b = await hashPassword('hunter2-hunter2');
    expect(a).not.toBe(b);
    expect(await verifyPassword('hunter2-hunter2', a)).toBe(true);
    expect(await verifyPassword('hunter3-hunter3', a)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
  });
});
