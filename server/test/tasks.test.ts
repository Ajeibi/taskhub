import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetData, testConfig, testPool } from './helpers.js';

const logger = pino({ level: 'silent' });

describe('tasks & comments', () => {
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
  const mkProject = async (p: Person, name = 'Apollo'): Promise<string> =>
    (await request(app).post('/api/projects').set(as(p)).send({ name })).body.id;
  const addMember = (owner: Person, projectId: string, who: Person) =>
    request(app).post(`/api/projects/${projectId}/members`).set(as(owner)).send({ email: who.email });
  const mkTask = async (p: Person, projectId: string, body: Record<string, unknown> = {}) =>
    request(app).post(`/api/projects/${projectId}/tasks`).set(as(p)).send({ title: 'Task', ...body });
  /** A team of ada (owner) and bob (member) with one project. */
  const team = async () => {
    const ada = await signup('ada');
    const bob = await signup('bob');
    const project = await mkProject(ada);
    await addMember(ada, project, bob);
    return { ada, bob, project };
  };

  describe('Scenario B: create, assign, track', () => {
    it('lets a member create a task, assign it to another member, and track it to done', async () => {
      const { ada, bob, project } = await team();
      const created = await mkTask(bob, project, {
        title: 'Write spec', description: 'details', priority: 'high', assigneeId: ada.id, dueDate: '2030-06-30',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        title: 'Write spec', status: 'todo', priority: 'high', dueDate: '2030-06-30', isOverdue: false, version: 1,
        assignee: { id: ada.id, name: 'ada' }, creator: { id: bob.id, name: 'bob' }, completedAt: null,
      });

      // It shows up in the assignee's personal list
      const mine = await request(app).get('/api/tasks').set(as(ada)).query({ assignee: 'me' });
      expect(mine.body.items.map((t: { id: string }) => t.id)).toEqual([created.body.id]);

      const started = await request(app).patch(`/api/tasks/${created.body.id}`).set(as(ada)).send({ status: 'in_progress', version: 1 });
      expect(started.body).toMatchObject({ status: 'in_progress', version: 2, completedAt: null });
      const done = await request(app).patch(`/api/tasks/${created.body.id}`).set(as(ada)).send({ status: 'done', version: 2 });
      expect(done.body.status).toBe('done');
      expect(done.body.completedAt).toBeTruthy();
      const reopened = await request(app).patch(`/api/tasks/${created.body.id}`).set(as(ada)).send({ status: 'in_review', version: 3 });
      expect(reopened.body.completedAt).toBeNull(); // leaving 'done' clears it (DB CHECK would reject otherwise)
    });

    it('returns the due date exactly as sent (no time-zone shift)', async () => {
      const { ada, project } = await team();
      const res = await mkTask(ada, project, { dueDate: '2030-01-01' });
      expect(res.body.dueDate).toBe('2030-01-01');
    });

    it('can reassign, unassign, and clear the due date with null', async () => {
      const { ada, bob, project } = await team();
      const t = (await mkTask(ada, project, { assigneeId: bob.id, dueDate: '2030-01-01' })).body;
      const res = await request(app).patch(`/api/tasks/${t.id}`).set(as(ada)).send({ assigneeId: null, dueDate: null, version: 1 });
      expect(res.body.assignee).toBeNull();
      expect(res.body.dueDate).toBeNull();
    });

    it('writes a readable audit trail', async () => {
      const { ada, bob, project } = await team();
      const t = (await mkTask(ada, project, { title: 'Old' })).body;
      await request(app).patch(`/api/tasks/${t.id}`).set(as(ada)).send({ status: 'done', assigneeId: bob.id, title: 'New', version: 1 });
      const log = await db.query(`SELECT action, metadata FROM activity_log WHERE task_id = $1 ORDER BY id`, [t.id]);
      expect(log.rows.map((r) => r.action)).toEqual(['task.created', 'task.status_changed', 'task.assigned', 'task.updated']);
      expect(log.rows[1].metadata).toEqual({ from: 'todo', to: 'done' });
      expect(log.rows[3].metadata.changes.title).toEqual({ from: 'Old', to: 'New' });
    });
  });

  describe('relationship consistency', () => {
    it('refuses to assign a task to someone outside the project (422)', async () => {
      const { ada, project } = await team();
      const eve = await signup('eve');
      const create = await mkTask(ada, project, { assigneeId: eve.id });
      expect(create.status).toBe(422);
      expect(create.body.error.code).toBe('invalid_assignee');
      const t = (await mkTask(ada, project)).body;
      const patch = await request(app).patch(`/api/tasks/${t.id}`).set(as(ada)).send({ assigneeId: eve.id, version: 1 });
      expect(patch.status).toBe(422);
    });

    it('does not leave a half-created task behind when creation fails', async () => {
      const { ada, project } = await team();
      const eve = await signup('eve');
      await mkTask(ada, project, { assigneeId: eve.id });
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM tasks`);
      expect(rows[0].n).toBe(0);
      const log = await db.query(`SELECT count(*)::int AS n FROM activity_log WHERE action = 'task.created'`);
      expect(log.rows[0].n).toBe(0);
    });

    it('un-assigns tasks when their assignee leaves the project, keeping the tasks', async () => {
      const { ada, bob, project } = await team();
      const t = (await mkTask(ada, project, { assigneeId: bob.id })).body;
      await request(app).delete(`/api/projects/${project}/members/${bob.id}`).set(as(ada));
      const after = await request(app).get(`/api/tasks/${t.id}`).set(as(ada));
      expect(after.body.assignee).toBeNull();
      expect(after.body.projectId).toBe(project);
    });

    it('makes tasks disappear with their soft-deleted project', async () => {
      const { ada, project } = await team();
      const t = (await mkTask(ada, project)).body;
      await request(app).delete(`/api/projects/${project}`).set(as(ada));
      expect((await request(app).get(`/api/tasks/${t.id}`).set(as(ada))).status).toBe(404);
      expect((await request(app).get('/api/tasks').set(as(ada))).body.items).toHaveLength(0);
    });

    it('makes archived projects read-only for tasks and comments, but still readable', async () => {
      const { ada, project } = await team();
      const t = (await mkTask(ada, project)).body;
      await request(app).patch(`/api/projects/${project}`).set(as(ada)).send({ status: 'archived', version: 1 });
      expect((await mkTask(ada, project)).status).toBe(409);
      expect((await request(app).patch(`/api/tasks/${t.id}`).set(as(ada)).send({ title: 'x', version: 1 })).status).toBe(409);
      expect((await request(app).delete(`/api/tasks/${t.id}`).set(as(ada))).status).toBe(409);
      expect((await request(app).post(`/api/tasks/${t.id}/comments`).set(as(ada)).send({ body: 'hi' })).status).toBe(409);
      expect((await request(app).get(`/api/tasks/${t.id}`).set(as(ada))).status).toBe(200);
    });
  });

  describe('authorization', () => {
    it('hides tasks from non-members of the project (404 on every operation)', async () => {
      const { ada, project } = await team();
      const eve = await signup('eve');
      const t = (await mkTask(ada, project)).body;
      expect((await request(app).get(`/api/tasks/${t.id}`).set(as(eve))).status).toBe(404);
      expect((await request(app).patch(`/api/tasks/${t.id}`).set(as(eve)).send({ title: 'x', version: 1 })).status).toBe(404);
      expect((await request(app).delete(`/api/tasks/${t.id}`).set(as(eve))).status).toBe(404);
      expect((await request(app).get(`/api/tasks/${t.id}/comments`).set(as(eve))).status).toBe(404);
      expect((await request(app).post(`/api/tasks/${t.id}/comments`).set(as(eve)).send({ body: 'x' })).status).toBe(404);
      expect((await mkTask(eve, project)).status).toBe(404);
      expect((await request(app).get(`/api/projects/${project}/tasks`).set(as(eve))).status).toBe(404);
    });

    it("never leaks other projects' tasks through the global list or filters", async () => {
      const { ada, project } = await team();
      const eve = await signup('eve');
      await mkTask(ada, project, { title: 'secret roadmap' });
      const evesProject = await mkProject(eve, 'Eve');
      await mkTask(eve, evesProject, { title: 'eve task' });
      const all = await request(app).get('/api/tasks').set(as(eve));
      expect(all.body.items.map((t: { title: string }) => t.title)).toEqual(['eve task']);
      const search = await request(app).get('/api/tasks').set(as(eve)).query({ q: 'roadmap' });
      expect(search.body.items).toHaveLength(0);
      const byProject = await request(app).get('/api/tasks').set(as(eve)).query({ projectId: project });
      expect(byProject.status).toBe(404);
    });

    it('lets only the creator or the owner delete a task', async () => {
      const { ada, bob, project } = await team();
      const carol = await signup('carol');
      await addMember(ada, project, carol);
      const bobsTask = (await mkTask(bob, project)).body;
      expect((await request(app).delete(`/api/tasks/${bobsTask.id}`).set(as(carol))).status).toBe(403);
      expect((await request(app).delete(`/api/tasks/${bobsTask.id}`).set(as(bob))).status).toBe(204);
      const another = (await mkTask(bob, project)).body;
      expect((await request(app).delete(`/api/tasks/${another.id}`).set(as(ada))).status).toBe(204); // owner
    });

    it('soft-deletes: hidden from reads and counts, row kept', async () => {
      const { ada, project } = await team();
      const t = (await mkTask(ada, project)).body;
      await request(app).delete(`/api/tasks/${t.id}`).set(as(ada));
      expect((await request(app).get(`/api/tasks/${t.id}`).set(as(ada))).status).toBe(404);
      expect((await request(app).get(`/api/projects/${project}`).set(as(ada))).body.taskCounts.total).toBe(0);
      const row = await db.query(`SELECT deleted_at FROM tasks WHERE id = $1`, [t.id]);
      expect(row.rows[0].deleted_at).not.toBeNull();
    });

    it('requires authentication', async () => {
      const { ada, project } = await team();
      const t = (await mkTask(ada, project)).body;
      expect((await request(app).get('/api/tasks')).status).toBe(401);
      expect((await request(app).get(`/api/tasks/${t.id}`)).status).toBe(401);
      expect((await request(app).post(`/api/projects/${project}/tasks`).send({ title: 'x' })).status).toBe(401);
    });
  });

  describe('validation', () => {
    it.each([
      ['empty title', { title: '   ' }],
      ['long title', { title: 'x'.repeat(201) }],
      ['bad priority', { priority: 'whenever' }],
      ['bad date format', { dueDate: '30/06/2030' }],
      ['impossible date', { dueDate: '2024-02-30' }],
      ['assignee not a uuid', { assigneeId: 'bob' }],
    ])('rejects %s with 400', async (_label, body) => {
      const { ada, project } = await team();
      expect((await mkTask(ada, project, body)).status).toBe(400);
    });

    it('rejects empty patches, unknown statuses and bad ids', async () => {
      const { ada, project } = await team();
      const t = (await mkTask(ada, project)).body;
      const patch = (b: object) => request(app).patch(`/api/tasks/${t.id}`).set(as(ada)).send(b);
      expect((await patch({ version: 1 })).status).toBe(400);
      expect((await patch({ title: 'x' })).status).toBe(400); // version required
      expect((await patch({ status: 'archived', version: 1 })).status).toBe(400);
      expect((await request(app).get('/api/tasks/nope').set(as(ada))).status).toBe(400);
      expect((await request(app).get('/api/tasks').set(as(ada)).query({ status: 'nope' })).status).toBe(400);
    });
  });

  describe('concurrency', () => {
    it('rejects a stale edit with 409 and the current version', async () => {
      const { ada, bob, project } = await team();
      const t = (await mkTask(ada, project, { title: 'v1' })).body;
      await request(app).patch(`/api/tasks/${t.id}`).set(as(ada)).send({ title: 'ada edit', version: 1 });
      const stale = await request(app).patch(`/api/tasks/${t.id}`).set(as(bob)).send({ title: 'bob edit', version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.error.details.currentVersion).toBe(2);
      expect((await request(app).get(`/api/tasks/${t.id}`).set(as(ada))).body.title).toBe('ada edit');
    });

    it('lets exactly one of several simultaneous edits win', async () => {
      const { ada, bob, project } = await team();
      const t = (await mkTask(ada, project)).body;
      const results = await Promise.all(
        [ada, bob, ada, bob].map((who, i) => request(app).patch(`/api/tasks/${t.id}`).set(as(who)).send({ title: `edit ${i}`, version: 1 })),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409, 409]);
      expect((await request(app).get(`/api/tasks/${t.id}`).set(as(ada))).body.version).toBe(2);
    });

    it('keeps the assignee rule even if the member is removed mid-request (DB constraint as backstop)', async () => {
      const { ada, bob, project } = await team();
      const t = (await mkTask(ada, project)).body;
      await db.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [project, bob.id]);
      const res = await request(app).patch(`/api/tasks/${t.id}`).set(as(ada)).send({ assigneeId: bob.id, version: 1 });
      expect(res.status).toBe(422);
    });
  });

  describe('Scenario D: filtering, search, paging', () => {
    const seed = async () => {
      const { ada, bob, project } = await team();
      const other = await mkProject(ada, 'Other');
      const create = async (body: Record<string, unknown>, pid = project) => (await mkTask(ada, pid, body)).body;
      const login = await create({ title: 'Fix login bug', priority: 'urgent', assigneeId: bob.id, dueDate: '2000-01-01' });
      const docs = await create({ title: 'Write docs', priority: 'low' });
      const deploy = await create({ title: 'Deploy pipeline', priority: 'high', assigneeId: ada.id });
      await request(app).patch(`/api/tasks/${deploy.id}`).set(as(ada)).send({ status: 'done', version: 1 });
      const elsewhere = await create({ title: 'Login page copy' }, other);
      return { ada, bob, project, other, login, docs, deploy, elsewhere };
    };
    const titles = async (who: Person, path: string, query: Record<string, string> = {}) =>
      (await request(app).get(path).set(as(who)).query(query)).body.items.map((t: { title: string }) => t.title).sort();

    it('filters by status, priority, assignee, overdue and text', async () => {
      const { ada, bob, project } = await seed();
      const p = `/api/projects/${project}/tasks`;
      expect(await titles(ada, p, { status: 'done' })).toEqual(['Deploy pipeline']);
      expect(await titles(ada, p, { status: 'todo,done' })).toEqual(['Deploy pipeline', 'Fix login bug', 'Write docs']);
      expect(await titles(ada, p, { priority: 'urgent,high' })).toEqual(['Deploy pipeline', 'Fix login bug']);
      expect(await titles(bob, p, { assignee: 'me' })).toEqual(['Fix login bug']);
      expect(await titles(ada, p, { assignee: 'none' })).toEqual(['Write docs']);
      expect(await titles(ada, p, { assignee: bob.id })).toEqual(['Fix login bug']);
      expect(await titles(ada, p, { overdue: 'true' })).toEqual(['Fix login bug']);
      expect(await titles(ada, p, { q: 'logi' })).toEqual(['Fix login bug']);
      expect(await titles(ada, p, { q: 'fix deploy' })).toEqual([]);
      expect(await titles(ada, p, { q: '")(&|' })).toHaveLength(3); // punctuation ignored, no 500
    });

    it('does not count done tasks as overdue', async () => {
      const { ada, project } = await team();
      const t = (await mkTask(ada, project, { dueDate: '2000-01-01' })).body;
      expect(t.isOverdue).toBe(true);
      const done = await request(app).patch(`/api/tasks/${t.id}`).set(as(ada)).send({ status: 'done', version: 1 });
      expect(done.body.isOverdue).toBe(false);
    });

    it('searches across all of a user\'s projects, and can narrow to one', async () => {
      const { ada, other } = await seed();
      expect(await titles(ada, '/api/tasks', { q: 'login' })).toEqual(['Fix login bug', 'Login page copy']);
      expect(await titles(ada, '/api/tasks', { q: 'login', projectId: other })).toEqual(['Login page copy']);
    });

    it('pages through tasks exactly once', async () => {
      const { ada, project } = await team();
      for (let i = 1; i <= 7; i++) await mkTask(ada, project, { title: `T${i}` });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: request.Response = await request(app).get(`/api/projects/${project}/tasks`).set(as(ada)).query({ limit: 3, ...(cursor ? { cursor } : {}) });
        seen.push(...res.body.items.map((t: { title: string }) => t.title));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(['T7', 'T6', 'T5', 'T4', 'T3', 'T2', 'T1']);
    });

    it('shows task counts per status in the project view (Scenario C)', async () => {
      const { ada, bob, project } = await seed();
      const res = await request(app).get(`/api/projects/${project}`).set(as(bob));
      expect(res.body.taskCounts).toEqual({ total: 3, todo: 2, inProgress: 0, inReview: 0, done: 1, overdue: 1 });
      expect(res.body.members.map((m: { name: string }) => m.name).sort()).toEqual(['ada', 'bob']);
      void ada;
    });
  });

  describe('comments', () => {
    it('adds, lists oldest-first, and counts comments', async () => {
      const { ada, bob, project } = await team();
      const t = (await mkTask(ada, project)).body;
      const first = await request(app).post(`/api/tasks/${t.id}/comments`).set(as(bob)).send({ body: '  first ' });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ body: 'first', author: { id: bob.id }, edited: false });
      await request(app).post(`/api/tasks/${t.id}/comments`).set(as(ada)).send({ body: 'second' });
      const list = await request(app).get(`/api/tasks/${t.id}/comments`).set(as(ada));
      expect(list.body.items.map((c: { body: string }) => c.body)).toEqual(['first', 'second']);
      expect((await request(app).get(`/api/tasks/${t.id}`).set(as(ada))).body.commentCount).toBe(2);
    });

    it('lets only the author edit; author or owner delete', async () => {
      const { ada, bob, project } = await team();
      const carol = await signup('carol');
      await addMember(ada, project, carol);
      const t = (await mkTask(ada, project)).body;
      const c = (await request(app).post(`/api/tasks/${t.id}/comments`).set(as(bob)).send({ body: 'mine' })).body;
      const url = `/api/tasks/${t.id}/comments/${c.id}`;
      expect((await request(app).patch(url).set(as(ada)).send({ body: 'rewritten' })).status).toBe(403); // not even the owner
      const edited = await request(app).patch(url).set(as(bob)).send({ body: 'fixed typo' });
      expect(edited.body).toMatchObject({ body: 'fixed typo', edited: true });
      expect((await request(app).delete(url).set(as(carol))).status).toBe(403);
      expect((await request(app).delete(url).set(as(ada))).status).toBe(204); // owner moderates
      expect((await request(app).get(`/api/tasks/${t.id}/comments`).set(as(bob))).body.items).toHaveLength(0);
    });

    it('rejects empty comments and comments addressed through the wrong task', async () => {
      const { ada, project } = await team();
      const t1 = (await mkTask(ada, project)).body;
      const t2 = (await mkTask(ada, project)).body;
      expect((await request(app).post(`/api/tasks/${t1.id}/comments`).set(as(ada)).send({ body: '   ' })).status).toBe(400);
      const c = (await request(app).post(`/api/tasks/${t1.id}/comments`).set(as(ada)).send({ body: 'x' })).body;
      expect((await request(app).delete(`/api/tasks/${t2.id}/comments/${c.id}`).set(as(ada))).status).toBe(404);
    });
  });
});
