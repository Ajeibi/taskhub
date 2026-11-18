# TaskHub: Project & Task Management Platform

Authenticated users create projects, add teammates, create and assign tasks with priority and deadline, track progress
on list and board views, comment, search, and monitor everything from a dashboard.

**Live demo:** https://taskhub-4imx.onrender.com (free tier: the first request after idle takes about a minute;
create an account on the sign-in page). **Start with the technical document:** [docs/TECHNICAL.md](docs/TECHNICAL.md).

| | |
|---|---|
| Backend | Node 22, Express, TypeScript (strict), PostgreSQL 16 via plain SQL, versioned migrations |
| Frontend | React + Vite, served by the API from the same container |
| Tests | 114 API integration tests on a real Postgres, web unit/component tests, Playwright end-to-end, CI on GitHub Actions |
| Deployment | Docker Compose, Kubernetes (Kustomize, tested on kind), Render Blueprint for the live demo |

## Prerequisites
- Node.js 20+ (developed on 22)
- Docker Desktop (for PostgreSQL)

## Quick start: everything in containers
```bash
docker compose up --build      # database -> migrations -> app
# open http://localhost:8080  (create an account on the sign-in page)
```
Kubernetes manifests, CI and the deployment/scaling/failure discussion: [deploy/README.md](deploy/README.md).

## Run locally for development
```bash
# 1. Start only PostgreSQL 16 (creates `taskhub` and `taskhub_test` databases on first start)
docker compose up -d db --wait

# 2. Configure and install
cp .env.example server/.env
cd server && npm install

# 3. Apply database migrations
npm run migrate

# 4. Start the API (http://localhost:8080)
npm run dev
```
Check it: `GET /healthz` (liveness) and `GET /readyz` (readiness, verifies the DB).

## Frontend (React + Vite, plain CSS)
```bash
cd web && npm install
npm run dev        # http://localhost:5173, proxies /api to the backend on :8080
npm run build      # typecheck + production build into web/dist
```
Start the API first (`cd server && npm run dev`). Create an account on the sign-in page and you are in.

## Tests
```bash
cd server && npm test        # rebuilds taskhub_test from the real migrations, then runs everything
npm run typecheck
cd ../web && npm test        # API client unit tests + React component tests
```

Browser end-to-end tests (Playwright) drive the real UI against the running Docker stack. Each test signs up its own
throw-away users, so nothing needs cleaning up:
```bash
AUTH_RATE_LIMIT_MAX=1000 docker compose up -d --build   # the suite signs up many users, so lift the login rate limit
cd e2e && npm install
npx playwright install chromium && npm test             # Playwright's Chromium
# or, on Windows, with the Edge you already have (no download):  npm run test:edge
```

## Database migrations
Plain SQL files in `server/migrations/`, named `NNNN_description.sql`, applied in order, each in a
transaction, and recorded in `schema_migrations` with a checksum. Editing an applied migration is
refused. Migrations are serialised with a Postgres advisory lock, so concurrent runners are safe.
They run as a separate step, never inside the app process: `npm run migrate` locally, a one-shot `migrate` service in
Compose, a Kubernetes Job in `deploy/k8s`. The single-instance Render demo runs them in its start script, just before
the server (safe for one instance thanks to the lock; see `render.yaml`).

## Auth API
| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | `{email, name, password}` returns `{user, accessToken}` and sets the refresh cookie |
| POST | `/api/auth/login` | `{email, password}` |
| POST | `/api/auth/refresh` | uses the refresh cookie; rotates it |
| POST | `/api/auth/logout` | revokes the session |
| GET | `/api/auth/me` | requires `Authorization: Bearer <accessToken>` |

## Projects API, all require `Authorization: Bearer <token>`
| Method | Path | Notes |
|---|---|---|
| POST | `/api/projects` | `{name, description?}`; creator becomes owner |
| GET | `/api/projects` | `?q=&status=&limit=&cursor=`; returns `{items, nextCursor}` with task counts |
| GET | `/api/projects/:id` | detail: members, task counts, `myRole` |
| PATCH | `/api/projects/:id` | owner/admin; requires `version` (409 if stale) |
| DELETE | `/api/projects/:id` | owner/admin; soft delete |
| GET/POST | `/api/projects/:id/members` | POST `{email}` (owner/admin) |
| PATCH | `/api/projects/:id/members/:userId` | `{role:"owner"}` transfers ownership |
| DELETE | `/api/projects/:id/members/:userId` | owner/admin, or a member leaving |
| GET | `/api/users?q=` | people picker (2+ chars, max 10) |

## Tasks API, all require a bearer token
| Method | Path | Notes |
|---|---|---|
| POST | `/api/projects/:projectId/tasks` | `{title, description?, priority?, assigneeId?, dueDate?}` |
| GET | `/api/projects/:projectId/tasks` | filters: `q, status, priority, assignee (me/none/uuid), overdue, limit, cursor` |
| GET | `/api/tasks` | same filters across all your projects (+ `projectId`) |
| GET | `/api/tasks/:id` | detail with comment count |
| PATCH | `/api/tasks/:id` | any field + required `version`; `assigneeId`/`dueDate` accept `null` |
| DELETE | `/api/tasks/:id` | creator, owner or admin; soft delete |
| GET/POST | `/api/tasks/:id/comments` | oldest first, paginated |
| PATCH/DELETE | `/api/tasks/:id/comments/:commentId` | author edits; author/owner deletes |

## Dashboard API
`GET /api/dashboard` (bearer token): project counts, workload by status/priority, overdue and due-soon,
my tasks and next deadlines, and the 15 most recent activity events across your projects.

## Docs
- Architecture decisions: [docs/adr](docs/adr)
- **Technical document (start here):** [docs/TECHNICAL.md](docs/TECHNICAL.md)
- Performance measurements: [docs/PERFORMANCE.md](docs/PERFORMANCE.md)
- Deployment and Kubernetes: [deploy/README.md](deploy/README.md)
