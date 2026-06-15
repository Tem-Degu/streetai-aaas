# StreetAI agent — containerized runtime.
#
# A self-contained box: Node + the aaas engine + the dashboard UI, pre-built.
# It runs the dashboard headless (the unified runtime) and serves the dashboard
# on port 3400. All persistent state (the workspace, registry, credentials,
# logs) lives on the /data volume, so it stays on the host — nothing leaves.
#
# Build the generic base:   docker build -t streetai/aaas:base .
# Bake a client workspace:  see DOCKER.md (a 3-line overlay Dockerfile).

# ---- Stage 1: builder — install deps incl. the native module (better-sqlite3)
FROM node:20-bookworm AS builder
WORKDIR /app
# Build tools so node-gyp can compile better-sqlite3.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: runtime — slim image with the app + compiled modules
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV AAAS_PORT=3400
WORKDIR /app

# App code + the compiled dependencies from the builder (same Debian/Node base,
# so the native better-sqlite3 binary is compatible).
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY dashboard/dist ./dashboard/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh /app/src/cli/index.js \
    && ln -s /app/src/cli/index.js /usr/local/bin/aaas

# Per-client images add their configured workspace (and optionally the LLM
# provider credentials) as templates here, e.g.:
#   COPY lifer2_hospital            /opt/agent-template/lifer2_hospital
#   COPY credentials.json           /opt/agent-template/credentials.json   # optional: baked-in LLM keys
#   ENV  AGENT_NAME=lifer2_hospital
# The entrypoint seeds both into /data on first run (and never overwrites data).

EXPOSE 3400
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
