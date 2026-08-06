# companion-ui test web container.
#
# Multi-stage build: compile the companion-ui Vite PWA from repo source, then
# serve the static dist/ tree with a pinned nginx-unprivileged base. This image
# holds NO server logic; it only serves pre-built static files. Fleet session
# and Hub attachment paths are derived from the canonical browser origin. It is a
# stopgap test surface, to be replaced by a packaged app.
#
# Build context is the repo root (mirrors docker/Dockerfile.agent), so the
# builder can read companion-ui/ source and this directory's nginx.conf.
FROM node:22.22.2-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build

WORKDIR /build/companion-ui

# The build helper passes the commit SHA here. Vite injects it into sw.js so a
# new image always installs a new cache generation in returning browsers.
ARG SOURCE_REVISION=unknown
ENV COMPANION_UI_BUILD_REVISION=${SOURCE_REVISION}

COPY companion-ui/package.json companion-ui/package-lock.json ./
RUN npm ci

COPY companion-ui/ ./

# Preserve the repository layout expected by Companion UI's framework imports.
# Keep this list to the exact transitive TypeScript closure; the focused build-
# context test rejects both missing imports and broad source-tree copies.
COPY src/core/agent/tool-surface/registry.ts \
     src/core/agent/tool-surface/descriptions.ts \
     /build/src/core/agent/tool-surface/
COPY src/core/agent/tool-surface/descriptions/agency-contracts.ts \
     src/core/agent/tool-surface/descriptions/catalog-boundary-contracts.ts \
     src/core/agent/tool-surface/descriptions/continuity-contracts.ts \
     src/core/agent/tool-surface/descriptions/contracts.ts \
     src/core/agent/tool-surface/descriptions/operations-contracts.ts \
     /build/src/core/agent/tool-surface/descriptions/
COPY src/shared/contracts/approval-envelope.ts \
     src/shared/contracts/companion-relay.ts \
     src/shared/contracts/emotion-contracts.ts \
     src/shared/contracts/filesystem.ts \
     src/shared/contracts/hub-device-ingress.ts \
     src/shared/contracts/satellite-registry.ts \
     src/shared/contracts/shard-directory.ts \
     src/shared/contracts/tool-call-outcome.ts \
     src/shared/contracts/trust-contracts.ts \
     /build/src/shared/contracts/
COPY src/shared/routing/companion-id.ts /build/src/shared/routing/
COPY src/shared/utils/types.ts /build/src/shared/utils/
COPY src/system/trust/context-envelope.ts /build/src/system/trust/
RUN npm run build

# nginx-unprivileged is designed to run as a non-root uid and listens on 8080.
# The index (manifest-list) digest resolves the arm64 sub-image on the Pi.
FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS runtime

ARG SOURCE_REVISION=unknown

LABEL org.opencontainers.image.title="psfn-companion-ui-test"
LABEL org.opencontainers.image.description="PSFN companion-ui PWA static test surface served over HTTP for in-cluster browser testing"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"

COPY docker/companion-ui/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /build/companion-ui/dist/ /usr/share/nginx/html/companion-ui/

# Match the chart's pinned non-root uid/gid so runtime paths are owned correctly.
USER 999:999

EXPOSE 8080

# Inherit the base nginx-unprivileged entrypoint/CMD (nginx -g "daemon off;").
