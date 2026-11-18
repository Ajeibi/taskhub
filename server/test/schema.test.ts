import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeProject, makeUser, resetData, testPool } from './helpers.js';

// These tests prove the DATABASE enforces the business rules, independent of any application code.
describe('schema integrity', () => {
  const db: pg.Pool = testPool();
  beforeEach(() => resetData(db));
  afterAll(() => db.end());

  it('rejects an assignee who is not a member of the task project', async () => {
    const owner = await makeUser(db, 'owner@x.io');
    const outsider = await makeUser(db, 'outsider@x.io');
    const project = await makeProject(db, owner);
    await expect(
      db.query(`INSERT INTO tasks (project_id, title, creator_id, assignee_id) VALUES ($1, 't', $2, $3)`, [
        project,
        owner,
        outsider,
      ]),
    ).rejects.toThrow(/tasks_assignee_is_member/);
  });

  it('allows unassigned tasks and members as assignees', async () => {
    const owner = await makeUser(db, 'owner@x.io');
    const member = await makeUser(db, 'member@x.io');
    const project = await makeProject(db, owner);
    await db.query(`INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)`, [project, member]);
    await db.query(`INSERT INTO tasks (project_id, title, creator_id) VALUES ($1, 'unassigned', $2)`, [project, owner]);
    await db.query(`INSERT INTO tasks (project_id, title, creator_id, assignee_id) VALUES ($1, 'assigned', $2, $3)`, [
      project,
      owner,
      member,
    ]);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1`, [project]);
    expect(rows[0].n).toBe(2);
  });

  it('unassigns (but keeps) tasks when their assignee is removed from the project', async () => {
    const owner = await makeUser(db, 'owner@x.io');
    const member = await makeUser(db, 'member@x.io');
    const project = await makeProject(db, owner);
    await db.query(`INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)`, [project, member]);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, creator_id, assignee_id) VALUES ($1, 't', $2, $3) RETURNING id`,
      [project, owner, member],
    );
    await db.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [project, member]);
    const task = await db.query(`SELECT project_id, assignee_id FROM tasks WHERE id = $1`, [rows[0]!.id]);
    expect(task.rows[0].assignee_id).toBeNull();
    expect(task.rows[0].project_id).toBe(project); // project_id must NOT be nulled
  });

  it('allows only one owner per project', async () => {
    const a = await makeUser(db, 'a@x.io');
    const b = await makeUser(db, 'b@x.io');
    const project = await makeProject(db, a);
    await expect(
      db.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [project, b]),
    ).rejects.toThrow(/project_members_one_owner_idx/);
  });

  it('requires completed_at exactly when a task is done', async () => {
    const owner = await makeUser(db, 'owner@x.io');
    const project = await makeProject(db, owner);
    await expect(
      db.query(`INSERT INTO tasks (project_id, title, creator_id, status) VALUES ($1, 't', $2, 'done')`, [project, owner]),
    ).rejects.toThrow(/tasks_completed_consistent/);
    await expect(
      db.query(`INSERT INTO tasks (project_id, title, creator_id, completed_at) VALUES ($1, 't', $2, now())`, [project, owner]),
    ).rejects.toThrow(/tasks_completed_consistent/);
  });

  it('rejects invalid enum values', async () => {
    const owner = await makeUser(db, 'owner@x.io');
    const project = await makeProject(db, owner);
    await expect(
      db.query(`INSERT INTO tasks (project_id, title, creator_id, priority) VALUES ($1, 't', $2, 'whenever')`, [project, owner]),
    ).rejects.toThrow(/check constraint/);
  });

  it('enforces unique, lower-cased emails', async () => {
    await makeUser(db, 'dup@x.io');
    await expect(makeUser(db, 'dup@x.io')).rejects.toThrow(/users_email_key/);
    await expect(makeUser(db, 'Mixed@X.io')).rejects.toThrow(/users_email_format/);
  });

  it('deleting a project cascades to its tasks, memberships and activity', async () => {
    const owner = await makeUser(db, 'owner@x.io');
    const project = await makeProject(db, owner);
    await db.query(`INSERT INTO tasks (project_id, title, creator_id) VALUES ($1, 't', $2)`, [project, owner]);
    await db.query(`INSERT INTO activity_log (project_id, actor_id, action) VALUES ($1, $2, 'x')`, [project, owner]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [project]);
    for (const table of ['tasks', 'project_members', 'activity_log']) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  it('finds tasks by full-text search', async () => {
    const owner = await makeUser(db, 'owner@x.io');
    const project = await makeProject(db, owner);
    await db.query(`INSERT INTO tasks (project_id, title, description, creator_id) VALUES ($1, 'Fix login bug', 'users cannot sign in', $2)`, [project, owner]);
    await db.query(`INSERT INTO tasks (project_id, title, creator_id) VALUES ($1, 'Write docs', $2)`, [project, owner]);
    const { rows } = await db.query(
      `SELECT title FROM tasks WHERE search_vector @@ to_tsquery('simple', $1)`,
      ['login:*'],
    );
    expect(rows.map((r) => r.title)).toEqual(['Fix login bug']);
  });
});
