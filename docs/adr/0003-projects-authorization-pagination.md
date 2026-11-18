# ADR 0003: Projects, authorization, pagination and search

Status: accepted

## Authorization
- One gate: `requireProject()` (`modules/projects/access.ts`). Every project-scoped operation (projects, members, later tasks and comments) calls it, so there is a single place to audit.
- Roles: `owner` (manage project and members), `member` (read, work on tasks), platform `admin` (everything). Role checks are `requireManager()`.
- **Non-members get 404, not 403**, identical to a nonexistent project. The API does not confirm which project ids exist.
- Roles are looked up per request from `project_members`, not stored in the JWT, so removing a member takes effect immediately even though access tokens live 15 minutes.
- The owner cannot be removed or leave; ownership must be transferred first, so a project is never ownerless. Transfer locks the project row, then demotes before promoting, so two owners never exist (also guaranteed by a partial unique index).

## Consistency and concurrency
- Multi-step operations run in one transaction (create project + owner membership + activity entry), so there are no half-created projects.
- Activity-log writes share the transaction: the log never records something that rolled back.
- Edits use optimistic locking: the client sends the `version` it last saw; `UPDATE ... WHERE version = $n`. A stale write returns 409 with the current version instead of silently overwriting.
- Removing a member un-assigns their tasks through the composite foreign key (`ON DELETE SET NULL (assignee_id)`), no application loop needed.
- Delete is a soft delete (`deleted_at`), logged, and hidden from all reads.

## Pagination
- Keyset pagination ordered by `(created_at DESC, id DESC)`; cursor is opaque base64 JSON validated on input. Cost per page is independent of depth. `id` is the tie-breaker so equal timestamps are never skipped.
- The cursor stores the timestamp as Postgres text (microseconds). A JS `Date` is millisecond-precision and would silently skip or repeat rows created in the same millisecond.
- Fetch `limit + 1` rows to know whether a next page exists without a COUNT. We deliberately do not return a total: an exact count of a large filtered set is expensive. Trade-off: no "page 7 of 40" jumping.
- Max page size 100.

## Search
- Postgres full-text (`tsvector` generated column + GIN index), `simple` configuration, prefix matching on every term, AND semantics.
- User text is reduced to letters/digits before building the `tsquery`, so operators cannot cause syntax errors or injection-style surprises.
- No external search engine: avoids operating another system. Evolution path: `pg_trgm` for fuzzy/typo matching, then OpenSearch if relevance requirements outgrow Postgres.

## Avoiding N+1
- Task counts for a page of projects come from one grouped query (`GROUP BY project_id` with `FILTER`), not one query per project.

## Trade-offs
- `GET /api/users?q=` lets any signed-in user look up colleagues by prefix (limited to 10 results, 2+ chars). Fine for an internal directory; a multi-tenant SaaS would scope it to the organisation.
- Prefix `LIKE` on `users.email` only uses an index with `text_pattern_ops`; at very large user counts add a `pg_trgm` index.
- Adding a member by email lets owners test whether an email is registered. Accepted for usability.
