# Performance measurements

Reproduce: `docker compose up -d db`, then in `server/`: `npm run perf:seed` (≈3.5 min) and `npm run perf:run`.
Both refuse to touch any database whose name does not contain `perf`.

## What was measured, and the limits

- **Data**: 2,000 users, 2,000 projects, **500,000 tasks**, 75k comments, 700k activity rows, 18k memberships.
  Deliberately skewed: 5 "hot" projects hold 30% of tasks (~30,000 each, 40 members), like a real company's biggest projects.
- **Setup**: laptop, Postgres 16 in Docker, app and load generator in one Node process, warm cache, one Node process, pool of 10.
  Raw DB round trip is ~1 ms (`SELECT 1`), so the figures below are query cost, not connection overhead.
- **Not measured**: multiple pods, network latency, cold cache, a managed database, a separate load generator.
  Treat these as *relative* evidence (which queries scale, which do not), not capacity promises.

## Results (per-endpoint, sequential)

| Area | p50 | p95 | Notes |
|---|---|---|---|
| Most endpoints (lists, search, task detail, comments) | 10–27 ms | ≤ 45 ms | No large sequential scans; slowest SQL ≤ ~5 ms |
| Project detail, hottest project | — | — | Slowest SQL 35.8 ms (task counts over ~30k rows) |
| **Dashboard, member of a hot project** | 76 ms | 110 ms | Task aggregate (76.9 ms) is O(tasks in the user's active projects) |
| **Dashboard, platform admin** | 217 ms | 264 ms | Seq scan over all 500k tasks |

## Keyset vs OFFSET (task list, hottest project)

| Rows skipped | OFFSET | Keyset |
|---|---|---|
| 30,301 | 15.8 ms, 273 buffers | **0.27 ms, 4 buffers** |

Keyset cost is constant at any depth; OFFSET grows linearly. This is why the API uses cursors.

## Concurrent mixed load (single Node process, pool 10)

| Concurrency | Throughput | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|
| 1 | 50 req/s | 18.9 ms | — | — | 0 |
| 10 | 123 req/s | 76.8 ms | 137 ms | 165 ms | 0 |
| 50 | 111 req/s | 447 ms | 699 ms | 758 ms | 0 |

Throughput plateaus around 10 concurrent requests (one Node process, 10 DB connections) and extra concurrency
turns into queueing latency, not errors. That is the expected shape; it is the reason for horizontal scaling
(HPA, see `deploy/README.md`) and for the pool budget (`replicas × DB_POOL_MAX ≤ max_connections`).

## Findings and options

1. **Everything list-shaped scales** (indexes + keyset). No change needed.
2. **The dashboard task aggregate is the one real hot spot.** It counts every task in the caller's active projects.
   Fine for typical users; 76 ms for a member of a 30k-task project; 217 ms for an admin. Options:
   - *Short TTL cache per user (e.g. 30 s)*: cheapest; stale counts for ≤ 30 s; per-pod unless Redis is added.
   - *Maintained per-project counters* (updated in the same transaction as task changes): exact and O(projects),
     but more write-path code and a drift risk to test.
   - *Leave as is* and rely on the documented evolution path (ADR 0005). Acceptable at this scale.
3. Admin dashboard should not aggregate the whole platform live; if admins matter, serve it from counters or a cache.

## Decision taken: per-user dashboard cache

Implemented the first option: `DASHBOARD_CACHE_TTL_SECONDS` (default 30, `0` disables) in
`server/src/modules/dashboard/dashboard.service.ts`. Properties and trade-offs:

- Keyed by user + role; caches the in-flight promise, so concurrent requests share one query (no stampede).
- Failures are never cached. Bounded to 5,000 entries (oldest evicted).
- **Per pod**: with N replicas a user can see up to N different snapshots, each at most 30 s old.
- **Stale after your own writes**: a task you just changed may not show in the counts for up to 30 s. The activity
  feed and task lists are not cached, so they stay current.
- The perf runner and the other tests set the TTL to 0 so they measure and assert the real queries.
- Still the right next step if this is not enough: maintained per-project counters.
