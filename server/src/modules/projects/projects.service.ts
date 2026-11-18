import { withTransaction, type Db } from '../../db.js';
import { conflict, notFound } from '../../errors.js';
import { decodeCursor, toPage, type Page } from '../../pagination.js';
import { toTsQuery } from '../../search.js';
import { logActivity, type Queryable } from '../activity/activity.js';
import type { AuthUser } from '../auth/tokens.js';
import { requireManager, requireProject, type ProjectRole, type ProjectRow } from './access.js';

export interface TaskCounts {
  total: number;
  todo: number;
  inProgress: number;
  inReview: number;
  done: number;
  overdue: number;
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string;
  status: ProjectRow['status'];
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  myRole: ProjectRole;
  taskCounts: TaskCounts;
}

export interface MemberDto {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'member';
  addedAt: string;
}

const EMPTY_COUNTS: TaskCounts = { total: 0, todo: 0, inProgress: 0, inReview: 0, done: 0, overdue: 0 };

const toDto = (p: ProjectRow, role: ProjectRole, counts: TaskCounts | undefined): ProjectDto => ({
  id: p.id,
  name: p.name,
  description: p.description,
  status: p.status,
  version: p.version,
  createdBy: p.created_by,
  createdAt: p.created_at.toISOString(),
  updatedAt: p.updated_at.toISOString(),
  myRole: role,
  taskCounts: counts ?? EMPTY_COUNTS,
});

/** One grouped query for a whole page of projects (no N+1), served by the (project_id, status) index. */
async function taskCountsFor(q: Queryable, projectIds: string[]): Promise<Map<string, TaskCounts>> {
  const map = new Map<string, TaskCounts>();
  if (projectIds.length === 0) return map;
  const { rows } = await q.query(
    `SELECT project_id,
            count(*)::int                                                          AS total,
            count(*) FILTER (WHERE status = 'todo')::int                           AS todo,
            count(*) FILTER (WHERE status = 'in_progress')::int                    AS in_progress,
            count(*) FILTER (WHERE status = 'in_review')::int                      AS in_review,
            count(*) FILTER (WHERE status = 'done')::int                           AS done,
            count(*) FILTER (WHERE status <> 'done' AND due_date < current_date)::int AS overdue
       FROM tasks
      WHERE project_id = ANY($1::uuid[]) AND deleted_at IS NULL
      GROUP BY project_id`,
    [projectIds],
  );
  for (const r of rows) {
    map.set(r.project_id, {
      total: r.total,
      todo: r.todo,
      inProgress: r.in_progress,
      inReview: r.in_review,
      done: r.done,
      overdue: r.overdue,
    });
  }
  return map;
}

export interface ListQuery {
  q?: string;
  status?: ProjectRow['status'];
  cursor?: string;
  limit: number;
}

export class ProjectService {
  constructor(private readonly db: Db) {}

