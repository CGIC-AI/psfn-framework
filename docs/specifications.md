# Specifications

This document is the compact contract for how the live runtime is supposed to behave. When this file disagrees with code, prefer the code in the order listed below.

Last updated: 2026-08-07.

## Source Of Truth Order

1. Runtime entrypoints and composition
   - `src/app/startup/index.ts`
   - `src/app/gateway/main.ts`
   - `src/app/agent/main.ts`
   - `src/app/startup/composition/composition.ts`
   - `src/app/startup/composition/parity.ts`
2. Config and persistence contracts
   - `src/shared/contracts/runtime.ts`
   - `src/system/settings.ts`
   - `src/system/settings/contracts.ts`
   - `src/persistence/layout.ts`
3. Bootstrap example only
   - `.env.example`

## Runtime Contract

- The canonical operational mode is split gateway + agent.
- `src/app/startup/index.ts` is disabled and exits fail-closed.
- `npm run gateway`, `npm run agent`, and `npm run operator` are the supported
  component entrypoints.

### Cluster human and operator surfaces

- The canonical HTTPS origin's `/fleet` route is the cluster overview inside the
  same compiled Garden frontend used for companion administration.
- `/fleet` and `/v1/fleet/portal` require a live gateway cluster session and
  expose only the current principal's bounded authorized projection.
- Authorized companion navigation always uses
  `/companions/<companion-uuid>/garden/...`; the immutable URL target is the
  sole browser authority for page, API, download, and WebSocket traffic.
- **Standalone token admission** is a permanent supported mode for local testing
  and for single-user, non-Kubernetes installations. When `fleet-auth.json` is
  absent, the Garden operator surface admits browser requests with `ADMIN_TOKEN`
  or the explicit loopback-only `ADMIN_ALLOW_INSECURE=true` bypass. This mode is
  mutually exclusive with fleet-principal admission; a deployment with
  `fleet-auth.json` enabled rejects `ADMIN_TOKEN` and `ADMIN_ALLOW_INSECURE`
  before listen.
- The former unauthenticated raw cluster-status listener and its
  `FLEET_STATUS_PORT` / `FLEET_STATUS_HOST` wiring are retired. The public
  origin does not expose `/fleet/status.json` or complete cluster-operational
  metadata.

## Live Alpha Migration Boundary

Until beta, the live runtime may keep only the migration support listed here. New compatibility or fallback behavior in config, startup, persistence, or model-facing tool names must fail closed unless this section is updated with the supported scope, validation path, and beta-removal condition.

Supported until beta:

- Continuous/local shared-root layout through `DATA_DIR`. This is for local development and smoke testing only; production mode forbids shared-root operation.
- Split-root persistence cutover through `npm run migrate:persistence-layout` and the installer `--migrate-data` path. The cutover tooling may read legacy shared roots, write manifests, and run existing intra-root cleanup, but production startup should stop until the plan is clean.
- Explicit system-owner cluster re-rooting through
  `npm run migrate:system-owner-fleet`. This one-time operator command may read
  only legacy `charge-policy.json` and `skills.json` left at
  `SYSTEM_DATA_DIR`, fan their exact approved bytes to the explicit
  single-companion identity/root or to
  every companion enumerated by `companions.json`, and retire each source only
  after all destinations verify. Validation is the
  exact source digest and filesystem identity per file, no-overwrite destination
  checks, descriptor-pinned receipt/staging/destination directories, durable
  receipt-owned source quarantine, and the durable schema-v4
  `migrations/system-owner-fleet-reroot.json` receipt. The bootstrap receipt
  records unpredictable quarantine, staging, and temporary identifiers before
  those objects are created; created objects are fsynced and identity-bound
  before use. Partial retries may resume only an identity-bound exact source
  prefix. An unbound crash remnant is preserved and durably superseded under a
  new recorded identifier, while unknown or replaced artifacts fail closed.
  Retries must match the receipt, its pinned directory identities, and the
  unchanged cluster. A Helm deployment may invoke the same compiled command only
  through the explicit `ownerMigration` pre-upgrade hook: the rollout must set
  `required=true`, disable bootstrap seeding, bind every source digest, mount
  the exact system and backup claims plus either the one explicit
  single-companion PVC or every manifest companion PVC at its canonical path,
  select single-vs-multi topology explicitly (never from companion count), keep
  the snapshot path beneath the PVC-mounted backup directory, capture the
  whole-install snapshot first, and complete the mandatory packaged
  per-companion readiness probes before Helm admits the new revision. Missing
  claims, wrong paths, image-digest resolution failures, shared companion
  claims, and an omitted required hook fail the upgrade while the old revision
  remains deployed. Validate this path with `npm run verify:helm-chart` and
  `npm run e2e:kube-owner-upgrade`. Remove the command, Helm hook, packaged
  probe, and receipt reader before beta after
  every split cluster has a completed receipt (or a plan proving no system-root
  per-companion owners remain).
