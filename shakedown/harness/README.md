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
| `run-shakedown-profile.mjs` | Profile runner: `--profile lite\|full`. `full` reproduces the standard scripted Layer A (matrix sweep + scorecard) with no profile stamp. `lite` runs the manifest's preflight gates, drives the sweep with ~10 stable-id smoke cases at the baseline tier + the capability-gate matrix at all three tiers under a sub-hour deadline (SIGTERM-on-deadline/signal so the sweep's trap restores the tier), then scores with `PSFN_PROFILE=lite`. See `docs/shakedown.md` → "Profiles: lite vs full". |
| `profiles/lite.manifest.json` | Declarative lite-profile manifest: preflight gates, the smoke case subset (by stable id), required tiers + coverage ids, and the sub-hour deadline. Consumed by both `run-shakedown-profile.mjs` and `shakedown-scorecard.mjs`. |
| `bootstrap-local.mjs` | One-command local bootstrap: validates protected roots before any write, builds the RC, seeds owner files, imports Artie, launches split runtime, and prints the exact persisted first-turn record. |
| `live-system-shakedown.mjs` | Tier-tagged case harness. One phase per run; writes a run JSON (tagged with `target`) to `PSFN_SHAKEDOWN_OUTPUT`. |
| `run-live-shakedown-matrix.sh` | Tier sweep: nursery → apprentice → autonomous, for `local` or `kube` (`PSFN_TARGET`). Captures the pre-sweep tier, restores it on exit (trap) **and verifies the restore** — owner-file diff for local, settings-API re-read for kube — even on SIGINT/SIGTERM, and emits one run JSON per tier. |
| `tier-conformance-sweep.mjs` | Kube 3-tier **tool-conformance** sweep. Flips the live tier nursery → apprentice → autonomous (reusing `lib/target.mjs`), triggers `POST /api/admin/tool-conformance/run` + `GET …/latest` at each tier, writes `tool-conformance.<tier>.json` per tier, and restores + confirms the pre-sweep tier on any exit (normal / error / SIGINT / SIGTERM). **Tier-insensitive for capability gating** — see the runbook below. |
| `restart-split-runtime.sh` | Restarts the split gateway/agent runtime for a lane (Postgres backend, health-gated). |
| `operator-ui-sweep.mjs` | Garden behavioral sweep (Playwright) — asserts behavior, not HTTP 200s. |
| `shakedown-scorecard.mjs` | Aggregates run JSONs; enforces the non-green taxonomy and cross-checks the coverage appendix. Exits non-zero if any case is non-green (unwaived) or any appendix surface is uncovered. |
| `coverage-map.json` | Maps each appendix surface to the case ids that exercise it (or an explicit disposition). Maintained per sprint. |

## Sprint 10 coverage cases

`cases/sprint10.mjs` composes domain-focused modules into the existing catalog;
it does not fork the harness. The ten cases cover physical and placeless situated presence, virtual
mindspace and physical precedence, synthetic world telemetry with
`world list/perceive`, hub enrollment and repeatable presence-follow, API and
classified-satellite CogSec document quarantine, temporal history rendering
plus outbound stamp stripping, and incremental SSE first-content
timing. Each output row carries `tier`, `variants`, `feature`, and `proof`
metadata. Its verdict comes from the exact persisted TurnRecord and side
artifacts, never from the assistant's claim.

The physical, placeless, and hub cases require named synthetic satellite
claims. For each prefix below, set `_CLAIM_TYPE`, `_ID`, `_ENDPOINT_ID`, and
`_SESSION_ID`; `_CAPABILITIES` and `_TELEMETRY_SCOPES` are optional:

- `PSFN_SHAKEDOWN_PHYSICAL_SATELLITE`
- `PSFN_SHAKEDOWN_PLACELESS_SATELLITE`
- `PSFN_SHAKEDOWN_HUB_SATELLITE`

