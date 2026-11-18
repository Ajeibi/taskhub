import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __test, api, ApiError, login, qs } from './api';

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api client', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { __test.reset(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the bearer token after login', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { user: { id: 'u' }, accessToken: 'tok-1' }));
    await login('a@b.io', 'pw');
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await api('/api/projects');
    expect(fetchMock.mock.calls[1]![1].headers.authorization).toBe('Bearer tok-1');
  });

  it('on 401 refreshes once and retries the original request', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'unauthorized', message: 'expired' } }))
      .mockResolvedValueOnce(json(200, { user: {}, accessToken: 'tok-2' })) // refresh
      .mockResolvedValueOnce(json(200, { items: [] })); // retry
    await expect(api('/api/projects')).resolves.toEqual({ items: [] });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/projects', '/api/auth/refresh', '/api/projects']);
    expect(__test.token()).toBe('tok-2');
  });

  it('retries the refresh once when another tab just rotated the cookie', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'unauthorized', message: 'expired' } }))
      .mockResolvedValueOnce(json(401, { error: { code: 'refresh_race', message: 'retry' } })) // other tab won the race
      .mockResolvedValueOnce(json(200, { user: {}, accessToken: 'tok-3' })) // second attempt, new cookie
      .mockResolvedValueOnce(json(200, { items: [] }));
    await expect(api('/api/projects')).resolves.toEqual({ items: [] });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/projects', '/api/auth/refresh', '/api/auth/refresh', '/api/projects']);
    expect(__test.token()).toBe('tok-3');
  });

  it('shares ONE refresh between parallel requests (refresh tokens are single-use)', async () => {
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string, init: { headers: Record<string, string> }) => {
      if (url === '/api/auth/refresh') { refreshCalls++; await new Promise((r) => setTimeout(r, 10)); return json(200, { user: {}, accessToken: 'fresh' }); }
      return init.headers.authorization === 'Bearer fresh' ? json(200, { ok: url }) : json(401, { error: { code: 'unauthorized', message: 'x' } });
    });
    const results = await Promise.all([api('/api/a'), api('/api/b'), api('/api/c')]);
    expect(refreshCalls).toBe(1);
    expect(results).toHaveLength(3);
  });

  it('reports a lost session when refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'unauthorized', message: 'expired' } }))
      .mockResolvedValueOnce(json(401, { error: { code: 'unauthorized', message: 'no cookie' } }));
    await expect(api('/api/projects')).rejects.toBeInstanceOf(ApiError);
  });

  it('exposes error code, details and conflict status', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: { code: 'conflict', message: 'stale', details: { currentVersion: 4 } } }));
    const err = (await api('/api/x', { method: 'PATCH', body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(err.isConflict).toBe(true);
    expect((err.details as { currentVersion: number }).currentVersion).toBe(4);
  });

  it('does not try to refresh for auth endpoints (wrong password is a plain 401)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: { code: 'unauthorized', message: 'Invalid email or password' } }));
    await expect(login('a@b.io', 'bad')).rejects.toThrow('Invalid email or password');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('builds query strings, skipping empty values', () => {
    expect(qs({ q: 'a b', status: '', limit: 10, overdue: false, x: undefined })).toBe('?q=a+b&limit=10');
    expect(qs({})).toBe('');
  });
});
