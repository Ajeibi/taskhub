# Deployment guide

What is verified vs. not (be precise about this in the review):

| Artifact | Status |
|---|---|
| `Dockerfile` (multi-stage, non-root, read-only FS) | **Built and run** locally: migrations from an empty DB, health probes, UI, API all work in the container |
| `docker-compose.yml` (db + migrate job + app) | **Run end to end** locally |
| `deploy/k8s` manifests (Kustomize base + `local` overlay) | **Rendered and checked offline** (15 objects, namespaces, images, labels). **Not applied to a cluster**: none was available on the build machine |
| GitHub Actions `ci.yml` | Written, **not executed** (no GitHub remote yet) |

## 1. Run with Docker Compose (one command)
```bash
docker compose up --build        # db -> migrate (runs once, exits) -> app
# open http://localhost:8080
docker compose down              # add -v to also delete the database volume
```
Override the signing secret outside local development: `JWT_SECRET=<48+ random chars> docker compose up`.

## 2. Build the image
```bash
docker build -t taskhub:local .
```
One image serves the API **and** the built frontend (same origin: no CORS, and the strict refresh cookie works).
The same image runs migrations with `node dist/migrate-cli.js`.

## 3. Deploy to Kubernetes (local cluster: Docker Desktop, kind or minikube)
Prerequisites: an ingress controller (`ingress-nginx`) and metrics-server (for the autoscaler).
```bash
docker build -t taskhub:local .                 # kind users: kind load docker-image taskhub:local
O=deploy/k8s/overlays/local

# Stage 1: namespace, config, secrets, network policies, throwaway Postgres
kubectl apply -k $O -l taskhub.io/stage=prereq
kubectl -n taskhub rollout status statefulset/postgres

# Stage 2: migrations as a one-off Job, and WAIT for it
kubectl -n taskhub delete job taskhub-migrate --ignore-not-found
kubectl apply -k $O -l taskhub.io/stage=migrate
kubectl -n taskhub wait --for=condition=complete job/taskhub-migrate --timeout=180s

# Stage 3: the application (Deployment, Service, Ingress, HPA, PDB)
kubectl apply -k $O -l taskhub.io/stage=app
kubectl -n taskhub rollout status deployment/taskhub
# open http://taskhub.localhost
```
Why three stages instead of one `apply`? The app must never start against an old schema, and a
migration must run exactly once per release, not once per replica.

## 4. Operating it
| Task | How |
|---|---|
| Release a new version | build + push a tagged image, set it via `images:` in the overlay, repeat stages 2 and 3 (migrate first, then rolling update) |
| Roll back the app | `kubectl rollout undo deployment/taskhub` (schema changes must be backward compatible, see below) |
| Scale manually | `kubectl scale deployment/taskhub --replicas=N` (the HPA otherwise manages 2 to 10) |
| Look at logs | `kubectl logs -l app.kubernetes.io/name=taskhub -f` (JSON, request-id correlated) |
| Rotate the JWT secret | update the Secret, restart; all access tokens become invalid and clients refresh once (refresh tokens live in the DB, so sessions survive) |

## 5. How the design handles growth, failure and change

### More traffic
- The app is **stateless** (no sessions in memory, JWT access tokens, state only in Postgres), so any pod can serve any request and scaling out is just more replicas.
- **HPA** scales 2 to 10 pods at 70% CPU (of the *request*), scaling up fast and down slowly to avoid flapping. Ingress spreads load across ready pods.
- **The first real limit is the database, not the app.** Connections = replicas x `DB_POOL_MAX` (8) = at most 80 against Postgres' default 100. Beyond that: PgBouncer in front of Postgres, then read replicas for the heavy read paths (lists, dashboard), then partitioning/archiving `activity_log`.
- Rate limiting: per-pod in the app (documented weakness) plus a shared per-IP limit at the Ingress.

### Failures
| Failure | What happens |
|---|---|
| A pod crashes or hangs | liveness probe restarts it; other replicas keep serving (`minReplicas: 2`) |
| A node dies | pods are spread across nodes (topology spread); the scheduler recreates the missing ones |
| Database unreachable | readiness (`/readyz`) fails, pods leave the Service and return clean 503s instead of hanging. Liveness does **not** check the DB, so pods are not restart-looped. They recover by themselves when the DB returns |
| Bad release | `maxUnavailable: 0` + readiness gate: a broken new pod never receives traffic, and the old pods keep running. `kubectl rollout undo` reverts |
| Node drain / cluster upgrade | PodDisruptionBudget keeps at least 1 pod up; `preStop` sleep + SIGTERM handler drain in-flight requests (no dropped requests) |
| A failed migration | the Job fails, the app stage is never applied, the running version is untouched (migrations are transactional per file) |

### Future infrastructure changes
- **Config is entirely environment variables** (12-factor), so moving cloud, switching to a managed database or a secret manager changes only `DATABASE_URL` / the Secret source, not the code or image.
- **Kustomize overlays** are the extension point: add `overlays/staging` and `overlays/production` (real host, registry image tag, replica counts, resource limits, `ExternalSecret` instead of the plain Secret) without touching the base. Helm/Argo CD can consume the same manifests later.
- **Zero-downtime schema changes** use expand/contract: ship additive changes first (new nullable column), deploy code that uses it, remove old structure in a later release. That keeps `rollout undo` safe.
- The image is a plain OCI image with no cloud-specific dependencies, so it runs on ECS/Cloud Run/Nomad as well if Kubernetes is ever dropped.

## 6. Production gaps (stated honestly)
- Postgres in the `local` overlay is a single throwaway pod. Production needs managed or operator-run Postgres (HA, PITR backups, tested restores).
- Secrets must come from a secret manager; the checked-in Secret is development-only.
- No metrics/tracing yet (only structured logs). Next steps: `/metrics` (Prometheus), alerts on readiness failures, error rate and p95 latency, and OpenTelemetry traces.
- TLS certificates (cert-manager) and the registry/push step in CI are environment-specific and not included.
- No image vulnerability scan or SBOM step in CI yet (add Trivy/Grype).