- Explicit scheduler owner-shape migration through
  `npm run migrate:scheduler-owner -- --data-dir <exact-companion-data-dir>`.
  This operator-only command may migrate retired scheduler cadence keys in one
  named companion root; it is never part of launcher startup and may not infer
  `SYSTEM_DATA_DIR`, `DATA_DIR`, or another companion's root. Validate the
  resulting `scheduler.json` through the canonical startup-owner preflight.
  Remove the command before beta after every companion owner has the canonical
  scheduler shape.
- Explicit intake-policy owner migration through
  `npm run migrate:intake-policy-owner -- --data-dir <exact-system-data-dir>`.
  This operator-only command upgrades schema v1/v2/v3/v4 to v5: v1 gains the
  canonical `skill_write` sink rule, and legacy owners gain any missing URL
  scanner and bounded screening-pool policy from the distributed seed. It adds
  or repairs the explicit trusted `companion_self` source class used for
  screened self-authored mutations, remaps retired modes, and removes retired
  screener model selectors. Persona/trust caps remain `standard`, preserving
  the invariant that released untrusted external content may inform but never
  instruct those sinks. The command also repairs current schema-v5 owners that
  predate these remediations.
  Dry-run is the default and `--apply` performs a validated durable atomic
  replacement. Runtime loading never invokes the migrator and rejects legacy
  or unremediated owners. Validate the result through the canonical
  startup-owner preflight. Remove the command before beta after every system
  owner uses canonical schema v5.
- Startup owner-file hydration for currently supported legacy owner data. Hydration may seed missing owner files on first boot, migrate or warn on existing owner-file drift, and load model/provider registries with the existing migration paths, but it must not restore `.env` as mutable-settings authority.
- Helm's one-time per-companion owner and scheduler-schema cutover for
  `scheduler.json` and `capability-tier.json`. The chart init path may copy a legacy regular file
  from `systemDataDir` to a missing `companionDataDir` target byte-for-byte and
  retain a SHA-256 marker for the source, then use the canonical validated
  atomic scheduler migrator to replace retired cadence fields with
  `backgroundMaintenance`; it must never make the runtime read
  the legacy path as a fallback, overwrite an evolved companion-owned target,
  or choose between divergent unmarked files. Validate this boundary with
  `npm run verify:helm-chart` and an exact-image local Helm rollout covering
  agent, gateway, and Garden. Remove the legacy-source inspection, copy, and
  marker compatibility before beta after every supported cluster has a
  verified companion-owned target and the old-chart rollback window has been
  retired.
- Explicit session journal filename migration through
  `npm run migrate:session-filenames -- --data-dir <exact-companion-data-dir> --apply`.
  This operator-only command may rename retired L0 session filenames beneath
  exactly one companion data root and rebuild that root's derived channel
  index. Runtime startup never invokes the migration; an affected lookup fails
  closed with the command to run. Validate the boundary with the command E2E,
  SessionStore filename-boundary tests, and the persistence/sessions suites.
  Remove the command, legacy filename engine, and lazy runtime detector before
  beta after every supported companion session root uses readable filenames.
