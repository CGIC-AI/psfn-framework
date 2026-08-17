# Setup

PSFN runs as separate gateway, agent, and operator components. This repository
provides application entrypoints and a Docker Compose smoke environment; live
deployment configuration belongs in a separate repository.

## Requirements

- Node.js 24 LTS
- npm
- PostgreSQL with pgvector for a persistent runtime
- Docker and Docker Compose for the smoke environment

Install the pinned dependencies:

```bash
npm ci
npm run build
```

## Fast smoke test

The smoke environment starts disposable supporting services and performs a
single request through the public runtime path:

```bash
npm run smoke:docker
```

Use this to verify a checkout. It is not a production deployment template.

### Compose model cache

The isolated agent cannot download its embedding and text-emotion models. The
`model-prefetch` service normally downloads the pinned models before the agent
starts. If the Docker host cannot reach Hugging Face, prepare the cache on a
reachable machine from the same checkout:

```bash
PSFN_SMOKE_MODEL_CACHE_DIR="$PWD/models/transformers" \
PSFN_SMOKE_TEXT_EMOTION_MODEL_REVISION=90ee0c1c4796d370e68968687b8ba51fc11224f4 \
PSFN_SMOKE_EMBEDDING_MODEL_REVISION=751bff37182d3f1213fa05d7196b954e230abad9 \
  node scripts/ops/psfn-compose-smoke-prefetch.mjs
```

Transfer that directory without changing its contents, then use it as the
read-only Compose cache input:

```bash
PSFN_SMOKE_MODEL_CACHE_SOURCE=/absolute/path/to/transformers \
PSFN_SMOKE_MODEL_PREFETCH_OFFLINE=1 \
  npm run smoke:docker
```

Offline mode fails before startup when the supplied directory is empty and
prints the exact variables needed to repair the input. It also requires both
exact revision directories, replaces only those two owned model directories in
the disposable cache volume, and rejects a partial input before model loading.
The Compose defaults pin the same revisions shown above. Keep model cache
contents out of Git.

## Configuration model

Copy `.env.example` to `.env` for local development and fill only the wiring and
credentials you need. Never commit `.env`.

Environment variables own:

- secrets and credential-file locations;
- host, port, socket, and database wiring;
- runtime-root locations;
- explicit bootstrap overrides.

Mutable application settings live in validated JSON owner files. Seed files in
`config/` show the supported shape; runtime-owned copies belong beneath
`SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR`.

Production layout requires both roots and rejects overlaps:

```text
PSFN_RUNTIME_ROOT
├── system-data       -> SYSTEM_DATA_DIR
├── companions/…      -> COMPANION_DATA_DIR
└── workspaces/…      -> WORKSPACE_PATH
```

`WORKSPACE_PATH` is one companion's Personal Workspace. It must not be used for
databases, owner files, logs, sessions, backups, or shared runtime state.

## Start components

Start each component in its own terminal or supervisor:

```bash
npm run gateway
npm run agent
npm run operator
```

The gateway must be reachable before the agent can become ready. The operator
surface is independent and should receive only its own administrative
credentials.

## Validate configuration

After editing seed or owner-file contracts, run:

```bash
npm run verify:settings-contract
npm run verify:hardcoded-settings
npm run build
```

For a complete checkout validation:

```bash
npm test
npm run lint
npm run verify:repository-hygiene
```

## Deployment integration

A deployment repository should provide:

- process or workload supervision;
- durable volumes for system, companion, workspace, and backup roots;
- PostgreSQL and migration credentials;
- gateway transport and companion authentication;
- secret delivery;
- ingress, network policy, health probes, and restart policy;
- operator-specific rollout, recovery, and observability automation.

Do not copy live manifests, values, service units, kubeconfigs, host inventories,
or hardware profiles into this application repository. See
[`docs/operations.md`](./operations.md) for the public runtime contract.

## Common failures

- **Only one runtime root is set.** Set `SYSTEM_DATA_DIR` and
  `COMPANION_DATA_DIR` together.
- **Runtime roots overlap.** Give system data, companion data, and the Personal
  Workspace distinct paths.
- **Owner-file validation fails.** Compare the runtime file with the matching
  seed and run `npm run verify:settings-contract`.
- **The agent cannot reach the gateway.** Verify the configured socket or host,
  gateway readiness, and role-bound authentication values.
- **PostgreSQL startup fails.** Verify pgvector availability, database
  connectivity, schema ownership, and migration authority.
- **A backup lane will not start.** Ensure `BACKUP_ROOT_DIR` is mounted and
  writable and that the encryption key is supplied through a secret channel.
