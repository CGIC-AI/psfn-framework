FROM node:22.22.2-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build:ts

FROM node:22.22.2-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS runtime

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
