# Operations

This is the operator-facing runtime guide for the current repo-owned deployment model.

Last updated: 2026-06-29.

## Daily Runtime Commands

```bash
npm run split
npm run yolo
npm run gateway
npm run agent
npm run operator
npm run agent:docker          # Production profile (network_mode: "none")
npm run agent:docker:continuous # Continuous/dev profile (isolated internal network)
```

- `split` is the standard gateway + agent + operator launcher.
- `split` loads `.env` for gateway/operator processes and launches the agent with a curated non-secret environment allowlist; provider credentials, API keys, and admin tokens must not be agent-owned.
- `yolo` keeps the split runtime but broadens gateway `fs.read` scope across the codebase.
- `operator` runs only the Garden operator surface when you want it separate from the launcher.
- `agent:docker` is the production profile (`network_mode: "none"`).
- `agent:docker:continuous` is the continuous/dev profile on an isolated internal network.
- Use `npm run verify:agent-docker-isolation` after changing compose files or operator docs.

## Multi-Companion Fleet Operations

Multi-companion is an opt-in topology: N agent processes behind one gateway. It
is off by default and byte-identical to single-companion when off. The full
model is in [`docs/multi-companion.md`](./multi-companion.md); this section is
the operator quick reference. Enabling it requires `PSFN_MULTI_COMPANION=1` in
`.env` and a system-owned `companions.json` fleet manifest (seed
`config/companions.seed.json`). Both mismatches fail closed at startup: flag on
with no manifest refuses to start; a manifest present with the flag off refuses
to start.

### Supervisor launcher

`npm run split` (`scripts/start-gateway-agent.sh`) resolves the fleet and, when
multi-companion is enabled, enters supervisor mode: it spawns one agent process
per companion plus one Garden operator process per companion that declares a
`gardenPort`. The spawn plan is produced by:

```bash
npm run resolve:companion-fleet   # tab-delimited plan; empty stdout = single-companion
```

Each spawned agent gets a scrubbed environment plus `COMPANION_ID`,
`COMPANION_DATA_DIR`, `CHARACTER_CARD_PATH`, `COMPANION_PG_SCHEMA`,
`ADMIN_TRANSPORT_SOCKET`, and `ADMIN_PORT` from the plan. The supervisor is
shared-fate: if any supervised process exits, the whole fleet is torn down.
Preview without launching:

```bash
scripts/start-gateway-agent.sh --dry-run   # prints the spawn plan, launches nothing
```

Per-companion Gardens use socket admin transport only; network admin-transport
mode is rejected fail-closed under the supervisor.

### Per-companion Postgres schema

Each agent process pins its runtime persistence to its own schema via
`COMPANION_PG_SCHEMA` (see [`docs/setup.md`](./setup.md)). It is an explicit
opt-in, not derived from `COMPANION_ID`; leave it unset for single-companion
(the `public` schema). The schema is created up front on startup and the pool's
`search_path` is pinned to it. One additional `shared` schema holds
cross-companion world data (`companion_presence`, shared-world wiki chunks) and
is provisioned advisory-lock-serialized so concurrently-starting agents are safe.

### Per-companion Discord accounts

Each companion has its own Discord bot identity, configured in `channels.json`.
Discord accounts carry `companionId` (the routing dimension — one companionId
maps to one bot account) and reference their token by env-var name, not inline
secret:

```jsonc
{ "companionId": "…", "tokenRef": { "envName": "DISCORD_TOKEN_ARIA" } }
```

The gateway holds all tokens and resolves each `tokenRef.envName` (or the
credential vault) at load; an inline `token` field is rejected, and an
unresolved/empty token fails closed. Add each companion's bot token to `.env`
under the env var name its account references.

### Fleet status page

The gateway serves a read-only, loopback-only fleet-status surface when
`FLEET_STATUS_PORT` is set (host `FLEET_STATUS_HOST`, default `127.0.0.1`):

- `GET /` and `GET /fleet` — HTML overview of the cluster
- `GET /fleet/status.json` — JSON

