import type { Db } from '../../db.js';
import type { AuthUser } from '../auth/tokens.js';

export interface DashboardDto {
  projects: { total: number; active: number; completed: number; archived: number };
  /** Work in active projects the caller belongs to. */
  tasks: {
    total: number;
    byStatus: { todo: number; inProgress: number; inReview: number; done: number };
    openByPriority: { low: number; medium: number; high: number; urgent: number };
    overdue: number;
    dueNext7Days: number;
    unassigned: number;
    completedLast7Days: number;
  };
  mine: { open: number; overdue: number; dueNext7Days: number };
  upcoming: Array<{
    id: string; title: string; priority: string; status: string; dueDate: string; isOverdue: boolean;
    projectId: string; projectName: string;
  }>;
  recentActivity: Array<{
    id: string; action: string; createdAt: string; metadata: Record<string, unknown>;
    actor: { id: string; name: string } | null;
    project: { id: string; name: string };
    task: { id: string; title: string } | null;
  }>;
}

const FEED_SIZE = 15;
const UPCOMING_SIZE = 5;

/**
 * Everything is scoped to the caller's projects (platform admins see all). Four independent, indexed
 * queries run in parallel; none loads rows into the app to count them.
 *
 * Scaling note: the task aggregate is O(tasks in the caller's active projects): measured 76 ms for a member of a
 * 30k-task project and 217 ms for an admin at 500k tasks (docs/PERFORMANCE.md). Hence the short per-user cache
 * above. Next step if that is not enough: maintained per-project counters.
 */
export class DashboardService {
  // Per-pod, per-user cache of the in-flight/finished result. Caching the PROMISE means concurrent requests for
  // the same user share one query (no stampede). Bounded so it cannot grow without limit.
  private readonly cache = new Map<string, { at: number; value: Promise<DashboardDto> }>();
  private static readonly MAX_ENTRIES = 5000;

  constructor(private readonly db: Db, private readonly ttlMs = 0) {}

