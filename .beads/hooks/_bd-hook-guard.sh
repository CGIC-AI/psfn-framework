#!/usr/bin/env sh

set -eu

hook_name="${1:-}"

if [ "${PSFN_FORCE_BD_GIT_HOOK:-0}" = "1" ]; then
  exit 0
fi

case "$hook_name" in
  pre-commit|prepare-commit-msg)
    ;;
  *)
    exit 0
    ;;
esac

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

if ! staged_paths="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null)"; then
  exit 0
fi

for path in $staged_paths; do
  case "$path" in
    issues.jsonl|.beads/issues.jsonl|.beads/beads.left.jsonl|.beads/beads.left.meta.json)
      exit 0
      ;;
  esac
done

exit 1