Those claims must match three synthetic entries in the round's canonical
`satellites.json`: physical (`living_room`), deliberately placeless, and hub
face telemetry (`kitchen`). The place IDs and labels can be overridden through
the corresponding `PSFN_SHAKEDOWN_*_PLACE_*` values in the Artie env template.
The hub probe resets to the physical fixture, creates and revokes its own opaque enrollment,
then restores the physical place so a rerun starts from the same precondition
(`PSFN_SHAKEDOWN_HUB_IDENTITY_ID` may override the generated handle). The CogSec
document cases require the disposable round's `intake-policy.json` mode to be
`enforce`; shadow mode is intentionally not accepted as quarantine proof. Both
cases prove the held item through the Garden queue, await the memory and emotion
background jobs, assert zero hostile/notice leakage, and discard the synthetic
fixture through Garden's two-step decision path.

The scorecard unions a successful artifact's top-level `coverageCaseIds` with
successful harness case IDs. This is how the real-process multi-companion support
artifact and per-tier capability-conformance artifact cover their appendix
rows without duplicating those runtimes in the chat catalog. Generic external
artifacts must report `status: "passed"` (or `ok: true`); an unrecognized or
failed status makes the scorecard red. The real-HA control, shared-wiki toaster
test, hub/PWA/touch walk, and final Garden UX pass remain explicit manual or
partner dispositions.

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
`shakedown/artie/shakedown.env.template`). The bootstrap host must have `psql`
available for the pre-write disposable-database proof. Then:

```bash
# Fresh local lane. PSFN_LIVE_DATA_ROOTS in the sourced round env is mandatory
# and colon-separated. The env also captures the stage-1 live PostgreSQL URL,
# names an exact dedicated round database + non-default schema, and disables
# external channels unless dedicated shakedown accounts are explicitly opted in.
# A dirty root refuses unless resume is explicit.
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

# scorecard over the sweep plus external support/conformance/UI proof artifacts
PSFN_SCORECARD_INPUTS="$PSFN_MATRIX_DIR/live-system-shakedown.nursery.json,$PSFN_MATRIX_DIR/live-system-shakedown.apprentice.json,$PSFN_MATRIX_DIR/live-system-shakedown.autonomous.json,$PSFN_SUPPORT_ARTIFACT,$PSFN_UI_ARTIFACT" \
PSFN_SCORECARD_JSON=$SHAKEDOWN_ROOT/artifacts/shakedown-scorecard.json \
PSFN_SCORECARD_MD=$SHAKEDOWN_ROOT/SHAKEDOWN-SCORECARD.md \
  shakedown/harness/shakedown-scorecard.mjs
```

## Running the kube tier-conformance sweep

`tier-conformance-sweep.mjs` is the committed, repeatable version of the ad-hoc
3-tier probe that was run against Artie (ARTEMIS, the test companion) on the k3d
cluster. It flips the **live** capability tier nursery → apprentice → autonomous,
triggers the Garden tool-conformance sweep at each tier, captures the per-tier
result JSON, and **guarantees** the pre-sweep tier is restored on any exit.

> **Tier-insensitive caveat (read first).** The default tool-conformance sweep
> probes only **safe reads and schema shapes** (`probeKind` `read_only` /
> `schema_only` / `rejection_check`); it does **not** attempt gated actions. So
> its results are **expected to be identical across all three tiers** — identical
> output is NOT evidence of a gating bug, and this probe does **not** certify
> capability gating. What it proves is that the live tier-flip + confirmed-restore
> contract works and the conformance surface stays healthy while the tier is
> flipped. Real capability-gate certification (does nursery actually deny an
> action autonomous allows?) is **bead 65rk.6**, not this probe.

### Cluster access

Kube context `k3d-psfn-kube-test`, namespace `psfn-test`. Fetch the tokens from
the app secret (names only — never paste the values into any committed file):

```bash
kubectl config use-context k3d-psfn-kube-test
ADMIN_TOKEN="$(kubectl -n psfn-test get secret psfn-app -o jsonpath='{.data.ADMIN_TOKEN}' | base64 -d)"
API_KEY="$(kubectl -n psfn-test get secret psfn-app -o jsonpath='{.data.API_KEY}' | base64 -d)"
```

Stand up the two port-forwards (Garden admin :10054, gateway :10053):

