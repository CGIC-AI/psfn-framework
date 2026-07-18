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
  - `lib/target.mjs` — the deployment-target abstraction (below). Single place
    that resolves the transport contract for `local` vs `kube`, and owns the
    kube live tier-flip via the Garden settings API.

## Targets (`PSFN_TARGET`)

Every entrypoint resolves its transport contract through `lib/target.mjs` from
`PSFN_TARGET` (default `local`; any other value than `local`/`kube` is a named,
fail-closed error). The contract — chat base URL, Garden admin base URL, gateway
API key, admin token, Postgres — comes from the same env variables for both
targets, so nothing hardcodes a namespace, service, port, or `/mnt` path:

| Variable | Both targets | Kube note |
| --- | --- | --- |
| `PSFN_TARGET` | `local` (default) / `kube` | — |
| `PSFN_API_BASE` | gateway API base | point at a `kubectl port-forward svc/<gateway> 10053` |
| `PSFN_ADMIN_BASE` | Garden admin base | point at a second `port-forward svc/<garden> 10054` |
| `API_KEY` / `PSFN_API_KEY` | gateway API key | — |
| `ADMIN_TOKEN` / `PSFN_ADMIN_TOKEN` | Garden admin token | fleet-auth token also works |
| `POSTGRES_DATABASE_URL` | round Postgres | reach the deployment DB via a port-forward; proofs run against it |
| `PSFN_TIER_FLIP_CONFIRM_TIMEOUT_MS` | tier-flip confirm budget (default 30000) | kube only |
| `PSFN_TIER_FLIP_POLL_MS` | tier-flip confirm poll interval (default 1500) | kube only |
| `PSFN_ORIGINAL_TIER_FILE` | durable pre-sweep tier record (default `$PSFN_MATRIX_DIR/original-capability-tier`) | kube only |
| `PSFN_TIER_RESTORE_MAX_ATTEMPTS` | bounded revert retries on transient failure (default 5) | kube only |
| `PSFN_TIER_RESTORE_RETRY_DELAY_S` | delay between revert retries (default 2) | kube only |

**local** bootstraps a fresh split runtime; the tier sweep edits
`capability-tier.json` in the round `system-data` and restarts the runtime
between tiers. **kube** targets Artie's persistent deployment: the sweep flips
the tier **live through the canonical owner-file editor** — `capabilityTier` is
an owner-mapped field that `PATCH /api/admin/settings` rejects (HTTP 400
`wrong_owner`), so the tier is only mutable via
`POST /api/admin/settings/capabilities` (`Content-Type`
`application/x-www-form-urlencoded`, body `configJson=<full owner JSON>`). The
flip GETs the current owner object from `GET /api/admin/settings/capabilities`,
swaps only `.tier` while **preserving `customTokens`**, and POSTs the whole
object back; success is HTTP 200 `capability-tier.json saved`. The capability
runtime hot-reloads on the persisted change (no redeploy, no PVC file edit), and
each flip is **confirmed** by re-reading `.tier` from
`GET /api/admin/settings/capabilities` before that tier's cases run — an
unconfirmed flip is a hard error that aborts the phase. The pre-sweep tier is
persisted to a durable record before the first flip and the revert retries a
bounded number of times, confirming the read-back is back to the original before
it is marked restored. Do not bootstrap or wipe the kube lane and never write
owner files on the PVC to change the tier.

`lib/target.mjs` doubles as a CLI the sweep drives (`get-tier`, `set-tier <tier>`,
`check-gateway`, `check-postgres`, `resolve`); each is fail-closed and prints no
secrets.

## Entrypoints

| Script | Role |
| --- | --- |
| `bootstrap-local.mjs` | One-command local bootstrap: validates protected roots before any write, builds the RC, seeds owner files, imports Artie, launches split runtime, and prints the exact persisted first-turn record. |
| `live-system-shakedown.mjs` | Tier-tagged case harness. One phase per run; writes a run JSON (tagged with `target`) to `PSFN_SHAKEDOWN_OUTPUT`. |
| `run-live-shakedown-matrix.sh` | Tier sweep: nursery → apprentice → autonomous, for `local` or `kube` (`PSFN_TARGET`). Captures the pre-sweep tier, restores it on exit (trap) **and verifies the restore** — owner-file diff for local, settings-API re-read for kube — even on SIGINT/SIGTERM, and emits one run JSON per tier. |
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
# Fresh local lane. PSFN_LIVE_DATA_ROOTS in the sourced round env is mandatory
# and colon-separated. A dirty root refuses unless resume is explicit.
npm run shakedown:bootstrap

# Resume a bootstrap that has a matching .bootstrap-state.json. Immutable
# completed stages are skipped; runtime readiness and first-turn proof rerun.
PSFN_SHAKEDOWN_RESUME=1 npm run shakedown:bootstrap

# local tier sweep (writes per-tier run JSONs under $PSFN_MATRIX_DIR)
PSFN_TARGET=local \
PSFN_TIER_FILE=$SYSTEM_DATA_DIR/capability-tier.json \
PSFN_MATRIX_DIR=$SHAKEDOWN_ROOT/artifacts/matrix \
  shakedown/harness/run-live-shakedown-matrix.sh

# kube tier sweep — flip via the settings API, no PVC edit, no redeploy.
# Stand up the two port-forwards first, then point the bases at them:
#   kubectl -n <ns> port-forward svc/<gateway> 10053:10053 &
#   kubectl -n <ns> port-forward svc/<garden>  10054:10054 &
PSFN_TARGET=kube \
PSFN_API_BASE=http://127.0.0.1:10053 \
PSFN_ADMIN_BASE=http://127.0.0.1:10054 \
PSFN_MATRIX_DIR=$SHAKEDOWN_ROOT/artifacts/matrix \
  shakedown/harness/run-live-shakedown-matrix.sh

# scorecard over the sweep output
PSFN_SCORECARD_INPUTS="$PSFN_MATRIX_DIR/live-system-shakedown.nursery.json,$PSFN_MATRIX_DIR/live-system-shakedown.apprentice.json,$PSFN_MATRIX_DIR/live-system-shakedown.autonomous.json" \
PSFN_SCORECARD_JSON=$SHAKEDOWN_ROOT/artifacts/shakedown-scorecard.json \
PSFN_SCORECARD_MD=$SHAKEDOWN_ROOT/SHAKEDOWN-SCORECARD.md \
  shakedown/harness/shakedown-scorecard.mjs
```
