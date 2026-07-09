# Multi-Companion Substrate

Last updated: 2026-07-09.

This is the canonical page for running more than one companion on a single PSFN
cluster: the topology, the opt-in flag, the fleet manifest, and the fleet
operations that ride on top of it. It documents only what is wired in the
branch; forward-looking items are marked as future.

Single-companion remains the default topology. Everything here is behind an
explicit opt-in and is inert — byte-identically so — when the flag is off.

## Topology

- **One gateway, one database, N agent processes.** Each companion is a distinct
  `SubstrateAgent` in its own OS process, with its own companion ID, data dir,
  character card, and Postgres schema. All agents connect to the one gateway
  over the existing Unix-socket protocol; the gateway keeps sole ownership of
  secrets and external egress.
- **Process boundary = isolation boundary.** Per-companion state is isolated by
  the process boundary and (in Postgres) by the schema boundary. Failure
  isolation is a property of the topology, not extra code.
- **Companion ID is a UUID.** The fleet keys on lowercase RFC-4122 UUIDs
  (`src/system/config/companions-config.ts`, `COMPANION_ID_PATTERN`).

## The flag and the fleet manifest

Multi-companion is selected by the `PSFN_MULTI_COMPANION` env flag (process
wiring / topology selection, same scope as `PSFN_RUNTIME_LAYOUT_MODE`). The
flag alone does nothing; it requires a system-owned `companions.json` owner file
enumerating the fleet.

- Flag reader: `isMultiCompanionEnabled(env)`
  (`src/system/config/companions-config.ts`). Unset/empty means
  single-companion; an explicitly-set-but-unparseable value **throws** rather
  than silently defaulting off — the flag selects a tenancy boundary, so it
  fails closed.
- Owner file: `companions.json` (registered in
  `src/system/config/startup-owner-files.ts`, seed `config/companions.seed.json`).
- Resolution + fail-closed contract: `resolveCompanionFleet({ dataDir,
  multiCompanion, seedDir })`:
  - flag **on** + `companions.json` missing/invalid → refuse to start
  - flag **off** + `companions.json` present → refuse to start (owner-file
    strictness will not ignore a fleet manifest)
  - flag off + no manifest → `undefined` (default single-companion topology)

Each companion entry (`CompanionFleetEntry`, strict — unknown keys rejected)
carries exactly:

| Field | Meaning | Validation |
|---|---|---|
| `companionId` | UUID identifying the companion across the fleet | lowercase RFC-4122 UUID |
| `companionDataDir` | companion's data root, relative to the canonical persistence root (`PSFN_RUNTIME_ROOT`, or the selected layout's runtime root) | relative path, may not escape the root |
| `characterCardPath` | companion's character card, relative to the same canonical persistence root | relative path, may not escape the root |
| `postgresSchema` | Postgres schema owning this companion's tenant tables | lowercase identifier, ≤63 chars, no `pg_` prefix |
| `gardenPort` | optional TCP port for this companion's own Garden operator surface | integer 1–65535, unique across the fleet |

Cross-entry validation rejects duplicate `companionId`, duplicate
`postgresSchema`, duplicate `gardenPort`, and overlapping `companionDataDir`.
Before any process is spawned, the supervisor resolves both path fields to
canonical absolute strict subpaths of the runtime root. Existing symlink
ancestors are resolved and an escape outside that root is rejected. Agent and
operator startup then bind `COMPANION_ID`, both paths, `COMPANION_PG_SCHEMA`,
and the per-companion admin socket back to that one manifest entry; an unknown
ID or any drift refuses startup before persistence or character-card loading.

**What is NOT in `companions.json`:** per-companion Discord tokens and per-companion
model/settings selections. Discord identity + channel→companion routing live in
`channels.json`; the per-companion Postgres schema for a single agent process is
sourced from the `COMPANION_PG_SCHEMA` env var. The manifest owns identity, data
location, tenant schema, and Garden port only.

## Postgres tenancy: schema-per-companion + one shared schema

Each agent process pins its runtime persistence to its own schema; there is one
extra `shared` schema for cross-companion world data.

- Env: `COMPANION_PG_SCHEMA` is parsed in `src/system/config/load-config.ts`
  into `config.postgresSchema`. It is an **explicit opt-in**, deliberately not
  derived from `COMPANION_ID`. Leave it unset for single-companion (the `public`
  schema).
- Pool pinning: `createPostgresPool(url, { schema })`
  (`src/persistence/postgres.ts`) sets `options=-c search_path=<schema>,public`
  at connection startup. The schema name is validated by
  `assertValidPostgresSchemaName` before it ever reaches a connection option, so
  it cannot smuggle SQL. `public` is retained in the search path so the
  `pgvector` `VECTOR` type still resolves. Queries themselves are unchanged.
