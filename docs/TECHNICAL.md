# TaskHub: technical document

A project and task management platform: authenticated users create projects, add teammates, create and assign tasks,
track priority, deadline and progress, comment, and monitor work from a dashboard.
Run instructions are in the [README](../README.md); this document explains **why** it is built the way it is.
Each decision has a fuller record in `docs/adr/`.

## 1. Shape of the system

```
Browser (React SPA)  ->  Express API (stateless, N replicas)  ->  PostgreSQL
                              serves /api/* and the built SPA
```

- **Backend:** Node 22, Express, TypeScript (strict). Feature modules (`auth`, `projects`, `tasks`, `dashboard`,
  `activity`) each have routes (HTTP and validation) and a service (rules and SQL).
- **Database:** PostgreSQL 16, plain SQL through `pg`, versioned migrations applied by a one-shot job.
- **Frontend:** React, Vite, plain CSS. List and Board views, a task slide-over, dashboard.
- **Statelessness:** the API holds no session state, so any replica can answer any request. This is what makes
  horizontal scaling and rolling restarts safe.

## 2. Major decisions and trade-offs

| Decision | Why | Cost / alternative rejected |
|---|---|---|
| **Plain SQL (`pg`), not an ORM** | Queries are the hot path and the thing reviewers will inspect. I can show exactly what runs and prove indexes are used (`EXPLAIN`). | More typing; no auto-generated types. Accepted for control. |
| **Integrity in the database, not just code** | Rules hold even if a code path forgets them. A composite foreign key `(project_id, assignee_id)` means a task can only be assigned to a member of *its own project*. A partial unique index allows one owner per project. A CHECK ties `status = done` to `completed_at`. Removing a member sets their tasks' assignee to NULL (`ON DELETE SET NULL (assignee_id)`). | Constraint errors must be translated into clean API errors. |
| **Single authorization gate** (`requireProject`) | Every project-scoped route goes through one function, so a missing check is hard to write by accident. Non-members get **404, not 403**, so project existence does not leak. Roles: owner, member, platform admin. | Slightly less informative errors for legitimate users. |
| **Optimistic locking** (`version` column) | Two people editing one task must not silently overwrite each other. The loser gets 409 with the current version. No long-held locks, so concurrency stays high. | The client must handle conflicts. The UI refreshes the task and queues its own rapid edits so one user never conflicts with themselves. |
| **Soft delete + append-only activity log** | Deleted work is recoverable and auditable. The log row is written in the **same transaction** as the change, so it never disagrees with the data. | Queries must filter `deleted_at`. Partial indexes keep that cheap. |
| **Keyset (cursor) pagination, no total counts** | Cost stays constant at any depth. Measured at 30,301 rows deep: 0.27 ms keyset vs 15.8 ms OFFSET. | No "page 7 of 40" and no jump-to-page. Acceptable for feeds and lists. |
| **Postgres full-text search** (generated `tsvector` + GIN) | Findable records without a new service to run. | Less relevance tuning than a search engine. Revisit if search becomes central. |
| **Short-lived JWT + rotating refresh token** | The 15-minute access token lives only in memory (nothing persistent for XSS to steal). The 7-day refresh token is an httpOnly cookie, stored hashed, single-use, with reuse detection that revokes the whole token family. | More moving parts than a long-lived token. Worth it for a multi-user product. |
| **Password hashing: scrypt** (Node built-in) | Memory-hard, no native dependency. Login does constant-time work even for unknown emails (no user enumeration). | Slow by design (~32 MiB per hash). The test run lowers the cost via `SCRYPT_N`; production refuses to start with a weak value. |
| **Dashboard cached 30 s per user** | The task aggregate scales with project size (measured 76 ms in a 30k-task project). A short cache fixes it cheaply. | Counts can be up to 30 s stale, and the cache is per pod. Next step if needed: maintained per-project counters. |
| **Optimistic-UI-free frontend** | The UI re-fetches after changes instead of guessing server state. Simple and always correct. | One extra round trip per change. |

## 3. Data model (summary)

`users` - `projects` (soft delete, status, version) - `project_members` (role) - `tasks` (status, priority, assignee,
due date, `completed_at`, soft delete, version, search vector) - `comments` - `activity_log` - `refresh_tokens`.
Indexes follow the queries: tasks by `(project_id, created_at, id)` for the keyset list, by `(project_id, status)` for
counts, by `(assignee_id, status)` for "my work", a partial index for overdue, and GIN for search.

## 4. Scenarios from the brief