- Explicit memory embedding re-index through
  `npm run migrate:embeddings [-- --batch-size <n> --parallelism <n>]`.
  This operator-only command re-embeds all L2 memories with the configured
  in-process Transformers embedding provider after a provider or model change.
  It requires `config.persistenceBackend=postgres` and never runs at startup.
  Validate the boundary with a bounded retrieval smoke after migration.
  Remove the command and its `src/faculties/memory/migration.ts` driver before
  beta after every live installation has rebuilt its L2 embedding space with
  the target provider/dimensions and passed the retrieval smoke.
- Explicit prompt-layer identifier backfill through
  `npm run migrate:prompt-layer-identifiers -- --apply`.
  This operator-only command inserts the missing `identifier: "main"` property
  into stored base prompt layers that predate the identifier field. It performs
  a byte-surgical write and fails closed on multi-base or malformed layers.
  Dry-run is the default; `--apply` performs the write. Validate the boundary
  with the command's own tests and a live-snapshot smoke. Remove the command,
  its backfill implementation, and the fail-closed coercion path in prompt
  loading before beta after every companion's base prompt-layer records carry
  an explicit identifier.
- Explicit channel envelope label migration through
  `npm run migrate:channel-envelope -- --apply`.
  This operator-only command seeds `channels.json` channel-owned
  `contextEnvelope` labels from contact conversation-channel rows, session
  journals, and the demoted prefix heuristics. Dry-run report is the default;
  `--apply` writes through the validated owner-file path. Conflicting or absent
  evidence is reported, never guessed, and receives `invite_only` plus a
  `needsReview` flag. Validate the boundary with the command E2E and the
  Context Envelope golden tests. Remove the command and its planner/support
  modules before beta after every companion's channels.json owns channel
  envelope labels and no trust-policy override fallback remains active.
- Existing companion persistence migrations for legacy continuity files,
  opaque pre-cutover SQLite database placement, contact `discord_user_id`
  identity rows, and the `core_memory.json` orientation filename. These flows
  may preserve or move opaque files but do not open them through a SQLite
  reader; they are not permission to add new parallel artifact names. Remove
  the remaining move/warn paths before beta after every supported companion
  root no longer contains the legacy filenames or placement that the migrator
  recognizes.
- Biographical typed-claim projection cutover for the legacy `contact_profiles`
  summary (psfn-framework-o61vb). `biographical_claims`, grants, rebuild rows,
  and review audits are the durable portable authority. Turn assembly obtains
  typed claim rendering and its CogSec contributions through one atomic
  projection result; a missing or mismatched contribution withholds the whole
  projection, and no prompt path falls back to summary prose. Structured
  candidates are synthesized only from live, current, exact-subject memory
  rows, then rebound to runtime-owned subject and source snapshots before
  admission. Legacy summary text is never an extraction source.

  The memory migration renames `contact_profiles` to
  `recent_contact_shapes`. Existing rows become `schema_version=0`, receive an
  already-expired `fresh_until`, and are not loaded. Only a live-source rebuild
  writes version-1 Recent Contact Shape rows. Their source memories must still
  pass current source, subject, consent, room, destination, and Context Envelope
  policy, and those sources contribute to outbound disclosure lineage. The
  shape is therefore useful current interaction context, not durable biography
  or portability authority.

  This is a one-way schema cutover: no compatibility view, dual read/write, or
  pre-cutover application rollback is supported after migration. Rollback
  requires restoring the pre-cutover Postgres dump. Retain version-0 rows only
  until an exact-head o61vb.10 privacy-conformance run and a scratch
  backup/restore verification both pass and the operator confirms that no
  pre-cutover image rollback is required; then delete those expired rows and
  remove the migration-only `contact_profiles` rename branch before beta.
  Validate the boundary with migration SQL assertions, source-rebuild and
  atomic-projection tests, Postgres adapter/parity checks, and the restore
  verifier and the delivery tickets o61vb.3 through o61vb.10.
- Forward-schema rollback bridges for the live-alpha Postgres memory and model
  usage tables. `l2_memories.salience_decay_anchor_at` retains a current-time
  default so an image from before the anchor column can insert a new live
  memory without weakening the column's `NOT NULL` invariant. The
  `model_usage_events` insert trigger converts only null or blank attribution
  fields from the pre-attribution writer to the canonical `unknown` sentinel
  and derives its missing fingerprint as
  `legacy:rollback-writer:<event-id>`; all accounting, currency, token,
  schema-version, and attribution constraints remain enforced. Validate this
  boundary with the Postgres memory integration test and model-usage migration
  certification against the exact older insert shapes, plus a bounded live
  turn proving memory, embedding, chat, and reflection writes after any
  rollback. Remove both bridges before beta after every deployment has retired
  images that predate these columns and the supported Helm rollback window no
  longer includes those writers.