It reports, per companion: up/down state, health, last-seen and connected
timestamps, recent violation count, and a link to that companion's Garden. It is
fed by the gateway connection registry plus the fleet roster. Setting
`FLEET_STATUS_PORT` while `PSFN_MULTI_COMPANION` is off fails closed; a taken
port fails closed. Fatigue/charge posture and tool-error counts are a documented
follow-up and are not shown today.

### Fleet backups

See "Backups And Integrity" below for the per-companion-slice / cluster-artifact
/ group-mode model and the deterministic leader-election rule.

## Production Deployment

The repo already contains the system-account installer:

```bash
scripts/system/install-psfn-service.sh
```

What it does:

- creates or reuses a dedicated service account
- stages a repo-owned checkout under the service home
- bundles a Node binary under the app root
- writes the filtered env file under the deployed checkout at `deployment/systemd/psfn.env`
- renders the authoritative unit under the deployed checkout at `deployment/systemd/psfn.service`
- links `/etc/systemd/system/psfn.service` to that repo-owned rendered unit as the only required external pointer
- can optionally run the persistence cutover before enabling the service

Use `--dry-run` first. Keep authoritative env and runtime wiring in the deployed repo tree; do not create shadow service config elsewhere. The installer-owned unit injects the production layout paths and `PSFN_SKIP_DOTENV=true`, while the filtered env file only carries env-owned values that remain appropriate to source from disk.

## Live Raspberry Pi Storage Layout

The live Raspberry Pi host is `psfn-shard`. Its write-heavy PSFN paths are bind-mounted from the Crucial NVMe drive mounted at `/mnt/psfn-nvme`; the root filesystem still boots from the SD card. Treat the path existing as insufficient evidence: verify the backing device with `findmnt` before debugging storage or startup problems.

Current NVMe identity:

```text
device: /dev/nvme0n1
model: CT500P3SSD8
label: PSFN_NVME
uuid: d1f3c5fc-c352-418f-8fbd-bf72d84935a2
mount: /mnt/psfn-nvme
```

Bind-mounted live paths:

```text
/home/psfn/psfn-framework-source
/home/psfn/psfn-satellite-hub
/home/psfn/.cache
/home/psfn/.npm
/var/lib/psfn/runtime
/var/lib/postgresql/17/main
/var/log/postgresql
```

Validation:

```bash
findmnt -T /home/psfn/psfn-framework-source
findmnt -T /var/lib/psfn/runtime
findmnt -T /var/lib/postgresql/17/main
systemctl is-active postgresql@17-main.service postgresql.service litellm.service psfn.service psfn-satellite-hub.service psfn-companion-ui.service
pg_isready -h 127.0.0.1 -p 5432
ss -ltnp | grep -E ':(5432|4000|10053|10054|5173|8787|8790)'
```

`psfn-satellite-hub.service` and `psfn-companion-ui.service` must be loadable by systemd before `/home/psfn/psfn-framework-source` is bind-mounted. Their stable registrations are regular files in `/etc/systemd/system`, copied from repo-owned files under `deployment/systemd/`. Treat the repo files as the source; when they change, update the systemd registrations intentionally and record why. If services fail after reboot, check `systemctl --failed --no-pager`, `systemctl cat psfn-satellite-hub.service psfn-companion-ui.service`, and the `multi-user.target.wants` links before changing app code.

## Out-of-Process Watchdog Paging

The repo-owned watchdog runner lives at:

```bash
scripts/ops/continuity-watchdog-healthcheck.mjs
```

It is intended to run outside the Purrsephone runtime, usually through the repo-owned systemd user timer templates:

```text
deployment/systemd/user/purrsephone-watchdog.service
deployment/systemd/user/purrsephone-watchdog.timer
deployment/systemd/user/purrsephone-watchdog.environment.example
```

The watchdog checks the configured `systemd --user` service, optional process pattern, and API `/health` continuity contract. It pages through ntfy when the service is down, the health endpoint is unreachable, or continuity checks such as `schedulerHealthcheck` report stale liveness. It persists a small replay guard under the repo-local `data/ops/` default so repeated timer runs do not send duplicate pages for the same unresolved incident until `CONTINUITY_WATCHDOG_REPEAT_PAGE_AFTER_MS` elapses.

