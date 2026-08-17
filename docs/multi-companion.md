# Multi-Companion Substrate

Last updated: 2026-07-14.

This is the canonical page for running more than one companion on a single PSFN
cluster: the topology, the mandatory cluster manifest, and the cluster operations
that ride on top of it. It documents only what is wired in the branch;
forward-looking items are marked as future.

Every deployment is a companion cluster enumerated by a mandatory `companions.json`
manifest. A single-companion deployment is a one-entry manifest and is inert —
byte-identically so — with respect to the multi-companion machinery here (which
activates only when the manifest has more than one entry).

> **Terminology:** Per charter §8.12 (2026-07-20) the multi-companion system is a
> **companion cluster**. The term "fleet" persists only in code identifiers
> (`fleet-auth`, `resolveCompanionFleet`, `/v1/fleet/portal`, etc.) pending a
> staged engineering rename.

## Topology

- **One gateway, one database, N agent processes.** Each peer companion is a
  distinct `SubstrateAgent`/Companion Core in its own OS process, with its own
  companion ID, data dir, character card, and Postgres schema. All agents
  connect to the one gateway over the existing Unix-socket protocol; the
  gateway keeps sole ownership of secrets and external egress.
- **Process/schema/workspace boundaries isolate their declared domains.** The
  process boundary isolates agent-local execution and failures, the Postgres
  schema isolates tenant database state, and the authenticated companion
  identity selects exactly one deterministic Personal Workspace. Shell
  interpreters are denied until an OS-mediated filesystem sandbox exists;
  other allowlisted commands retain the existing cwd and argument-path checks.
- **Companion ID is a UUID.** The cluster keys on lowercase RFC-4122 UUIDs
  (`src/system/config/companions-config.ts`, `COMPANION_ID_PATTERN`).
- **Peers, not shards.** A cluster companion is independently rooted. A shard is
  a bounded derived runtime of one origin companion and does not become a cluster
  entry or peer identity.

### Unix-socket admission and companion ownership

The shared gateway Unix socket is protected by host filesystem ownership and
mode `0770`; it does not authenticate an OS peer on each JSON-RPC call. Every
process admitted by that owner/group is therefore inside the local transport
trust boundary. The multi-companion application protocol adds a separate,
one-time ownership bind: each agent presents a role-bound credential for one
manifest companion, and the gateway pins the live connection to that companion
until disconnect. Credentials cannot be used for another role, a connection
cannot change companion identity, and a second live connection cannot evict the
current owner. Requests then derive companion scope from the bound connection,
never from an untrusted RPC parameter.

This division is intentional: socket permissions decide which local processes
may connect; the authenticated identify handshake decides which companion a
connection owns. Remote WSS connections use mutual TLS and peer SPIFFE identity
before the same application-level ownership rules.

## The cluster manifest

Every PSFN deployment is a cluster of one or more companions: the system-owned
`companions.json` owner file is **mandatory**, and the topology is derived from
its contents rather than a flag. A single-companion deployment is simply a
one-entry manifest ("a cluster of one"); multi-companion tenancy is a manifest
with more than one entry. The `PSFN_MULTI_COMPANION` env flag has been retired.

- Owner file: `companions.json` (registered in
  `src/system/config/startup-owner-files.ts`, seed `config/companions.seed.json`).
- Resolution + fail-closed contract: `resolveCompanionFleet({ dataDir, seedDir })`
  (`src/system/config/companions-config.ts`):
  - `companions.json` missing or invalid → refuse to start with an actionable error
  - one-entry manifest → one cluster agent, the cluster supervisor, Cluster Auth,
    the cluster Garden, and an isolated Postgres schema
  - additional entries → more agents and schemas under those same controls;
    the values and launch contracts do not change

The root `postgres` block owns the dedicated shared-schema migration role and
its gateway-only credential reference. This topology authority is independent
of the optional Cluster Auth owner file; `fleet-auth.json` does not own shared
DDL. The gateway's `POSTGRES_DATABASE_URL` must exactly match one companion
credential resolved from the manifest; sibling and shared-migration credentials
remain gateway-only.