- Tool-surface migration aliases documented in `docs/tool-surface.md`. They preserve model-facing continuity while unified tools roll out, and should be removed after canonical actions have stable adoption.
- One-time legacy Personal Workspace assignment during the multi-companion alpha
  cutover. If legacy `WORKSPACE_PATH` contains data, startup stops and prints its
  deterministic tree digest. An operator must select exactly one configured
  companion with `PSFN_LEGACY_WORKSPACE_COMPANION_ID` and approve the exact
  digest with `PSFN_LEGACY_WORKSPACE_SHA256`; migration copies without merging
  or overwriting and retains the source. If the legacy and canonical paths
  resolve to the same directory by realpath or device-and-inode identity,
  startup records an explicit `not_needed` decision without requiring a receipt.
  A completed migration is validated by the immutable receipt's internally
  consistent entry manifest and configured source, destination, companion, and
  approved digest identity; the mutable live Personal Workspace tree is not
  re-hashed after completion. Once the retained legacy source is deliberately
  removed, the receipt and canonical destination still validate without the
  migration env inputs; partial env configuration remains an error.
  Remove this startup migration and both env inputs before beta after every live
  installation has a verified receipt.

Out of boundary:

- alternate config owner paths not listed in the owner-file contract
- silent fallback from JSON owner files to `.env`
- production fallback to `DATA_DIR` or to overlapping mutable roots
- direct-provider bypass around the gateway/proxy security boundary
- persistence backend fallbacks that change truth, such as app-side vector scans replacing required `pgvector`
- new seed-loading behavior introduced as a compatibility workaround

## Configuration Ownership

### `.env` owns only

- secrets
- host/port/socket wiring
- runtime mode/layout wiring
- explicit bootstrap overrides

### JSON owner files own mutable runtime state

- `settings.json`
- `models.json`
- `providers.json`
- `scheduler.json`
- `capability-tier.json`
- `channels.json`
- `skills.json`
- `trust-policy.json`
- `mcp-servers.json`
- `charge-policy.json`
- `backup.json`

Legacy env values for JSON-owned settings are ignored, and startup hydration migrates or warns on drift where compatibility shims still exist.

## External MCP Client Contract

- PSFN is an MCP host/client. It does not expose companion internals as an MCP
  server.
- The gateway owns external MCP egress, credentials, transport, policy,
  confirmation, and screening. The agent receives no MCP credential or raw
  protocol result.
- Transport is remote Streamable HTTP over verified HTTPS/TLS 1.2 or newer.
  Plain HTTP, stdio subprocesses, legacy SSE transport, redirects, and global
  TLS-verification bypasses are unsupported.
- The exact official TypeScript client dependency performs protocol negotiation
  and bounded calls. Server-initiated elicitation is not auto-fulfilled; PSFN
  advertises no automatic roots/sampling authority.
- Authentication is bearer, explicit API-key header, or OAuth client
  credentials. Owner files contain only credential references. OAuth issuer and
  token endpoint are HTTPS and same-origin.
- The model-facing surface is one stable `mcp` tool with
  `catalog|search|inspect|call|release`. The fixed provider tool payload never
  contains remote tool definitions. Catalog is config-only; connection,
  summaries, and one selected schema load progressively.
- One client session is scoped to `(companion, server)`. Explicit release, idle
  expiry, disconnect, and shutdown drop loaded schemas and close transport
  resources. Later selection reconnects lazily.
- Every server has explicit companion allowlisting, factual hosting/data/input
  trust factors, a trust level that cannot exceed their minimum ceiling, an
  outbound-sensitivity ceiling, and a deny-by-default per-tool effect/
  confirmation policy. Unknown tools reject; destructive/control effects always
  require confirmation; approvals bind to exact arguments.
