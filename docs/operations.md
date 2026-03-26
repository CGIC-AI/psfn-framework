# Operations

This is the operator-facing runtime guide for the current repo-owned deployment model.

## Daily Runtime Commands

```bash
npm run dev
npm run split
npm run yolo
npm run gateway
npm run agent
npm run agent:docker
npm run agent:docker:continuous
```

- `split` is the standard gateway + agent launcher.
- `yolo` keeps the split runtime but broadens gateway `fs.read` scope across the codebase.
- `agent:docker` is the production-style isolated agent path.

## Production Deployment

The repo already contains the system-account installer:

```bash
scripts/system/install-psfn-service.sh
```

What it does:

- creates or reuses a dedicated service account
- stages a repo-owned checkout under the service home
- bundles a Node binary under the app root
- writes a filtered env file with only env-owned values
- renders a systemd unit from the repo template
- can optionally run the persistence cutover before enabling the service

Use `--dry-run` first. Keep authoritative env and runtime wiring in the repo tree; do not create shadow service config elsewhere.

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

## Backups And Integrity

- Backup cadence and retention live in `backup.json` and `scheduler.json`.
- Startup runs SQLite integrity checks.
- Embedding-dimension mismatches are surfaced at startup.
- Use this verification when backup behavior changes:

```bash
npm run verify:backup-restore
```

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

If behavior seems inconsistent with old docs, prefer the split-runtime entrypoints and the contracts in `src/persistence/layout.ts` and `src/config/settings-contract.ts`.
