import { notFound } from '../../errors.js';
import type { Queryable } from '../activity/activity.js';
import type { AuthUser } from '../auth/tokens.js';
import { requireProject, type ProjectAccess } from '../projects/access.js';

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'in_review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee_id: string | null;
  creator_id: string;
  due_date: string | null; // 'YYYY-MM-DD' (selected as text; a JS Date would shift the day across time zones)
  version: number;
  deleted_at: Date | null;
}

/**
 * Loads a task and proves the caller may see it. Authorization is inherited from the task's project:
 * a task in a project you cannot access is indistinguishable from a task that does not exist (404).
 */
export async function requireTask(
  q: Queryable,
  taskId: string,
  user: AuthUser,
): Promise<{ task: TaskRow; access: ProjectAccess }> {
  const { rows } = await q.query<TaskRow>(
    `SELECT id, project_id, title, description, status, priority, assignee_id, creator_id,
            due_date::text AS due_date, version, deleted_at
       FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
    [taskId],
  );
  const task = rows[0];
  if (!task) throw notFound('Task');
  const access = await requireProject(q, task.project_id, user); // 404 for non-members / deleted projects
  return { task, access };
}
