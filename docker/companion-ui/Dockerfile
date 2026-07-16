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

# The layout mirrors the repo: companion-ui/ sits next to the parent src/ tree,
# because companion-ui reaches into ../../../../src/shared/utils/types.js.
WORKDIR /build/companion-ui

# The build helper passes the commit SHA here. Vite injects it into sw.js so a
# new image always installs a new cache generation in returning browsers.
ARG SOURCE_REVISION=unknown
ENV COMPANION_UI_BUILD_REVISION=${SOURCE_REVISION}

COPY companion-ui/package.json companion-ui/package-lock.json ./
RUN npm ci

COPY companion-ui/ ./
# Cross-package dependency: companion-ui/src/lib/protocol/framing.ts and
# .../api/client.ts import isObjectRecord from ../../../../src/shared/utils/types.js
# in the parent repo. That module is self-contained (no further imports), so
# providing just it at the path the relative import expects keeps the build
# faithful without dragging in the whole runtime source tree.
COPY src/shared/utils/types.ts /build/src/shared/utils/types.ts
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
