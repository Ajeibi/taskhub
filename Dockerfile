# syntax=docker/dockerfile:1
# One image serves the API and the built frontend. Multi-stage so the final image has no compilers,
# dev dependencies, sources or test code: smaller, faster to pull, smaller attack surface.

# ---- 1. Build the frontend -----------------------------------------------------------------------
FROM node:22-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- 2. Compile the server -----------------------------------------------------------------------
FROM node:22-alpine AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ---- 3. Production dependencies only -------------------------------------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- 4. Runtime ----------------------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/web/dist
WORKDIR /app/server
COPY --from=prod-deps /app/server/node_modules ./node_modules
COPY --from=server-build /app/server/dist ./dist
COPY server/package.json ./
COPY server/migrations ./migrations
COPY --from=web-build /web/dist /app/web/dist

# Never run as root. The numeric UID (the `node` user) lets Kubernetes verify runAsNonRoot.
USER 1000:1000
EXPOSE 8080

# Docker-level liveness for plain `docker run` / compose. Kubernetes uses its own probes instead.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

# `node` as PID 1 receives SIGTERM directly, so the graceful-shutdown handler runs.
# Migrations use the same image:  node dist/migrate-cli.js
CMD ["node", "dist/index.js"]
