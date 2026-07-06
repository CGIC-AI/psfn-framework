#!/usr/bin/env bash
# Ship a PSFN build to the live psfn-shard k3s deployment, component-selectively.
#
#   scripts/ops/ship-kube-update.sh --components agent            # companion-core only
#   scripts/ops/ship-kube-update.sh --components all              # full stack
#   scripts/ops/ship-kube-update.sh --components agent,garden
#
# The build always produces one image from HEAD (shared artifact, three
# entrypoints); "components" selects which deployments move to the new tag.
# Selective rollouts are guarded by the contract-surface hash baked into the
# image: when the new build's hash differs from what the live, non-updated
# components are running, the ship FAILS CLOSED and demands --components all.
#
# Bead: psfn-framework-hpx6. Proven procedure from the 2026-07-06 deploys.
set -euo pipefail

HOST_ALIAS="${PSFN_HOST_ALIAS:-psfn-pi}"
NAMESPACE="${PSFN_NAMESPACE:-psfn}"
REMOTE_DIR="/home/psfn/psfn-kube-runtime"
IMAGE_NAME="psfn-framework"
CACHE_DIR="${PSFN_BUILDX_CACHE:-$HOME/.cache/psfn-buildx}"
COMPONENTS=""
SKIP_GATE=0
DRY_RUN=0
VALUES_OVERLAY=

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --components) COMPONENTS="$2"; shift 2 ;;
    --values-overlay) VALUES_OVERLAY="$2"; shift 2 ;;
    --host) HOST_ALIAS="$2"; shift 2 ;;
    --skip-gate) SKIP_GATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

[[ -n "$COMPONENTS" ]] || { echo "--components is required (agent|gateway|garden|all, comma-separated)" >&2; exit 1; }

if [[ "$COMPONENTS" == "all" ]]; then
  SELECTED=(agent gateway garden)
else
  IFS=',' read -r -a SELECTED <<<"$COMPONENTS"
  for c in "${SELECTED[@]}"; do
    case "$c" in agent|gateway|garden) ;; *) echo "invalid component: $c" >&2; exit 1 ;; esac
  done
fi