Configuration is fail-closed. The service template targets the live checkout at `%h/psfn-framework-source`, requires `deployment/systemd/user/purrsephone-watchdog.env` in that deployed repo checkout, and the script refuses to run without explicit ntfy base URL, topic, and token by default. If a deployment uses a different checkout path, edit the repo-owned template before installation. Copy the example file to that ignored env path and fill in deployment-specific values there. Do not create shadow watchdog env files in `~/.config/systemd`, `/etc/systemd`, `/tmp`, or other off-repo locations.

Dry-run and config validation:

```bash
set -a
. deployment/systemd/user/purrsephone-watchdog.env
set +a
CONTINUITY_WATCHDOG_DRY_RUN=true node scripts/ops/continuity-watchdog-healthcheck.mjs
node scripts/ops/continuity-watchdog-healthcheck.mjs --check-config
node scripts/ops/continuity-watchdog-smoke.mjs
```

The smoke harness uses a local fake health endpoint and dummy dry-run ntfy settings; it does not install or enable the systemd timer.

## Persistence Cutover

Use this when moving from legacy shared `data/` layout into split roots:

```bash
npm run migrate:persistence-layout
npm run migrate:persistence-layout -- --apply
```

The cutover tooling:

- builds a migration plan
- validates source/target conflicts
- copies or relocates artifacts into system-data and companion-data
- writes a migration manifest under the backup area

Production startup should not proceed until the cutover plan is clean.

## Migration Boundary Until Beta

The live alpha migration boundary is defined in [`docs/specifications.md`](./specifications.md). Operationally, keep migration support explicit and temporary:

- Use `npm run migrate:persistence-layout` for legacy shared-root data. Do not keep the old shared root mounted as a runtime fallback after cutover.
- Use continuous/local `DATA_DIR` only for local development and smoke testing. Production must use split roots and fail closed on shared-root or partial split-root wiring.
- Keep `WORKSPACE_PATH` as the personal files root. It must not overlap runtime data roots; live Purrsephone personal files live under repo-root `purrsephone/`, while active config, databases, sessions, telemetry, and identity artifacts remain under runtime data.
- Treat owner-file drift warnings as cleanup signals, not as permission to keep `.env` as mutable config authority.
- Review config, startup, persistence, and tool-surface changes against the live boundary. If a compatibility path is not named there, reject it, make it fail closed, or track it for beta removal before expanding it.
- When migration-boundary guidance changes, run `npm run verify:settings-contract` and `npm run verify:startup-owner-files` in addition to the affected runtime validation.

## Persistence Backends

PostgreSQL is the required backend for the repo-owned runtime. SQLite-backed stores are retained only for legacy migration utilities, explicit repair flows, and tests that exercise those adapters directly.

Operational rules:

- JSONL L0 remains authoritative even when a database mirror is enabled.
- Fast-search tables and indices are projections that can be rebuilt from canonical archive truth.
- Backend-specific adapter code stays behind the port/composition layer.
- PostgreSQL long-term memory requires the `pgvector` extension. Startup and migrations fail closed when `pgvector` is unavailable; there is no supported fallback to `DOUBLE PRECISION[]` scanning.
- If a backend or projection strategy changes, run `npm run lint`, `npm run build`, and targeted parity tests for the affected domains before treating the change as safe.
- If projection drift is suspected, repair from the archive before trusting search results or operator views.
- Use `npm run session:repair:transcript-projection` to rebuild the searchable transcript projection from authoritative JSONL L0 after drift, backend migration, or recovery work.
- The repair utility accepts `--data-dir` and `--sessions-dir` overrides and targets the configured PostgreSQL session projection backend through the port layer.

## Group-Room Memory Operations

Group-room memory exists to make multi-human Discord-style rooms produce useful, attributable memories without changing the direct/1:1 extraction path. Direct conversations keep the lightweight response-turn cadence and the normal two-write default. Group rooms use JSON-owned windows, observed-message triggers, salience selection, per-contact caps, watermarks, and profile-coverage refresh because high-volume rooms need bounded range processing instead of a tiny conversational tail.

Configuration owners:

