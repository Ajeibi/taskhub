import { withTransaction, type Db } from '../../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../../errors.js';
import { decodeCursor, toPage, type Page } from '../../pagination.js';
import { toTsQuery } from '../../search.js';
import { logActivity, type Queryable } from '../activity/activity.js';
import type { AuthUser } from '../auth/tokens.js';
import { requireManager, requireProject, requireWritable } from '../projects/access.js';
import { requireTask, type TaskRow } from './task-access.js';

export type Status = TaskRow['status'];
export type Priority = TaskRow['priority'];

export interface TaskDto {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  assignee: { id: string; name: string } | null;
  creator: { id: string; name: string };
  dueDate: string | null;
  isOverdue: boolean;
  completedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// One query shape for list and detail. Joins are all by primary/foreign key and bounded by the page size.
const SELECT_TASK = `
  SELECT t.id, t.project_id, p.name AS project_name, t.title, t.description, t.status, t.priority,
         t.assignee_id, a.name AS assignee_name, t.creator_id, c.name AS creator_name,
         t.due_date::text AS due_date, t.completed_at, t.version, t.created_at, t.updated_at,
         t.created_at::text AS created_at_raw,
         COALESCE(t.due_date < current_date AND t.status <> 'done', false) AS is_overdue
    FROM tasks t
    JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
    JOIN users c ON c.id = t.creator_id
    LEFT JOIN users a ON a.id = t.assignee_id`;

interface TaskQueryRow {
  id: string; project_id: string; project_name: string; title: string; description: string;
  status: Status; priority: Priority; assignee_id: string | null; assignee_name: string | null;
  creator_id: string; creator_name: string; due_date: string | null; completed_at: Date | null;
  version: number; created_at: Date; updated_at: Date; created_at_raw: string; is_overdue: boolean;
}

const toDto = (r: TaskQueryRow): TaskDto => ({
  id: r.id,
  projectId: r.project_id,
  projectName: r.project_name,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name! } : null,
  creator: { id: r.creator_id, name: r.creator_name },
  dueDate: r.due_date,
  isOverdue: r.is_overdue,
  completedAt: r.completed_at?.toISOString() ?? null,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

async function fetchTask(q: Queryable, id: string): Promise<TaskDto> {
  const { rows } = await q.query<TaskQueryRow>(`${SELECT_TASK} WHERE t.id = $1 AND t.deleted_at IS NULL`, [id]);
  if (!rows[0]) throw notFound('Task');
  return toDto(rows[0]);
}

const assigneeError = () => unprocessable('invalid_assignee', 'The assignee must be a member of the project');

async function assertMember(q: Queryable, projectId: string, userId: string): Promise<void> {
  const { rows } = await q.query(`SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
  if (!rows[0]) throw assigneeError();
}

/** The composite FK is the real guarantee; this maps a violation (e.g. member removed mid-request) to a clean 422. */
function mapAssigneeViolation(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23503' && e.constraint === 'tasks_assignee_is_member') throw assigneeError();
  throw err;
}

export interface TaskFilters {
  projectId?: string;
  q?: string;
  status?: Status[];
  priority?: Priority[];
  assignee?: 'me' | 'none' | string;
  overdue?: boolean;
  cursor?: string;
  limit: number;
}

export interface CreateTask {
  title: string;
  description: string;
  priority: Priority;
  assigneeId?: string | null;
  dueDate?: string | null;
}

export interface UpdateTask {
  title?: string;
  description?: string;
  status?: Status;
  priority?: Priority;
  assigneeId?: string | null;
  dueDate?: string | null;
  version: number;
}

export class TaskService {
  constructor(private readonly db: Db) {}

  async create(user: AuthUser, projectId: string, input: CreateTask): Promise<TaskDto> {
    return withTransaction(this.db, async (tx) => {
      const access = await requireProject(tx, projectId, user);
      requireWritable(access);
      if (input.assigneeId) await assertMember(tx, projectId, input.assigneeId);
      let id: string;
      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO tasks (project_id, title, description, priority, assignee_id, due_date, creator_id)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7) RETURNING id`,
          [projectId, input.title, input.description, input.priority, input.assigneeId ?? null, input.dueDate ?? null, user.id],
        );
        id = rows[0]!.id;
      } catch (err) {
        mapAssigneeViolation(err);
      }
      await logActivity(tx, {
        projectId,
        taskId: id,
        actorId: user.id,
        action: 'task.created',
        metadata: { title: input.title, assigneeId: input.assigneeId ?? null, priority: input.priority },
      });
      return fetchTask(tx, id);
    });
  }

  /**
   * Lists tasks the caller may see. With `projectId` it is one project's board; without, it spans every
   * project the caller belongs to (their personal "my tasks"/global search view). Admins see all.
   */
  async list(user: AuthUser, f: TaskFilters): Promise<Page<TaskDto>> {
    const params: unknown[] = [];
    const bind = (v: unknown): string => `$${params.push(v)}`;
    const where = ['t.deleted_at IS NULL'];
    let join = '';

    if (f.projectId) {
      await requireProject(this.db, f.projectId, user); // authorizes the whole query
      where.push(`t.project_id = ${bind(f.projectId)}`);
    } else if (user.role !== 'admin') {
      join = `JOIN project_members m ON m.project_id = t.project_id AND m.user_id = ${bind(user.id)}`;
    }
    if (f.status?.length) where.push(`t.status = ANY(${bind(f.status)}::text[])`);
    if (f.priority?.length) where.push(`t.priority = ANY(${bind(f.priority)}::text[])`);
    if (f.assignee === 'me') where.push(`t.assignee_id = ${bind(user.id)}`);
    else if (f.assignee === 'none') where.push('t.assignee_id IS NULL');
    else if (f.assignee) where.push(`t.assignee_id = ${bind(f.assignee)}::uuid`);
    if (f.overdue) where.push(`t.due_date < current_date AND t.status <> 'done'`);
    const ts = f.q ? toTsQuery(f.q) : null;
    if (ts) where.push(`t.search_vector @@ to_tsquery('simple', ${bind(ts)})`);
    if (f.cursor) {
      const c = decodeCursor(f.cursor);
      where.push(`(t.created_at, t.id) < (${bind(c.t)}::timestamptz, ${bind(c.id)}::uuid)`);
    }
    const limit = bind(f.limit + 1);

    // `join` goes right after FROM tasks; SELECT_TASK is spliced so the membership join stays before WHERE.
    const sql = SELECT_TASK.replace('FROM tasks t', `FROM tasks t ${join}`) +
      ` WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit}`;
    const { rows } = await this.db.query<TaskQueryRow>(sql, params);
    return toPage(rows, f.limit, toDto, (r) => ({ t: r.created_at_raw, id: r.id }));
  }

  async get(user: AuthUser, taskId: string): Promise<TaskDto & { commentCount: number; myRole: string }> {
    const { access } = await requireTask(this.db, taskId, user);
    const [task, count] = await Promise.all([
      fetchTask(this.db, taskId),
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM comments WHERE task_id = $1 AND deleted_at IS NULL`, [taskId]),
    ]);
    return { ...task, commentCount: count.rows[0]!.n, myRole: access.role };
  }

  async update(user: AuthUser, taskId: string, patch: UpdateTask): Promise<TaskDto> {
    return withTransaction(this.db, async (tx) => {
      const { task, access } = await requireTask(tx, taskId, user);
      requireWritable(access);
      if (task.version !== patch.version) {
        throw conflict('The task was modified by someone else. Reload and try again.', { currentVersion: task.version });
      }
      if (patch.assigneeId) await assertMember(tx, task.project_id, patch.assigneeId);

      const params: unknown[] = [taskId, patch.version];
      const sets: string[] = [];
      const set = (col: string, value: unknown, cast = ''): number => {
        const n = params.push(value);
        sets.push(`${col} = $${n}${cast}`);
        return n;
      };
      if (patch.title !== undefined) set('title', patch.title);
      if (patch.description !== undefined) set('description', patch.description);
      if (patch.priority !== undefined) set('priority', patch.priority);
      if (patch.assigneeId !== undefined) set('assignee_id', patch.assigneeId);
      if (patch.dueDate !== undefined) set('due_date', patch.dueDate, '::date');
      if (patch.status !== undefined) {
        const n = set('status', patch.status);
        // completed_at is derived from status (the DB CHECK demands they agree): set on entering 'done', cleared on leaving.
        sets.push(`completed_at = CASE WHEN $${n}::text = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END`);
      }

      try {
        const { rowCount } = await tx.query(
          `UPDATE tasks SET ${sets.join(', ')}, version = version + 1, updated_at = now()
            WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
          params,
        );
        if (!rowCount) {
          const { rows } = await tx.query<{ version: number }>(`SELECT version FROM tasks WHERE id = $1`, [taskId]);
          throw conflict('The task was modified by someone else. Reload and try again.', { currentVersion: rows[0]?.version });
        }
      } catch (err) {
        mapAssigneeViolation(err);
      }

      // One audit entry per kind of change, so the activity feed can say "moved to Done" or "assigned to X".
      const base = { projectId: task.project_id, taskId, actorId: user.id };
      if (patch.status !== undefined && patch.status !== task.status) {
        await logActivity(tx, { ...base, action: 'task.status_changed', metadata: { from: task.status, to: patch.status } });
      }
      if (patch.assigneeId !== undefined && patch.assigneeId !== task.assignee_id) {
        await logActivity(tx, { ...base, action: 'task.assigned', metadata: { from: task.assignee_id, to: patch.assigneeId } });
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const fields = [['title', 'title', task.title], ['description', 'description', task.description],
        ['priority', 'priority', task.priority], ['dueDate', 'due_date', task.due_date]] as const;
      for (const [key, , before] of fields) {
        const after = patch[key];
        if (after !== undefined && after !== before) changes[key] = { from: before, to: after };
      }
      if (Object.keys(changes).length) await logActivity(tx, { ...base, action: 'task.updated', metadata: { changes } });

      return fetchTask(tx, taskId);
    });
  }

  /** Soft delete. Allowed for the project owner, platform admins, and the task's own creator. */
  async remove(user: AuthUser, taskId: string): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const { task, access } = await requireTask(tx, taskId, user);
      requireWritable(access);
      if (task.creator_id !== user.id) {
        try { requireManager(access); } catch { throw forbidden('Only the task creator or the project owner can delete this task'); }
      }
      await tx.query(`UPDATE tasks SET deleted_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [taskId]);
      await logActivity(tx, { projectId: task.project_id, taskId, actorId: user.id, action: 'task.deleted', metadata: { title: task.title } });
    });
  }
}