- MCP descriptions and schemas are canonicalized, SHA-256 hashed, and screened
  through CogSec. An exact companion/hash hit may reuse its prior screened
  artifact. A changed hash must be screened again. "Screened" never means
  trusted.
- Each classified tool policy binds effect, confirmation, a narrowing outbound
  sensitivity ceiling, and the SHA-256 fingerprint of the exact screened tool
  definition. Missing or changed fingerprints deny search/inspect/call until
  operator reclassification. Calls validate arguments against the screened
  discovered input schema before any external dispatch.
- The model-facing tool and `mcp.execute` RPC cannot assert MCP sensitivity or
  origin. The trusted turn runtime classifies the admitted generation context;
  the provider request carries that classification and the gateway binds it to
  one opaque, expiring, single-use permit for the exact provider-emitted MCP
  tool call. Missing lineage, autonomous work specs, and shard-originated
  generations receive no call permit. The gateway consumes the permit before
  capability, trust, approval, or broker execution. Screened discovery metadata
  does not raise the turn sensitivity; remote call results and other admitted
  tool outputs tighten subsequent calls to confidential.
- Every dynamic tool result is size-bounded and CogSec-screened on every call,
  independent of trust and static-cache state. Only the screened projection may
  cross the broker boundary.
- Health and Garden lifecycle projections are content-free and companion-
  scoped. They may reveal ids, policy, loaded state, and screening hash/time/
  count, but never endpoints, credentials, descriptions, schemas, arguments, or
  outputs.

## Persistence Layout Contract

### Continuous mode

- Default when `PSFN_RUNTIME_LAYOUT_MODE` is unset and `NODE_ENV` is not `production`
- Shared-root compatibility through `DATA_DIR`
- Defaults to `./data`

### Production mode

- Activated by `PSFN_RUNTIME_LAYOUT_MODE=production` or `NODE_ENV=production`
- Uses isolated mutable roots
- Defaults to:
  - `./runtime/production/system-data`
  - `./runtime/production/companion-data`
  - `./runtime/production/workspace`
  - `./runtime/production/logs`
  - `./runtime/production/tmp`
  - `./runtime/production/backups`

### Fail-closed rules

- `SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR` must be set together or not at all
- production mode forbids `DATA_DIR` shared-root operation
- production mutable roots must not overlap
- companion and system roots must be different paths

### Workspace scopes

`WORKSPACE_PATH` means one companion's **Personal Workspace**: writable
documents, journal, personal knowledge base, authored skills, modules,
experiments, downloads, images, and other personal durable files. It is not a
runtime-state root and not a general shared-files root.

The multi-companion layout has one validated Personal Workspace per
companion plus an installation-owned **Shared Companion Workspace** for
explicitly published collaboration artifacts and common reference material. The
shared-world wiki remains a narrower, site-scoped operator-owned knowledge
surface—not a general shared filesystem.

Cluster wiring deterministically derives personal roots from the runtime root and
companion UUID, provisions them before process startup, and injects exactly one
resolved Personal Workspace into each agent and Garden. The authenticated
gateway connection selects the same root for filesystem, shell, image, beads,
and channel attachment surfaces. There is no `SHARED_WORKSPACE_PATH` env setting
or manifest override.

Personal and shared workspace roots are canonicalized,
non-overlapping with each other and with system/companion/runtime roots, and
contained beneath the configured runtime root. Garden-mediated shared writes
derive proposer, reviewer, and CogSec principals from three distinct
credentials; body identity claims are rejected. Publication requires provenance,
a revision-bound CogSec artifact, independent review, a crash-recoverable
transaction, and containment checks. Shared material does not automatically reach prompts,
wikis, memory, skills, or modules.

## Artifact Ownership

### System-owned

- JSON owner files listed above
- capability and runtime policy state
- channel configuration

### Companion-owned

- character card
- PostgreSQL-backed companion runtime state
- append-only session JSONL archives
- notes, reflections, scratchpad mirror, values evolution ledger
- prompt layers and prompt registry
- core memory and north-star state
- images and identity assets
- safeguard audit trail and post-turn queue

### Personal-workspace-owned

