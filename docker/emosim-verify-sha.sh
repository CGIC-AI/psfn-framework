#!/bin/sh
# Fail-closed pin check for the emo_sim observer-sidecar build.
#
# The emo_sim source is NOT vendored in this repository; the build context is a
# checkout of the sibling emo_sim repo (see docker/Dockerfile.emosim). This
# script is the single source of truth for the pin comparison so the logic is
# unit-testable in isolation and identical to what the Dockerfile enforces.
#
# Contract:
#   EXPECTED_EMOSIM_SHA  (env)  the pinned upstream commit; MUST be set.
#   $1                   (arg)  the actual SHA of the build-context checkout,
#                               e.g. `git --git-dir=.git rev-parse HEAD`.
#
# Exit codes:
#   0  actual == expected            (pin satisfied)
#   1  actual != expected            (wrong checkout — refuse)
#   2  expected or actual is empty   (misconfiguration — refuse, fail closed)
#
# There is no "skip" path: a missing SHA on either side refuses the build.
set -eu

expected="${EXPECTED_EMOSIM_SHA:-}"
actual="${1:-}"

if [ -z "$expected" ]; then
  echo "emosim-verify-sha: EXPECTED_EMOSIM_SHA is empty; refusing (fail closed)" >&2
  exit 2
fi
if [ -z "$actual" ]; then
  echo "emosim-verify-sha: no actual build-context SHA provided; refusing (fail closed)" >&2
  exit 2
fi
if [ "$actual" != "$expected" ]; then
  echo "emosim-verify-sha: build context SHA $actual != pinned $expected; refusing to build" >&2
  exit 1
fi

echo "emosim-verify-sha: OK (pinned $expected)"
