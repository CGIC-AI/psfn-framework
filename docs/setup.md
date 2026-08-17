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
the disposable cache volume, verifies the pinned `prompt-injection-v2` files,
and rejects a partial input before model loading.
The Compose defaults pin the same revisions shown above. Keep model cache
contents out of Git.

The disposable profile also runs an internal-only operator-alert sink so CogSec
can retain its production fail-closed posture without requiring a second real
credential. The sink exposes no host port and discards request bodies; it is not
a production notification service.

## Clean local split: first persisted conversation

Use this procedure when you want the gateway and agent as separate host
processes instead of Compose. It is a disposable development check, not a live
deployment recipe. It starts only pgvector in Docker, generates all other local
credentials, and uses the checked-in owner-file seeds. The agent receives no
provider secret, session HMAC key, or inline database URL.

Run every block below from the repository root in one dedicated Bash shell.
You need Node.js 24.19 or newer within the supported Node 24 range, Docker,
`curl`, `openssl`, and the `gio` trash command. The first run downloads the
pinned CogSec classifier and the local embedding/emotion models, so it also
needs access to Hugging Face.

First install and build, then read your OpenRouter key without putting it in a
tracked file or command history:

```bash
node --version
npm ci
npm run build

if test -z "${OPENROUTER_API_KEY:-}"; then
  read -rsp 'OpenRouter API key: ' OPENROUTER_API_KEY
  printf '\n'
fi
test -n "$OPENROUTER_API_KEY"
```

Create a non-overlapping disposable layout and generated local credentials.
The fixed companion UUID and names below are invented test identities.

```bash
set -euo pipefail

LOCAL_SPLIT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/psfn-local-split.XXXXXX")"
LOCAL_RUNTIME_ROOT="$LOCAL_SPLIT_ROOT/runtime"
SYSTEM_DATA_DIR="$LOCAL_RUNTIME_ROOT/system-data"
COMPANION_DATA_DIR="$LOCAL_RUNTIME_ROOT/companions/smoke"
WORKSPACE_PATH="$LOCAL_RUNTIME_ROOT/workspaces/smoke"
CHARACTER_CARD_PATH="$COMPANION_DATA_DIR/companion.json"
GATEWAY_SOCKET="$LOCAL_SPLIT_ROOT/run/gateway.sock"
COMPANION_ID=11111111-1111-4111-8111-111111111111
LOCAL_API_PORT=13000
LOCAL_ALERT_PORT=13002
LOCAL_API_KEY="$(openssl rand -hex 24)"
LOCAL_HMAC_KEY="$(openssl rand -hex 32)"
LOCAL_BACKUP_KEY="$(openssl rand -base64 48 | tr -d '\n')"
LOCAL_PG_PASSWORD="$(openssl rand -hex 24)"
LOCAL_PG_CONTAINER="psfn-local-split-${LOCAL_SPLIT_ROOT##*.}"
LOCAL_MODEL_ROOT="$LOCAL_SPLIT_ROOT/models"
LOCAL_AUTH_ROOT="$LOCAL_SPLIT_ROOT/agent-auth"
mkdir -p "$LOCAL_SPLIT_ROOT/logs"

cleanup_local_split_processes() {
  for pid in "${AGENT_PID:-}" "${GATEWAY_PID:-}" "${ALERT_PID:-}"; do
    if test -n "$pid"; then kill "$pid" 2>/dev/null || true; fi
  done
  wait "${AGENT_PID:-}" "${GATEWAY_PID:-}" "${ALERT_PID:-}" 2>/dev/null || true
  docker stop --time 10 "$LOCAL_PG_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup_local_split_processes EXIT INT TERM
```

Start an exact, digest-pinned pgvector image on a Docker-assigned loopback port.
The data disappears with the container during teardown.

```bash
docker run --detach --rm \
  --name "$LOCAL_PG_CONTAINER" \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_DB=psfn \
  --env POSTGRES_USER=psfn \
  --env POSTGRES_PASSWORD="$LOCAL_PG_PASSWORD" \
  pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f

until docker exec "$LOCAL_PG_CONTAINER" pg_isready -U psfn -d psfn >/dev/null 2>&1; do
  sleep 1
done
LOCAL_PG_PORT="$(docker port "$LOCAL_PG_CONTAINER" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
LOCAL_POSTGRES_URL="postgresql://psfn:${LOCAL_PG_PASSWORD}@127.0.0.1:${LOCAL_PG_PORT}/psfn"
```

