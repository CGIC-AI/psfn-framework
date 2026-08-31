#!/usr/bin/env bash
# Runs the shakedown harness regression tests. The dependency-light Node scripts
# stub the Garden settings API / tier CLI so no live cluster is touched. The
# Vitest verdict suite exercises production harness scoring. Each command exits
# non-zero on failure.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../../.." && pwd)"

tests=(
  "bootstrap-config.test.mjs"  # bootstrap rejects unsafe roots before any write
  "bootstrap-postgres.test.mjs" # bootstrap proves a disposable isolated database/schema
  "bootstrap-runner.test.mjs"  # bootstrap sequences seed/readiness/proof and explicit resume
  "bootstrap-services.test.mjs" # readiness plus exact persisted-turn proof
  "capability-matrix.test.mjs" # 65rk.6: exact 22-token tier/refusal contract
  "case-execution.test.mjs" # per-step recovery fits the case budget; timeout stays case-local
  "memory-tier-catalog.test.mjs" # memory write/patch and delete/restore stay in their capability tiers
  "operator-approval-target.test.mjs" # SSO chat and independent Operator authority stay distinct
  "production-capability-probe.test.mjs" # 65rk.6: production gate and shard boundary
  "host-cleanup.test.mjs" # 65rk.6: host cleanup continues and reports failures
  "probe-provenance.test.mjs" # chat cases auto-attach testing-harness provenance headers
  "target-contract.test.mjs"   # A: tier flip uses the canonical capabilities editor
  "flip-abort.test.mjs"        # C: an unconfirmed forward flip aborts the phase
  "coverage-hole-continuation.test.mjs" # case-local config holes do not abort later tiers
  "persisted-proofs.test.mjs"  # S10 persisted-state proofs fail closed
  "revert-on-signal.test.mjs"  # B: pre-sweep tier restored on SIGINT/SIGTERM
  "tier-conformance-sweep.test.mjs" # D: 3-tier conformance sweep restores + counts ok:false
  "scorecard-coverage-artifacts.test.mjs" # external proof artifacts feed coverage
  "sprint10-catalog.test.mjs"  # S10 catalog metadata and seam inventory
  "hardening-proofs.test.mjs"  # 65rk.9: model-lane attribution + backup encryption proofs fail closed
  "hardening-catalog.test.mjs" # 65rk.9: July hardening catalog metadata and disposition boundary
  "sse-probe.test.mjs"         # first non-empty SSE delta precedes terminal
  "profile-runner.test.mjs"    # 65rk.8: --profile lite|full runner, deadline + signal-safe restore
  "scorecard-profile.test.mjs" # 65rk.8: scorecard profile:lite stamp + attestation gate; full unchanged
)

for t in "${tests[@]}"; do
  echo "===== $t ====="
  node "$TEST_DIR/$t"
  echo
done

npm --prefix "$REPO_ROOT" run test:shakedown-harness

echo "All harness regression tests passed."