- **A. Project creation:** creator becomes owner in one transaction; activity logged; appears in the sidebar.
- **B. Task assignment:** any member can create a task and assign it to another *member* with priority and deadline. Assigning
  a non-member is rejected by both the API (422) and the database (foreign key).
- **C. Monitoring:** per-project progress and overdue counts; a dashboard with workload by status and priority, my
  deadlines, and a recent-activity feed scoped to projects the user belongs to.
- **D. Growing workload:** measured, not assumed (section 6).

## 5. Containers and Kubernetes

- **Image:** multi-stage build, non-root user, read-only filesystem, health check; API and built SPA in one image.
- **Compose:** `db`, a one-shot `migrate` service, then `app`, so the app never starts against an unmigrated schema.
- **Kubernetes** (`deploy/k8s`, Kustomize): Deployment with startup, liveness (`/healthz`, no DB) and readiness
  (`/readyz`, checks DB) probes; rolling update with `maxUnavailable: 0` and a pre-stop delay; HorizontalPodAutoscaler 2-10;
  PodDisruptionBudget; topology spread across nodes; NetworkPolicies; restricted pod security; migrations as a Job applied
  **before** the app via stage labels.
- **Traffic growth:** add replicas (HPA). The API is stateless, so this is safe. The limit moves to the database:
  `replicas x DB_POOL_MAX` must stay under Postgres `max_connections` (budgeted: 10 x 8 = 80 of 100); beyond that,
  add PgBouncer, then read replicas for read-heavy endpoints.
- **Failures:** a crashed pod is replaced and removed from traffic by readiness; a DB outage fails readiness (pods stop
  receiving traffic) but not liveness (they are not restart-looped); SIGTERM drains in-flight requests.
- **Future infra changes:** the app reads all settings from environment variables and has no node-local state, so moving to a
  managed database, a different ingress, or another cluster is configuration, not code.

Full detail and the "verified vs not verified" table: [deploy/README.md](../deploy/README.md).

## 6. Evidence

- **Automated tests:** 114 backend tests against a real PostgreSQL (schema constraints, migrations, auth and token reuse,
  authorization, concurrency conflicts, pagination, dashboard, metrics, static serving) and 15 frontend tests (token
  refresh, task row, login, and the task panel's queued saves), plus 8 browser end-to-end tests (Playwright, real UI
  against the Docker stack): sign-up and session restore, wrong password, project and task lifecycle with comments,
  quick-add, Board drag-and-drop, search, and a two-user collaboration flow proving outsiders get "not found".
- **Observability:** structured JSON logs with a validated request id; Prometheus metrics (request latency by route
  pattern, DB pool saturation, process stats) on an internal port (9100) that the Ingress does not route.
- **Multi-tab safety:** two tabs refreshing the shared cookie at once are treated as a race (short grace window,
  client retries once), not as token theft, so users are not logged out everywhere. Replays after the window still
  revoke the whole token family.
- **Load data:** 500,000 tasks, 700,000 activity rows, five projects with ~30,000 tasks each. Most endpoints: p50 10-27 ms,
  p95 <= 45 ms. One hot spot found (dashboard) and fixed with the cache. Concurrent load of 50 clients: 0 errors, throughput
  plateaus around one Node process, as expected. Details and limits: [PERFORMANCE.md](PERFORMANCE.md).

## 7. Known limitations (stated honestly)

- **Kubernetes manifests were validated by rendering only.** No cluster was available; they have not been applied.
- **CI workflow has not run** (no remote repository yet).
- **Rate limiting and the dashboard cache are per pod.** With many replicas, limits are approximate. A shared store
  (Redis) fixes both.
- **Performance numbers** come from one laptop with a warm cache and the load generator in the same process. They show
  what scales, not production capacity.
- **Not built:** email invitations and verification, password reset, notifications, file attachments, task dependencies
  and subtasks, per-project custom statuses, and distributed tracing and alerting rules. The E2E suite passes locally in Edge; its CI job has not run yet.
- **A refresh replay inside the grace window (10 s) is not flagged as theft.** The replayer gets nothing (401), but the
  event is not escalated. This is the deliberate cost of not logging users out when two tabs race.

## 8. What I would do next

1. Apply the manifests to a real cluster (kind or managed) and run a rolling-update and pod-kill test.
2. Add tracing and alerting rules on the existing metrics (readiness failures, error rate, p95 latency, pool waiters).
3. Replace per-pod rate limit and cache with Redis; add maintained per-project counters if dashboards grow heavier.
4. Email invitations and password reset; notifications driven by the activity log.
5. Grow the E2E suite (error states, archived projects, mobile viewport) and run it against every deployment.
