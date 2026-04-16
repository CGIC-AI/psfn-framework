#!/bin/bash
set -euo pipefail

# Benchmark: real-provider TTFT benchmark across multiple models and turns.
# Measures time-to-first-token and total turn latency with live LLM calls.
# Runs 3 repetitions and reports the median of medians to reduce provider variance.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

run_bench() {
  npx tsx eval/ttft-real-providers.ts 2>&1 | tee /tmp/autoresearch-bench-${1}.log
  grep "^METRIC median_turn_ms=" /tmp/autoresearch-bench-${1}.log | tail -1
}

echo "=== Run 1/3 ==="
run_bench 1

echo ""
echo "=== Run 2/3 ==="
run_bench 2

echo ""
echo "=== Run 3/3 ==="
run_bench 3

# Extract median_turn_ms values and compute median of medians
values=$(
  for i in 1 2 3; do
    grep "^METRIC median_turn_ms=" /tmp/autoresearch-bench-${i}.log | tail -1 | sed 's/METRIC median_turn_ms=//'
  done | sort -n | tr '\n' ' '
)
read -r v1 v2 v3 <<< "$values"
median_of_medians="$v2"

echo ""
echo "Median of medians: ${median_of_medians}ms"
echo "METRIC median_turn_ms=${median_of_medians}"

# Also print all individual metrics for reference
for i in 1 2 3; do
  echo ""
  echo "--- Run $i metrics ---"
  grep "^METRIC" /tmp/autoresearch-bench-${i}.log || true
done