Each companion entry (`CompanionFleetEntry`, strict — unknown keys rejected)
carries exactly:

| Field | Meaning | Validation |
|---|---|---|
| `companionId` | UUID identifying the companion across the cluster | lowercase RFC-4122 UUID |
| `companionDataDir` | companion's data root, relative to the canonical persistence root (`PSFN_RUNTIME_ROOT`, or the selected layout's runtime root) | relative path, may not escape the root |
| `characterCardPath` | companion's character card, relative to the same canonical persistence root | relative path, may not escape the root |
| `postgresSchema` | Postgres schema owning this companion's tenant tables | lowercase identifier, ≤63 chars, no `pg_` prefix |
| `postgresRole` | dedicated owner/runtime role for that schema | safe PostgreSQL role name, unique across the cluster and distinct from the shared migration role |
| `postgresDatabaseUrlRef` | launcher-resolved credential reference delivered to this agent through an inherited file descriptor | valid credential reference, unique across the cluster and never `POSTGRES_DATABASE_URL` |
| `displayName` | optional human-facing roster label (display-only, no authority) | non-empty string, ≤120 chars, no control characters |
| `avatarRef` | optional opaque avatar reference for the roster (display-only) | non-empty string, ≤512 chars, no control characters |

`displayName` and `avatarRef` are surfaced **only** through the authenticated
cluster portal roster (`GET /v1/fleet-auth/companions`; see
[garden-control-plane.md](./garden-control-plane.md)). They are never routing
keys or authorization inputs. The roster's display name resolves as
`displayName` when present, otherwise the `companionId` — no character-card file
is read at request time.

Cross-entry validation rejects duplicate `companionId`, `postgresSchema`,
`postgresRole`, database credential reference, and overlapping
`companionDataDir`.
Before any process is spawned, the supervisor resolves both path fields to
canonical absolute strict subpaths of the runtime root. Existing symlink
ancestors are resolved and an escape outside that root is rejected. Each agent
startup then binds `COMPANION_ID`, both paths, `COMPANION_PG_SCHEMA`, and the
per-companion admin socket back to that one manifest entry; an unknown ID or any
drift refuses startup before persistence or character-card loading. The one
cluster Garden receives the complete registry without inheriting any companion's
identity, Personal Workspace, or database schema.

**What is NOT in `companions.json`:** database secret values, per-companion
Discord tokens, model/settings selections, or a mutable personal workspace path.
The file contains credential references only. Discord identity +
channel→companion routing live in `channels.json`; the per-companion Postgres
schema for a single agent process is sourced from the `COMPANION_PG_SCHEMA` env
var. The manifest owns identity, data location, and tenant schema. The cluster
Garden listener is configured once through `ADMIN_PORT`; the runtime
deterministically derives `workspaces/personal/<companionId>` from the validated
runtime root rather than accepting another path override.

## Per-companion settings overlay

The single-release cluster shares one `settings.json` on the system-data root, so
every setting is cluster-global by default. A companion can override a scoped
whitelist of keys with an **optional** `settings.overlay.json` in its own
`companionDataDir` (`src/system/config/settings-overlay.ts`).

- **Whitelist only.** The overlay may set `activeTimezone`, the `voice*` block
  (`voiceEnabled`, `ttsProvider`, `voiceId`, `voiceTargetGuildId`,
  `voiceTargetUserId`, `voiceReadyCueText`, `echoTts*`, `sttProvider`,
  `deepgram*`, `elevenLabs*`), `observerEvalSidecar`, `emotionScoping`,
  `uiThemeId`, and `discordTrigger*`. `COMPANION_SETTINGS_OVERLAY_WHITELIST` is
  the single source of truth; the settings contract derives a `scope`
  (`global` | `perCompanion`) per field from it.
- **Fail closed.** Any key outside the whitelist, malformed JSON, or a non-object
  overlay aborts startup — the runtime never silently drops the offending key or
  falls back to global settings for a broken overlay.
