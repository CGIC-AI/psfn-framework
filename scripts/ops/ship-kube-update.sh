#!/usr/bin/env bash
# Ship a PSFN build to the live psfn-shard k3s deployment, component-selectively.
#
#   scripts/ops/ship-kube-update.sh --components agent            # companion-core only
#   scripts/ops/ship-kube-update.sh --components all              # full app stack
#   scripts/ops/ship-kube-update.sh --components agent,garden
#   scripts/ops/ship-kube-update.sh --components emosim           # observer-eval engine only
#
# The build always produces one image from HEAD (shared artifact, three
# entrypoints); "components" selects which deployments move to the new tag.
# Selective rollouts are guarded by the contract-surface hash baked into the
# image: when the new build's hash differs from what the live, non-updated
# components are running, the ship FAILS CLOSED and demands --components all.
#
# "emosim" is a separate Python image (docker/Dockerfile.emosim) built from a
# clean checkout of the sibling emo_sim repo ($PSFN_EMOSIM_SRC, default
# ~/emo_sim) and tagged by THAT repo's commit. It has no TS contract surface,
# so it is outside the contract-hash guard ("all" does not include it); its
# runtime contract (17 appraisal dims / 48 emotions) is verified in-image at
# build time and again by the validation gate.
#
# Target selection: --host <ssh-dest> / PSFN_HOST_ALIAS, --namespace /
# PSFN_NAMESPACE. Build platform (arm64/amd64) is probed from the target node,
# the staging dir defaults to <remote home>/psfn-kube-runtime (override:
# PSFN_REMOTE_DIR), and the companion source checkout path is
# PSFN_SOURCE_CHECKOUT (default /mnt/psfn-nvme/psfn-source; absent dir = skip).
#
# Bead: psfn-framework-hpx6 (+w05a emosim). Proven procedure from the
# 2026-07-06 deploys.
set -euo pipefail

HOST_ALIAS="${PSFN_HOST_ALIAS:-psfn-pi}"
NAMESPACE="${PSFN_NAMESPACE:-psfn}"
REMOTE_DIR="${PSFN_REMOTE_DIR:-}"
SOURCE_CHECKOUT="${PSFN_SOURCE_CHECKOUT:-/mnt/psfn-nvme/psfn-source}"
IMAGE_NAME="psfn-framework"
EMOSIM_IMAGE_NAME="psfn-emosim"
COMPONENTS=""
SKIP_GATE=0
DRY_RUN=0
VALUES_OVERLAY=

usage() {
  sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --components) COMPONENTS="$2"; shift 2 ;;
    --values-overlay) VALUES_OVERLAY="$2"; shift 2 ;;
    --host) HOST_ALIAS="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --skip-gate) SKIP_GATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

[[ -n "$COMPONENTS" ]] || { echo "--components is required (agent|gateway|garden|emosim|all, comma-separated)" >&2; exit 1; }

SHIP_EMOSIM=0
if [[ "$COMPONENTS" == "all" ]]; then
  SELECTED=(agent gateway garden)
else
  SELECTED=()
  IFS=',' read -r -a REQUESTED <<<"$COMPONENTS"
  for c in "${REQUESTED[@]}"; do
    case "$c" in
      agent|gateway|garden) SELECTED+=("$c") ;;
      emosim) SHIP_EMOSIM=1 ;;
      *) echo "invalid component: $c" >&2; exit 1 ;;
    esac
  done
