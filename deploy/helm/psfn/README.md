# PSFN Helm Image Contract

This worktree does not yet contain chart templates. The image values here define
the contract those templates should consume.

## PSFN App Image

Gateway, agent, and Garden use one shared PSFN app image. The image contains:

- `dist/gateway-main.js`
- `dist/agent-main.js`
- `dist/operator-main.js`
- `admin-ui/build/index.html` and SvelteKit static assets
- PostgreSQL 17 client wrappers for backup/restore paths: `pg_dump`,
  `pg_restore`, `psql`, and `pg_isready`

Build it locally without publishing:

```bash
docker build \
  --platform linux/amd64 \
  -f docker/Dockerfile.agent \
  -t localhost/psfn-framework:0.1.0-kube .
```

For Pi/k3s image testing, build with `--platform linux/arm64` on a builder that
can produce ARM64 images. The base images are pinned by digest in
`docker/Dockerfile.agent`.

Workload commands:

```yaml
gateway: ["node", "dist/gateway-main.js"]
agent: ["node", "dist/agent-main.js"]
garden: ["node", "dist/operator-main.js"]
```

Production registry values should set `psfnAppImage.digest` after the image is
pushed. The local `localhost/psfn-framework:0.1.0-kube` value is only for local
k3s/import workflows.

## Garden Assets

The Dockerfile runs both `npm run build` and `npm run garden:build`, then copies
`admin-ui/build` into the runtime image. Garden static serving resolves that
directory at `/app/admin-ui/build`, so the operator pod should not need a
separate UI asset image.

## Satellite Hub Image

PSFN-Satellite-Hub is not vendored in this worktree. A separate checkout exists
at `/home/ada/psfn-framework/PSFN-Satellite-Hub`, but it has no Dockerfile today
and its package uses floating dependency ranges. This bead does not modify that
repo.

Set `satelliteHub.image.repository`, `satelliteHub.image.tag`, and preferably
`satelliteHub.image.digest` to an operator-built hub image before enabling the
hub workload. Until that image exists, the chart should treat the hub image as a
required external override.

## Backup And Restore Tools

The shared PSFN app image includes PG17 client tools for the scheduled backup
path owned by the agent process. Standalone restore verification jobs can also
use this app image, or use this pinned tool image:

```yaml
repository: docker.io/library/postgres
tag: 17.6-bookworm
digest: sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3
```

Do not use `latest` tags for app, hub, Postgres, Redis, or backup job images.