- Global defaults live in `settings.json` under `groupMemory`.
- Discord/channel overrides live in `channels.json` under `discord.groupMemory`.
- `memoryMode` may be `direct`, `group`, or `auto`. Use `direct` for ambiguous 1:1 channels, `group` for known group rooms, and `auto` when provider topology plus recent participant count is reliable.

Live group windows should be tuned to channel velocity. The expected default shape is 50-100 recent messages, not one fixed large live batch. Increase or decrease `onlineExtraction.observedMessageTriggerCount`, `onlineExtraction.maxMessagesPerChunk`, `onlineExtraction.backlogLagTriggerMessages`, cooldowns, and write caps in JSON when a room is unusually fast or slow. Use bounded backfill for old history.

Garden diagnostics:

- `GET /api/admin/group-memory` lists group-memory health across channels.
- `GET /api/admin/group-memory/<url-encoded-channel-id>` shows one channel.
- Diagnostics include channel classification, manual override source, resolved config, head message ID, group-memory watermark, lag, last processed/skipped/failed span, salience candidate counts, parsed facts, accepted writes, rejection breakdown, write-cap skips, ambiguous attribution skips, and per-contact memory/profile coverage.
- Diagnostic payloads are redacted: they expose IDs, counts, reasons, config, and coverage, not raw transcript text or memory text.

Low-yield triage:

1. Confirm the channel class is `group` or group-capable. If auto mode is wrong, add a channel override.
2. Check the resolved `groupMemory` config in diagnostics. Make sure the participant window, trigger count, chunk size, cooldown, salience threshold, and caps match the room's velocity.
3. Check watermark lag. Lag with no extraction usually means thresholds/cooldowns are too conservative or a prior in-flight extraction is blocking.
4. Check salience telemetry. High `low_signal`, `duplicate_repetition`, or `below_threshold` counts mean the room is mostly chatter or the threshold is too strict.
5. Check `rejectionBreakdown`, `writeCapSkips`, and `ambiguousSpeakerSkippedCount`. Cap skips mean writes are being intentionally throttled; ambiguous skips mean the LLM output did not provide enough structured source/subject attribution.
6. Check per-contact profile coverage. A contact with activity but no profile usually lacks enough accepted source memories or is inside profile cooldown.

Safe group-history backfill:

1. Inspect diagnostics first and choose an explicit message or time range. URL-encode channel IDs in API paths.
2. Dry-run before writing:

```bash
curl -X POST "$ADMIN_URL/api/admin/group-memory/$CHANNEL_ID/backfill" \
  -H "content-type: application/json" \
  --data '{"mode":"dry_run","startMessageId":1,"endMessageId":500}'
```

3. Review planned chunks, candidate source message IDs, estimated LLM calls, deferred backlog, and privacy flags. Dry-run must not include raw transcript text or memory text.
4. Run live with limits at or below the JSON policy ceilings:

```bash
curl -X POST "$ADMIN_URL/api/admin/group-memory/$CHANNEL_ID/backfill" \
  -H "content-type: application/json" \
  --data '{"mode":"live","startMessageId":1,"endMessageId":500,"maxMessagesPerRun":120,"maxChunksPerRun":3,"maxLlmCallsPerRun":3}'
```

5. Stop behavior is fail-closed. A failed extractor call does not advance the watermark. A no-salience chunk is marked skipped so normal resume can keep moving. Rerun with `resume:true` to continue from the watermark; use `resume:false` only for an explicit bounded repair of a known span.
6. Backfill preserves existing memories and writes through the same dedupe, attribution, salience, write-cap, and profile-refresh path as online group extraction. There is no destructive bulk rollback path in backfill. If a bad memory is written, remove or supersede that memory through the normal memory repair/deletion workflow using its provenance.

Privacy boundaries:

- Observed group extraction schedules memory work only; it must never send a Discord response.
- Group memories retain source speaker, source contact, subject contact when known, trigger contact when applicable, address mode, source message IDs, and source spans.
- Structured source metadata is required for safe cross-contact facts. Ambiguous or conflicting mixed-speaker attribution fails closed.
- Retrieval privacy remains contact/trust scoped. A person sharing a group room with the companion does not gain access to another person's private memories.