Seed every current owner file, the one-companion manifest, the starter card,
and the agent's role-bound authentication files. The seeder also makes both
capability-tier owners explicitly Autonomous for this disposable proof.

```bash
env \
  SYSTEM_DATA_DIR="$SYSTEM_DATA_DIR" \
  COMPANION_DATA_DIR="$COMPANION_DATA_DIR" \
  WORKSPACE_PATH="$WORKSPACE_PATH" \
  CHARACTER_CARD_PATH="$CHARACTER_CARD_PATH" \
  GATEWAY_SOCKET="$GATEWAY_SOCKET" \
  COMPANION_ID="$COMPANION_ID" \
  POSTGRES_DATABASE_URL="$LOCAL_POSTGRES_URL" \
  GATEWAY_SESSION_HMAC_KEY="$LOCAL_HMAC_KEY" \
  PSFN_BACKUP_ENCRYPTION_KEY="$LOCAL_BACKUP_KEY" \
  PSFN_SEED_CONFIG_DIR="$PWD/config" \
  PSFN_SMOKE_AGENT_AUTH_DIR="$LOCAL_AUTH_ROOT" \
  PSFN_SMOKE_MODEL_CACHE_ROOT="$LOCAL_MODEL_ROOT" \
  PSFN_RUNTIME_UID="$(id -u)" \
  PSFN_RUNTIME_GID="$(id -g)" \
  sh scripts/ops/psfn-compose-smoke-seed.sh

node --input-type=module - "$SYSTEM_DATA_DIR/settings.json" "$LOCAL_MODEL_ROOT/transformers" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const [settingsPath, cachePath] = process.argv.slice(2);
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
settings.transformersCacheDir = cachePath;
settings.textEmotionCacheDir = cachePath;
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE

PSFN_INJECTION_MODEL_DIR="$LOCAL_MODEL_ROOT/prompt-injection-v2" \
  npm run provision:injection-model
```

Start the disposable, body-discarding alert sink, then the gateway, then the
agent. The explicit outbound override is for this host-local development check:
it lets the agent fetch the two local models on first use. The agent command
still removes provider, raw HMAC, and inline persistence credentials from its
environment; model calls go through the gateway socket.

```bash
env \
  PSFN_SMOKE_OPERATOR_ALERT_HOST=127.0.0.1 \
  PSFN_SMOKE_OPERATOR_ALERT_PORT="$LOCAL_ALERT_PORT" \
  PSFN_SMOKE_OPERATOR_ALERT_TOPIC=local-split-alerts \
  node scripts/ops/psfn-compose-smoke-operator-alert-sink.mjs \
  >"$LOCAL_SPLIT_ROOT/logs/operator-alert-sink.log" 2>&1 &
ALERT_PID=$!

env \
  PSFN_RUNTIME_MODE=split \
  PSFN_RUNTIME_LAYOUT_MODE=production \
  PSFN_RUNTIME_ROOT="$LOCAL_RUNTIME_ROOT" \
  SYSTEM_DATA_DIR="$SYSTEM_DATA_DIR" \
  COMPANION_DATA_DIR="$COMPANION_DATA_DIR" \
  WORKSPACE_PATH="$WORKSPACE_PATH" \
  CHARACTER_CARD_PATH="$CHARACTER_CARD_PATH" \
  GATEWAY_SOCKET="$GATEWAY_SOCKET" \
  COMPANION_ID="$COMPANION_ID" \
  PSFN_LOGS_DIR="$LOCAL_SPLIT_ROOT/logs" \
  PSFN_TEMP_DIR="$LOCAL_SPLIT_ROOT/tmp" \
  BACKUP_ROOT_DIR="$LOCAL_SPLIT_ROOT/backups" \
  POSTGRES_DATABASE_URL="$LOCAL_POSTGRES_URL" \
  API_HOST=127.0.0.1 \
  API_PORT="$LOCAL_API_PORT" \
  API_KEY="$LOCAL_API_KEY" \
  GATEWAY_SESSION_HMAC_KEY="$LOCAL_HMAC_KEY" \
  PSFN_BACKUP_ENCRYPTION_KEY="$LOCAL_BACKUP_KEY" \
  OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  PSFN_INJECTION_MODEL_DIR="$LOCAL_MODEL_ROOT/prompt-injection-v2" \
  NTFY_BASE_URL="http://127.0.0.1:${LOCAL_ALERT_PORT}" \
  NTFY_TOPIC=local-split-alerts \
  npm run gateway >"$LOCAL_SPLIT_ROOT/logs/gateway.log" 2>&1 &
GATEWAY_PID=$!

(
  . "$LOCAL_AUTH_ROOT/agent-auth.env"
  env \
    -u OPENROUTER_API_KEY \
    -u POSTGRES_DATABASE_URL \
    -u GATEWAY_SESSION_HMAC_KEY \
    PSFN_RUNTIME_MODE=split \
    PSFN_RUNTIME_LAYOUT_MODE=production \
    PSFN_RUNTIME_ROOT="$LOCAL_RUNTIME_ROOT" \
    SYSTEM_DATA_DIR="$SYSTEM_DATA_DIR" \
    COMPANION_DATA_DIR="$COMPANION_DATA_DIR" \
    WORKSPACE_PATH="$WORKSPACE_PATH" \
    CHARACTER_CARD_PATH="$CHARACTER_CARD_PATH" \
    GATEWAY_SOCKET="$GATEWAY_SOCKET" \
    COMPANION_ID="$COMPANION_ID" \
    PSFN_LOGS_DIR="$LOCAL_SPLIT_ROOT/logs" \
    PSFN_TEMP_DIR="$LOCAL_SPLIT_ROOT/tmp" \
    BACKUP_ROOT_DIR="$LOCAL_SPLIT_ROOT/backups" \
    POSTGRES_DATABASE_URL_FILE="$LOCAL_AUTH_ROOT/postgres-database-url" \
    ALLOW_AGENT_OUTBOUND_NETWORK=true \
    NTFY_BASE_URL="http://127.0.0.1:${LOCAL_ALERT_PORT}" \
    NTFY_TOPIC=local-split-alerts \
    npm run agent
) >"$LOCAL_SPLIT_ROOT/logs/agent.log" 2>&1 &
AGENT_PID=$!
```