- Up-front provisioning: `src/persistence/runtime-factory.ts` creates the schema
  once (`ensurePostgresSchemaExists`) via a bootstrap pool before any store
  connects, so a store's first DDL cannot land in `public` by accident. The same
  `schema` is then threaded into every store.
- Shared schema: `SHARED_SCHEMA_NAME = 'shared'`
  (`src/persistence/postgres/migrations.ts`) holds cross-companion world data —
  `companion_presence` (co-presence) and the shared-world wiki chunks. It is
  provisioned advisory-lock-serialized (`src/persistence/postgres/shared-schema.ts`)
  so N concurrently-starting agents are safe. With the flag off the shared schema
  is never created or touched.
- Migrations run per schema: `runPostgresMigrations(pool, statements, { schema })`.
  Omitting `schema` is byte-identical to single-companion behavior.

## Launcher: supervisor mode

`scripts/start-gateway-agent.sh` grows a supervisor mode that reads the resolved
fleet and spawns one agent process per companion.

- Fleet plan: `npm run resolve:companion-fleet`
  (`scripts/resolve-companion-fleet.ts`) reuses `resolveCompanionFleet` and emits
  an internal tab-delimited spawn plan, one line per companion:
  `companionId, companionDataDir, characterCardPath, postgresSchema,
  role-bound agent proof, role-bound session-integrity proof,
  adminTransportSocket, gardenPort` (`gardenPort` is `-` when absent). A
  single-companion topology prints nothing — the launcher reads empty stdout as
  "stay in single-agent mode." The admin socket is derived from
  `resolveCompanionAdminTransportSocketPath`
  (`src/operator/garden/transport-paths.ts`), never by the shell.
- Per-agent env: each spawned agent gets a scrubbed environment
  (`env -i` from an allowlist) plus `COMPANION_ID`, `COMPANION_DATA_DIR`,
  `CHARACTER_CARD_PATH`, `COMPANION_PG_SCHEMA`, `ADMIN_TRANSPORT_SOCKET`, and
  `ADMIN_PORT` from the plan. The gateway proofs are derived from the gateway
  session keyring and companion ID; they are passed only to the agent and its
  isolated session-integrity worker and are omitted from dry-run output.
  The default single-companion launcher derives the same role separation for
  its isolated worker even though normal agent methods retain local-socket
  trust for flag-off compatibility.
- `--dry-run` (or `PSFN_SUPERVISOR_DRY_RUN=1`) prints the spawn plan and exits
  without launching anything.
- Shared fate: any supervised process exit tears down the whole fleet.

Gateway registration is authenticated in multi-companion mode. The gateway
accepts only IDs present in the resolved fleet and verifies a role-bound HMAC
proof before routing any request. General agent RPC methods and the two
session-integrity signing methods have disjoint role policies in both
topologies; selecting the internal role always requires its proof.

Network admin-transport mode is rejected fail-closed under the supervisor:
per-companion Gardens currently support socket mode only.

## Per-companion channels (Discord)

Each companion has its own Discord bot identity. Discord accounts in
`channels.json` carry:

- `tokenRef: { envName: "<UPPERCASE_ENV_VAR>" }` — env-var-name indirection to
  the token, never an inline secret (`src/channels/backplane/config.ts`,
  `parseConfiguredCredentialReference`). An inline `token` field is rejected; the
  secret is resolved from the named env var (or the credential vault) at load.
- `companionId` — the routing dimension. One `companionId` maps to one Discord
  bot account (duplicates rejected). The gateway holds all tokens and routes each
  companion's inbound/outbound traffic to that companion only
  (`src/boundary/gateway/companion-channels.ts`).

## Gardens: one per companion + a fleet-status page

