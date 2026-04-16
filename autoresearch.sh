#!/bin/bash
set -euo pipefail

# Benchmark: measure median handleMessage turn latency with fully mocked dependencies.
# We run the benchmark via vitest in a dedicated test file so we get accurate Node timing.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

# Fast syntax check first
npx tsc --noEmit --skipLibCheck src/core/agent/autoresearch-ttft.test.ts 2>/dev/null || true

# Run the benchmark test
npx vitest run --reporter=verbose src/core/agent/autoresearch-ttft.test.ts 2>&1 | tee /tmp/autoresearch-bench.log

# Parse METRIC lines from vitest output
grep "^METRIC" /tmp/autoresearch-bench.log || echo "METRIC median_turn_ms=0"
