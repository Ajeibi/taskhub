# ADR 0001: Stack and data-model foundations

Status: accepted

## Decisions

| Area | Choice | Alternatives considered | Why |
|---|---|---|---|
| Backend | Node + Express + TypeScript | Fastify, NestJS | Team strength is TS. Express is minimal, so structure is explicit and easy to defend; NestJS adds framework magic that doesn't pay off at this size. |
| Database | PostgreSQL 16, plain SQL via `pg` | Prisma, Drizzle | Relational data with strong integrity needs. Plain SQL gives full control of transactions, constraints, partial indexes and full-text search, which are central to this problem. Cost: more hand-written SQL. |
| Frontend | React + Vite + TypeScript | Next.js, API only | Authenticated app, no SEO need, so SSR adds weight without benefit. |
| Auth | Email/password, short-lived JWT access token + rotating, hashed refresh tokens | Server sessions, third-party IdP | Stateless access tokens scale across pods; refresh tokens stay revocable and reuse-detectable. |
| Authorization | Per-project roles (owner/member) + global admin; non-members get 404 | Richer RBAC, global roles only | Covers the scenarios without over-building; 404 avoids leaking project existence. |
| Concurrency | Optimistic locking (`version` column) inside transactions | Row locks, last-write-wins | No long-held locks; conflicts surface as 409 instead of silent data loss. |
| Listing at scale | Keyset (cursor) pagination, targeted indexes, Postgres full-text search | Offset paging, external search engine | Constant-time paging on large tables; no extra infrastructure for search. |

## Data-model principles
1. **The database enforces consistency.** The assignee must be a member of the task's project via a composite foreign key. One owner per project is a partial unique index. `done` implies `completed_at` is set via a CHECK. Application bugs cannot violate these.
2. **Membership is the single source of truth** for both authorization and ownership (no separate `owner_id` to drift out of sync).
3. **Soft delete** (`deleted_at`) on projects, tasks and comments: recoverable, and the audit trail never dangles. Hot-path indexes are partial (`WHERE deleted_at IS NULL`) so deleted rows cost nothing in reads.
4. **Audit trail**: append-only `activity_log` with JSON metadata; also feeds the dashboard's recent activity.
5. **Search config `simple`** (no stemming/stop-words): task titles contain names and codes where language-specific stemming hurts. Prefix matching (`term:*`) provides search-as-you-type.

## Operational principles
- Config only from environment variables, validated at startup (fail fast).
- Liveness (`/healthz`) never touches the DB; readiness (`/readyz`) does. A DB outage removes pods from rotation instead of restarting them.
- Migrations are a separate, one-time step (Kubernetes Job), not run by every replica at startup.
- Graceful shutdown on SIGTERM (drain requests, close pool).

## Consequences / trade-offs
- More SQL to write and test by hand than with an ORM. Mitigated by integration tests against real Postgres.
- Hard deletes are never done by the app, so a retention/purge job will eventually be needed for soft-deleted rows.
- Requires PostgreSQL 15+ (column-list `ON DELETE SET NULL`).