- **One Garden per companion.** Each fleet entry with a `gardenPort` gets its own
  operator process (today's operator-process shape × N), bound to that
  companion's admin transport socket
  (`garden-admin-<companionId>.sock`) and listening on its `gardenPort`. The
  supervisor spawns them; a companion with no `gardenPort` gets no operator
  process. Auth stays single-operator token; the operator sees everything.
  Operator processes start from a least-privilege `env -i` allowlist, do not
  load the repo `.env`, and do not retain gateway, provider, channel, database,
  or companion-auth credentials. Credential status in Settings is a boolean-only
  snapshot queried from the gateway over the authenticated admin path.
- **Gateway fleet-status surface.** A thin, read-only, loopback-only page served
  by the gateway (`src/boundary/gateway/fleet-status.ts`,
  `startOptionalFleetStatusServer`), enabled by `FLEET_STATUS_PORT` (host
  `FLEET_STATUS_HOST`, default `127.0.0.1`). Routes: `GET /` and `GET /fleet`
  render an HTML overview; `GET /fleet/status.json` returns JSON. It is fed by
  the gateway connection registry + the fleet roster and shows, per companion:
  up/down state, health, last-seen and connected timestamps, recent violation
  count, and a link out to that companion's Garden. Setting `FLEET_STATUS_PORT`
  while `PSFN_MULTI_COMPANION` is off fails closed; a taken port fails closed
  (never re-picks).

  Not yet surfaced (documented follow-up in the code): fatigue/charge posture and
  tool-error counts. Do not assume the fleet page shows them today.

## Fleet backups

Backups are per-companion by default, with an optional whole-family artifact.

- **Per-companion slices.** Each companion in the shared database is backed up as
  its own slice (its own `postgresSchema` dump + its own companion-data tree), so
  one companion can be moved to another cluster as a slice
  (`src/persistence/backups/service.ts`).
- **Cluster artifact.** A separate `cluster` artifact captures the shared-world
  schema (`shared`) plus system-data owner files — the data that belongs to the
  cluster rather than to any one companion.
- **Group mode.** With `groupMode` enabled (`backup.json`, env override
  `BACKUP_GROUP_MODE`) the fleet collapses into one whole-database family
  artifact instead of per-companion slices.
- **Leader election is deterministic.** Exactly one process runs the fleet backup
  cycle: the leader is `fleet.companions[0].companionId`
  (`isFleetBackupLeader`, `src/persistence/backups/fleet-scheduler.ts`) — first
  entry in `companions.json` order, no distributed lock. Followers register no
  backup lane. A process missing `COMPANION_ID`, or whose ID is absent from the
  manifest, fails closed.
- Partial failure (`FleetBackupPartialFailureError`) is recorded and re-thrown,
  never swallowed.

Restore currently mirrors the single-companion path; per-companion fleet restore
build-out is a tracked follow-up.

## Locations, presence, and the shared world

Multi-companion layers on top of the single-companion locations/world surface
(see [`docs/architecture.md`](./architecture.md) and the working design note
`working_docs/SPRINT_10_LOCATIONS.md`). The multi-companion deltas:

- **Co-presence.** `companion_presence` lives in the `shared` schema
  (`companionId → siteId/placeId`, `kind: physical | virtual`, `since`), written
  by the cross-companion presence writer
  (`src/core/agent/companion-presence-runtime.ts`,
  `CompanionPresenceRuntime` / `CompanionPresenceTurnPort`) as emanation or a
  deliberate `move` changes. It is the durable authority behind "who else is
  here," and entering a place where another companion is present emits a
  co-location event. Wired only under the multi-companion flag.
- **Companion channels.** Same-cluster companion↔companion conversation runs
  through the normal turn pipeline as ordinary channels
  (`src/shared/contracts/companion-channels.ts`): a many-to-many room
  (`companion-room:<placeId>`) and a 1:1 DM (`companion-dm:<a>:<b>`). Because they
  are normal turns, fatigue governs them with no new mechanism — MI↔MI turns
  charge `companion_room` budgets, human participation is free, and hard
  exhaustion suppresses the model call (see the fatigue section in
  [`docs/operations.md`](./operations.md)).
- **Private-room delivery is presence-windowed.** A place carries an optional
  `privacy` field (`PlacePrivacy = 'public' | 'private'`,
  `src/shared/contracts/places-registry.ts`; absent = `public`, byte-identical to
  prior behavior). For a `private` place, an occupant receives room chat only from
  their join (`companion_presence.since`) until their exit, enforced at delivery
  time (gateway fan-out + session/context serving), never by filtering memory
  extraction. A later joiner has no evidence of pre-join conversation.
- **Shared-world wiki.** Companions read shared world knowledge and propose
  writes; they never write the shared scope directly — see
  [`docs/memory.md`](./memory.md).

## Deferred / future (not built)

Marked here so the doc's scope is unambiguous. These are named in the design
notes but are not wired in this branch:

- The shared-wiki **caretaker** layer (dedup, rewrite, cleanup, LLM-assisted
  updates). Today shared-world writes are operator-driven maintenance commands.
- Cross-cluster companion communication and cross-cluster world sync (one world =
  one cluster).
- A "management" capability tier acting on other companions' settings.
- Voice subsystem rewrite; per-companion fleet restore build-out.
- Fatigue/charge and tool-error metrics on the fleet-status page.
