import type pg from 'pg';
import type { Db } from '../../db.js';

export type Queryable = Db | pg.PoolClient;

export interface ActivityEvent {
  projectId: string;
  taskId?: string | null;
  actorId: string;
  action: string; // e.g. project.created, member.added, task.status_changed
  metadata?: Record<string, unknown>;
}

/**
 * Append to the audit trail. Callers pass their transaction client so the log entry commits or rolls
 * back together with the change it describes: the log can never claim something that did not happen.
 */
export async function logActivity(q: Queryable, e: ActivityEvent): Promise<void> {
  await q.query(
    `INSERT INTO activity_log (project_id, task_id, actor_id, action, metadata) VALUES ($1, $2, $3, $4, $5)`,
    [e.projectId, e.taskId ?? null, e.actorId, e.action, JSON.stringify(e.metadata ?? {})],
  );
}