  async create(user: AuthUser, input: { name: string; description: string }): Promise<ProjectDto> {
    return withTransaction(this.db, async (tx) => {
      const { rows } = await tx.query<ProjectRow>(
        `INSERT INTO projects (name, description, created_by) VALUES ($1, $2, $3)
         RETURNING id, name, description, status, created_by, version, created_at, updated_at`,
        [input.name, input.description, user.id],
      );
      const project = rows[0]!;
      await tx.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        project.id,
        user.id,
      ]);
      await logActivity(tx, { projectId: project.id, actorId: user.id, action: 'project.created', metadata: { name: project.name } });
      return toDto(project, 'owner', undefined);
    });
  }

  async list(user: AuthUser, query: ListQuery): Promise<Page<ProjectDto>> {
    const params: unknown[] = [];
    const bind = (v: unknown): string => `$${params.push(v)}`;
    const where = ['p.deleted_at IS NULL'];
    let join = '';
    let roleExpr = `'admin'`;

    if (user.role !== 'admin') {
      // Visibility rule: members see only projects they belong to.
      join = `JOIN project_members m ON m.project_id = p.id AND m.user_id = ${bind(user.id)}`;
      roleExpr = 'm.role';
    }
    if (query.status) where.push(`p.status = ${bind(query.status)}`);
    const ts = query.q ? toTsQuery(query.q) : null;
    if (ts) where.push(`p.search_vector @@ to_tsquery('simple', ${bind(ts)})`);
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      where.push(`(p.created_at, p.id) < (${bind(c.t)}::timestamptz, ${bind(c.id)}::uuid)`);
    }
    const limitParam = bind(query.limit + 1);

    const { rows } = await this.db.query<ProjectRow & { my_role: ProjectRole; created_at_raw: string }>(
      `SELECT p.id, p.name, p.description, p.status, p.created_by, p.version, p.created_at, p.updated_at,
              p.created_at::text AS created_at_raw, ${roleExpr} AS my_role
         FROM projects p ${join}
        WHERE ${where.join(' AND ')}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${limitParam}`,
      params,
    );
    const visible = rows.slice(0, query.limit);
    const counts = await taskCountsFor(this.db, visible.map((r) => r.id));
    return toPage(
      rows,
      query.limit,
      (r) => toDto(r, r.my_role, counts.get(r.id)),
      (r) => ({ t: r.created_at_raw, id: r.id }),
    );
  }

  async get(user: AuthUser, projectId: string): Promise<ProjectDto & { members: MemberDto[] }> {
    const access = await requireProject(this.db, projectId, user);
    const [counts, members] = await Promise.all([taskCountsFor(this.db, [projectId]), this.members(projectId)]);
    return { ...toDto(access.project, access.role, counts.get(projectId)), members };
  }

  async update(
    user: AuthUser,
    projectId: string,
    patch: { name?: string; description?: string; status?: ProjectRow['status']; version: number },
  ): Promise<ProjectDto> {
    return withTransaction(this.db, async (tx) => {
      const access = await requireProject(tx, projectId, user);
      requireManager(access);

      // Optimistic locking: the UPDATE only applies if nobody changed the row since the client read it.
      const { rows } = await tx.query<ProjectRow>(
        `UPDATE projects
            SET name = COALESCE($3, name), description = COALESCE($4, description), status = COALESCE($5, status),
                version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 AND deleted_at IS NULL
      RETURNING id, name, description, status, created_by, version, created_at, updated_at`,
        [projectId, patch.version, patch.name ?? null, patch.description ?? null, patch.status ?? null],
      );
      const updated = rows[0];
      if (!updated) {
        throw conflict('The project was modified by someone else. Reload and try again.', {
          currentVersion: access.project.version,
        });
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const key of ['name', 'description', 'status'] as const) {
        if (patch[key] !== undefined && patch[key] !== access.project[key]) {
          changes[key] = { from: access.project[key], to: patch[key] };
        }
      }
      await logActivity(tx, { projectId, actorId: user.id, action: 'project.updated', metadata: { changes } });
      const counts = await taskCountsFor(tx, [projectId]);
      return toDto(updated, access.role, counts.get(projectId));
    });
  }

  /** Soft delete: the row stays (recoverable, audit trail intact) but disappears from every query. */
  async remove(user: AuthUser, projectId: string): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const access = await requireProject(tx, projectId, user);
      requireManager(access);
      await tx.query(`UPDATE projects SET deleted_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [projectId]);
      await logActivity(tx, { projectId, actorId: user.id, action: 'project.deleted', metadata: { name: access.project.name } });
    });
  }

  async listMembers(user: AuthUser, projectId: string): Promise<MemberDto[]> {
    await requireProject(this.db, projectId, user);
    return this.members(projectId);
  }

  async addMember(user: AuthUser, projectId: string, email: string): Promise<MemberDto> {
    return withTransaction(this.db, async (tx) => {
      requireManager(await requireProject(tx, projectId, user));
      const { rows: found } = await tx.query<{ id: string; name: string; email: string }>(
        `SELECT id, name, email FROM users WHERE email = $1`,
        [email],
      );
      const target = found[0];
      if (!target) throw notFound('User');
      const { rows } = await tx.query<{ added_at: Date }>(
        `INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING added_at`,
        [projectId, target.id],
      );
      if (!rows[0]) throw conflict('User is already a member of this project');
      await logActivity(tx, { projectId, actorId: user.id, action: 'member.added', metadata: { userId: target.id, email: target.email } });
      return { userId: target.id, name: target.name, email: target.email, role: 'member', addedAt: rows[0].added_at.toISOString() };
    });
  }

  /** The owner/admin can remove anyone except the owner; any member can remove themselves (leave). */
  async removeMember(user: AuthUser, projectId: string, targetId: string): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const access = await requireProject(tx, projectId, user);
      if (targetId !== user.id) requireManager(access);
      const { rows } = await tx.query<{ role: 'owner' | 'member' }>(
        `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
        [projectId, targetId],
      );
      if (!rows[0]) throw notFound('Member');
      if (rows[0].role === 'owner') throw conflict('The owner cannot be removed. Transfer ownership first.');
      // The composite foreign key un-assigns the member's tasks automatically; we only count them for the log.
      const { rows: n } = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM tasks WHERE project_id = $1 AND assignee_id = $2 AND deleted_at IS NULL`,
        [projectId, targetId],
      );
      await tx.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, targetId]);
      await logActivity(tx, {
        projectId,
        actorId: user.id,
        action: 'member.removed',
        metadata: { userId: targetId, unassignedTasks: n[0]!.count },
      });
    });
  }

  async transferOwnership(user: AuthUser, projectId: string, targetId: string): Promise<MemberDto[]> {
    await withTransaction(this.db, async (tx) => {
      requireManager(await requireProject(tx, projectId, user));
      // Serialise concurrent transfers on this project so we can never briefly (or permanently) have two owners.
      await tx.query(`SELECT 1 FROM projects WHERE id = $1 FOR UPDATE`, [projectId]);
      const { rows } = await tx.query(`SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, targetId]);
      if (!rows[0]) throw notFound('Member');
      // Demote first: the partial unique index allows only one owner at any moment.
      await tx.query(`UPDATE project_members SET role = 'member' WHERE project_id = $1 AND role = 'owner'`, [projectId]);
      await tx.query(`UPDATE project_members SET role = 'owner' WHERE project_id = $1 AND user_id = $2`, [projectId, targetId]);
      await logActivity(tx, { projectId, actorId: user.id, action: 'project.ownership_transferred', metadata: { to: targetId } });
    });
    return this.members(projectId);
  }

  private async members(projectId: string): Promise<MemberDto[]> {
    const { rows } = await this.db.query(
      `SELECT u.id, u.name, u.email, m.role, m.added_at
         FROM project_members m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1
        ORDER BY (m.role = 'owner') DESC, u.name, u.id`,
      [projectId],
    );
    return rows.map((r) => ({ userId: r.id, name: r.name, email: r.email, role: r.role, addedAt: r.added_at.toISOString() }));
  }
}
