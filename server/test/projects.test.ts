import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetData, testConfig, testPool } from './helpers.js';

const logger = pino({ level: 'silent' });

describe('projects & membership', () => {
  const db = testPool();
  const app = createApp({ db, logger, config: testConfig() });
  beforeEach(() => resetData(db));
  afterAll(() => db.end());

  interface Person { id: string; email: string; token: string }
  const signup = async (name: string): Promise<Person> => {
    const email = `${name}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, name, password: 'a-long-password-1' });
    return { id: res.body.user.id, email, token: res.body.accessToken };
  };
  const as = (p: Person) => ({ authorization: `Bearer ${p.token}` });
  const createProject = async (p: Person, name = 'Apollo', description = '') =>
    (await request(app).post('/api/projects').set(as(p)).send({ name, description })).body;

  describe('Scenario A: creation', () => {
    it('creates a project; the creator becomes its owner and the only member', async () => {
      const ada = await signup('ada');
      const res = await request(app).post('/api/projects').set(as(ada)).send({ name: '  Apollo ', description: 'Moon' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Apollo', status: 'active', version: 1, myRole: 'owner' });
      expect(res.body.taskCounts.total).toBe(0);

      const detail = await request(app).get(`/api/projects/${res.body.id}`).set(as(ada));
      expect(detail.body.members).toHaveLength(1);
      expect(detail.body.members[0]).toMatchObject({ userId: ada.id, role: 'owner' });

      const log = await db.query(`SELECT action FROM activity_log WHERE project_id = $1`, [res.body.id]);
      expect(log.rows.map((r) => r.action)).toEqual(['project.created']);
    });

    it('requires authentication on every endpoint', async () => {
      const ada = await signup('ada');
      const p = await createProject(ada);
      for (const [method, path] of [
        ['post', '/api/projects'], ['get', '/api/projects'], ['get', `/api/projects/${p.id}`],
        ['patch', `/api/projects/${p.id}`], ['delete', `/api/projects/${p.id}`],
        ['get', `/api/projects/${p.id}/members`], ['post', `/api/projects/${p.id}/members`], ['get', '/api/users?q=ad'],
      ] as const) {
        expect((await request(app)[method](path)).status, `${method} ${path}`).toBe(401);
      }
    });

    it('rejects invalid input with 400', async () => {
      const ada = await signup('ada');
      for (const body of [{}, { name: '   ' }, { name: 'x'.repeat(121) }, { name: 'ok', description: 'y'.repeat(5001) }]) {
        expect((await request(app).post('/api/projects').set(as(ada)).send(body)).status).toBe(400);
      }
      expect((await request(app).get('/api/projects/not-a-uuid').set(as(ada))).status).toBe(400);
    });
  });

  describe('authorization', () => {
    it('hides projects from non-members: 404, indistinguishable from a missing project', async () => {
      const ada = await signup('ada');
      const eve = await signup('eve');
      const p = await createProject(ada);
      const missing = '00000000-0000-4000-8000-000000000000';
      const forbiddenRes = await request(app).get(`/api/projects/${p.id}`).set(as(eve));
      const missingRes = await request(app).get(`/api/projects/${missing}`).set(as(eve));
      expect(forbiddenRes.status).toBe(404);
      expect(forbiddenRes.body).toEqual(missingRes.body);
      for (const [method, path] of [
        ['patch', `/api/projects/${p.id}`], ['delete', `/api/projects/${p.id}`],
        ['get', `/api/projects/${p.id}/members`], ['post', `/api/projects/${p.id}/members`],
      ] as const) {
        expect((await request(app)[method](path).set(as(eve)).send({ name: 'x', version: 1, email: ada.email })).status, path).toBe(404);
      }
    });

    it("lists only the caller's own projects", async () => {
      const ada = await signup('ada');
      const bob = await signup('bob');
      await createProject(ada, 'Ada project');
      await createProject(bob, 'Bob project');
      const res = await request(app).get('/api/projects').set(as(ada));
      expect(res.body.items.map((p: { name: string }) => p.name)).toEqual(['Ada project']);
    });

    it('lets platform admins see and manage every project', async () => {
      const ada = await signup('ada');
      const root = await signup('root');
      await createProject(ada, 'Secret');
      await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [root.id]);
      const login = await request(app).post('/api/auth/login').send({ email: root.email, password: 'a-long-password-1' });
      const admin = { ...root, token: login.body.accessToken as string };
      const list = await request(app).get('/api/projects').set(as(admin));
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].myRole).toBe('admin');
      const patch = await request(app).patch(`/api/projects/${list.body.items[0].id}`).set(as(admin)).send({ name: 'Renamed', version: 1 });
      expect(patch.status).toBe(200);
    });

    it('lets members read but not edit, delete, or manage members', async () => {
      const ada = await signup('ada');
      const bob = await signup('bob');
      const p = await createProject(ada);
      await request(app).post(`/api/projects/${p.id}/members`).set(as(ada)).send({ email: bob.email });

      expect((await request(app).get(`/api/projects/${p.id}`).set(as(bob))).status).toBe(200);
      expect((await request(app).patch(`/api/projects/${p.id}`).set(as(bob)).send({ name: 'Hijack', version: 1 })).status).toBe(403);
      expect((await request(app).delete(`/api/projects/${p.id}`).set(as(bob))).status).toBe(403);
      expect((await request(app).post(`/api/projects/${p.id}/members`).set(as(bob)).send({ email: ada.email })).status).toBe(403);
      expect((await request(app).delete(`/api/projects/${p.id}/members/${ada.id}`).set(as(bob))).status).toBe(403);
    });
  });

  describe('membership', () => {
    it('adds a member by email and rejects duplicates and unknown users', async () => {
      const ada = await signup('ada');
      const bob = await signup('bob');
      const p = await createProject(ada);
      const add = await request(app).post(`/api/projects/${p.id}/members`).set(as(ada)).send({ email: 'BOB@example.com' });
      expect(add.status).toBe(201);
      expect(add.body).toMatchObject({ userId: bob.id, role: 'member' });
      expect((await request(app).post(`/api/projects/${p.id}/members`).set(as(ada)).send({ email: bob.email })).status).toBe(409);
      expect((await request(app).post(`/api/projects/${p.id}/members`).set(as(ada)).send({ email: 'ghost@example.com' })).status).toBe(404);
      // the new member can now see the project
      expect((await request(app).get('/api/projects').set(as(bob))).body.items).toHaveLength(1);
    });

    it('removing a member keeps their tasks but un-assigns them', async () => {
      const ada = await signup('ada');
      const bob = await signup('bob');
      const p = await createProject(ada);
      await request(app).post(`/api/projects/${p.id}/members`).set(as(ada)).send({ email: bob.email });
      const t = await db.query(
        `INSERT INTO tasks (project_id, title, creator_id, assignee_id) VALUES ($1, 'T', $2, $3) RETURNING id`,
        [p.id, ada.id, bob.id],
      );
      expect((await request(app).delete(`/api/projects/${p.id}/members/${bob.id}`).set(as(ada))).status).toBe(204);
      const task = await db.query(`SELECT project_id, assignee_id FROM tasks WHERE id = $1`, [t.rows[0].id]);
      expect(task.rows[0]).toEqual({ project_id: p.id, assignee_id: null });
      expect((await request(app).get(`/api/projects/${p.id}`).set(as(bob))).status).toBe(404); // lost access
      const log = await db.query(`SELECT metadata FROM activity_log WHERE action = 'member.removed'`);
      expect(log.rows[0].metadata.unassignedTasks).toBe(1);
    });

    it('lets a member leave, but never lets the owner be removed', async () => {
      const ada = await signup('ada');
      const bob = await signup('bob');
      const p = await createProject(ada);
      await request(app).post(`/api/projects/${p.id}/members`).set(as(ada)).send({ email: bob.email });
      expect((await request(app).delete(`/api/projects/${p.id}/members/${ada.id}`).set(as(ada))).status).toBe(409);
      expect((await request(app).delete(`/api/projects/${p.id}/members/${bob.id}`).set(as(bob))).status).toBe(204);
    });

    it('transfers ownership, leaving exactly one owner', async () => {
      const ada = await signup('ada');
      const bob = await signup('bob');
      const p = await createProject(ada);
      await request(app).post(`/api/projects/${p.id}/members`).set(as(ada)).send({ email: bob.email });
      const res = await request(app).patch(`/api/projects/${p.id}/members/${bob.id}`).set(as(ada)).send({ role: 'owner' });
      expect(res.status).toBe(200);
      expect(res.body.items.filter((m: { role: string }) => m.role === 'owner').map((m: { userId: string }) => m.userId)).toEqual([bob.id]);
      // ada is now a regular member and loses manager powers
      expect((await request(app).patch(`/api/projects/${p.id}`).set(as(ada)).send({ name: 'x', version: 1 })).status).toBe(403);
    });

    it('cannot transfer ownership to a non-member', async () => {
      const ada = await signup('ada');
      const eve = await signup('eve');
      const p = await createProject(ada);
      expect((await request(app).patch(`/api/projects/${p.id}/members/${eve.id}`).set(as(ada)).send({ role: 'owner' })).status).toBe(404);
    });
  });

  describe('updates and concurrency', () => {
    it('updates with the current version and bumps it', async () => {
      const ada = await signup('ada');
      const p = await createProject(ada);
      const res = await request(app).patch(`/api/projects/${p.id}`).set(as(ada)).send({ status: 'completed', version: 1 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'completed', version: 2, name: 'Apollo' });
    });

    it('rejects a stale version with 409 and the current version (lost-update protection)', async () => {
      const ada = await signup('ada');
      const p = await createProject(ada);
      await request(app).patch(`/api/projects/${p.id}`).set(as(ada)).send({ name: 'First', version: 1 });
      const stale = await request(app).patch(`/api/projects/${p.id}`).set(as(ada)).send({ name: 'Second', version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.error.details.currentVersion).toBe(2);
      const now = await request(app).get(`/api/projects/${p.id}`).set(as(ada));
      expect(now.body.name).toBe('First');
    });

    it('lets exactly one of two simultaneous edits win', async () => {
      const ada = await signup('ada');
      const p = await createProject(ada);
      const results = await Promise.all(
        ['A', 'B'].map((name) => request(app).patch(`/api/projects/${p.id}`).set(as(ada)).send({ name, version: 1 })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('rejects an empty patch and a missing version', async () => {
      const ada = await signup('ada');
      const p = await createProject(ada);
      expect((await request(app).patch(`/api/projects/${p.id}`).set(as(ada)).send({ version: 1 })).status).toBe(400);
      expect((await request(app).patch(`/api/projects/${p.id}`).set(as(ada)).send({ name: 'x' })).status).toBe(400);
    });

    it('records what changed in the activity log', async () => {
      const ada = await signup('ada');
      const p = await createProject(ada, 'Old');
      await request(app).patch(`/api/projects/${p.id}`).set(as(ada)).send({ name: 'New', version: 1 });
      const log = await db.query(`SELECT metadata FROM activity_log WHERE action = 'project.updated'`);
      expect(log.rows[0].metadata.changes).toEqual({ name: { from: 'Old', to: 'New' } });
    });
  });

  describe('soft delete', () => {
    it('hides a deleted project everywhere but keeps the row and its history', async () => {
      const ada = await signup('ada');
      const p = await createProject(ada);
      expect((await request(app).delete(`/api/projects/${p.id}`).set(as(ada))).status).toBe(204);
      expect((await request(app).get(`/api/projects/${p.id}`).set(as(ada))).status).toBe(404);
      expect((await request(app).get('/api/projects').set(as(ada))).body.items).toHaveLength(0);
      expect((await request(app).post(`/api/projects/${p.id}/members`).set(as(ada)).send({ email: ada.email })).status).toBe(404);
      const row = await db.query(`SELECT deleted_at FROM projects WHERE id = $1`, [p.id]);
      expect(row.rows[0].deleted_at).not.toBeNull();
      const log = await db.query(`SELECT action FROM activity_log WHERE project_id = $1 ORDER BY id`, [p.id]);
      expect(log.rows.map((r) => r.action)).toEqual(['project.created', 'project.deleted']);
    });
  });

  describe('Scenario C: monitoring', () => {
    it('reports task counts per status and overdue work', async () => {
      const ada = await signup('ada');
      const p = await createProject(ada);
      const ins = (status: string, due: string | null, deleted = false) =>
        db.query(
          `INSERT INTO tasks (project_id, title, creator_id, status, due_date, completed_at, deleted_at)
           VALUES ($1, 't', $2, $3, $4, CASE WHEN $3 = 'done' THEN now() END, CASE WHEN $5 THEN now() END)`,
          [p.id, ada.id, status, due, deleted],
        );
      await ins('todo', '2000-01-01'); // overdue
      await ins('todo', null);
      await ins('in_progress', '2000-01-01'); // overdue
      await ins('in_review', null);
      await ins('done', '2000-01-01'); // done: never overdue
      await ins('todo', null, true); // soft-deleted: not counted
      const res = await request(app).get(`/api/projects/${p.id}`).set(as(ada));
      expect(res.body.taskCounts).toEqual({ total: 5, todo: 2, inProgress: 1, inReview: 1, done: 1, overdue: 2 });
    });
  });

  describe('Scenario D: finding things in large lists', () => {
    it('pages through everything exactly once, newest first', async () => {
      const ada = await signup('ada');
      for (let i = 1; i <= 7; i++) await createProject(ada, `Project ${i}`);
      const seen: string[] = [];
      let cursor: string | null = null;
      const sizes: number[] = [];
      do {
        const res: request.Response = await request(app).get('/api/projects').set(as(ada)).query({ limit: 3, ...(cursor ? { cursor } : {}) });
        expect(res.status).toBe(200);
        sizes.push(res.body.items.length);
        seen.push(...res.body.items.map((p: { name: string }) => p.name));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(sizes).toEqual([3, 3, 1]);
      expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1].map((n) => `Project ${n}`));
    });

    it('does not skip or repeat rows that share the same timestamp (tie-break + microsecond precision)', async () => {
      const ada = await signup('ada');
      for (let i = 0; i < 5; i++) await createProject(ada, `P${i}`);
      await db.query(`UPDATE projects SET created_at = '2024-01-01 10:00:00.123456+00'`); // identical keys
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const res: request.Response = await request(app).get('/api/projects').set(as(ada)).query({ limit: 2, ...(cursor ? { cursor } : {}) });
        for (const p of res.body.items) seen.add(p.id);
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen.size).toBe(5);
    });

    it('searches by name/description prefix and filters by status', async () => {
      const ada = await signup('ada');
      await createProject(ada, 'Website redesign', 'new landing page');
      const b = await createProject(ada, 'Mobile app', 'iOS and Android');
      await request(app).patch(`/api/projects/${b.id}`).set(as(ada)).send({ status: 'archived', version: 1 });
      const names = async (query: Record<string, string>) =>
        (await request(app).get('/api/projects').set(as(ada)).query(query)).body.items.map((p: { name: string }) => p.name);
      expect(await names({ q: 'redes' })).toEqual(['Website redesign']);
      expect(await names({ q: 'android' })).toEqual(['Mobile app']);
      expect(await names({ status: 'archived' })).toEqual(['Mobile app']);
      expect(await names({ q: 'website mobile' })).toEqual([]); // AND semantics
      expect(await names({ q: '(&|!:*)' })).toHaveLength(2); // pure punctuation is ignored, never a 500
    });

    it('rejects malformed cursors and absurd limits', async () => {
      const ada = await signup('ada');
      expect((await request(app).get('/api/projects').set(as(ada)).query({ cursor: 'garbage' })).status).toBe(400);
      expect((await request(app).get('/api/projects').set(as(ada)).query({ limit: 100000 })).status).toBe(400);
    });
  });

  describe('user search', () => {
    it('finds colleagues by name or email prefix and exposes only safe fields', async () => {
      const ada = await signup('ada');
      await signup('adrian');
      const res = await request(app).get('/api/users').set(as(ada)).query({ q: 'ad' });
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(Object.keys(res.body.items[0]).sort()).toEqual(['email', 'id', 'name']);
    });

    it('requires at least 2 characters and treats % literally', async () => {
      const ada = await signup('ada');
      expect((await request(app).get('/api/users').set(as(ada)).query({ q: 'a' })).status).toBe(400);
      expect((await request(app).get('/api/users').set(as(ada)).query({ q: '%%' })).body.items).toHaveLength(0);
    });
  });
});
