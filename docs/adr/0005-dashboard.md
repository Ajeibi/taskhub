# ADR 0005: Dashboard

Status: accepted

## What it shows (`GET /api/dashboard`)
- Project counts by status.
- Workload across active projects: tasks by status, open tasks by priority, overdue, due in the next 7 days, unassigned, completed in the last 7 days.
- "Mine": my open, overdue and due-soon tasks, plus my next 5 deadlines.
- Recent activity: the 15 newest audit-log events across my projects.

## Decisions
- **Scoped by membership in SQL**, never filtered in application code. Platform admins see all projects.
- **Aggregation in the database** with `count(*) FILTER (...)`: one pass computes every number; no rows are shipped to the app to be counted.
- **Archived and deleted projects drop out of workload numbers** (closed work is not workload) but archived ones still count in the project totals.
- **Activity feed via LATERAL per project**: the newest 15 events of each of the user's projects are fetched using `activity_project_idx`, then merged. The cost depends on how many projects the user has, not on the size of the global log. The naive alternative (`ORDER BY id DESC` over the whole table filtered by membership) degrades as other teams generate events.
- **`Cache-Control: private, no-store`**: the response is per-user and must never be stored by a shared proxy or CDN.
- Queries run in parallel on the pool; the numbers are not one atomic snapshot (they can differ by an in-flight write), which is acceptable for a monitoring view.

## Trade-offs and evolution
- The task aggregate is O(tasks in the user's active projects). Index-supported, fine at team scale. If a single user spans very large projects: cache for ~30s, or maintain per-project counters updated by the write path.
- "Today" and "next 7 days" use the database's `current_date` (UTC in the container); per-user time zones would need a stored preference.
- Admin feed reads the newest 45 events then drops deleted projects; if most recent events belong to deleted projects the feed can come back short. Acceptable for an admin overview.