fi
[[ ${#SELECTED[@]} -gt 0 || $SHIP_EMOSIM -eq 1 ]] || { echo "no components selected" >&2; exit 1; }

remote() { ssh "$HOST_ALIAS" "$@"; }
rkubectl() { remote "sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n $NAMESPACE $*"; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "FAIL: working tree is dirty; ship only committed state" >&2
  exit 1
fi

# Probe the target once: build platform must match the node's CPU, and the
# staging dir lives under the remote user's home (psfn on the Pi, o_0 on
# Carlini's miniforum01). Fail closed if the host is unreachable.
REMOTE_ARCH_RAW="$(remote 'uname -m' | tr -d '[:space:]')" \
  || { echo "FAIL: cannot reach ${HOST_ALIAS} to probe architecture" >&2; exit 1; }
case "$REMOTE_ARCH_RAW" in
  aarch64|arm64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="amd64" ;;
  *) echo "FAIL: unsupported remote architecture: ${REMOTE_ARCH_RAW}" >&2; exit 1 ;;
esac
PLATFORM="linux/${ARCH}"
if [[ -z "$REMOTE_DIR" ]]; then
  REMOTE_HOME="$(remote 'echo "$HOME"' | tr -d '[:space:]')"
  [[ -n "$REMOTE_HOME" ]] || { echo "FAIL: cannot resolve remote home on ${HOST_ALIAS}" >&2; exit 1; }
  REMOTE_DIR="${REMOTE_HOME}/psfn-kube-runtime"
fi
remote "mkdir -p ${REMOTE_DIR}"
CACHE_DIR="${PSFN_BUILDX_CACHE:-$HOME/.cache/psfn-buildx}"
[[ "$ARCH" == "arm64" ]] || CACHE_DIR="${CACHE_DIR}-${ARCH}"
echo "==> target ${HOST_ALIAS} ns=${NAMESPACE} arch=${ARCH} staging=${REMOTE_DIR}"

SHORT_SHA="$(git rev-parse --short=8 HEAD)"
FULL_SHA="$(git rev-parse HEAD)"
TAG="0.1.0-kube-${SHORT_SHA}"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/psfn-ship.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

NEW_HASH=""
if [[ ${#SELECTED[@]} -gt 0 ]]; then
  echo "==> building ${IMAGE_NAME}:${TAG} (components to roll: ${SELECTED[*]})"
  git archive HEAD | tar -x -C "$BUILD_DIR"
  mkdir -p "$CACHE_DIR"
  docker buildx build --platform "$PLATFORM" -f "$BUILD_DIR/docker/Dockerfile.agent" \
    --cache-from "type=local,src=$CACHE_DIR" \
    --cache-to "type=local,dest=$CACHE_DIR,mode=max" \
    --label "org.opencontainers.image.revision=${FULL_SHA}" \
    -t "${IMAGE_NAME}:${TAG}" --load "$BUILD_DIR"

  echo "==> in-image verification"
  NEW_HASH="$(docker run --rm --platform "$PLATFORM" --entrypoint cat "${IMAGE_NAME}:${TAG}" /app/contract-hash.txt | tr -d '[:space:]')"
  [[ -n "$NEW_HASH" ]] || { echo "FAIL: image carries no contract hash" >&2; exit 1; }
  docker run --rm --platform "$PLATFORM" --entrypoint sh "${IMAGE_NAME}:${TAG}" -c \
    "grep -q toolCallBlocksByIndex /app/node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js \
     && test -f /app/config/concern-softening.json && command -v bd >/dev/null && command -v rg >/dev/null" \
    || { echo "FAIL: in-image verification (pi-ai patch / config / bd / rg)" >&2; exit 1; }
  echo "    contract hash: $NEW_HASH"
fi

EMOSIM_TAG=""
if [[ $SHIP_EMOSIM -eq 1 ]]; then
  EMOSIM_SRC="${PSFN_EMOSIM_SRC:-$HOME/emo_sim}"
  [[ -d "$EMOSIM_SRC/.git" ]] || { echo "FAIL: emo_sim checkout not found at ${EMOSIM_SRC} (set PSFN_EMOSIM_SRC)" >&2; exit 1; }
  if [[ -n "$(git -C "$EMOSIM_SRC" status --porcelain)" ]]; then
    echo "FAIL: emo_sim working tree at ${EMOSIM_SRC} is dirty; ship only committed state" >&2
    exit 1
  fi
  EMOSIM_SHA="$(git -C "$EMOSIM_SRC" rev-parse --short=8 HEAD)"
  EMOSIM_TAG="0.1.0-emosim-${EMOSIM_SHA}"
  echo "==> building ${EMOSIM_IMAGE_NAME}:${EMOSIM_TAG} (from ${EMOSIM_SRC})"
  mkdir -p "$BUILD_DIR/emosim-src"
  git -C "$EMOSIM_SRC" archive HEAD | tar -x -C "$BUILD_DIR/emosim-src"
  docker buildx build --platform "$PLATFORM" -f "docker/Dockerfile.emosim" \
    -t "${EMOSIM_IMAGE_NAME}:${EMOSIM_TAG}" --load "$BUILD_DIR/emosim-src"

  echo "==> emosim in-image verification (17 appraisal dims / 48 emotions)"
  docker run --rm --platform "$PLATFORM" --entrypoint python "${EMOSIM_IMAGE_NAME}:${EMOSIM_TAG}" -c \
    "import statemashine, sys; sys.exit(0 if (len(statemashine.APPRAISAL_DIMS) == 17 and len(statemashine.EMOTIONS) == 48) else 1)" \
    || { echo "FAIL: emosim in-image contract verification" >&2; exit 1; }
fi

if [[ ${#SELECTED[@]} -gt 0 && ${#SELECTED[@]} -lt 3 ]]; then
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
  echo "==> dry run: stopping before ship. tag=${TAG} hash=${NEW_HASH:-<no app build>} emosim_tag=${EMOSIM_TAG:-<not selected>}"
  exit 0
fi

if [[ ${#SELECTED[@]} -gt 0 ]]; then
  echo "==> shipping image to ${HOST_ALIAS}"
  docker save "${IMAGE_NAME}:${TAG}" | gzip >"$BUILD_DIR/image.tar.gz"
  scp "$BUILD_DIR/image.tar.gz" "${HOST_ALIAS}:${REMOTE_DIR}/psfn-${SHORT_SHA}-${ARCH}.tar.gz"
  remote "cd ${REMOTE_DIR} && gunzip -f psfn-${SHORT_SHA}-${ARCH}.tar.gz \
    && sudo k3s ctr images import psfn-${SHORT_SHA}-${ARCH}.tar >/dev/null \
    && sudo k3s ctr images tag docker.io/library/${IMAGE_NAME}:${TAG} localhost/${IMAGE_NAME}:${TAG} >/dev/null \
    && rm -f psfn-${SHORT_SHA}-${ARCH}.tar"
fi

if [[ $SHIP_EMOSIM -eq 1 ]]; then
  echo "==> shipping emosim image to ${HOST_ALIAS}"
  docker save "${EMOSIM_IMAGE_NAME}:${EMOSIM_TAG}" | gzip >"$BUILD_DIR/emosim-image.tar.gz"
  scp "$BUILD_DIR/emosim-image.tar.gz" "${HOST_ALIAS}:${REMOTE_DIR}/emosim-${EMOSIM_SHA}-${ARCH}.tar.gz"
  remote "cd ${REMOTE_DIR} && gunzip -f emosim-${EMOSIM_SHA}-${ARCH}.tar.gz \
    && sudo k3s ctr images import emosim-${EMOSIM_SHA}-${ARCH}.tar >/dev/null \
    && sudo k3s ctr images tag docker.io/library/${EMOSIM_IMAGE_NAME}:${EMOSIM_TAG} localhost/${EMOSIM_IMAGE_NAME}:${EMOSIM_TAG} >/dev/null \
    && rm -f emosim-${EMOSIM_SHA}-${ARCH}.tar"
fi

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
if [[ $SHIP_EMOSIM -eq 1 ]]; then
  # Persisted into release values by this upgrade, so later app-only ships
  # (which reuse exported live values) keep the emosim deployment as-is.
  HELM_SETS+=("--set" "emosim.enabled=true")
  HELM_SETS+=("--set" "emosim.image.repository=localhost/${EMOSIM_IMAGE_NAME}")
  HELM_SETS+=("--set" "emosim.image.tag=${EMOSIM_TAG}")
fi
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
if [[ $SHIP_EMOSIM -eq 1 ]]; then
  rkubectl rollout status deploy/psfn-emosim --timeout=300s
fi

if [[ $SKIP_GATE -eq 1 ]]; then
  echo "==> gate skipped (--skip-gate)"
  exit 0
fi

echo "==> refreshing companion self-management copies (repo checkout + beads)"
if remote "test -d ${SOURCE_CHECKOUT}/.git" 2>/dev/null; then
  git bundle create "$BUILD_DIR/repo.bundle" HEAD >/dev/null 2>&1
  scp "$BUILD_DIR/repo.bundle" "${HOST_ALIAS}:/tmp/psfn-repo-refresh.bundle"
  remote "sudo git -C ${SOURCE_CHECKOUT} fetch /tmp/psfn-repo-refresh.bundle HEAD 2>/dev/null     && sudo git -C ${SOURCE_CHECKOUT} reset --hard FETCH_HEAD >/dev/null     && sudo chown -R 999:999 ${SOURCE_CHECKOUT} && rm -f /tmp/psfn-repo-refresh.bundle"     && echo "    source checkout refreshed to $(git rev-parse --short=8 HEAD)"     || echo "    WARNING: source checkout refresh failed (non-fatal)"
else
  echo "    no source checkout on host; skipping repo refresh"
fi
if PSFN_HOST_ALIAS="$HOST_ALIAS" PSFN_NAMESPACE="$NAMESPACE" bash "$(dirname "$0")/sync-companion-beads.sh" >/dev/null 2>&1; then
  echo "    beads round-trip synced"
else
  echo "    WARNING: beads sync failed (non-fatal; run scripts/ops/sync-companion-beads.sh manually)"
fi

echo "==> validation gate"
GATE_ARGS=(--remote --host "$HOST_ALIAS" --namespace "$NAMESPACE" --smoke)
if [[ ${#SELECTED[@]} -eq 3 ]]; then
  GATE_ARGS+=(--expect-tag "$TAG")
fi
bash "$(dirname "$0")/validate-kube-rollout.sh" "${GATE_ARGS[@]}"