Wait for the real gateway health surface. This check requires the agent RPC,
Postgres memory, embeddings, scheduler, and configured LLM to be healthy. If it
times out, the last commands print only local logs; inspect them before teardown.

```bash
LOCAL_READY=0
for _attempt in $(seq 1 240); do
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null || ! kill -0 "$AGENT_PID" 2>/dev/null; then
    break
  fi
  curl -sS \
    --header "Authorization: Bearer $LOCAL_API_KEY" \
    "http://127.0.0.1:${LOCAL_API_PORT}/health" \
    >"$LOCAL_SPLIT_ROOT/health.json" 2>/dev/null || true
  if node --input-type=module - "$LOCAL_SPLIT_ROOT/health.json" <<'NODE'
import { readFileSync } from 'node:fs';
let health;
try { health = JSON.parse(readFileSync(process.argv[2], 'utf8')); } catch { process.exit(1); }
const required = ['memory', 'embeddings', 'scheduler', 'llm'];
process.exit(required.every((name) => health.subsystems?.[name]?.status === 'healthy') ? 0 : 1);
NODE
  then
    LOCAL_READY=1
    break
  fi
  sleep 2
done

if test "$LOCAL_READY" -ne 1; then
  tail -n 80 "$LOCAL_SPLIT_ROOT/logs/gateway.log" || true
  tail -n 80 "$LOCAL_SPLIT_ROOT/logs/agent.log" || true
  false
fi
```

Send one request through the public OpenAI-compatible edge, then prove its exact
user and assistant bodies occur in order in the canonical L0 journal selected
by that API principal and session. The verifier prints identifiers and row
positions, not credentials.

