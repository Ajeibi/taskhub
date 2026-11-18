# ADR 0007: Containers and Kubernetes

Status: accepted

## Decisions
- **One image for API + frontend.** The Express app serves the built SPA (`STATIC_DIR`). Same origin means no CORS and the `SameSite=Strict` refresh cookie works. Alternative: nginx container for static files plus an API container; better if the UI needs a CDN or independent release cadence, but it doubles deploy units for no benefit at this size.
- **Multi-stage build** (web build, server build, prod-only deps, runtime). The runtime image has no compilers, dev dependencies, sources or tests. Runs as numeric UID 1000, read-only root filesystem, no capabilities, `no-new-privileges`.
- **Migrations are a separate one-shot step using the same image** (compose service / Kubernetes Job), never at app startup. The app only starts after they succeed. A Postgres advisory lock makes an accidental overlap safe anyway.
- **Kustomize** (built into kubectl) rather than Helm: the app has one deployable and a few environment differences (host, image, secrets, replicas); overlays express that without a templating language. If many teams consume it, Helm is the upgrade path.
- **Probes:** startup, liveness (`/healthz`, no DB), readiness (`/readyz`, checks DB). Liveness must not depend on the database or an outage becomes a restart storm.
- **Rolling update with `maxUnavailable: 0` + `maxSurge: 1`**, `preStop` sleep and a SIGTERM drain handler: deploys and node drains drop no requests.
- **Resource policy:** CPU and memory *requests* set (HPA measures CPU % against the request), memory *limit* set, no CPU limit (avoids throttling latency spikes).
- **HPA 2 to 10, PDB `minAvailable: 1`, topology spread across nodes.** Max replicas is bounded by the database connection budget (replicas x pool size <= `max_connections`).
- **NetworkPolicies:** default deny, then allow ingress-controller to app, app to Postgres and DNS only; Postgres accepts only the app.
- **Pod Security `restricted`** enforced on the namespace, so the cluster itself rejects non-conforming pods.
- **Deploy stages via a label** (`taskhub.io/stage`: prereq, migrate, app) so a plain `kubectl apply -l` sequence enforces ordering without extra tooling.
- **Secrets are not in the base.** The local overlay holds development-only values; production sources the same keys from a secret manager.

## Trade-offs
- Compose and the local overlay run Postgres in a container: fine for demos, not production (no HA, no backups).
- Stage ordering with labels is manual; a CD tool (Argo CD sync waves, Helm hooks) automates it.
- No service mesh, metrics stack, or tracing yet; deliberately left out as unjustified at this scale (see `deploy/README.md`, production gaps).
