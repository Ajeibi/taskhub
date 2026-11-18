# TaskHub: Project & Task Management Platform

Work in progress. Currently: **Slice 1, foundation** (schema, migrations, health endpoints, tests).

## Prerequisites
- Node.js 20+ (developed on 22)
- Docker Desktop (for PostgreSQL)

## Run locally
```bash
# 1. Start PostgreSQL 16 (creates `taskhub` and `taskhub_test` databases on first start)
docker compose up -d --wait

# 2. Configure and install
cp .env.example server/.env
cd server && npm install

# 3. Apply database migrations
npm run migrate

# 4. Start the API (http://localhost:8080)
npm run dev
```
Check it: `GET /healthz` (liveness) and `GET /readyz` (readiness, verifies the DB).

## Tests
```bash
cd server && npm test        # rebuilds taskhub_test from the real migrations, then runs everything
npm run typecheck
```

## Database migrations
Plain SQL files in `server/migrations/`, named `NNNN_description.sql`, applied in order, each in a
transaction, and recorded in `schema_migrations` with a checksum. Editing an applied migration is
refused. Migrations are serialised with a Postgres advisory lock, so concurrent runners are safe.
They run as a separate step (`npm run migrate`, later a Kubernetes Job), never on app startup.

## Auth API (slice 2)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | `{email, name, password}` returns `{user, accessToken}` and sets the refresh cookie |
| POST | `/api/auth/login` | `{email, password}` |
| POST | `/api/auth/refresh` | uses the refresh cookie; rotates it |
| POST | `/api/auth/logout` | revokes the session |
| GET | `/api/auth/me` | requires `Authorization: Bearer <accessToken>` |

## Docs
- Architecture decisions: [docs/adr](docs/adr)