  /** Cached wrapper. Staleness is bounded by ttlMs and is per pod; a TTL of 0 disables caching. */
  get(user: AuthUser): Promise<DashboardDto> {
    if (this.ttlMs <= 0) return this.compute(user);
    const key = `${user.id}:${user.role}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;

    const value = this.compute(user);
    this.cache.delete(key); // re-insert so Map order tracks recency of write
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); }); // never cache failures
    if (this.cache.size > DashboardService.MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  private async compute(user: AuthUser): Promise<DashboardDto> {
    const isAdmin = user.role === 'admin';
    // Membership restriction fragments. $1 is always the caller's id.
    const projectScope = isAdmin ? '' : 'JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1';

    const [projects, tasks, upcoming, activity] = await Promise.all([
      this.db.query(
        `SELECT p.status, count(*)::int AS n FROM projects p ${projectScope}
          WHERE p.deleted_at IS NULL AND ($1::uuid IS NOT NULL) GROUP BY p.status`,
        [user.id],
      ),
      this.db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE t.status = 'todo')::int         AS todo,
                count(*) FILTER (WHERE t.status = 'in_progress')::int  AS in_progress,
                count(*) FILTER (WHERE t.status = 'in_review')::int    AS in_review,
                count(*) FILTER (WHERE t.status = 'done')::int         AS done,
                count(*) FILTER (WHERE t.status <> 'done' AND t.priority = 'low')::int     AS p_low,
                count(*) FILTER (WHERE t.status <> 'done' AND t.priority = 'medium')::int  AS p_medium,
                count(*) FILTER (WHERE t.status <> 'done' AND t.priority = 'high')::int    AS p_high,
                count(*) FILTER (WHERE t.status <> 'done' AND t.priority = 'urgent')::int  AS p_urgent,
                count(*) FILTER (WHERE t.status <> 'done' AND t.due_date < current_date)::int AS overdue,
                count(*) FILTER (WHERE t.status <> 'done' AND t.due_date BETWEEN current_date AND current_date + 7)::int AS due_soon,
                count(*) FILTER (WHERE t.status <> 'done' AND t.assignee_id IS NULL)::int AS unassigned,
                count(*) FILTER (WHERE t.completed_at >= now() - interval '7 days')::int AS completed_7d,
                count(*) FILTER (WHERE t.status <> 'done' AND t.assignee_id = $1)::int AS my_open,
                count(*) FILTER (WHERE t.status <> 'done' AND t.assignee_id = $1 AND t.due_date < current_date)::int AS my_overdue,
                count(*) FILTER (WHERE t.status <> 'done' AND t.assignee_id = $1
                                   AND t.due_date BETWEEN current_date AND current_date + 7)::int AS my_due_soon
           FROM tasks t
           JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL AND p.status = 'active'
           ${projectScope}
          WHERE t.deleted_at IS NULL`,
        [user.id],
      ),
      // My next deadlines, overdue first. Served by tasks_assignee_status_idx.
      this.db.query(
        `SELECT t.id, t.title, t.priority, t.status, t.due_date::text AS due_date, t.project_id, p.name AS project_name,
                (t.due_date < current_date) AS is_overdue
           FROM tasks t JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL AND p.status <> 'archived'
          WHERE t.assignee_id = $1 AND t.deleted_at IS NULL AND t.status <> 'done' AND t.due_date IS NOT NULL
          ORDER BY t.due_date, t.id LIMIT ${UPCOMING_SIZE}`,
        [user.id],
      ),
      this.recentActivity(user, isAdmin),
    ]);

    const byStatus = Object.fromEntries(projects.rows.map((r) => [r.status, r.n])) as Record<string, number>;
    const t = tasks.rows[0];
    const active = byStatus.active ?? 0, completed = byStatus.completed ?? 0, archived = byStatus.archived ?? 0;

    return {
      projects: { total: active + completed + archived, active, completed, archived },
      tasks: {
        total: t.total,
        byStatus: { todo: t.todo, inProgress: t.in_progress, inReview: t.in_review, done: t.done },
        openByPriority: { low: t.p_low, medium: t.p_medium, high: t.p_high, urgent: t.p_urgent },
        overdue: t.overdue,
        dueNext7Days: t.due_soon,
        unassigned: t.unassigned,
        completedLast7Days: t.completed_7d,
      },
      mine: { open: t.my_open, overdue: t.my_overdue, dueNext7Days: t.my_due_soon },
      upcoming: upcoming.rows.map((r) => ({
        id: r.id, title: r.title, priority: r.priority, status: r.status, dueDate: r.due_date,
        isOverdue: r.is_overdue, projectId: r.project_id, projectName: r.project_name,
      })),
      recentActivity: activity,
    };
  }

  /**
   * Latest events across the caller's projects. For members, take the newest FEED_SIZE events of EACH of
   * their projects via LATERAL (each uses activity_project_idx) and merge: cost depends on the number of
   * the user's projects, not on how large the global log is. A naive "ORDER BY id DESC" over the whole table
   * filtered by membership would scan the global log backwards looking for rows the user may see.
   */
  private async recentActivity(user: AuthUser, isAdmin: boolean): Promise<DashboardDto['recentActivity']> {
    const columns = `a.id, a.action, a.created_at, a.metadata, a.actor_id, a.task_id, a.project_id`;
    const source = isAdmin
      ? `SELECT ${columns} FROM activity_log a ORDER BY a.id DESC LIMIT ${FEED_SIZE * 3}` // pk scan, then filter deleted projects
      : `SELECT x.* FROM project_members pm
           CROSS JOIN LATERAL (
             SELECT ${columns} FROM activity_log a WHERE a.project_id = pm.project_id ORDER BY a.id DESC LIMIT ${FEED_SIZE}
           ) x
          WHERE pm.user_id = $1`;
    const { rows } = await this.db.query(
      `SELECT e.id, e.action, e.created_at, e.metadata, e.project_id, p.name AS project_name,
              e.actor_id, u.name AS actor_name, e.task_id, t.title AS task_title
         FROM (${source}) e
         JOIN projects p ON p.id = e.project_id AND p.deleted_at IS NULL
         LEFT JOIN users u ON u.id = e.actor_id
         LEFT JOIN tasks t ON t.id = e.task_id
        ORDER BY e.id DESC LIMIT ${FEED_SIZE}`,
      isAdmin ? [] : [user.id],
    );
    return rows.map((r) => ({
      id: String(r.id),
      action: r.action,
      createdAt: r.created_at.toISOString(),
      metadata: r.metadata,
      actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null,
      project: { id: r.project_id, name: r.project_name },
      task: r.task_id && r.task_title ? { id: r.task_id, title: r.task_title } : null,
    }));
  }
}