```bash
kubectl -n psfn-test port-forward svc/psfn-garden 10054:10054 &
kubectl -n psfn-test port-forward svc/psfn-gateway 10053:10053 &
```

### Environment

Export (values elided; `POSTGRES_DATABASE_URL` is required because the shared
`resolveTarget` resolver reads it fail-closed for both targets):

```bash
export PSFN_TARGET=kube
export PSFN_API_BASE=http://127.0.0.1:10053     # gateway port-forward
export PSFN_ADMIN_BASE=http://127.0.0.1:10054    # Garden admin port-forward
export API_KEY=…                                 # from the secret above
export ADMIN_TOKEN=…                             # from the secret above
export POSTGRES_DATABASE_URL=…                   # round Postgres (resolver requires it)
export PSFN_MATRIX_DIR=$SHAKEDOWN_ROOT/artifacts/matrix   # or PSFN_ROUND_DIR — output dir
```

Optional knobs (all have safe defaults): `PSFN_ROUND_DIR` (alias for the output
dir), `PSFN_ORIGINAL_TIER_FILE` (durable pre-sweep record, default
`$PSFN_MATRIX_DIR/original-capability-tier`), `PSFN_CONFORMANCE_RUN_TIMEOUT_MS`,
`PSFN_CONFORMANCE_LATEST_TIMEOUT_MS`, `PSFN_CONFORMANCE_SETTLE_MS`,
`PSFN_TIER_FLIP_CONFIRM_TIMEOUT_MS`, `PSFN_TIER_FLIP_POLL_MS`,
`PSFN_TIER_RESTORE_MAX_ATTEMPTS`, `PSFN_TIER_RESTORE_RETRY_DELAY_MS`.

### Run

```bash
node shakedown/harness/tier-conformance-sweep.mjs
```

It writes `tool-conformance.nursery.json`, `tool-conformance.apprentice.json`,
`tool-conformance.autonomous.json` and `original-capability-tier` under the output
dir, and prints a per-tier summary (`total`, `ok:false` count, and each failure as
`toolName/action -> classification (error)`).

### Safety and manual restore

The sweep flips the **live** companion's tier. It records the pre-sweep tier to
the durable `original-capability-tier` file **before any flip**, and restores +
re-reads it on normal exit, on error, and on SIGINT/SIGTERM. A restore that never
confirms after the bounded retries is a **loud FATAL** naming the tier and the
durable record.

If a run is hard-killed (SIGKILL / crash) so no restore trap fires, re-flip
manually through the same fail-closed CLI (still via the settings API, **never**
by editing `capability-tier.json` on the PVC):

```bash
node shakedown/harness/lib/target.mjs set-tier "$(cat "$PSFN_MATRIX_DIR/original-capability-tier")"
```

Prefer the settings-API path above. Direct PVC edits of `capability-tier.json`
are **discouraged** (the harness rule is: change the tier through the settings
API, never by writing the owner file on the PVC). As a genuine last resort — the
settings API is down but the tier must be corrected — you can read, and only if
unavoidable rewrite, the owner file via `kubectl exec` into the companion pod
(`<agent-deploy>` = the agent/runtime deployment, `<system-data-mount>` = the
`system-data` root, both from the live Helm values):

```bash
# inspect first
kubectl -n psfn-test exec deploy/<agent-deploy> -- cat <system-data-mount>/capability-tier.json
# emergency in-place fix (runtime hot-reloads on mtime change); resume the settings-API path ASAP
```

### Tier-flip contract — correct vs rejected

The tier is only mutable through the canonical owner-file editor. Editing it via
the general settings route is **rejected**:

| Contract | Result |
| --- | --- |
| `POST /api/admin/settings/capabilities`, `Content-Type application/x-www-form-urlencoded`, body `configJson=<full owner JSON>` | ✅ 200 `capability-tier.json saved` (whole-file replace; the flip preserves `customTokens`) |
| `PATCH /api/admin/settings {capabilityTier}` | ❌ HTTP 400 `wrong_owner` — `capabilityTier` is owner-mapped and rejected by `validateSettingsPayload` before any mutation |
