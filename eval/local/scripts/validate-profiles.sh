#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

for script_path in "${SCRIPT_DIR}"/*.sh; do
  bash -n "$script_path"
done

while IFS= read -r profile_name; do
  load_profile "$profile_name"
  require_profile_field BACKEND
  require_profile_field HOST
  require_profile_field PORT

  case "$BACKEND" in
    vllm)
      require_profile_field MODEL_ID
      require_profile_field MODEL_CACHE
      require_profile_field MAX_MODEL_LEN
      bash "${SCRIPT_DIR}/launch-vllm.sh" "$profile_name" --dry-run >/dev/null
      ;;
    llama.cpp)
      require_profile_field CTX_SIZE
      if [[ -z "${HF_REPO:-}" && -z "${MODEL_FILE:-}" ]]; then
        die "profile ${profile_name} must set either HF_REPO or MODEL_FILE"
      fi
      bash "${SCRIPT_DIR}/launch-llamacpp.sh" "$profile_name" --dry-run >/dev/null
      ;;
    *)
      die "profile ${profile_name} uses unsupported BACKEND=${BACKEND}"
      ;;
  esac
done < <(list_profiles)

printf '[eval/local] validated %s profiles\n' "$(list_profiles | wc -l | tr -d ' ')"