Multi-companion rooms (charter gate, Law 26 / 8.10):

- Peer companions (contacts flagged `isMachineIntelligence`) may share a room with the companion. When one speaks, it is treated as an OBSERVED participant: its turns are attributed in history, it appears in the participant roster, and group-memory extraction weights it (see `groupMemory.autoDetection.includeAiCompanions`). It is never selected as the canonical human for any binding (DM/room scope contact, core-memory participant subject, or contact-continuity fallback). A companion binds normally only in a genuine 1:1 DM with that companion.
- Companions replying to companions in a live conversational room is a separate, gated capability. It is governed by the FatigueBudgetPort epic (relationship/channel fatigue budgets that bound machine-intelligence-triggered turns and prevent companion-to-companion reply loops). Observation is always supported; autonomous companion-to-companion conversation is bounded by the fatigue budget so a companion cannot loop nonsense at a peer after the salient things are said.

### Machine-intelligence auto-tagging (E7.3)

- Peer companions are identified automatically. When Discord reports a message author as a bot (`author.bot`), the runtime tags the resolved contact `isMachineIntelligence` at contact resolution time (provenance-honest: sourced from channel bot/app metadata, recorded under a `system:channel_observation:<channel>` audit actor). No manual tagging is required for fatigue relationship classes to apply.
- Operator control wins. A deliberate correction — the Garden/contacts surface or the `set_machine_intelligence` contact tool (any non-`system:` audit actor) — is never clobbered by re-observation. To pin a bot as not-a-companion, correct an auto-tagged contact from the contacts surface; the correction survives.
- Telegram currently ignores bot-authored messages entirely (the adapter drops `is_bot` senders), so there is no observed-contact path to tag there yet. Enabling bot-author observation on Telegram is a prerequisite follow-up before MI auto-tagging applies to that channel.

### Enabling and tuning fatigue for companion rooms

Fatigue evaluation is always wired and always runs, but it only ever SPENDS on machine-intelligence-triggered turns (a machine-intelligence peer whose turn is itself triggered by a machine intelligence). Human turns, and turns with a non-MI peer, are always free — the guard never bounds human conversation. Enabling companion-to-companion chat for a room is therefore two operator actions plus tuning:

1. Let the peer's messages reach the runtime. On Discord, add the peer companion's bot user id to the adapter's allowed-bot set (`allowedBotUserIds`). Without this, peer bots are ignored outright.
2. Auto-tagging then marks the peer `isMachineIntelligence` on first resolution (above), so the fatigue relationship class applies with no manual step.
3. Tune the budgets in the `charge-policy.json` owner file under `fatigue` (schema-validated by `src/system/config/charge-policy-config.ts`; a missing/invalid `fatigue` section fails closed at startup). The knobs:
   - `relationshipBudgets` — per relationship class (`stranger_mi` … `trusted_collaborator_mi`) `softTarget`/`hardCap` response counts per peer, per room, per UTC day.
   - `channelSettingLimits` — per channel setting (`dm`, `busy_human_group`, `one_human_companion_hosted`, `quiet_companion_room`, `public_group`, `unknown`) `maxSoftTarget`/`maxHardCap` caps.
   - `intentMultipliers` — scale soft/hard limits by inferred intent (casual, social, check_in, work, research, problem_solving).
   - `activityThresholds` / `stateThresholds` — busy/quiet room classification and the nearing-limit / wrap-up remaining-response bands.
   - `overcharge` — `enabled`, `reserveResponses` (bounded extra replies past the hard cap), and the recent-human-participation window/minimums. Overcharge fires only when a human recently participated OR the turn carries a work/research intent, so a companion can finish a genuinely useful exchange but cannot self-authorize an endless loop.
- A human message in the room resets the dynamics: it is free, and recent human participation unlocks the bounded overcharge reserve for subsequent machine-to-machine replies.
- Per-room fatigue state is readable in Garden via `GET /api/admin/charges`, which returns the fatigue ledger scope summaries and a tuning report. Filter to one room/peer/day with `channelId`, `peerContactId`, `localCompanionId`, and `dayKey` query parameters. The fatigue ledger is a companion-data JSONL file (`fatigue-ledger.jsonl`), scoped per (companion, peer, channel, UTC day) and reset daily.