- one companion's authored documents, personal journal, personal knowledge base,
  managed skills, modules, experiments, downloads, and saved artifacts
- these files are companion-private by default and are not runtime state

### Shared-workspace-owned (target contract)

- installation-owned collaboration artifacts and common reference material
- a Companion Library / Seed Bundle of approved documentation, templates, and
  default skills
- never personal memory, session archives, identity assets, credentials, or
  mutable runtime configuration

Path helpers for these artifacts live in `src/persistence/layout.ts`.

## Startup Hydration Guarantees

Both gateway and agent startup run canonical hydration through `hydrateCanonicalStartupConfig`, which:

- resolves runtime path layout
- loads settings and splits them by owner domain
- loads model and provider registries with legacy migration support
- loads trust-policy, scheduler, capability, charge-policy, backup, skills, and channel config
- warns on legacy drift instead of silently re-authorizing `.env`

## Same-Cluster Inter-Companion Autonomy

- Autonomous initiation is same-cluster only, enabled by default, and started
  only when `scheduler.json > icpAutonomy.enabled` is true. Its strict owner
  block also owns candidate TTL/retry, permit TTL, and operator availability
  lease TTL. There is no env shadow or compatibility reader.
- `charge-policy.json` owns companion-social quota and continuation cost,
  fatigue/social/overcharge reserve, structured continuation-evidence switches,
  and the ICP conversation cost breaker. Existing `trust-policy.json`,
  `channels.json`, capability tier, contact block/trust, and gateway policy
  remain independent mandatory gates.
- Operator quiet hours govern unsolicited companion-to-human outreach only.
  They do not silence companion-to-companion initiation or the companions'
  self-directed time; ICP remains governed by its own availability, fatigue,
  charge, trust/block, provenance, capability, and cost controls.
- Candidate motivation and peer-contact binding stay companion-local. Shared
  arbitration stores only content-free availability, episode, provenance, and
  permit control state. Permits are short-lived, single-use, candidate-bound,
  recovery-safe, and invalidated when operator DND or emergency disable fences a
  participant.
- When ICP is enabled and `external.companion` is granted, each agent publishes
  a coarse runtime availability lease at startup and renews it on the health
  heartbeat. Healthy agents default to `available`; hard fatigue exhaustion
  defaults to `resting` and remains an independent broker gate. Source authority
  is `operator > companion > runtime`, so lifecycle renewal cannot erase an
  explicit state. Disabling ICP or revoking the capability immediately fences
  participation and suppresses a runtime-owned lease to `resting`; a preserved
  higher-authority lease cannot reopen the closed runtime fence.
- Peer-visible content is authored by the target ordinary channel turn. The
  source handoff never accepts message content, and ICP-correlated turns cannot
  recursively initiate another channel.
- Garden `/autonomy` exposes only bounded/redacted local-participant
  control-plane state and effective/on-disk/restart owner semantics. Unrelated
  peer↔peer lifecycle, provenance, reason, fatigue, cost, and derived counts are
  excluded. Audited local controls are
  revision-checked candidate cancellation, operator DND, and one-way live
  emergency disable plus persisted owner disable.
- Not shipped: cross-cluster communication, cluster-wide/cross-companion control,
  message puppeteering, private transcript/reasoning inspection, and any Garden
  exposure of chain-of-thought.

## Security And Fail-Closed Posture

- Gateway owns external egress and secrets.
- Agent startup probes outbound reachability and aborts unless the operator explicitly overrides isolation.
- URL fetches, filesystem access, and sensitive tool actions are policy-gated.
- Capability eligibility and confirmation queues gate privileged actions.
- External MCP calls are gateway-only, deny-by-default, sensitivity-bounded,
  and screened on every dynamic response.
- Trust-aware memory retrieval withholds data by default when policy does not allow disclosure.
- Unknown or malformed provider/settings data should reject rather than silently coerce.

## Validation Baseline

Use the smallest relevant set, but these are the common contract checks:

```bash
npm run lint
npm run build
npm run verify:settings-contract
npm run verify:repository-hygiene
npm run verify:backup-restore
```

For runtime-specific surfaces, add the matching smoke or e2e command.
