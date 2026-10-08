#!/usr/bin/env bash
# Run every executable harness regression, plus the distinct Vitest verdict
# suite. These use disposable fixtures; none connects to a live runtime.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

for test_file in "$TEST_DIR"/*.test.mjs; do
  # This one suite imports Vitest; all other harness files run with Node.
  [[ "$(basename "$test_file")" == "harness-verdicts.test.mjs" ]] && continue
  node --import tsx "$test_file"
done

npm exec -- vitest run --config shakedown/harness/vitest.config.mjs