## Backups And Integrity

- Backup cadence and retention live in `backup.json` and `scheduler.json`.
- Backups are encrypted at rest. `backup.json` declares `encryption.mode: "required"` and an env key reference; the actual key material stays in `PSFN_BACKUP_ENCRYPTION_KEY` or another configured env secret. Startup fails closed when the key is missing.
- Under the PostgreSQL runtime backend the scheduled backup stages a `pg_dump` custom-format archive (requires `pg_dump`/`pg_restore` on PATH) plus session JSONL, memory journal, and character-card files; the scheduler refuses to start without a database backup source.
- The scheduled backup also stages the full companion-data file tree (journals, generated media/selfies, vault notes, prompt and card history, scratchpad) into `companion-tree/` with a per-file sha256 manifest; the walk is exhaustive except for sessions (captured separately), backup targets, and repair snapshots, so new companion-authored file classes can never silently fall out of scope.
- System-data JSON owner files are staged into `system-config/` with a per-file sha256 manifest. This includes `settings.json`, `models.json`, `providers.json`, `scheduler.json`, `capability-tier.json`, `channels.json`, `backup.json`, `skills.json`, `trust-policy.json`, and `charge-policy.json` when present. `.env`, generated systemd env files, and raw provider/channel secrets are not copied by this system-config snapshot.
- `WORKSPACE_PATH` is staged separately into `workspace-tree/` with its own sha256 manifest. This covers personal docs, downloads, images, journal/scratchpad files, authored skills/modules, experiments, and the canonical `knowledge/wiki/` store. Runtime roots, backup targets, VCS metadata, dependency directories, caches, and temp directories are excluded and recorded in the manifest.
- Workspace backup fails closed if `WORKSPACE_PATH` overlaps runtime data roots, logs, temp, backup output, the mirror target, or other protected runtime paths. Keep personal wiki/reference documents under `WORKSPACE_PATH/knowledge/wiki/`; do not rely on the external Obsidian bridge for canonical storage or backup coverage.
- With `verifyRestore` enabled, every scheduled cycle verifies the plaintext staging area before encryption: it restores the dump into a dedicated scratch database (`<dbname>_restore_verify`, derived from the runtime database URL) and asserts schema, pgvector functionality on restored vectors, critical-table presence, and that tables populated at the source restored non-empty. One-time setup: `CREATE DATABASE <dbname>_restore_verify OWNER <runtime-role>` and `CREATE EXTENSION vector` in it as superuser (the extension survives wipes; user tables/sequences/views are dropped each run). The dump archive table of contents is also checked via `pg_restore --list`, companion-tree, workspace-tree, and system-config manifest hashes are re-verified, and the L0 journal snapshot must parse as JSONL.
- After verification, the retained backup set contains `encrypted-backup.json` plus `snapshot.tar.gz.enc`; the plaintext staging directory is removed. Mirrors receive the encrypted package, not the plaintext tree.
- `npm run verify:backup-restore -- --backup-dir <snapshot> --postgres-restore-url <scratch-url> [--postgres-source-url <url>]` decrypts encrypted backup sets using the manifest key reference and runs the same fidelity verification (the decant rehearsal).
- A failed scheduled backup logs an error and emits a `backup.failed` event on the runtime event bus.
- Under the multi-companion topology, backups are per-companion by default: each companion is captured as its own slice (its own `postgresSchema` dump plus its own companion-data tree) so a single companion can be moved to another cluster as a slice. A separate `cluster` artifact captures the shared-world schema (`shared`) plus system-data owner files. Enabling `groupMode` (`backup.json`, env override `BACKUP_GROUP_MODE`) instead collapses the fleet into one whole-database family artifact. Exactly one process runs the fleet backup cycle: the leader is deterministic — the first companion in `companions.json` order (`isFleetBackupLeader`, `src/persistence/backups/fleet-scheduler.ts`), no distributed lock — and followers register no backup lane. Partial failure (`FleetBackupPartialFailureError`) is recorded and re-thrown, never swallowed. Per-companion fleet restore build-out is a tracked follow-up.
- Startup skips SQLite integrity checks for the PostgreSQL runtime backend.
- Embedding-dimension mismatches are surfaced at startup.
- Use this verification when backup behavior changes:

