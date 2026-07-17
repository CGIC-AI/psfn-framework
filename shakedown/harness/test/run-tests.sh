#!/usr/bin/env bash
# Runs the shakedown harness regression tests. These are dependency-light Node
# scripts (no test framework) that stub the Garden settings API / tier CLI so no
# live cluster is touched. Each exits non-zero on failure.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

tests=(
  "target-contract.test.mjs"   # A: tier flip uses the canonical capabilities editor
  "flip-abort.test.mjs"        # C: an unconfirmed forward flip aborts the phase
  "revert-on-signal.test.mjs"  # B: pre-sweep tier restored on SIGINT/SIGTERM
)

for t in "${tests[@]}"; do
  echo "===== $t ====="
  node "$TEST_DIR/$t"
  echo
done

echo "All harness regression tests passed."
