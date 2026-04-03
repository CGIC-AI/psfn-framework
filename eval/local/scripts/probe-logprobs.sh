#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

PROFILE_NAME_ARG="${1:-}"
PROMPT_TEXT="${2:-Classify the dominant emotion in this sentence as joy, sadness, anger, fear, surprise, or neutral: I finally got the call and burst into relieved tears.}"

load_profile "$PROFILE_NAME_ARG"
require_command curl
require_command jq

BASE_URL="http://${HOST}:${PORT}"

if [[ "${BACKEND:-}" == "vllm" ]]; then
  require_profile_field MODEL_ID
  REQUEST_JSON=$(jq -n \
    --arg model "$MODEL_ID" \
    --arg prompt "$PROMPT_TEXT" \
    '{
      model: $model,
      messages: [
        {
          role: "system",
          content: "Return a one-label answer only."
        },
        {
          role: "user",
          content: $prompt
        }
      ],
      max_tokens: 8,
      temperature: 0,
      top_p: 1,
      logprobs: 5,
      prompt_logprobs: 2
    }')

  curl -fsS \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/v1/chat/completions" \
    -d "$REQUEST_JSON" \
    | jq '{
        id,
        model,
        text: .choices[0].message.content,
        logprobs: .choices[0].logprobs
      }'
  exit 0
fi

if [[ "${BACKEND:-}" == "llama.cpp" ]]; then
  REQUEST_JSON=$(jq -n \
    --arg prompt "$PROMPT_TEXT" \
    '{
      prompt: $prompt,
      n_predict: 8,
      temperature: 0,
      n_probs: 5,
      cache_prompt: false
    }')

  curl -fsS \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/completion" \
    -d "$REQUEST_JSON" \
    | jq '{
        content,
        stop,
        probabilities: .completion_probabilities[0]
      }'
  exit 0
fi

die "unsupported backend in profile ${PROFILE_NAME}: ${BACKEND:-unset}"