```bash
npm run verify:backup-restore
```

Generate or rotate the default encryption key with:

```bash
openssl rand -base64 48
```

## Heartbeat Audit Posture

Use `schedule action=list_templates` when you need the live reflection/scheduler classification, not raw prompt text.

The default reflection set is intentionally consolidated:

- `daily-review`: private multi-turn reflection that can cover mood, goals, memory, and metacognitive continuity when the rest window allows it.
- `weekly-review`: broader consolidation and planning pass for durable themes, values, and longer arcs.
- Heartbeat remains a runtime cadence/checkpoint. It should not burn tokens unless useful work is configured.

Operational rule: silent/background intervals are valid outcomes. Do not treat every cadence tick as requiring a visible note or a durable extraction artifact.

## Re-Embedding

Re-embed when any of these change:

- embedding provider
- embedding model
- embedding dimensions
- vector format expectations

Relevant commands:

```bash
npm run migrate:embeddings
npm run verify:backup-restore
```

Validate retrieval quality after the migration, not just command success.

## Shared-World Wiki And Places Maintenance

The shared-world wiki is operator-owned. Companions read shared world knowledge
and propose entries through the normal wiki pass; they never write the
`shared_world:<siteId>` scope directly (the personal wiki store rejects any
non-personal write fail-closed). The dedicated caretaker layer described in the
design notes is not built yet — shared-world writes happen only through these
operator maintenance commands:

```bash
npm run wiki:publish:places          # dry-run: report only
npm run wiki:publish:places -- --apply
npm run wiki:import -- --scope shared --site <siteId> --dir <path>          # dry-run
npm run wiki:import -- --scope shared --site <siteId> --dir <path> --apply
npm run wiki:import -- --scope personal --dir <path> --apply
```

- `wiki:publish:places` projects `places.json` into browsable shared-world wiki
  pages (one site-overview page plus one page per place, scope
  `shared_world:<siteId>`). It is idempotent — re-running against an unchanged
  registry is a no-op. Shared-world markdown lives under
  `<system-data>/shared-world/wiki/sites/<siteId>/`, never in companion-data.
- `wiki:import --scope shared` runs a deterministic personal-fact guard over
  every file and rejects any file containing a personal fact; `--scope personal`
  imports into a companion's own wiki without that gate. Both fail closed on an
  unknown `siteId`.
- Projection coupling: under the multi-companion topology both commands project
  the shared-world markdown into the `shared_wiki_chunks` pgvector store in the
  `shared` schema in the same operation, and abort before touching the
  filesystem if the projection target is unreachable. Retrieval then unions a
  companion's personal wiki with the current site's shared chunks
  (`resolveWikiRetrievalPlan`).

Room privacy is a property of the place, set as an optional `privacy` field on
the place registry entry in `places.json` (`"public"` — the default when absent
— or `"private"`). A `private` place delivers room chat presence-windowed: an
occupant sees only what was said between their join and exit. This is enforced
at delivery time (gateway fan-out + session/context serving), never by filtering
memory extraction. See [`docs/chat-turn-lifecycle.md`](./chat-turn-lifecycle.md).

## TLS And Proxy Trust

For the LiteLLM proxy and custom CAs:

```bash
./scripts/cert-setup.sh --help
```

Key runtime wiring:

- `GATEWAY_TLS_CA_PATH` adds a trusted CA bundle for outbound TLS
- `GATEWAY_TLS_REJECT_UNAUTHORIZED=false` is rejected in production and never sets `NODE_TLS_REJECT_UNAUTHORIZED`; any development self-signed exception must be wired on the intended endpoint client
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is rejected in production because it disables TLS verification process-wide

If you enable HTTPS on the bundled proxy, update the proxy compose mounts and keep the certs under the repo-owned tree.

## Validation Commands

These are the common operational checks:

