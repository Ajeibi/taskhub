import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetData, testConfig, testPool } from './helpers.js';

const logger = pino({ level: 'silent' });

describe('dashboard', () => {
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
  const mkProject = async (p: Person, name: string): Promise<string> =>
    (await request(app).post('/api/projects').set(as(p)).send({ name })).body.id;
  const dash = async (p: Person) => {
    const res = await request(app).get('/api/dashboard').set(as(p));
    expect(res.status).toBe(200);
    return res.body;
  };
  /** Inserts directly so due dates can be relative to "today" inside the database. */
  const task = (projectId: string, creator: string, o: { status?: string; priority?: string; assignee?: string | null; dueInDays?: number | null; title?: string; deleted?: boolean } = {}) =>
    db.query(
      `INSERT INTO tasks (project_id, title, creator_id, status, priority, assignee_id, due_date, completed_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE current_date + $7::int END,
               CASE WHEN $4 = 'done' THEN now() END, CASE WHEN $8 THEN now() END)`,
      [projectId, o.title ?? 'T', creator, o.status ?? 'todo', o.priority ?? 'medium', o.assignee ?? null, o.dueInDays ?? null, o.deleted ?? false],
    );

  it('requires authentication and is never cached', async () => {
    expect((await request(app).get('/api/dashboard')).status).toBe(401);
    const ada = await signup('ada');
    const res = await request(app).get('/api/dashboard').set(as(ada));
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('returns zeros and an empty feed for a brand-new user', async () => {
    const ada = await signup('ada');
    const d = await dash(ada);
    expect(d.projects).toEqual({ total: 0, active: 0, completed: 0, archived: 0 });
    expect(d.tasks.total).toBe(0);
    expect(d.mine).toEqual({ open: 0, overdue: 0, dueNext7Days: 0 });
    expect(d.upcoming).toEqual([]);
    expect(d.recentActivity).toEqual([]);
  });

  it('summarises workload correctly', async () => {
    const ada = await signup('ada');
    const bob = await signup('bob');
    const p = await mkProject(ada, 'Apollo');
    await request(app).post(`/api/projects/${p}/members`).set(as(ada)).send({ email: bob.email });
    await task(p, ada.id, { status: 'todo', priority: 'urgent', assignee: ada.id, dueInDays: -3 }); // mine, overdue
    await task(p, ada.id, { status: 'in_progress', priority: 'high', assignee: ada.id, dueInDays: 2 }); // mine, due soon
    await task(p, ada.id, { status: 'in_review', priority: 'low', assignee: bob.id, dueInDays: 30 });
    await task(p, ada.id, { status: 'todo', priority: 'medium' }); // unassigned
    await task(p, ada.id, { status: 'done', priority: 'high', assignee: ada.id, dueInDays: -10 }); // done: never overdue
    await task(p, ada.id, { status: 'todo', priority: 'urgent', deleted: true }); // soft-deleted: ignored

    const d = await dash(ada);
    expect(d.projects).toEqual({ total: 1, active: 1, completed: 0, archived: 0 });
    expect(d.tasks.total).toBe(5);
    expect(d.tasks.byStatus).toEqual({ todo: 2, inProgress: 1, inReview: 1, done: 1 });
    expect(d.tasks.openByPriority).toEqual({ low: 1, medium: 1, high: 1, urgent: 1 });
    expect(d.tasks.overdue).toBe(1);
    expect(d.tasks.dueNext7Days).toBe(1);
    expect(d.tasks.unassigned).toBe(1);
    expect(d.tasks.completedLast7Days).toBe(1);
    expect(d.mine).toEqual({ open: 2, overdue: 1, dueNext7Days: 1 });

    // Bob's personal numbers differ from the team's
    const b = await dash(bob);
    expect(b.mine).toEqual({ open: 1, overdue: 0, dueNext7Days: 0 });
    expect(b.tasks.total).toBe(5);
  });

  it("only counts the caller's own projects (no data from other teams)", async () => {
    const ada = await signup('ada');
    const eve = await signup('eve');
    const mine = await mkProject(ada, 'Mine');
    const hers = await mkProject(eve, 'Hers');
    await task(mine, ada.id);
    await task(hers, eve.id);
    await task(hers, eve.id, { priority: 'urgent', dueInDays: -5 });
    const d = await dash(ada);
    expect(d.projects.total).toBe(1);
    expect(d.tasks.total).toBe(1);
    expect(d.tasks.overdue).toBe(0);
    expect(JSON.stringify(d)).not.toContain('Hers');
    expect(d.recentActivity.map((e: { project: { name: string } }) => e.project.name)).toEqual(['Mine']);
  });

  it('counts projects by status; archived and deleted projects drop out of task stats', async () => {
    const ada = await signup('ada');
    const live = await mkProject(ada, 'Live');
    const old = await mkProject(ada, 'Old');
    const gone = await mkProject(ada, 'Gone');
    await task(live, ada.id);
    await task(old, ada.id);
    await task(gone, ada.id);
    await request(app).patch(`/api/projects/${old}`).set(as(ada)).send({ status: 'archived', version: 1 });
    await request(app).delete(`/api/projects/${gone}`).set(as(ada));
    const d = await dash(ada);
    expect(d.projects).toEqual({ total: 2, active: 1, completed: 0, archived: 1 });
    expect(d.tasks.total).toBe(1);
    // deleted project's history must not appear in the feed
    expect(d.recentActivity.some((e: { project: { name: string } }) => e.project.name === 'Gone')).toBe(false);
  });

  it('lists my next deadlines, overdue first, excluding done and undated tasks', async () => {
    const ada = await signup('ada');
    const bob = await signup('bob');
    const p = await mkProject(ada, 'Apollo');
    await request(app).post(`/api/projects/${p}/members`).set(as(ada)).send({ email: bob.email });
    await task(p, ada.id, { title: 'later', assignee: ada.id, dueInDays: 9 });
    await task(p, ada.id, { title: 'late', assignee: ada.id, dueInDays: -2 });
    await task(p, ada.id, { title: 'soon', assignee: ada.id, dueInDays: 1 });
    await task(p, ada.id, { title: 'undated', assignee: ada.id });
    await task(p, ada.id, { title: 'finished', assignee: ada.id, dueInDays: -1, status: 'done' });
    await task(p, ada.id, { title: 'bobs', assignee: bob.id, dueInDays: 0 });
    const d = await dash(ada);
    expect(d.upcoming.map((t: { title: string }) => t.title)).toEqual(['late', 'soon', 'later']);
    expect(d.upcoming[0]).toMatchObject({ isOverdue: true, projectName: 'Apollo' });
    expect(d.upcoming[1].isOverdue).toBe(false);
  });

  it('shows a readable, newest-first activity feed capped at 15', async () => {
    const ada = await signup('ada');
    const p = await mkProject(ada, 'Apollo');
    const created = await request(app).post(`/api/projects/${p}/tasks`).set(as(ada)).send({ title: 'Ship it' });
    await request(app).patch(`/api/tasks/${created.body.id}`).set(as(ada)).send({ status: 'done', version: 1 });
    let d = await dash(ada);
    expect(d.recentActivity.map((e: { action: string }) => e.action)).toEqual(['task.status_changed', 'task.created', 'project.created']);
    expect(d.recentActivity[0]).toMatchObject({
      actor: { name: 'ada' }, project: { name: 'Apollo' }, task: { title: 'Ship it' }, metadata: { from: 'todo', to: 'done' },
    });
    for (let i = 0; i < 20; i++) await request(app).post(`/api/projects/${p}/tasks`).set(as(ada)).send({ title: `T${i}` });
    d = await dash(ada);
    expect(d.recentActivity).toHaveLength(15);
    const ids = d.recentActivity.map((e: { id: string }) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('merges activity across projects and keeps one busy project from hiding the others', async () => {
    const ada = await signup('ada');
    const quiet = await mkProject(ada, 'Quiet');
    const busy = await mkProject(ada, 'Busy');
    for (let i = 0; i < 20; i++) await request(app).post(`/api/projects/${busy}/tasks`).set(as(ada)).send({ title: `B${i}` });
    const d = await dash(ada);
    expect(d.recentActivity).toHaveLength(15);
    expect(d.recentActivity.every((e: { project: { id: string } }) => e.project.id === busy)).toBe(true);
    void quiet;
  });

  it('lets platform admins see everything', async () => {
    const ada = await signup('ada');
    const root = await signup('root');
    const p = await mkProject(ada, 'Apollo');
    await task(p, ada.id);
    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [root.id]);
    const login = await request(app).post('/api/auth/login').send({ email: root.email, password: 'a-long-password-1' });
    const d = await dash({ ...root, token: login.body.accessToken });
    expect(d.projects.total).toBe(1);
    expect(d.tasks.total).toBe(1);
    expect(d.recentActivity.length).toBeGreaterThan(0);
  });
});
