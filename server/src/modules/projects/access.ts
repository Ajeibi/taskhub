import { conflict, forbidden, notFound } from '../../errors.js';
import type { AuthUser } from '../auth/tokens.js';
import type { Queryable } from '../activity/activity.js';

export type ProjectRole = 'owner' | 'member' | 'admin';

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'completed' | 'archived';
  created_by: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectAccess {
  project: ProjectRow;
  role: ProjectRole;
}

/**
 * The single authorization gate for everything that lives inside a project (projects, members, tasks,
 * comments). Every handler goes through here, so there is one place to audit.
 *
 * Non-members receive 404, exactly like a project that does not exist, so the API does not reveal
 * which project ids are real. Platform admins may access every project.
 */
export async function requireProject(q: Queryable, projectId: string, user: AuthUser): Promise<ProjectAccess> {
  const { rows } = await q.query<ProjectRow & { member_role: 'owner' | 'member' | null }>(
    `SELECT p.id, p.name, p.description, p.status, p.created_by, p.version, p.created_at, p.updated_at,
            m.role AS member_role
       FROM projects p
       LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $2
      WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [projectId, user.id],
  );
  const row = rows[0];
  if (!row) throw notFound('Project');
  const { member_role, ...project } = row;
  if (user.role === 'admin') return { project, role: member_role ?? 'admin' };
  if (!member_role) throw notFound('Project');
  return { project, role: member_role };
}

/** Archived projects are read-only: no new or changed tasks and comments. */
export function requireWritable(access: ProjectAccess): void {
  if (access.project.status === 'archived') throw conflict('This project is archived and read-only');
}

/** Owner-level actions: edit/delete the project, manage members. Admins have the same power. */
export function requireManager(access: ProjectAccess): void {
  if (access.role === 'member') throw forbidden('Only the project owner can do this');
}
