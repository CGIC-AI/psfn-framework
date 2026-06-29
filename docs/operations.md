# Operations

This is the operator-facing runtime guide for the current repo-owned deployment model.

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
```

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
