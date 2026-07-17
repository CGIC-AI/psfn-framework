# Shakedown Layer A harness

Scripted Layer A tooling for the post-sprint shakedown. **The process is the
canonical [`docs/shakedown.md`](../../docs/shakedown.md)** — this README only
describes the mechanics. Run artifacts (round dirs, run JSONs, screenshots) live
outside the repo in the per-round root; only this harness is versioned.

## Rules baked in

- **Fail closed on env.** Every entrypoint reads all configuration from the
  sourced shakedown env and exits non-zero, naming the variable, if a required
  one is missing. There are no fallback path defaults and nothing points at a
  previous sprint tree.
- **One shared probe library.** `lib/` holds the reusable primitives; case files
  import them instead of copy-pasting.
  - `lib/env.mjs` — fail-closed env accessors (`requireEnv`, `requireEnvOneOf`, …).
  - `lib/probe.mjs` — chat transport (`/v1/chat/completions` with session /
    privacy / identity-claim headers), turn-record lookup, and the agent-busy
    retry loop. Proof comes from the persisted turn record, never reply text.
  - `lib/postgres.mjs` — Postgres proof queries from `POSTGRES_DATABASE_URL`
    (optional `COMPANION_PG_SCHEMA`). Runtime stores are Postgres-only; this
    replaces the old `sqlite3` CLI queries.
  - `lib/coverage.mjs` — parses the `docs/shakedown.md` coverage appendix.

## Entrypoints

| Script | Role |
| --- | --- |
| `live-system-shakedown.mjs` | Tier-tagged case harness. One phase per run; writes a run JSON to `PSFN_SHAKEDOWN_OUTPUT`. |
| `run-live-shakedown-matrix.sh` | Tier sweep: nursery → apprentice → autonomous. Backs up `capability-tier.json`, restores it on exit (trap) **and verifies the restore**, and emits one run JSON per tier. |
| `restart-split-runtime.sh` | Restarts the split gateway/agent runtime for a lane (Postgres backend, health-gated). |
| `operator-ui-sweep.mjs` | Garden behavioral sweep (Playwright) — asserts behavior, not HTTP 200s. |
| `shakedown-scorecard.mjs` | Aggregates run JSONs; enforces the non-green taxonomy and cross-checks the coverage appendix. Exits non-zero if any case is non-green (unwaived) or any appendix surface is uncovered. |
| `coverage-map.json` | Maps each appendix surface to the case ids that exercise it (or an explicit disposition). Maintained per sprint. |

## Non-green taxonomy (enforced in `shakedown-scorecard.mjs`)

Only `ok` is green. Every other case status is a failure and is bucketed into
`semantic_failure`, `completed_after_abort`, `agent_busy`, `runtime_stale`,
`matrix_aborted`, `unproven_tool_claim`, `unledgered_charge`, or
`other_failure`. Failures count unless the operator records an explicit waiver
(`PSFN_SCORECARD_WAIVERS`).

## Coverage cross-check

The scorecard parses the `docs/shakedown.md` coverage appendix and, for each
in-scope surface, requires ≥1 executed mapped case (via `coverage-map.json`) or
an explicit `manual` / `partner` / `waived` disposition. A green scorecard whose
coverage rows are untouched is itself a failure.

## Running

Source the env first (two stages, both `set -a`; see `docs/shakedown.md` and
`shakedown/artie/shakedown.env.template`), then:

```bash
# whole tier sweep (writes per-tier run JSONs under $PSFN_MATRIX_DIR)
PSFN_TIER_FILE=$SYSTEM_DATA_DIR/capability-tier.json \
PSFN_MATRIX_DIR=$SHAKEDOWN_ROOT/artifacts/matrix \
  shakedown/harness/run-live-shakedown-matrix.sh

# scorecard over the sweep output
PSFN_SCORECARD_INPUTS="$PSFN_MATRIX_DIR/live-system-shakedown.nursery.json,$PSFN_MATRIX_DIR/live-system-shakedown.apprentice.json,$PSFN_MATRIX_DIR/live-system-shakedown.autonomous.json" \
PSFN_SCORECARD_JSON=$SHAKEDOWN_ROOT/artifacts/shakedown-scorecard.json \
PSFN_SCORECARD_MD=$SHAKEDOWN_ROOT/SHAKEDOWN-SCORECARD.md \
  shakedown/harness/shakedown-scorecard.mjs
```