remote() { ssh "$HOST_ALIAS" "$@"; }
rkubectl() { remote "sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n $NAMESPACE $*"; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "FAIL: working tree is dirty; ship only committed state" >&2
  exit 1
fi

SHORT_SHA="$(git rev-parse --short=8 HEAD)"
FULL_SHA="$(git rev-parse HEAD)"
TAG="0.1.0-kube-${SHORT_SHA}"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/psfn-ship.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "==> building ${IMAGE_NAME}:${TAG} (components to roll: ${SELECTED[*]})"
git archive HEAD | tar -x -C "$BUILD_DIR"
mkdir -p "$CACHE_DIR"
docker buildx build --platform linux/arm64 -f "$BUILD_DIR/docker/Dockerfile.agent" \
  --cache-from "type=local,src=$CACHE_DIR" \
  --cache-to "type=local,dest=$CACHE_DIR,mode=max" \
  -t "${IMAGE_NAME}:${TAG}" --load "$BUILD_DIR"

echo "==> in-image verification"
NEW_HASH="$(docker run --rm --platform linux/arm64 --entrypoint cat "${IMAGE_NAME}:${TAG}" /app/contract-hash.txt | tr -d '[:space:]')"
[[ -n "$NEW_HASH" ]] || { echo "FAIL: image carries no contract hash" >&2; exit 1; }
docker run --rm --platform linux/arm64 --entrypoint sh "${IMAGE_NAME}:${TAG}" -c \
  "grep -q toolCallBlocksByIndex /app/node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js \
   && test -f /app/config/concern-softening.json && command -v bd >/dev/null && command -v rg >/dev/null" \
  || { echo "FAIL: in-image verification (pi-ai patch / config / bd / rg)" >&2; exit 1; }
echo "    contract hash: $NEW_HASH"

if [[ ${#SELECTED[@]} -lt 3 ]]; then
  echo "==> contract-skew guard (selective rollout requested)"
  for c in agent gateway garden; do
    if [[ ! " ${SELECTED[*]} " == *" $c "* ]]; then
      LIVE_HASH="$(rkubectl exec "deploy/psfn-${c}" -- cat /app/contract-hash.txt 2>/dev/null | tr -d '[:space:]' || true)"
      if [[ -z "$LIVE_HASH" ]]; then
        echo "FAIL: live psfn-${c} carries no contract hash (pre-hash image); first selective ship requires --components all" >&2
        exit 1
      fi
      if [[ "$LIVE_HASH" != "$NEW_HASH" ]]; then
        echo "FAIL: contract hash changed (${LIVE_HASH} -> ${NEW_HASH}); psfn-${c} would skew. Use --components all." >&2
        exit 1
      fi
    fi
  done
  echo "    live components agree with new build; selective rollout is safe"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo "==> dry run: stopping before ship. tag=${TAG} hash=${NEW_HASH}"
  exit 0
fi

echo "==> shipping image to ${HOST_ALIAS}"
docker save "${IMAGE_NAME}:${TAG}" | gzip >"$BUILD_DIR/image.tar.gz"
scp "$BUILD_DIR/image.tar.gz" "${HOST_ALIAS}:${REMOTE_DIR}/psfn-${SHORT_SHA}-arm64.tar.gz"
remote "cd ${REMOTE_DIR} && gunzip -f psfn-${SHORT_SHA}-arm64.tar.gz \
  && sudo k3s ctr images import psfn-${SHORT_SHA}-arm64.tar >/dev/null \
  && sudo k3s ctr images tag docker.io/library/${IMAGE_NAME}:${TAG} localhost/${IMAGE_NAME}:${TAG} >/dev/null \
  && rm -f psfn-${SHORT_SHA}-arm64.tar"

echo "==> shipping chart and upgrading (helm)"
git archive HEAD deploy/helm/psfn | gzip >"$BUILD_DIR/chart.tgz"
scp "$BUILD_DIR/chart.tgz" "${HOST_ALIAS}:${REMOTE_DIR}/chart-${SHORT_SHA}.tgz"
remote "cd ${REMOTE_DIR} && rm -rf chart-${SHORT_SHA} && mkdir -p chart-${SHORT_SHA} && tar xzf chart-${SHORT_SHA}.tgz -C chart-${SHORT_SHA}"
remote "sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm get values psfn -n $NAMESPACE -o yaml > ${REMOTE_DIR}/live-values-${SHORT_SHA}.yaml"
OVERLAY_ARG=""
if [[ -n "$VALUES_OVERLAY" ]]; then
  [[ -f "$VALUES_OVERLAY" ]] || { echo "FAIL: values overlay not found: $VALUES_OVERLAY" >&2; exit 1; }
  scp "$VALUES_OVERLAY" "${HOST_ALIAS}:${REMOTE_DIR}/overlay-${SHORT_SHA}.yaml"
  OVERLAY_ARG="-f ${REMOTE_DIR}/overlay-${SHORT_SHA}.yaml"
fi

HELM_SETS=()
if [[ ${#SELECTED[@]} -eq 3 ]]; then
  PREV_COMMIT="$(rkubectl exec deploy/psfn-agent -- sh -c 'echo "$PSFN_GIT_COMMIT"' 2>/dev/null | tr -d '[:space:]' || true)"
  HELM_SETS+=("--set" "psfnAppImage.tag=${TAG}")
  HELM_SETS+=("--set" "psfnAppImage.gitCommit=${FULL_SHA}")
  [[ -n "$PREV_COMMIT" ]] && HELM_SETS+=("--set" "psfnAppImage.previousGitCommit=${PREV_COMMIT}")
  # full rollout resets any per-component overrides back to the shared tag
  HELM_SETS+=("--set" "workloads.agent.image.tag=" "--set" "workloads.gateway.image.tag=" "--set" "workloads.garden.image.tag=")
else
  for c in "${SELECTED[@]}"; do
    HELM_SETS+=("--set" "workloads.${c}.image.tag=${TAG}")
  done
  if [[ " ${SELECTED[*]} " == *" agent "* ]]; then
    PREV_COMMIT="$(rkubectl exec deploy/psfn-agent -- sh -c 'echo "$PSFN_GIT_COMMIT"' 2>/dev/null | tr -d '[:space:]' || true)"
    HELM_SETS+=("--set" "psfnAppImage.gitCommit=${FULL_SHA}")
    [[ -n "$PREV_COMMIT" ]] && HELM_SETS+=("--set" "psfnAppImage.previousGitCommit=${PREV_COMMIT}")
  fi
fi

remote "sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm upgrade psfn ${REMOTE_DIR}/chart-${SHORT_SHA}/deploy/helm/psfn -n $NAMESPACE -f ${REMOTE_DIR}/live-values-${SHORT_SHA}.yaml ${OVERLAY_ARG} $(printf '%s ' "${HELM_SETS[@]}") --timeout 10m" | tail -2

echo "==> waiting for selected rollouts"
for c in "${SELECTED[@]}"; do
  rkubectl rollout status "deploy/psfn-${c}" --timeout=300s
done

if [[ $SKIP_GATE -eq 1 ]]; then
  echo "==> gate skipped (--skip-gate)"
  exit 0
fi

echo "==> validation gate"
GATE_ARGS=(--remote --host "$HOST_ALIAS" --namespace "$NAMESPACE" --smoke)
if [[ ${#SELECTED[@]} -eq 3 ]]; then
  GATE_ARGS+=(--expect-tag "$TAG")
fi
bash "$(dirname "$0")/validate-kube-rollout.sh" "${GATE_ARGS[@]}"