- **Deep-merged, re-validated.** Whitelisted keys are deep-merged over the global
  runtime settings (nested objects merge; arrays/scalars replace) and the result
  is re-validated through the existing settings normalizer. This is how two cluster
  companions hold, e.g., different `observerEvalSidecar.adapter.sessionLabel`
  values (fixing the shared emo_sim session) or different `activeTimezone` clocks.
- **Absent overlay = byte-identical** to today's global-only behavior. The merge
  runs in both startup config-hydration paths (`hydrateCanonicalStartupConfig` in
  `src/app/startup/support/bootstrap-helpers.ts` and `hydrateJsonBackedRuntimeConfig`
  in `src/system/config/runtime-config.ts`).

Whole owner files that are semantically per-companion are relocated to
`companionDataDir` rather than overlaid. `capability-tier.json` is relocated
(dnll.2): each companion's maturation tier is loaded from its own
`companionDataDir/capability-tier.json`, so a nursery and a mature companion can
run side by side under one release. A missing per-companion tier file fails
startup closed (no fallback to a shared file), the settings contract marks the
`capabilities` subsystem `perCompanion`, and the file rides the per-companion
`companion-tree` backup slice, not the cluster-global `system-config` slice.
`scheduler.json` is relocated the same way (dnll.3): each companion's circadian
configuration — heartbeat/tick cadence, the episodic rest window,
`temporalWakeup.morningWake.localTime`, `freeTime`, and `sleepConsolidation` — is
loaded from its own `companionDataDir/scheduler.json`, so two cluster companions
can hold distinct wake/rest schedules under one release. A missing per-companion
scheduler file fails startup closed, the settings contract marks the `scheduler`
subsystem `perCompanion`, and the file rides the `companion-tree` backup slice,
not the cluster-global `system-config` slice. `charge-policy.json` and
`skills.json` are likewise relocated: fatigue/charge budgets are co-rooted with
their companion ledger, and enabled skill sets remain individuated. All four
files are enumerated in
`PER_COMPANION_OWNER_FILES` (`src/system/config/settings-contract.ts`), which the
owner-file config store and startup verification consult to root them at
`companionDataDir`. Helm releases created before this cutover migrate the two
legacy system-root files byte-for-byte in the init container and record
source-hash markers under `companionDataDir/.owner-migrations/`; divergent
unmarked copies fail closed instead of choosing an owner silently. See the
[Helm upgrade runbook](./operations.md#helm-upgrade-for-per-companion-scheduler-and-capability-owners).

Separately, the Garden admin surface owns several per-companion state files that
must resolve under `companionDataDir` to match the runtime and avoid cluster
collisions (`src/operator/garden/local-admin-contract.ts`,
`src/operator/garden/services/scheduler-service.ts`): `garden-audit-history.jsonl`,
the Garden-side `heartbeat-policy.json` (already runtime-rooted under companion
state via `resolveHeartbeatPolicyPath`), and the reflection-metacognition journal.
These were previously mis-rooted at the shared system-data root (`config.dataDir`);
correcting them is a pure path fix. Any pre-existing shared file at the old
system-data location is left frozen — its mixed-companion contents are not split
or migrated, and no dual-read fallback is added; each companion's file simply
starts fresh at the correct root. Model-usage accounting is already per-companion
through the Postgres `model_usage_events` store (`companion_id` attribution), so
there is no shared JSONL usage ledger to re-root. That ledger is fleet-wide, not
schema-per-companion: canonical topology order selects the first companion's
schema as its one durable home. The gateway uses that schema owner for migration
and writes; follower agents and the fleet Garden use read-only pools pinned to
the same schema. Each follower receives only schema `USAGE` plus `SELECT` on
`model_usage_events`, and companion-scoped queries retain their `companion_id`
predicate. Creating a ledger in each current companion schema would fork the
accounting history and is forbidden.

## Postgres tenancy: schema-per-companion + one shared schema

Each agent process pins its runtime persistence to its own schema; there is one
extra `shared` schema for cross-companion world data. The canonical model-usage
ledger is the one narrow cross-schema read exception described above: it remains
owned by the primary companion rather than becoming a second shared DML schema.

- Env: `COMPANION_PG_SCHEMA` is parsed in `src/system/config/load-config.ts`
  into `config.postgresSchema`. It is an **explicit opt-in**, deliberately not
  derived from `COMPANION_ID`. Leave it unset for single-companion (the `public`
  schema).
- Pool pinning: `createPostgresPool(url, { schema })`
  (`src/persistence/postgres.ts`) sets `options=-c search_path=<schema>,extensions`
  at connection startup. The schema name is validated by
  `assertValidPostgresSchemaName` before it ever reaches a connection option, so
  it cannot smuggle SQL. The operator-provisioned `extensions` schema keeps
  `pgvector` resolvable without exposing legacy objects from `public`. Queries
  themselves are unchanged.
- Up-front provisioning: the gateway resolves the topology-owned credentials,
  verifies the companion schemas and role posture, and runs the complete shared
  migration chain once through `prepareFleetSharedSchemaRuntime`. Agent startup
  is read-only: it verifies its tenant boundary, exact shared DML grants, and —
  for followers — exact primary-ledger `USAGE`/`SELECT` before any store connects.
- Shared schema: `SHARED_SCHEMA_NAME = 'shared'`
  (`src/persistence/postgres/migrations.ts`) holds cross-companion world data —
  `companion_presence` (co-presence) and the shared-world wiki chunks. It is
  provisioned advisory-lock-serialized (`src/persistence/postgres/shared-schema.ts`)
  only by the dedicated shared migration authority. Runtime stores never issue
  shared DDL.
- Migrations run per schema: `runPostgresMigrations(pool, statements, { schema })`.
  Every companion store supplies its registered schema.
- Stores that build their own pool from `SubstrateConfig` — rather than through
  `createAgentPersistenceRuntime` — must resolve `postgresSchema`/`postgresRole`
  themselves and hand them to `createPostgresPool`
  (`createPostgresAnalysisWorkbenchTraceStoreFromConfig` is the worked example).
  A companion-local store that skips the pin inherits the default
  `"$user", public` search_path, which resolves to *nothing* under a fleet
  member's credential — no schema is named after the login role, and an adopted
  `public` tenant has revoked USAGE from PUBLIC — so its unqualified startup DDL
  dies with `no schema has been selected to create in`. A `public` tenant never
  reproduces it, which is why the coverage in
  `src/persistence/postgres/named-tenant-store-boot.integration.test.ts` runs
  against a provisioned `companion_*` tenant.
- A startup migration promise built in a store constructor is not awaited until
  that store's first call, so it must be observed where it is created. Otherwise
  a boot-time failure escapes the agent as a process-level unhandled rejection
  instead of a reported error. Observing it does not swallow it: the promise is
  still awaited — and still throws — on every store operation.

## Supervisor integration

The public repository emits a validated cluster plan for an external supervisor
to consume when it starts one agent process per companion.

- Cluster plan: `npm run resolve:companion-fleet`
  (`scripts/resolve-companion-fleet.ts`) reuses `resolveCompanionFleet` and emits
  an internal tab-delimited spawn plan, one line per companion:
  `companionId, companionDataDir, characterCardPath, postgresSchema,
  personalWorkspacePath,
  role-bound agent proof, role-bound session-integrity proof,
  resolved database credential, adminTransportSocket`. A one-entry roster emits
  one line and follows the same
  execution path as a larger roster. The admin socket is derived from
  `resolveCompanionAdminTransportSocketPath`
  (`src/operator/garden/transport-paths.ts`), never by the shell.
- Per-agent env: each spawned agent gets a scrubbed environment
  (`env -i` from an allowlist) plus `COMPANION_ID`, `COMPANION_DATA_DIR`,
  `CHARACTER_CARD_PATH`, `COMPANION_PG_SCHEMA`, `ADMIN_TRANSPORT_SOCKET`, and
  the role-bound gateway proofs from the plan. The proofs are derived from the
  gateway session keyring and companion ID; they are passed only to the agent and its
  isolated session-integrity worker and are omitted from dry-run output.
  The launcher delivers the matching database URL through
  `POSTGRES_DATABASE_URL_FD`; no sibling or shared-migration credential is placed
  in the agent environment or dry-run output.
  A one-entry cluster derives the same role separation and uses the same bound
  gateway routing as every other cluster.
- `--dry-run` (or `PSFN_SUPERVISOR_DRY_RUN=1`) resolves and prints the spawn
  plan without creating workspace directories. The real launcher acquires its
  socket-scoped lock before migration or provisioning, so a rejected concurrent
  launcher cannot mutate workspace state.
- Shared fate: any supervised process exit tears down the whole cluster.

Gateway registration is authenticated for every roster size. The gateway
accepts only IDs present in the resolved cluster and verifies a role-bound HMAC
proof before routing any request. General agent RPC methods and the two
session-integrity signing methods have disjoint role policies in both
topologies; selecting the internal role always requires its proof.

Network admin-transport mode is rejected fail-closed under the supervisor. Each
agent must listen on its canonical local socket so the one cluster Garden can use
the validated target registry.

## Workspace scopes: runtime contract

PSFN distinguishes four domains: system-owned configuration and policy,
companion-owned runtime state, one **Personal Workspace** per companion, and an
installation-owned **Shared Companion Workspace**. The existing site-scoped
shared-world wiki is one governed knowledge surface within the shared domain; it
is not a general shared filesystem.

The target layout is:

```text
<runtime root>/
  system-data/                 operator config and shared-world wiki
  companion-data/<uuid>/       per-companion runtime state
  workspaces/
    personal/<uuid>/           each companion's WORKSPACE_PATH
    shared/                    Shared Companion Workspace
```

- A **Personal Workspace** is private and writable for one companion's
  documents, personal journal, personal wiki, authored skills, modules,
  experiments, downloads, and saved artifacts. It is not runtime state.
- A **Shared Companion Workspace** belongs to the installation, not to a peer.
  It holds explicitly shared reference material and published collaboration
  artifacts. It requires an explicit read/write policy, provenance, review, and
  containment checks; it is not an unrestricted drop box or implicit shared
  memory.
- The **Companion Library / Seed Bundle** is operator-maintained common
  framework, philosophy, onboarding, template, and default-skill material. It
  may seed a Personal Workspace without silently overwriting companion-authored
  files, and shared material must never auto-load as an executable skill or
  module merely because it is visible.

Cluster workspace wiring derives this layout from the canonical runtime root and
the companion UUIDs in `companions.json`; workspace paths are not mutable
manifest fields. The launcher provisions every root before starting a process,
then injects only `workspaces/personal/<uuid>` as that process's
`WORKSPACE_PATH`. Missing, overlapping, symlink-escaping, or tuple-mismatched
roots fail startup.

The Shared Companion Workspace is published through authenticated Garden
routes, not through an environment variable or normal companion filesystem
tools. Publication identities come only from the immutable Cluster principal
context signed into the exact Garden request capability; JSON/header identity
assertions and reusable shared-workspace credentials are rejected. Proposal,
CogSec, and independent-review steps each require their exact route-bound
authorization, and the latter two additionally require UV, explicit
confirmation, and their conjunctive approval requirements. CogSec and the
independent reviewer must be distinct authenticated principals. CogSec produces
a revision-bound decision artifact before the independent reviewer can approve.
Publication re-reads under a lock and journals artifact, decision, and immutable
provenance updates for crash recovery.

Authenticated companion connections have only `shared.workspace.list` and
`shared.workspace.read`; there is no companion write or autoload method.
Shared content is stored only below `artifacts/`, accepts non-executable text
formats, and is never auto-loaded into skills, modules, prompts, wikis, or
memory. The versioned Companion Library seed lands under
`docs/companion-library/` with no-overwrite copies. Its checked-in manifest
contains every source hash; source changes without a versioned manifest update
fail startup.

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

## Companion UI channel (`companion-ui`)

The companion-ui PWA reaches the runtime through the satellite hub relay and the
companion-ui WebSocket (`src/channels/api/companion-ui-websocket.ts` →
`src/app/gateway/api-surface.ts` action dispatch →
`gatewayApiRuntime.handleChatCompletion`). Browser turns land as the first-class
`companion-ui` channel type (`CHANNEL_TYPES`, `src/shared/contracts/runtime.ts`),
not generic `api` traffic.

- **Server-authored classification.** The channel type is stamped in
  `AgentApiBackend.prepareTurn` (`src/channels/api/agent-backend.ts`) whenever a
  turn carries a validated hub-device attachment — the authenticated proof that
  it originated from the PWA. It is **never** claimable via an
  `X-PSFN-Channel-Type` header: `companion-ui` is deliberately absent from the
  external-claim allowlist (`external-channel-claim.ts`), so a browser or API
  client cannot self-mint the trusted channel. The satellite hub is a read-only
  vendored dependency this wave; if a future hub revision emits a signed
  channel-type claim it can replace the attachment-derived classification without
  changing the downstream stamp.
- **Contact binding.** A Discord-SSO'd human binds to their existing canonical
  contact via the attachment's validated contact binding
  (`hubDeviceAttachment.actor.contact.contactId`) — never minted as a new person
  or an `api` principal. `isHubDeviceAttachmentSnapshot` guarantees a non-empty
  contact id, so the binding is fail-closed. Guests (`guestMode: 'explicit'`)
  author as `hub-device-guest:<deviceId>` with no contact.
- **Channel privacy.** companion-ui is a 1:1 human↔companion surface, so turns
  carry a non-null `channelPrivacy` (default `private`) sourced from the
  operator-owned `channels.json > companionUi` section. This clears the
  observer-eval sidecar privacy gate
  (`src/core/eval/observer-sidecar/privacy.ts`) instead of failing closed on
  `missing_channel_privacy_metadata`.
- **Owner file.** `channels.json > companionUi` owns `{ channelPrivacy }`.
  Contact identity comes only from the authenticated human attachment; the
  owner file cannot override it. Unknown keys are rejected on load and save
  (`src/channels/backplane/config.ts`,
  `parseCompanionUiSection`). Availability is decided by the fleet-auth/hub-device
  wiring, not an `enabled` flag. The section is exposed through the raw
  `channels.json` editor in Garden settings.
- **Not a scheduling destination.** Like the inter-companion `companion` lane,
  `companion-ui` is excluded from the schedule-tool reminder/follow-up channel
  enum (`src/core/scheduler/schedule-tool.ts`): it is a live surface, and the
  `scheduled_prompts` / follow-up tables' `channel_type` CHECK constraints omit
  it.

## One cluster Garden frontend

- **One Garden for the cluster.** The supervisor starts every companion agent,
  waits for all canonical `garden-admin-<companionId>.sock` listeners, probes
  every target, and then starts exactly one operator process on `ADMIN_PORT`.
  The operator routes companion-scoped requests through the immutable
  `FleetGardenTargetRegistry`. It starts from a least-privilege `env -i`
  allowlist, does not load the repo `.env`, and does not inherit any companion's
  identity, Personal Workspace, database schema, gateway proof, provider,
  or channel credentials. It receives the deployment database URL solely for
  the approved direct Garden services; authenticated request dispatch selects a
  companion-bound service instance before any database access. Cluster Auth and
  `GATEWAY_OPERATOR_API_BASE_URL` are required for this topology. Credential
  status in Settings is a boolean-only snapshot queried from the gateway over
  the authenticated admin path.
- **Gateway cluster overview.** The canonical HTTPS origin serves the same
  compiled Garden bundle at `/fleet` and at each authorized
  `/companions/<companion-uuid>/garden/...` path. `/v1/fleet/portal` returns
  only the signed-in principal's bounded companion projection; it does not
  expose ports, timestamps, violation counts, raw reasons, or topology.
  Companion selection is encoded in the immutable URL and is reauthorized on
  every page, API, download, and WebSocket request. The former raw
  cluster-status listener and `/fleet/status.json` route are retired.

## Cluster backups

Backups are per-companion by default, with an optional whole-family artifact.

- **Per-companion slices.** Each companion in the shared database is backed up as
  its own slice (its own `postgresSchema` dump + its own companion-data tree and
  Personal Workspace), so one companion can be moved to another cluster as a slice
  (`src/persistence/backups/service.ts`).
- **Cluster artifact.** A separate `cluster` artifact captures the shared-world
  schema (`shared`), system-data owner files, and the Shared Companion Workspace
  — the data that belongs to the cluster rather than to any one companion.
- **Group mode.** With `groupMode` enabled (`backup.json`, env override
  `BACKUP_GROUP_MODE`) the cluster collapses into one whole-database family
  artifact, including the complete workspace family, instead of per-companion
  slices.
- **Leader election is deterministic.** Exactly one process runs the cluster backup
  cycle: the leader is `fleet.companions[0].companionId`
  (`isFleetBackupLeader`, `src/persistence/backups/fleet-scheduler.ts`) — first
  entry in `companions.json` order, no distributed lock. Followers register no
  backup lane. A process missing `COMPANION_ID`, or whose ID is absent from the
  manifest, fails closed.
- Partial failure (`FleetBackupPartialFailureError`) is recorded and re-thrown,
  never swallowed.

`src/persistence/backups/fleet-restore.ts` restores exactly one selected scope:
a companion slice into explicit companion-data + Personal Workspace
destinations, the cluster artifact into explicit system-data + Shared Workspace
destinations, or a group artifact into explicit whole-cluster roots. Every tree is
hash-verified before restore, existing destinations are rejected (never merged
or overwritten), and the matching Postgres dump is restored with owner/ACL
replay disabled.

## Locations, presence, and the shared world

Multi-companion layers on top of the single-companion locations/world surface
(see [`docs/architecture.md`](./architecture.md)). The multi-companion deltas:

- **Co-presence.** `companion_presence` lives in the `shared` schema
  (`companionId → siteId/placeId`, `kind: physical | virtual`, `since`), written
  by the cross-companion presence writer
  (`src/core/agent/companion-presence-runtime.ts`,
  `CompanionPresenceRuntime` / `CompanionPresenceTurnPort`) as emanation or a
  deliberate `move` changes. It is the durable authority behind "who else is
  here," and entering a place where another companion is present emits a
  co-location event. Wired only under multi-companion topology (a multi-entry cluster).
- **Companion channels.** Same-cluster companion↔companion conversation runs
  through the normal turn pipeline as ordinary channels
  (`src/shared/contracts/companion-channels.ts`): a many-to-many room
  (`companion-room:<placeId>`) and a 1:1 DM (`companion-dm:<a>:<b>`). Because they
  are normal turns, fatigue governs them with no new mechanism — MI↔MI turns
  charge `companion_room` budgets, human participation is free, and hard
  exhaustion suppresses the model call (see the fatigue section in
  [`docs/operations.md`](./operations.md)).
- **Autonomous initiation (ICP) is shipped, same-cluster, and opt-in.** When
  `scheduler.json > icpAutonomy.enabled` is true at process start, the local
  source runtime may turn a bounded weighted-thought, intention, or co-location
  signal into a private local candidate. The gateway broker then applies
  canonical contact identity, bilateral trust/block, channel, provenance,
  availability, fatigue, charge, cost-breaker, capability, and
  outstanding-invitation gates before issuing a short-lived single-use permit.
  Operator quiet hours protect the human from unsolicited outreach; they do not
  gate companion-to-companion initiation or self-directed companion time.
  The target ordinary channel turn authors the peer-visible message; the source
  cannot provide a message body or impersonate the peer. Candidates, permits,
  and conversation episodes are recovery-safe Postgres state.
- **Availability follows the runtime lifecycle.** An enabled source with the
  `external.companion` capability publishes a coarse `runtime` availability
  lease during agent startup and renews it on the existing health heartbeat.
  Healthy posture publishes `available`; hard fatigue exhaustion publishes
  `resting`. Explicit companion or operator leases take precedence over this
  default. Disabling ICP or revoking the capability immediately fences
  participation and suppresses a runtime-owned lease to `resting` without
  overwriting a higher-authority explicit state.
- **Owner state and live state are distinct.** ICP enablement/candidate retry/
  permit/availability cadence live only in `scheduler.json`; social quota,
  continuation cost, fatigue/overcharge reserve, structured continuation
  evidence, and the conversation cost breaker live only in
  `charge-policy.json`. Unknown or malformed new fields reject. Owner edits are
  reported as on-disk state and require restart; there is no environment shadow
  authority. Garden emergency disable is the deliberate narrowing exception:
  it immediately fences the running source, publishes operator DND, invalidates
  outstanding permits through the shared store, and persists `enabled:false`
  for the next start.
- **Garden exposes a bounded control plane per companion.** `/autonomy` reads
  `GET /api/admin/icp-autonomy` and shows the local coarse availability lease,
  redacted local candidates, and only episodes/provenance, permit lifecycle,
  fatigue aggregates, and cost decisions in which the local companion
  participates. Bearer permit IDs remain withheld. It also reports breaker posture and
  machine-readable reasons/failures. It never reads candidate motivation,
  peer-contact IDs, transcripts, message bodies, private model reasoning, or
  chain-of-thought. Audited mutations can cancel one local revision-checked
  candidate, set local operator DND, emergency-disable the local source, or
  trigger a local model-independent test initiation through
  `POST /api/admin/icp-autonomy/test-initiations`. The test request contains only
  a canonical peer companion UUID plus an idempotent request UUID and is durably
  marked `operator_test`; it cannot supply peer-visible content or bypass broker
  capability, identity, trust/block, availability, fatigue, charge, cost, or
  one-use-permit policy. After canonical-peer validation and durable candidate
  creation, the route returns the deterministic candidate identity as
  accepted/pending without waiting for the provider-backed turn; a persistence
  failure rejects the request. Delivery continues through the ordinary broker
  path and terminal state remains observable through bounded lifecycle
  telemetry. These controls cannot target another cluster.
- **Private-room delivery is presence-windowed.** A place carries an optional
  `privacy` field (`PlacePrivacy = 'public' | 'private'`,
  `src/shared/contracts/places-registry.ts`; absent = `public`, byte-identical to
  prior behavior). For a `private` place, an occupant receives room chat only from
  their join (`companion_presence.since`) until their exit, enforced at delivery
  time (gateway fan-out + session/context serving), never by filtering memory
  extraction. A later joiner has no evidence of pre-join conversation.
- **Shared-world wiki.** Companions read shared world knowledge and propose
  writes; they never write the shared scope directly — see
  [`docs/memory.md`](./memory.md). It is a site-scoped knowledge base, not the
  general Shared Companion Workspace.

## Deferred / future (not built)

Marked here so the doc's scope is unambiguous. These are named in the design
notes but are not wired in this branch:

- The shared-wiki **caretaker** layer (dedup, rewrite, cleanup, LLM-assisted
  updates). Today shared-world writes are operator-driven maintenance commands.
- Cross-cluster companion communication and cross-cluster world sync (one world =
  one cluster).
- Cross-companion message composition/puppeteering, private-reasoning or
  transcript inspection, and cluster-wide autonomy controls. The shipped Garden
  surface is local, control-plane-only, and deliberately cannot become these.
- Additional bounded cluster-overview posture indicators, subject to the same
  authorization and privacy constraints as the current projection.