```bash
LOCAL_SESSION_ID=local-split-persistence
LOCAL_USER_MESSAGE='Reply with one short sentence confirming the local split is ready.'

curl --fail-with-body --silent --show-error --max-time 180 \
  --request POST \
  --url "http://127.0.0.1:${LOCAL_API_PORT}/v1/chat/completions" \
  --header "Authorization: Bearer $LOCAL_API_KEY" \
  --header 'Content-Type: application/json' \
  --header "X-Session-Id: $LOCAL_SESSION_ID" \
  --data "$(node -e 'console.log(JSON.stringify({model:"companion",messages:[{role:"user",content:process.argv[1]}],stream:false}))' "$LOCAL_USER_MESSAGE")" \
  --output "$LOCAL_SPLIT_ROOT/chat-response.json"

node --input-type=module - \
  "$COMPANION_DATA_DIR/state/sessions" \
  "$LOCAL_API_KEY" \
  "$LOCAL_SESSION_ID" \
  "$LOCAL_USER_MESSAGE" \
  "$LOCAL_SPLIT_ROOT/chat-response.json" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [sessionsDir, apiKey, sessionId, userContent, responsePath] = process.argv.slice(2);
const response = JSON.parse(readFileSync(responsePath, 'utf8'));
const assistantContent = response.choices?.[0]?.message?.content;
if (typeof assistantContent !== 'string' || assistantContent.trim() === '') {
  throw new Error('Chat response did not contain non-empty assistant content');
}
const principal = `api-key-${createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 24)}`;
const channelId = `api:${principal}:${sessionId}`;
const index = JSON.parse(readFileSync(join(sessionsDir, '_channel_index.json'), 'utf8'));
const filenames = index.channels?.[channelId]?.filenames;
if (!Array.isArray(filenames) || filenames.length === 0) {
  throw new Error(`Canonical L0 index has no files for ${channelId}`);
}
const rows = filenames.flatMap((filename) => readFileSync(join(sessionsDir, filename), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line)));
const userIndex = rows.findIndex((row) => row.type === 'message'
  && row.role === 'user' && row.content === userContent);
const assistantIndex = rows.findIndex((row, indexValue) => indexValue > userIndex
  && row.type === 'message' && row.role === 'assistant' && row.content === assistantContent);
if (userIndex < 0 || assistantIndex < 0) {
  throw new Error('Exact ordered user/assistant L0 pair was not persisted');
}
console.log(`PASS non-empty reply and exact canonical L0 pair: ${channelId} rows ${userIndex}/${assistantIndex}`);
NODE
```

Stop the three host processes and the disposable database. After inspecting any
logs you need, move only the guarded `mktemp` root created above to the desktop
trash so an accidental cleanup remains recoverable:

```bash
cleanup_local_split_processes
trap - EXIT INT TERM

case "$LOCAL_SPLIT_ROOT" in
  "${TMPDIR:-/tmp}"/psfn-local-split.*) gio trash "$LOCAL_SPLIT_ROOT" ;;
  *) printf 'Refusing to trash unexpected path: %s\n' "$LOCAL_SPLIT_ROOT" >&2; false ;;
esac
unset OPENROUTER_API_KEY LOCAL_API_KEY LOCAL_HMAC_KEY LOCAL_BACKUP_KEY LOCAL_PG_PASSWORD LOCAL_POSTGRES_URL
```

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

- **Node install reports `EBADENGINE`.** Select Node 24.19 or newer within the
  supported Node 24 range, then rerun `npm ci`; Node 22 is rejected.
- **The local pgvector container or API cannot bind.** The database uses a
  Docker-assigned loopback port. Change `LOCAL_API_PORT` or `LOCAL_ALERT_PORT`
  if 13000 or 13002 is already occupied, then restart the disposable procedure.
- **Startup reports a missing owner or `companions.json`.** Rerun the documented
  seed command with `PSFN_SEED_CONFIG_DIR="$PWD/config"`; do not copy a partial
  owner set by hand. Existing files are preserved, so use a fresh `mktemp` root
  if a previous attempt left incompatible state.
- **Startup requires an operator alert sink.** Start the documented local sink
  first and give both gateway and agent the same `NTFY_BASE_URL` and
  `NTFY_TOPIC`. Do not disable CogSec's required-alert posture to make startup
  pass.
- **Startup says the injection model is not provisioned.** Run
  `PSFN_INJECTION_MODEL_DIR="$LOCAL_MODEL_ROOT/prompt-injection-v2" npm run
  provision:injection-model`, then use that same absolute path for the gateway.
- **The agent rejects an inline database URL or missing session-integrity
  proof.** Do not export `POSTGRES_DATABASE_URL` to the agent. Rerun the seeder
  with the generated HMAC and database URL, source `agent-auth.env`, and pass
  only `POSTGRES_DATABASE_URL_FILE` to the agent as shown above.
- **The agent fails its network-isolation guard or cannot download local
  models.** For this host-local disposable procedure only, retain
  `ALLOW_AGENT_OUTBOUND_NETWORK=true` on the agent. Use Compose for the
  externally isolated smoke topology.
- **The LLM health check or chat request reports OpenRouter authentication,
  quota, credit, or model availability failure.** Re-enter a current
  `OPENROUTER_API_KEY`, verify account credit and access to the model selected by
  `models.json`, then restart the gateway. Never add the key to an owner file.
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