```bash
npm run lint
npm run build
npm test
npm run smoke:chat
npm run e2e
npm run e2e:voice
npm run verify:settings-contract
npm run verify:repository-hygiene
npm run verify:agent-docker-isolation
npm run test:group-harness
npm run test:prompt-goldens
npm run test:leak-matrix
```

- `npm run test:group-harness` runs the group-chat prompt-shape regression suite (`src/core/session/group-chat-harness/`). It drives the real prompt-assembly and memory-retrieval paths against synthetic multi-human room, DM, and non-member fixtures: room-visibility leak probes, group history attribution, room-scoped core memory, and conversation_state. Known group-chat defects are encoded as `it.fails(...)` expected failures (speaking_with tokens populating on group turns; DM core-memory participant binding following an arbitrary history speaker instead of the canonical contact) and flip to real failures when a fix lands. Reusable assertion helpers live in `group-chat-harness/assertions.ts`.
- `npm run test:leak-matrix` runs the Context Envelope leak-rate test family (`src/core/session/group-chat-harness/envelope-leak-matrix.test.ts`, E3.6). A documented ~26-row corner matrix (envelope class x sensitivity x trust tier, plus consent/disclosure-boundary/high-intimacy-contact-scope corners) drives the REAL `MemoryRetriever.retrieve` gating pipeline (`evaluateRetrievalAccessDecision` / `evaluateMemoryPolicy`) against synthetic sentinel memories -- not the unit-level gate suite in `src/system/trust/envelope-gating.test.ts` (E3.3), which this suite complements rather than duplicates. Every forbidden corner asserts zero leak of the sentinel text through the assembled output plus the correct withheld reason code (via the label `formatMemoryWithheldReasonLabel` renders); every allowed corner asserts presence, including positive controls for the room->DM-of-member, trust-ceiling, high-intimacy-contact-scope, and consent-granted paths. It reuses the group-chat-harness fixtures and adds a small set of additive fixture variants (a broadcast channel, an anonymous-audience room, and consent-flagged/boundary-tagged/contact-scoped sentinel memories) to `group-chat-harness/fixtures.ts`.
- `npm run test:prompt-goldens` runs the prompt-shape golden suite (`src/core/session/group-chat-harness/prompt-shape-goldens.test.ts`). Six deterministic golden snapshots under `group-chat-harness/goldens/` freeze the full rendered system prompt plus ordered block list for DM, group, heartbeat, DM-scoped reflection, DM-with-memories, and group-with-withheld-memories turns, and the suite also asserts the frozen static prompt prefix is byte-equal across consecutive turns. A failing golden means the assembled prompt shape changed: never blind re-record. For an intentional shape change, regenerate with `npx vitest run src/core/session/group-chat-harness/prompt-shape-goldens.test.ts -u`, review the golden diff like code, and explain the block-level change in the PR; then run `npm run test:prompt-goldens` twice to prove determinism. The full update procedure is documented in the test file header.
- `npm run smoke:chat` exercises the split-runtime admin bootstrap and chat completion path; set `PSFN_SMOKE_REPORT_PATH=/tmp/psfn-smoke-report.json` to capture a JSON artifact with the bootstrap, chat, and optional voice checks.
- `npm run verify:startup-owner-files` is the canonical startup preflight for the split-runtime owner-file contract; `npm run e2e` assumes that preflight has already passed.
- `npm run e2e` uses the isolated split-runtime harness under `src/app/e2e/e2e-test.ts`, with scripted local LLM responses so it does not consume ambient repo owner files or external model credentials.
- `npm run e2e:voice` exercises the isolated voice round-trip harness on the split runtime.
- Offline eval, validation, and model-experimentation commands live in the sibling `../psfn-eval-toolkit` repository.

For Discord voice specifically:

```bash
npm run smoke:discord:dm-voice -- --dry-run --strict
```

## Failure Triage

Check these first:

- runtime mode and path layout wiring in `.env`
- owner-file validity under `system-data/`
- gateway socket path and process pairing
- PostgreSQL connectivity, migration, and embedding-dimension warnings
- backup and migration manifests under the runtime backup root

If behavior seems inconsistent with old docs, prefer the split-runtime topology: gateway owns the public API edge, operator owns Garden HTTP/UI, and agent owns the companion loop plus private admin transport.
