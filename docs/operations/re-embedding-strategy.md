# Re-Embedding Strategy Runbook

- Status: Implemented
- Date: 2026-03-07
- Scope: PSFN-oft0.12

## When To Re-Embed

Run a full re-embedding migration when any of these conditions is true:

1. `EMBEDDING_PROVIDER`, embedding model, or embedding dimensions changed.
2. Startup fails with embedding mismatch (`configured != stored` dimensions).
3. Retrieval quality regresses after embedding provider/model changes.

Fail-closed behavior is already enforced in runtime startup:

- `src/runtime.ts`
- `src/agent-main.ts`

Both abort startup on dimension mismatch and require migration before normal operation.

## Preflight Checklist

1. Stop write-heavy workloads (or schedule maintenance window).
2. Take a backup snapshot.
3. Verify restore path before migration:

```bash
npm run verify:backup-restore -- --backup-root ./runtime/production/backups
```

4. Confirm target embedding provider and dimensions in environment/config.

## Execution Profiles

Default run:

```bash
npm run migrate:embeddings
```

Controlled run with explicit throughput:

```bash
npm run migrate:embeddings -- --batch-size 64 --parallelism 4
```

Include soft-deleted memories (usually only for archival rebuilding):

```bash
npm run migrate:embeddings -- --include-deleted
```

The migration rewrites `l2_memory_embeddings` in batches and prints progress plus summary totals (`total`, `updated`, `failed`).

## Post-Migration Validation

1. Ensure migration finished with `failed: 0`.
2. Restart runtime and confirm no embedding-dimension fatal startup guard is triggered.
3. Run focused retrieval/migration tests:

```bash
npm run test -- src/memory/migration.test.ts
npm run test -- src/memory/retrieval.test.ts
```

4. Spot-check embedding table cardinality:

```bash
sqlite3 "$DATABASE_PATH" \
  "SELECT COUNT(*) AS memories FROM l2_memories WHERE deleted_at IS NULL; SELECT COUNT(*) AS embeddings FROM l2_memory_embeddings;"
```

Cardinality does not need to be identical in all states (superseded/deleted rows can differ), but large unexplained drift should be treated as a migration incident.

## Failure Handling

- If migration reports failures, rerun after fixing provider/network issues. The tool is idempotent at memory-row granularity.
- If runtime still fails on dimension mismatch after migration, verify:
  - active runtime env points at the expected database
  - embedding provider dims match target model dims
  - no stale container/env override is forcing old dimensions

## Rollback

If migration quality is unacceptable:

1. Stop runtime.
2. Restore latest known-good backup snapshot.
3. Restart with the prior embedding provider/model configuration.
4. Re-run `verify:backup-restore` and retrieval smoke checks before re-opening traffic.
