FROM node:24.19.0-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts/clean-ts-dist.mjs ./scripts/clean-ts-dist.mjs
COPY src/ ./src/

RUN npm run build:ts

FROM node:24.19.0-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime

ARG SOURCE_REVISION=unknown

LABEL org.opencontainers.image.title="psfn-satellite-hub"
LABEL org.opencontainers.image.description="PSFN Satellite Hub TypeScript websocket and Voxta facade runtime"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && rm -rf /root/.npm

COPY --from=build /src/dist/ ./dist/

RUN groupadd -r -g 999 psfn && useradd -r -u 999 -g psfn -d /app psfn
RUN mkdir -p /app/.artifacts/runtime-ts \
    && chown -R psfn:psfn /app/.artifacts

USER 999:999

ENV NODE_ENV=production
ENV AGENT_RUNTIME=psfn
ENV REALTIME_VOICE_BIND_HOST=0.0.0.0
ENV REALTIME_VOICE_PORT=8787
ENV ARTIFACT_ROOT=/app/.artifacts/runtime-ts

CMD ["node", "dist/ts/hub/main.js"]
