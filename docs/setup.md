# Setup

PSFN boots through the split runtime. The legacy `src/app/startup/index.ts` entrypoint is disabled and exits fail-closed; use `npm run split` for the full gateway + agent + operator stack, or launch `npm run gateway`, `npm run agent`, and `npm run operator` individually.

Before upgrading any Helm cluster, read the canonical
[Helm Cluster Upgrade Guide](./helm-upgrades.md). It carries rollout-order
constraints, owner migrations, image import, Cluster Auth validation, and
recovery boundaries. It is the required procedure; this setup guide remains
the authority for initial configuration and ownership.

## Which path to take

There are two supported ways to stand PSFN up, plus one forthcoming guided one:

- **Docker Compose smoke stack (start here).** The newcomer on-ramp: one
  command from a clean checkout brings up the real split runtime — Postgres,
  the secret-holding gateway, and one isolated agent — and drives one chat turn.
  It self-seeds every owner file and a starter companion card, so you supply
  only one provider key. See [Fastest path](#fastest-path-the-docker-compose-smoke-stack).
- **Manual local split runtime (development).** You provision Postgres, lay the
  owner files by hand, and launch `npm run split`. More moving parts, full
  control. See [First Local Bring-Up](#first-local-bring-up).
- **Kubernetes / Helm (experienced operators).** The reference deployment shape
  (network-mode mTLS RPC, cert-manager, per-companion tenancy). This guide and
  [`docs/operations.md`](./operations.md) plus [`docs/helm-upgrades.md`](./helm-upgrades.md)
  cover it; it is not the newcomer on-ramp.

An interactive onboarding script, `npm run onboard`, walks you through the
setup questions in order: install mode (Compose, Kubernetes, or local dev),
provider and model choice, optional voice, an optional connectivity check, and
importing a companion — a SillyTavern-style Character Card (V2/V3 as
`.json`/`.png`/`.charx`), a SoulMD document, a plain persona markdown file from
OpenClaw/Hermes, or a fresh start. It generates the canonical JSON owner files
for your chosen mode, validates them against the same settings contract startup
enforces, and writes your secrets to `.env` — nothing is written until the
final confirm, so it is always safe to abort and start over. If you are not
sure where to begin, begin there:

```bash
npm install        # the onboarding script runs from the repo's dev install
npm run onboard
```

## Deployment done: the public on-ramp definition

This is the ratified bar for "a newcomer can deploy PSFN" (bead
`psfn-framework-65rk.14`). Deployment is **done** when, from a fresh clone, **one
documented command** brings up the split runtime (gateway + agent + Postgres)
and drives **one chat turn** end to end through the OpenAI-compatible `/v1` edge,
with the assistant reply persisted to Postgres — and the fail-closed laws hold in
that reference install (Postgres-only, no SQLite; distinct non-overlapping
system-data/companion-data roots; the agent on an internal-only network with no
egress; the gateway as the sole secret holder).

The command that meets this bar today is `npm run smoke:docker`
(`scripts/smoke-docker.mjs`) over `docker/docker-compose.smoke.yml`. Pass
criteria:

- **Command:** `export OPENROUTER_API_KEY=sk-or-...` then `npm run smoke:docker`.
- **Expected exit `0` — done:** the harness brought the stack up healthy,
  confirmed the gateway↔agent RPC and the `memory`/`embeddings`/`scheduler`
  plumbing via the gateway `/health` endpoint, POSTed one turn to
  `/v1/chat/completions`, and got a persisted assistant reply.
- **Proof artifact:** the log lines
  `[smoke:docker] PASS  full turn: assistant reply persisted and returned: …`
  followed by `[smoke:docker] PASS  Postgres persistence corroborated (public tables: N)`.
- **Exit `2` — provider boundary (not fully done, but everything up to the model
  call proven):** stack healthy, RPC connected, request accepted, the turn
  failed only at the external provider egress. This is the expected result when
  no `OPENROUTER_API_KEY` is set. A keyed exit-`0` run is the live-validation
  step of the definition.
- **Exit `1` — plumbing failure (not done):** the stack did not come up, the
  gateway edge never became healthy, or the request failed before the provider.

The Kubernetes/Helm path is the **experienced-operator equivalent**, not the
newcomer on-ramp: ship the chart at `deploy/helm/psfn` with `npm run ship:kube`
(`scripts/ops/ship-kube-update.sh`) and gate the rollout with
`bash scripts/ops/validate-kube-rollout.sh --smoke` (rollout status for
agent/gateway/garden, Garden health, the `/v1/models` companion route, and a
two-turn chat smoke); `npm run verify:kube-rollout` runs the same validator
without `--smoke`. See the [Kube lane](./shakedown.md#kube-lane).

## Fastest path: the Docker Compose smoke stack

Prerequisites: Docker and Docker Compose, plus Node 24 LTS (24.19.0 or newer 24.x) to invoke the harness
(`scripts/smoke-docker.mjs` uses only Node built-ins and the Docker CLI — no
`npm install` is required). First run needs internet: the image build and a
one-shot model-prefetch service download the in-process ML models (~hundreds of
MB) into a shared cache while they still have egress, so the isolated agent can
warm them offline.

```bash
git clone <repo-url> && cd psfn-framework
export OPENROUTER_API_KEY=sk-or-...   # the single real secret a full turn needs
npm run smoke:docker                  # up + one chat turn; exit 0 = persisted reply
# equivalently, with no install: node scripts/smoke-docker.mjs
```

What the one command does (`scripts/smoke-docker.mjs` +
`docker/docker-compose.smoke.yml`):

1. Builds the runtime image and runs a one-shot `seed` service that lays the
   split-root owner files into distinct `system-data` and `companion-data`
   volumes, writes a starter companion card and a one-entry `companions.json`,
   and derives the agent's two role-bound gateway proofs from the session HMAC
   key (the agent never receives the raw key).
2. Brings up Postgres (pgvector), the gateway, and the isolated agent with
   `docker compose up -d --wait`.
3. Asserts every container is healthy, confirms the gateway↔agent RPC and the
   plumbing subsystems via `/health`, then POSTs one turn to
   `/v1/chat/completions` and asserts a persisted assistant reply.

Without a key the whole stack still comes up healthy and the harness exits `2`
at the provider boundary (see the definition above). By default it tears the
stack down (`docker compose down -v`) on exit; pass `--keep-up` to inspect it or
`--no-up` to run against an already-running stack. Dev-only fixed
secrets/identity and the published port are overridable via `PSFN_SMOKE_API_KEY`,
`PSFN_SMOKE_COMPANION_ID`, `PSFN_SMOKE_SESSION_HMAC_KEY`, `PSFN_SMOKE_BACKUP_KEY`,
and `PSFN_SMOKE_API_PORT`. The full lane writeup is in
[`docs/shakedown.md`](./shakedown.md#docker-compose-smoke-lane).

### Your first conversation

An exit-`0` smoke run proves the plumbing with one turn and then tears the
stack down. To actually sit down and talk, keep it up:

```bash
export OPENROUTER_API_KEY=sk-or-...
npm run smoke:docker -- --keep-up
```

The stack stays running with the gateway's OpenAI-compatible edge published on
`http://127.0.0.1:13000` (override with `PSFN_SMOKE_API_PORT`). Any
OpenAI-compatible chat client can point at it; the dev API key is
`psfn-smoke-api-key-please-rotate` unless you overrode `PSFN_SMOKE_API_KEY`.
From the terminal:

```bash
curl -s http://127.0.0.1:13000/v1/chat/completions \
  -H "Authorization: Bearer psfn-smoke-api-key-please-rotate" \
  -H "Content-Type: application/json" \
  -d '{"model": "companion", "messages": [{"role": "user", "content": "Hi — first day. What should I call you?"}]}'
```

Conversation state persists across turns and restarts: the reply you get is a
turn in a real session archived to the companion-data volume and mirrored to
Postgres, not a stateless completion. When you are done exploring, take the
stack down with
`docker compose -f docker/docker-compose.smoke.yml down` (add `-v` to also
discard the data volumes and start completely fresh next time).

The smoke stack boots a starter companion. When you want your own — an
existing card, a soul document, or a persona you have been carrying between
frameworks — run `npm run onboard` and choose the import step; it previews
exactly what it parsed and writes nothing until you confirm.

### Why the runtime is split (and fail-closed)

The Compose stack is not a convenience wrapper around a monolith — it is the real
topology. The **gateway** is the host-side, privileged process: it holds every
secret (provider key, session HMAC key, backup key), owns all external egress,
and serves the OpenAI-compatible `/v1` edge. The **agent** is the companion's
isolated Core: no dotenv, no provider/egress secrets, on an internal-only network
that fails closed if it can reach the internet, reaching the gateway only over a
shared Unix socket. This is the same trust boundary the Kubernetes deployment
enforces with a NetworkPolicy and mTLS RPC.

Persistence is **two-root and fail-closed**: `system-data` (system-owned config
and operator/runtime state) and `companion-data` (character, prompts, sessions,
notes, memories) are distinct volumes that can never overlap — production layout
rejects overlapping mutable roots. The runtime store is **Postgres-only**
(`src/persistence/runtime-factory.ts`); there is no SQLite runtime path. See
[`docs/architecture.md`](./architecture.md) and
[`docs/specifications.md`](./specifications.md) for the full contracts.

### Config ownership in one paragraph

`.env` is for **secrets and wiring only** — provider keys, host/port/socket, the
runtime mode/layout, and explicit bootstrap overrides. Every **mutable runtime
setting** lives in a canonical JSON owner file under the system-owned config
domain (`settings.json`, `models.json`, `providers.json`, and the rest — listed
under [What Goes In JSON Owner Files](#what-goes-in-json-owner-files)).
`.env.example` is a **bootstrap template only and is never the authority** for
mutable settings; the runtime ignores mutable settings placed in `.env`. The
Compose seed writes all the owner files for you; the manual path below lays them
by hand.

## Prerequisites

- Node.js 24 LTS (24.19.0 or newer 24.x)
- PostgreSQL 16+ with the `pgvector` extension. The repo-owned runtime is Postgres-only for memories, episodes, contacts, concerns, intentions, internal state, and searchable projections.
- One provider secret for the model/provider owner file you plan to use. The shipped examples include OpenRouter, so using those examples usually means `OPENROUTER_API_KEY`.
- Optional channel/service secrets only for the surfaces you enable:
  - `DISCORD_TOKEN` and `DISCORD_BOT_ID`
  - `TELEGRAM_BOT_TOKEN`
  - `API_KEY`
  - `ADMIN_TOKEN`
  - `DEEPGRAM_API_KEY`
  - `ELEVENLABS_API_KEY`
  - `API_SATELLITE_KEYS` — comma-separated per-satellite bearer keys (each >=16 chars); each key yields a distinct satellite-scoped principal that `satellites.json` endpoints must list in `auth.apiKeyPrincipalIds`. Only needed when running satellites; leave unset otherwise.
- Required deployment identity wiring:
  - `COMPANION_ID`

## Install

```bash
git clone <repo-url>
cd psfn-framework
npm install
cp .env.example .env
```

The root install also provisions `admin-ui/`.
Default installs skip `onnxruntime-node`'s CUDA side-download and use the bundled CPU runtime. Set `ONNXRUNTIME_NODE_INSTALL_CUDA=v12` for an intentional ONNX Runtime CUDA binary install.

## What Goes In `.env`

Keep `.env` limited to:

- Secrets
- Host, port, and socket wiring
- Runtime mode and persistence layout wiring
- Personal files workspace wiring (`WORKSPACE_PATH`)
- Explicit bootstrap overrides such as `CHARACTER_CARD_PATH`
- Explicit deployment identity such as `COMPANION_ID`

The runtime ignores mutable settings that are owned by JSON files. Do not use `.env` for embeddings, model roster, scheduler cadence, capability tier, channel policy, skills, charge/fatigue policy, or trust policy.

## What Goes In JSON Owner Files

Mutable runtime/admin configuration lives in canonical JSON owner files.

Cluster-global owner files live under `SYSTEM_DATA_DIR`. Startup fails closed on
the first missing one — the required set is verified in
`src/system/config/startup-owner-files.ts` (`systemOwnerFileChecks`):

- `settings.json`
- `models.json`
- `providers.json`
- `trust-policy.json`
- `backup.json`
- `companions.json` — the mandatory fleet manifest; required for every
  deployment, including a cluster of one (see [Cluster topology](#cluster-topology)).
- `intake-policy.json`
- `mcp-servers.json` — external MCP client catalog, trust factors, per-tool
  policy, and credential references. The shipped seed enables no servers.
- `partner-affect-shadow.json`
- `fleet-auth.json` — conditional: required only when cluster human-auth is
  enabled, and must be **absent** otherwise (`PSFN_FLEET_AUTH`; see
  [Optional Surface Wiring](#cluster-authenticated-browser-origin)).
- `subagent-roles.json` (optional; absent ⇒ no subagent roles configured. Defines named subagent role profiles — researcher, reviewer, implementer, awaiter, observer — layered over inherited companion identity. A malformed file fails closed at load.)

`channels.json` is also system-owned but is **not** a fail-closed startup owner:
it has no seed file, loads safe defaults when absent, and is created or updated
when channel settings are saved through Garden or the admin API.

Four whole owner files live under each companion's `COMPANION_DATA_DIR`
(`companionOwnerFileChecks` in the same module); startup never reads a
system-root copy as a fallback:

- `scheduler.json`
- `capability-tier.json`
- `charge-policy.json`
- `skills.json`

In a local shared-root layout, system-data and companion-data resolve to the
same directory, so the ownership distinction does not change the path.
Production split-root and Helm deployments must place all four per-companion
files under `COMPANION_DATA_DIR`; startup does not fall back to system-root
copies.

Startup verifies the seed-backed owner files before the split runtime comes up. Distributed `config/*.seed.json` files are examples/templates only; PSFN does not silently copy them into runtime state.

`channels.json` has no seed file. Channel config loads safe defaults when it is absent and is created or updated when channel settings are saved through Garden or the admin API.

### Configure external MCP servers

PSFN is an MCP host/client. It does not expose companion internals as an MCP
server. The native client accepts remote Streamable HTTP only over verified
HTTPS/TLS; local subprocess (`stdio`), plain HTTP, and legacy SSE endpoints are
not supported. Public-CA endpoints need no `tls` field. Private-CA endpoints
name a gateway-held PEM secret through `tls.caCertificateRef`.

Start from `config/mcp-servers.seed.json`, then add one explicit server entry.
This loopback knowledge-base example is deliberately high-trust because the
operator owns the server, its data, and every input path:

```json
{
  "schemaVersion": 1,
  "limits": {
    "connectTimeoutMs": 10000,
    "requestTimeoutMs": 30000,
    "idleConnectionTtlMs": 300000,
    "metadataCacheTtlMs": 300000,
    "maxCatalogToolsPerServer": 256,
    "maxPaginationPages": 32,
    "maxStaticMetadataBytes": 1048576,
    "maxDynamicOutputBytes": 4194304
  },
  "servers": [
    {
      "id": "private-notes",
      "displayName": "Private notes",
      "enabled": true,
      "description": "Search and update the operator-owned knowledge base.",
      "endpoint": "https://127.0.0.1:9443/mcp",
      "tls": {
        "caCertificateRef": { "kind": "env", "envName": "MCP_NOTES_CA_PEM" }
      },
      "allowedCompanionIds": ["11111111-1111-4111-8111-111111111111"],
      "authentication": {
        "kind": "bearer",
        "tokenRef": { "kind": "env", "envName": "MCP_NOTES_TOKEN" }
      },
      "trust": {
        "level": "primary",
        "factors": {
          "hosting": "loopback",
          "dataOwnership": "operator_private",
          "inputExposure": "closed"
        },
        "allowedOutboundSensitivity": ["public", "personal", "intimate", "confidential"]
      },
      "toolPolicy": {
        "default": "deny",
        "tools": {
          "search_notes": {
            "effect": "read",
            "confirmation": "never",
            "maxOutboundSensitivity": "confidential",
            "metadataSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "write_note": {
            "effect": "write",
            "confirmation": "sensitive",
            "maxOutboundSensitivity": "confidential",
            "metadataSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          }
        }
      }
    }
  ]
}
```

Put `MCP_NOTES_TOKEN` and the complete PEM value for `MCP_NOTES_CA_PEM` in the
gateway secret environment or its configured credential vault. Never put the
secret value, URL userinfo, or an authorization header in `mcp-servers.json`.
Supported authentication modes are bearer, a named API-key header, and OAuth
client credentials with an exact expected issuer. Every URL is HTTPS, OAuth
token and issuer origins must match, redirects are rejected, and resolved
addresses are checked against the server's hosting declaration.

Trust is constrained by facts rather than being a free-form bypass. The
configured level cannot exceed the least-trusted factor in this matrix:

| Factor | `primary` ceiling | `trusted` ceiling | `regular` ceiling | `public` ceiling |
| --- | --- | --- | --- | --- |
| Hosting | `loopback` | `private_network`, `remote_dedicated` | `remote_shared` | — |
| Data ownership | `operator_private` | `operator_work` | `mixed` | `third_party` |
| Input exposure | `closed` | `operator_authenticated` | `multi_party` | `public_untrusted` |

The level's default outbound ceiling is `public` for public servers,
`public|personal` for regular/trusted servers, and every sensitivity for
primary servers. `allowedOutboundSensitivity` may narrow that ceiling but
cannot widen it. Every tool must narrow it again with
`maxOutboundSensitivity`. This is why an operator-owned closed journal can be primary,
while email with multi-party input cannot be—even when the mailbox and MCP
process are local.

At call time PSFN compares those ceilings with the sensitivity of the context
that actually produced the tool call. That classification is derived by the
turn runtime from admitted session, memory, wiki, and tool-result sources and
is bound by the gateway into the exact single-use invocation permit. A public
turn can therefore use a public-only game or calendar tool, while a turn that
has admitted confidential context cannot silently downgrade itself to do so.
Screened search and inspection metadata preserves that classification; a
remote call result or any other admitted tool output tightens subsequent calls
to confidential. Missing lineage and autonomous/shard model runs receive no
MCP call permit.

Tool authorization is also bound to the exact CogSec-screened definition.
Start a new tool entry without `metadataSha256`, run a lazy MCP search, and copy
the tool's `observedMetadataSha256` from Tools health into the owner file only
after reviewing its screened description and input schema. (The repeated
`a`/`b` digests above are placeholders.) An absent or mismatched digest keeps
the tool out of search and denies inspect/call. A same-name tool whose schema or
description changes therefore becomes unclassified until the operator reviews
and updates the digest.

Typical profiles:

- A loopback personal journal or closed operator-owned knowledge base can be
  `primary`; allow its known read/write tools and gate only the effects or
  sensitivities the operator wants to review.
- An operator calendar with authenticated inputs can be at most `trusted`;
  allow ordinary reads/writes, deny send/invite tools unless explicitly needed,
  and narrow outbound sensitivity to `public|personal`.
- Email is `public` when arbitrary senders can supply content, even if the
  mailbox connector runs locally. Allowlist reads and leave send/reply absent
  from `toolPolicy.tools`.
- A third-party game with public inputs is `public`; expose only the minimum
  play-state tools, send public data only, and keep control effects always
  confirmed. It gets no path to companion-private context.

Tool policy is separately allowlisted. Unknown tools always deny; destructive
and control tools must use `confirmation: "always"`; `confirmation:
"sensitive"` asks only when intimate/confidential content is leaving PSFN.
The companion needs the `external.mcp` capability to call a tool (included in
the apprentice and autonomous tiers); catalog/search/inspect/release use the
ordinary `identity.read` capability.

Garden exposes the canonical file at **Settings → Owner files** and validates
the whole candidate before saving. A restart is required after editing it.
The **Tools → Health** panel then shows content-free connection state, policy,
and the last screened metadata hash; it never displays credentials, endpoint
details, descriptions, schemas, or outputs.

## First Local Bring-Up

1. Set the minimum bootstrap values in `.env`:

   ```dotenv
   OPENROUTER_API_KEY=...
   COMPANION_ID=11111111-1111-4111-8111-111111111111
   DATA_DIR=./data
   WORKSPACE_PATH=./purrsephone
   CHARACTER_CARD_PATH=./data/companion.json
   POSTGRES_DATABASE_URL=postgresql://psfn:password@127.0.0.1:5432/psfn
   PSFN_BACKUP_ENCRYPTION_KEY=<long random secret>
   ```

2. Intentionally copy the example owner files into their canonical owner roots
   and edit them for this deployment. This shared-root local example uses
   `./data` for both roots. This list is the complete fail-closed startup set
   from `src/system/config/startup-owner-files.ts`; a missing one aborts
   startup:

   ```bash
   cp config/settings.seed.json ./data/settings.json
   cp config/models.seed.json ./data/models.json
   cp config/providers.seed.json ./data/providers.json
   cp config/scheduler.seed.json ./data/scheduler.json
   cp config/capability-tier.seed.json ./data/capability-tier.json
   cp config/trust-policy.seed.json ./data/trust-policy.json
   cp config/intake-policy.seed.json ./data/intake-policy.json
   cp config/mcp-servers.seed.json ./data/mcp-servers.json
   cp config/charge-policy.seed.json ./data/charge-policy.json
   cp config/backup.seed.json ./data/backup.json
   cp config/skills.seed.json ./data/skills.json
   cp config/partner-affect-shadow.seed.json ./data/partner-affect-shadow.json
   # Optional: named subagent role profiles (absent ⇒ no roles configured).
   cp config/subagent-roles.seed.json ./data/subagent-roles.json
   ```

   Then provide the mandatory fleet manifest. `config/companions.seed.json` ships
   a **two-entry example** (Flagship + Aria); reduce it to a **one-entry**
   manifest naming this deployment's `COMPANION_ID` and edit the
   `companionDataDir`, `characterCardPath`, `postgresSchema`, `postgresRole`, and
   `postgresDatabaseUrlRef` for your layout — startup does not reconstruct the
   entry from `COMPANION_ID`. The full field contract is in
   [Cluster topology](#cluster-topology).

   ```bash
   cp config/companions.seed.json ./data/companions.json
   # then edit ./data/companions.json down to your single companion entry
   ```

   Do **not** seed `fleet-auth.json` for a local single-companion bring-up: leave
   it absent and keep `PSFN_FLEET_AUTH` unset. `channels.json` is created on
   demand and needs no seed.

   For production split roots, place the outputs from
   `scheduler.seed.json`, `capability-tier.seed.json`,
   `charge-policy.seed.json`, and `skills.seed.json` under
   `COMPANION_DATA_DIR`; place every other owner file shown above under
   `SYSTEM_DATA_DIR`. In cluster mode, provision those four files separately for
   every companion root. Startup rejects a missing per-companion owner and
   never reads a system-root copy as a fallback.

   For existing Helm releases, the chart's guarded automatic cutover covers
   only `scheduler.json` and `capability-tier.json`, followed by scheduler
   schema migration; see
   [`deploy/helm/psfn/README.md`](../deploy/helm/psfn/README.md#upgrading-releases-created-before-per-companion-owner-routing).
   Existing multi-companion split clusters with registered per-companion owners
   under `SYSTEM_DATA_DIR` must instead use the digest-approved,
   receipt-bearing workflow in
   [`docs/operations.md`](./operations.md#existing-split-clusters-with-shared-per-companion-owners).

   Provider prompt caching on the byte-stable system-prompt prefix is on by default (Anthropic / OpenRouter→Anthropic get `cache_control` breakpoints; other providers get the stable-prefix benefit plus telemetry, no wire change). The `models.seed.json` template ships `promptCaching.enabled: true` for new deployments, and the registry normalizer treats an **absent** `promptCaching` key as enabled, so a `models.json` written before caching shipped picks it up without hand-editing — the seed never rewrites an existing owner file. Set `promptCaching.enabled: false` in `models.json` to fully disable it; an explicit `false` is always honored over the default. Tune lifetime with `promptCaching.retention` (`none`/`short`/`long`, default `short`) and the session key with `promptCaching.scope` (`channel`/`request`, default `channel`). The default only fills in `enabled`, so retention/scope fall through to `short`/`channel` — never to `retention: none`, which disables caching.

3. Provision the intake firewall's L1.5 prompt-injection classifier model (optional but recommended; ~704 MiB, gitignored, never downloaded at runtime):

   ```bash
   npm run provision:injection-model -- --dest ./models/prompt-injection-v2
   ```

   Without it the gateway skips L1.5 scoring with a loud startup warning and screens on the deterministic L1 layer alone; a present-but-broken model directory fails startup closed. Override the location with `PSFN_INJECTION_MODEL_DIR`. The `intake-policy.json` owner file copied above controls the firewall mode (`off`/`shadow`/`enforce`; the seed ships `shadow`) — see [`docs/cognitive-security.md`](./cognitive-security.md).

4. Provide the explicit character card at `CHARACTER_CARD_PATH`. Startup fails if the configured identity file is missing. Keep this active identity file under runtime data, not under the personal writable workspace.

5. Keep the backup encryption key secret in `.env` or your deployment secret manager. `backup.json` should contain only the env key reference. Generate a local key with `openssl rand -base64 48`.

6. Start the split runtime (gateway + agent + operator):

   ```bash
   npm run split
   ```

   The launcher loads `.env` for gateway/operator processes, then starts the agent with a curated non-secret environment allowlist. Provider credentials, API keys, and admin tokens stay gateway/operator-owned.

7. If you want the integrated Garden SPA served by the admin host, build it once:

   ```bash
   npm run garden:build
   ```

8. If you want the standalone Garden dev server instead:

   ```bash
   npm run garden:dev
   ```

## Runtime Modes

### Continuous / local

- Default mode when `PSFN_RUNTIME_LAYOUT_MODE` is unset.
- Uses the legacy shared root (`DATA_DIR`, default `./data`) for both system and companion data.
- Uses `WORKSPACE_PATH` as one companion's Personal Workspace for documents,
  downloads, generated images, personal journal/scratchpad files,
  knowledge-base notes, authored skills, modules, and experiments. It is not a
  runtime-state root or a general shared-files root. In the live Purrsephone
  deployment this is repo-root `./purrsephone`.
- Good for local development and smoke testing.
- This shared-root support is an alpha migration boundary item that survives only until beta. Do not build new setup or runtime behavior that depends on shared-root fallback.

### Production / split roots

- Set `PSFN_RUNTIME_LAYOUT_MODE=production`.
- Set both `SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR`, or neither.
- Production layout defaults under `./runtime/production/` if explicit dirs are not provided.
- Shared `DATA_DIR` is forbidden in production mode.

Production does not fall back to local/continuous layout. Partial split-root config, overlapping roots, malformed owner files, and mutable settings in `.env` should be fixed directly rather than papered over with compatibility paths.

### Cluster topology

Every deployment is a cluster. A deployment with one companion has a one-entry
`companions.json`; adding another companion adds another entry without changing
the launcher, authentication, Garden, or upgrade model. The process wiring is
documented in full in
[`docs/multi-companion.md`](./multi-companion.md) and
[`docs/operations.md`](./operations.md):

- `companions.json` — the mandatory system-owned cluster manifest. Every
  deployment is a cluster of one or more companions, so this owner file is always
  required (a cluster of one has one entry); a missing or invalid manifest fails
  closed at startup. Entry count determines only whether cross-companion
  tenancy is possible; it never selects a separate deployment path.
- `PSFN_FLEET_AUTH` — launcher wiring assertion. The one cluster Garden accepts
  companion-bound Cluster Auth capabilities; the launcher rejects a cluster
  topology that would fall back
  to standalone admin-token authority. Runtime enablement itself is decided solely
  by the presence of the system-owned `fleet-auth.json`: when that file is
  present, cluster auth is enabled and the flag cannot disable it (setting it to
  `0` only produces a loud startup warning); when the file is absent and the
  flag is set to `1`, startup refuses (fail closed) rather than starting
  without authentication.
  Cluster Auth is required for the cluster Garden even when the cluster contains one
  companion. The system-owned `companions.json` entry supplies a
  lowercase RFC-4122 UUID `companionId`, manifest-relative `companionDataDir`
  and `characterCardPath`, and a lowercase Postgres schema. Startup does not
  reconstruct this entry from `COMPANION_ID`. If the manifest is absent, it
  fails with the exact error:

  ```text
  Fleet authentication requires companions.json; deployments with one companion must provide a one-entry fleet manifest
  ```
- `COMPANION_PG_SCHEMA` — per-companion Postgres schema for one agent process.
  The cluster launcher sets it from the matching manifest entry.
- `companions.json` also owns the distinct `postgresRole` and
  `postgresDatabaseUrlRef` for each companion plus the root shared-migration
  role/reference. Put the referenced secret values in the configured credential
  vault. The gateway resolves them, runs shared DDL through the dedicated role,
  and gives each agent only its matching URL through an inherited descriptor.
  The gateway's shared-schema provisioning requires the `pgvector` extension
  installed in the `extensions` schema, so a multi-companion deployment must
  provision it before first launch even when no companion uses the shared-world
  wiki — the shared chain references the `vector` type and gateway startup fails
  closed without it.
- `PSFN_RUNTIME_ROOT` — canonical persistence root for manifest-relative
  `companionDataDir` and `characterCardPath`. The cluster resolver emits absolute
  paths beneath this root and rejects traversal or symlink escapes.
- `ADMIN_PORT` — the one cluster-level Garden listener port. It is process
  wiring, not a per-companion manifest field. A `gardenPort` key remaining in
  any `companions.json` entry is rejected as retired.
- `POSTGRES_DATABASE_URL` — the deployment database credential retained by the
  cluster Garden for approved direct model-usage and observer-eval telemetry.
  The immutable authenticated request target selects a companion-bound service
  instance before those routes query the database.
- `/fleet` — the authenticated cluster overview inside the same Garden frontend.
  It uses `/v1/fleet/portal` for the current principal's bounded authorized
  projection. There is no separate raw cluster-status listener or
  `FLEET_STATUS_*` wiring.
- Per-companion Discord tokens are referenced by env-var name from
  `channels.json` (`tokenRef.envName`), not inline. Add each companion's bot
  token to `.env` under the env var name its account references (for example
  `DISCORD_TOKEN_ARIA`); the token secret stays gateway-owned.

The Helm chart uses this topology exclusively: `fleet.enabled=true` renders
one shared gateway, one shared cluster Garden, and one UUID-addressed agent,
admin Service, and certificate pair per `fleet.companions` entry. The first
entry is canonical. `runtime.companionId`, `runtime.companionDataDir`,
`runtime.characterCardPath`, `runtime.workspacePath`, and the primary
companion/workspace claims must all name that first entry; chart rendering
fails closed when the tuple diverges.

Before converting an existing primary, follow
[Formalize an existing primary as a cluster tenant](./helm-upgrades.md#formalize-an-existing-primary-as-a-cluster-tenant).
Preserve its existing PVCs, add the matching one-entry `companions.json` and
`fleet-auth.json`, and reconcile Helm values before the first upgrade. Do not
retain a non-cluster launcher path and do not move durable data into empty claims
just to obtain canonical-looking paths.

The standard launcher derives and injects role-bound gateway authentication
proofs for every cluster agent so the isolated session-integrity worker never
shares the normal agent role. A direct `npm run agent` launch must provide the
exact cluster tuple, `GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN`, and
`GATEWAY_COMPANION_AUTH_TOKEN`.

If an existing split cluster still has any registered per-companion owner under
`SYSTEM_DATA_DIR`—including `scheduler.json`, `capability-tier.json`,
`charge-policy.json`, or `skills.json`—do not copy the shared system file into
one companion by hand and do not point `migrate:persistence-layout` at
`SYSTEM_DATA_DIR`. Stop the cluster and use the digest-approved,
receipt-bearing `npm run migrate:system-owner-fleet` workflow documented in
[`docs/operations.md`](./operations.md#existing-split-clusters-with-shared-per-companion-owners).
Before apply, mount every exact manifest root and run
`npm run snapshot:system-owner-fleet -- --output <backup-family-dir>`; a missing
root is a hard preflight failure and is never created by migration. Rehearse an
old-release rollback only into fresh empty PVC roots with
`npm run restore:system-owner-fleet-snapshot -- --manifest <family-manifest> --restore-runtime-root <fresh-root>`.
It enumerates every configured companion and retires the shared source only
after every exact-byte destination verifies, by moving the approved inode into
the durable receipt-owned quarantine. Its bootstrap receipt owns unpredictable
quarantine, staging, and copy identifiers before those objects are created, and
retries preserve rather than delete unbound or replaced crash remnants. Do not
remove the quarantine or retained staging artifacts manually; they are part of
deterministic receipt verification and retry.

For a cluster Helm upgrade, run that command once from the repo-owned
maintenance environment with all manifest PVC roots mounted, then require
`npm run preflight:startup-owner-files` to pass before upgrading any individual
release. Keep `bootstrap.seedOwnerFiles=false` throughout the upgrade. Rolling
back to a pre-routing release requires restoring the verified pre-migration
backup of system-data and every companion-data root together, never copying a
quarantined shared owner into selected companions.

### Cluster workspaces

Do not set per-companion workspace paths in `companions.json`. The cluster
resolver derives `<runtime-root>/workspaces/personal/<companion-uuid>` and the
single `<runtime-root>/workspaces/shared` root, validates containment and
non-overlap, and provisions them before launch. Each agent receives only its
matching personal root as `WORKSPACE_PATH`; the one cluster Garden selects an
agent through the immutable companion target registry instead of receiving N
personal roots. The shared root is available through its authenticated,
reviewed Garden surface and has no
environment-variable escape hatch. See
[`docs/multi-companion.md`](./multi-companion.md#workspace-scopes-runtime-contract).

The Helm deployment reads the isolated-worker proof from the application
Secret key named by `secrets.keys.gatewaySessionIntegrityAuthToken` (default
`GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN`). Derive it for the configured
`COMPANION_ID` with the same gateway HMAC keyring used by the gateway, and
provision it without logging the token. It is a distinct role-bound proof, not
the raw `GATEWAY_SESSION_HMAC_KEY` and not the normal companion-agent proof.
The agent derives a separate Garden audit opaque-ID key from this proof with a
domain-separated one-way transform. Rotating the worker proof changes the
opaque IDs returned by Garden but does not alter or discard the audit records.

## Common Launch Commands

```bash
npm run split        # gateway + agent + operator launcher
npm run yolo         # split runtime with broader fs.read policy
npm run gateway      # gateway only
npm run agent        # agent only (companion loop + private admin transport)
npm run operator     # Garden operator surface only
npm run agent:docker          # Production profile (network_mode: "none")
npm run agent:docker:continuous # Continuous/dev profile (isolated internal network)
```

## Optional Surface Wiring

### Cluster-authenticated browser origin

When the system-owned `fleet-auth.json` is present (file presence is the
single source of truth for cluster-auth enablement), do not publish
`ADMIN_HOST`/`ADMIN_PORT` as a browser endpoint. Terminate HTTPS at
the exact `canonicalOrigin`, route the full origin to the gateway API listener,
and open `/fleet`. This is the authenticated bounded overview in the Garden
bundle. A direct TLS listener must receive no forwarding headers. A single
reverse proxy requires
`FLEET_SSO_TRUST_PROXY=true`, exact forwarded
host/proto metadata, and an independent network restriction that admits only
that proxy. Non-loopback gateway-to-Garden traffic must configure the complete
`FLEET_SSO_GARDEN_TLS_*` mTLS tuple; partial configuration fails startup.
For Helm cluster mode, keep `networkPolicy.enabled=true`,
`hostPorts.gatewayApi.enabled=false`, `ingress.gateway.path=/`, and
`ingress.gateway.pathType=Prefix`; the chart rejects cluster auth if any of these
sole-origin requirements is weakened.

Treat that Gateway Ingress as durable infrastructure. A production browser
edge must not depend on a repeating `kubectl port-forward`: pod replacement
breaks the tunnel and surfaces as an avoidable 502. If the platform cannot
provide the configured Ingress, add a reviewed chart-owned durable Service
exposure first. The current gateway Service is `ClusterIP`; do not hand-patch
it to `NodePort` and leave Helm unaware of the live topology.

The optional static Companion UI may be registered with
`FLEET_SSO_COMPANION_UI_ORIGIN`. If the cluster has more than one companion, also
set `FLEET_SSO_COMPANION_UI_COMPANION_ID` to one exact registered UUID. It is
then available only at authenticated `/companion-ui/`; the configured origin is
internal wiring, never a second browser edge.

### Cluster-authenticated Garden operator surface + public API

```dotenv
ADMIN_HOST=127.0.0.1
ADMIN_PORT=3001
# ADMIN_TOKEN is rejected in cluster-auth mode; leave it unset.

API_HOST=127.0.0.1
API_PORT=3000
API_KEY=...

# optional private agent/operator transport override
ADMIN_TRANSPORT_SOCKET=./runtime/sockets/garden-admin.sock
```

Local startup runs exactly one cluster Garden: the launcher starts every
registered companion agent (including a one-entry roster), waits for every
canonical `garden-admin-<companion-uuid>.sock`, and only then starts Garden.
Garden is reachable only through `/companions/<companion-uuid>/garden/` on the
canonical gateway HTTPS origin. `ADMIN_TOKEN` and `ADMIN_ALLOW_INSECURE` are
rejected on that operator process. The repo launcher scrubs those retired
variables from the gateway and keeps proxy trust gateway-owned; child
agent/operator allowlists do not inherit them.

### Standalone token Garden operator surface

For local testing and non-Kubernetes single-user installations, leave
`fleet-auth.json` absent and start the operator surface directly with
`ADMIN_TOKEN`:

```dotenv
ADMIN_HOST=127.0.0.1
ADMIN_PORT=3001
ADMIN_TOKEN=...

API_HOST=127.0.0.1
API_PORT=3000
API_KEY=...

# optional private agent/operator transport override
ADMIN_TRANSPORT_SOCKET=./runtime/sockets/garden-admin.sock
```

In this mode the Garden operator surface listens on `ADMIN_HOST:ADMIN_PORT` and
authenticates browser requests with `ADMIN_TOKEN`. `ADMIN_ALLOW_INSECURE=true` is
supported only on loopback and is forbidden in production. This standalone-token
mode is mutually exclusive with fleet-principal admission; once `fleet-auth.json`
is present the operator surface selects fleet-principal admission and rejects
`ADMIN_TOKEN`/`ADMIN_ALLOW_INSECURE` before listen.

Fleet deployment checklist item — **do not set `ALLOW_INSECURE_LOCAL_API=true`
in a `PSFN_FLEET_AUTH` cluster.** Fleet auth forces the no-auth local API
bypass off regardless of the flag, and the gateway logs a loud startup warning
when the flag is present. Remove it so the insecure bypass cannot be re-enabled
by a later config change.

### Discord voice

```dotenv
DISCORD_VOICE_ENABLED=true
DISCORD_VOICE_GUILD_ID=...
DISCORD_VOICE_USER_ID=...
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
```

Provider selection and tuning stay in `settings.json`.

### Satellite Hub Endpoints

Wyoming/OpenHome endpoint transports live in the Satellite Hub repository. Configure endpoint host/port/runtime wiring there, then configure PSFN's `satellites.json` registry for claim-validated hub/API traffic.

Satellite authentication has two layers:

- **Per-satellite bearer keys**: set `API_SATELLITE_KEYS` (comma-separated, each >=16 chars). Each key yields a distinct satellite-scoped principal id that the matching `satellites.json` endpoint must list in `auth.apiKeyPrincipalIds`. Satellite keys are only valid on satellite surfaces.
- **Cluster-auth Hub devices**: each device-facing endpoint must declare a strict
  `hubDeviceEnrollment` with `deviceId`, positive `enrollmentVersion`, and
  `enrollmentStatus` (`active` or `revoked`). The authenticated Hub key selects
  the endpoint; the gateway then binds the signed assertion to this enrollment,
  the API surface's companion, the authenticated Hub session, and the
  satellite's optional `placeId` before a turn can enter the agent runtime.
- **Mutual TLS**: satellite client-cert identity is bound to the API listener's real TLS peer certificate (or to `X-PSFN-Client-Cert-*` headers only behind a trusted proxy presenting `API_TRUSTED_PROXY_CLIENT_CERT_TOKEN`). Certificate issuance, renewal, and revocation run through the cert-manager sidecar (`npm run cert-manager`, `src/app/cert-manager/`) — see [`docs/certificates.md`](./certificates.md) for the full bootstrap.

## Sanity Checks

Use the smallest set that proves your setup:

```bash
npm run lint
npm run build
npm run smoke:chat
npm run verify:settings-contract
npm run verify:agent-docker-isolation
```

## Troubleshooting

PSFN fails closed by design: a misconfiguration aborts startup with a named
error rather than booting into a degraded state. The top failure modes, their
cause, and the fix:

### Compose smoke path (`npm run smoke:docker`)

- **Exit `2`, log says `PROVIDER BOUNDARY REACHED`.** Not an error — the stack
  is healthy, the gateway↔agent RPC connected, and the turn ran up to the model
  call. It means `OPENROUTER_API_KEY` is unset (or empty). Export a valid key and
  re-run for exit `0`. If the key **is** set and you still see exit `2`, the
  harness reports `OPENROUTER_API_KEY is set but the provider call still failed`
  — check the key, its credit, and that the model in `models.json` is reachable
  on OpenRouter.
- **Exit `1`, `docker compose up did not reach a healthy state`.** A container
  never became healthy within the wait timeout. Inspect with
  `npm run smoke:docker -- --keep-up` then `docker compose -f docker/docker-compose.smoke.yml ps`
  and `logs`. Common causes: the first-run model download had no internet (the
  `model-prefetch` service needs egress), or Postgres never passed `pg_isready`.
- **Exit `1`, `chat request transport failed before reaching the provider` /
  plumbing signals (`companion_not_connected`, `econnrefused`, `no route`).**
  The gateway came up but the agent's RPC never registered. Check the `agent`
  container logs; a common cause is the agent tripping its network-isolation
  guard (it must stay on the internal-only network).

### Startup fail-closed rejections (any path)

- **`The fleet manifest is required but missing at <path>. Every PSFN
  deployment is a fleet of one or more companions…`.** `companions.json` is
  missing. Every deployment — including a cluster of one — requires a fleet
  manifest with at least one entry. See
  [What Goes In JSON Owner Files](#what-goes-in-json-owner-files) and
  [First Local Bring-Up](#first-local-bring-up) step 2. (Deployments with
  fleet authentication enabled see the variant `Fleet authentication requires
  companions.json; single-companion deployments must provide a one-entry fleet
  manifest` — same file, same fix.)
- **`COMPANION_ID is required. Set an explicit deployment identity in .env
  before startup`.** Both processes need to know which companion they serve.
  Set `COMPANION_ID` in `.env` to a lowercase UUID — the onboarding script
  generates one for you, or `uuidgen | tr 'A-Z' 'a-z'` does.
- **`POSTGRES_DATABASE_URL is required for runtime persistence`** (or the
  agent-side `Agent core runtime requires POSTGRES_DATABASE_URL`). The runtime
  store is Postgres-only, and the process was started without a database URL.
  Set `POSTGRES_DATABASE_URL` in `.env`; the Compose stack wires this for you.
- **`<label> owner-file validation failed at <path>: <cause>`.** The named
  owner file (settings, models, providers, companions, trust-policy, backup,
  intake-policy, partner-affect-shadow, or a per-companion scheduler /
  capability-tier / charge-policy / skills file) is missing, is not valid
  JSON, or fails its schema. The `<cause>` names the exact field. Repair the
  file in place — startup deliberately never overwrites an owner file from a
  seed or example template.
- **`Outbound network access is reachable from the agent container`.** The
  isolated agent found it can reach the internet, which the split trust model
  forbids. On Compose/Kubernetes this signals real broken isolation — fix the
  network. On a bare local `npm run split`, the host has no isolation to
  offer, so this fires on every first run: set
  `ALLOW_AGENT_OUTBOUND_NETWORK=true` in `.env` for local development and
  accept the loud DEGRADED warning it logs in exchange.
- **`GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN is required for the isolated
  session-integrity role`.** The agent was launched directly (`npm run agent`)
  without the proof the launcher derives. Launch through `npm run split`,
  which derives the role-bound tokens from the session HMAC key for you.
- **`Gateway connection could not be established; exiting for supervised
  restart`.** The agent gave up waiting for the gateway socket. Almost always
  the gateway itself failed to start — scroll up to its own fail-closed error,
  fix that first, and relaunch.
- **`Unsupported PSFN_RUNTIME_LAYOUT_MODE "<x>"`.** Typo in the layout mode.
  Accepted values: `continuous`, `dev`, `production`, `prod`.
- **`DATA_DIR shared-root mode is forbidden when PSFN runtime layout mode is
  production`.** Production requires the isolated split roots. Set
  `SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR` and drop `DATA_DIR`.
- **`Invalid character card at <path>: …`** (including `missing name or
  personality`). The card file exists but is malformed or incomplete. Repair
  the JSON, or re-import through `npm run onboard`, which validates the card
  against this same check before writing anything.
- **`DISCORD_TOKEN is required when DISCORD_BOT_ID is configured`** (and the
  mirror image). The Discord pair travels together — set both or neither.
- **A named owner file is missing** (e.g. `partner-affect-shadow.json`,
  `intake-policy.json`). Startup verifies the full owner set in
  `src/system/config/startup-owner-files.ts` and aborts on the first missing
  file. Lay every file listed under
  [What Goes In JSON Owner Files](#what-goes-in-json-owner-files); the Compose
  seed does this for you.
- **`Missing character card at <path>: explicit companion identity is required
  before startup`.** `CHARACTER_CARD_PATH` points at a file that does not exist.
  Provide the card; keep it under runtime data, not the personal workspace.
- **`SYSTEM_DATA_DIR and COMPANION_DATA_DIR must both be set together`.** You set
  one split-root variable but not the other. Set both, or set neither and use the
  shared-root `DATA_DIR` (continuous/local mode only).
- **`… must point to different roots` / `… must not overlap in production
  mode`.** In production the two data roots must be distinct and
  non-overlapping. Give them isolated paths. The same rule rejects a
  `WORKSPACE_PATH` that overlaps any runtime-state root.
- **pgvector errors on first migration.** The runtime store is Postgres-only and
  requires the `pgvector` extension. Use a pgvector-enabled image (the Compose
  stack uses `pgvector/pgvector:pg17`) or install the extension before first
  launch.
- **Missing backup encryption key.** `backup.json` ships with encryption
  `required`, so a missing `PSFN_BACKUP_ENCRYPTION_KEY` fails closed. Generate one
  with `openssl rand -base64 48` and set it in `.env`.
