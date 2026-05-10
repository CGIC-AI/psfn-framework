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
- Treat owner-file drift warnings as cleanup signals, not as permission to keep `.env` as mutable config authority.
- Review config, startup, persistence, and tool-surface changes against the live boundary. If a compatibility path is not named there, reject it, make it fail closed, or track it for beta removal before expanding it.
- When migration-boundary guidance changes, run `npm run verify:settings-contract` and `npm run verify:startup-owner-files` in addition to the affected runtime validation.

## Persistence Backends

SQLite remains the default backend for the repo-owned runtime, and PostgreSQL is supported behind the same ports for projection and memory surfaces without changing callers.

Operational rules:

- JSONL L0 remains authoritative even when a database mirror is enabled.
- Fast-search tables and indices are projections that can be rebuilt from canonical archive truth.
- Backend-specific adapter code stays behind the port/composition layer.
- PostgreSQL long-term memory requires the `pgvector` extension. Startup and migrations fail closed when `pgvector` is unavailable; there is no supported fallback to `DOUBLE PRECISION[]` scanning.
- If a backend or projection strategy changes, run `npm run lint`, `npm run build`, and targeted parity tests for the affected domains before treating the change as safe.
- If projection drift is suspected, repair from the archive before trusting search results or operator views.
- Use `npm run session:repair:transcript-projection` to rebuild the searchable transcript projection from authoritative JSONL L0 after drift, backend migration, or recovery work.
- The repair utility accepts `--data-dir` and `--sessions-dir` overrides and follows the configured SQLite or PostgreSQL session projection backend through the port layer.

## Backups And Integrity

- Backup cadence and retention live in `backup.json` and `scheduler.json`.
- Startup runs SQLite integrity checks.
- Embedding-dimension mismatches are surfaced at startup.
- Use this verification when backup behavior changes:

```bash
npm run verify:backup-restore
```

## Heartbeat Audit Posture

Use `heartbeat_get_policy` when you need the live heartbeat classification, not just the raw prompt text.

The default heartbeat set is intentionally split by purpose:

- `whisper` / `Musing`: optional outward Discord note; silence is acceptable when nothing genuinely worth sharing surfaces.
- `daily-review`, `emotional-check`, `goal-update`: background/private scans; they should only emit notes when they produce real carry-forward value.
- `experiential-review`: private internal-state narrative; extraction should be grounded in actual internal-state deltas or uncertainty.
- `values-reflection`: background deliberation; extraction should capture durable value signal, not a forced recital.

Operational rule: silent/background intervals are valid outcomes for the audited defaults. Do not treat every cadence tick as requiring a visible note or a durable extraction artifact.

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
- `GATEWAY_TLS_REJECT_UNAUTHORIZED=false` disables TLS verification and should stay development-only

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

For Discord voice specifically:

```bash
npm run smoke:discord:dm-voice -- --dry-run --strict
```

## Failure Triage

Check these first:

- runtime mode and path layout wiring in `.env`
- owner-file validity under `system-data/`
- gateway socket path and process pairing
- SQLite integrity and embedding-dimension warnings
- backup and migration manifests under the runtime backup root

If behavior seems inconsistent with old docs, prefer the split-runtime topology: gateway owns the public API edge, operator owns Garden HTTP/UI, and agent owns the companion loop plus private admin transport.
