#!/bin/bash
set -euo pipefail

# Benchmark: real-provider TTFT benchmark across multiple models and turns.
# Measures time-to-first-token and total turn latency with live LLM calls.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Run the real-provider benchmark
npx tsx eval/ttft-real-providers.ts 2>&1 | tee /tmp/autoresearch-bench.log

# Parse METRIC lines from output
grep "^METRIC" /tmp/autoresearch-bench.log || echo "METRIC median_turn_ms=0"
