#!/usr/bin/env bash
set -euo pipefail

SHAKEDOWN_ROOT="${PSFN_ARTEMIS_SHAKEDOWN_ROOT:-${HOME}/psfn-artemis-shakedown}"
CLUSTER="${PSFN_ARTEMIS_CLUSTER:-psfn-kube-test}"
NAMESPACE="${PSFN_ARTEMIS_NAMESPACE:-psfn-test}"
RELEASE="${PSFN_ARTEMIS_RELEASE:-psfn}"
COMPANION_ID="${PSFN_ARTEMIS_COMPANION_ID:-11111111-1111-4111-8111-111111111111}"
COMPANION_NAME="${PSFN_ARTEMIS_COMPANION_NAME:-ARTEMIS}"
GATEWAY_LOCAL_PORT="${PSFN_ARTEMIS_GATEWAY_PORT:-10153}"
GARDEN_LOCAL_PORT="${PSFN_ARTEMIS_GARDEN_PORT:-10154}"
RESET_CLUSTER=0
RESET_DATA=1
RUN_PREFETCH=1
RUN_GATE=1
RUN_CHAT_SMOKE=0
START_PORT_FORWARDS=1
PREPARED_ROOT=""
SEED_ROOT=""
COMPANION_AUTH_TOKEN=""
SESSION_INTEGRITY_AUTH_TOKEN=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_FORWARD_RUNNER="${SCRIPT_DIR}/keep-kube-port-forward.sh"

usage() {
  cat <<'EOF'
Usage: scripts/ops/setup-local-artemis-shakedown.sh [options]

Build and install the current checkout into the local k3d Helm shakedown
cluster with Artemis/Artie as the default companion.

Defaults:
  shakedown root: ${HOME}/psfn-artemis-shakedown
  cluster:        psfn-kube-test
  namespace:      psfn-test
  release:        psfn
  companion id:   shakedown-artemis
  gateway URL:    http://127.0.0.1:10153
  Garden URL:     http://127.0.0.1:10154

Options:
  --shakedown-root PATH   Artemis fixture root.
  --cluster NAME          k3d cluster name.
  --namespace NAME        Kubernetes namespace.
  --release NAME          Helm release name.
  --companion-id ID       COMPANION_ID for the local deployment.
  --companion-name NAME   Human-facing companion name.
  --reset-cluster         Recreate the local k3d cluster first.
  --preserve-data         Do not clear/reseed release PVC contents.
  --skip-prefetch         Skip the local HF model prefetch job.
  --skip-gate             Skip post-rollout validation.
  --chat-smoke            Include provider-backed chat smoke in validation.
  --no-port-forward       Do not start localhost port-forwards.
  -h, --help              Show this help.

Secrets:
  The script creates a local app Secret from the current process environment.
  It generates local API/admin/HMAC/backup placeholders when absent, derives
  the role-bound gateway worker proofs (GATEWAY_COMPANION_AUTH_TOKEN and
  GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN) from the same COMPANION_ID and session
  HMAC key, and only copies provider/media keys that are already set in the
  environment. Discord and Telegram keys are deliberately not copied into this
  local shakedown.
EOF
}

while (($# > 0)); do
  case "$1" in
    --shakedown-root)
      SHAKEDOWN_ROOT="${2:?--shakedown-root requires a value}"
      shift 2
      ;;
    --cluster)
      CLUSTER="${2:?--cluster requires a value}"
      shift 2
      ;;
    --namespace)
      NAMESPACE="${2:?--namespace requires a value}"
      shift 2
      ;;
    --release)
      RELEASE="${2:?--release requires a value}"
      shift 2
      ;;
    --companion-id)
      COMPANION_ID="${2:?--companion-id requires a value}"
      shift 2
      ;;
    --companion-name)
      COMPANION_NAME="${2:?--companion-name requires a value}"
      shift 2
      ;;
    --reset-cluster)
      RESET_CLUSTER=1
      shift
      ;;
    --preserve-data)
      RESET_DATA=0
      shift
      ;;
    --skip-prefetch)
      RUN_PREFETCH=0
      shift
      ;;
    --skip-gate)
      RUN_GATE=0
      shift
      ;;
    --chat-smoke)
      RUN_CHAT_SMOKE=1
      shift
      ;;
    --no-port-forward)
      START_PORT_FORWARDS=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 2
  }
}

cleanup_prepared_root() {
  if [[ -n "$PREPARED_ROOT" && -d "$PREPARED_ROOT" ]]; then
    rm -rf "$PREPARED_ROOT"
  fi
  if [[ -n "${SECRET_ENV_FILE:-}" && -f "$SECRET_ENV_FILE" ]]; then
    rm -f "$SECRET_ENV_FILE"
  fi
}

trap cleanup_prepared_root EXIT

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
  fi
}

prepare_seed_root() {
  PREPARED_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/psfn-artemis-seed.XXXXXX")"
  mkdir -p "$PREPARED_ROOT/system-data" "$PREPARED_ROOT/companion-data" "$PREPARED_ROOT/workspace"
  cp -a "${SHAKEDOWN_ROOT}/system-data/." "$PREPARED_ROOT/system-data/"
  cp -a "${SHAKEDOWN_ROOT}/companion-data/." "$PREPARED_ROOT/companion-data/"
  if [[ -d "${SHAKEDOWN_ROOT}/workspace" ]]; then
    cp -a "${SHAKEDOWN_ROOT}/workspace/." "$PREPARED_ROOT/workspace/"
  fi

  node - "$PREPARED_ROOT/system-data" "$PWD/config" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [, , systemDataDir, configDir] = process.argv;

// Fleet-only owner files (companions.json) make every single-companion process
// fail closed when PSFN_MULTI_COMPANION is disabled, so they are only seeded
// when the multi-companion topology is explicitly enabled. The truthiness set
// mirrors src/system/config/companions-config.ts (isMultiCompanionEnabled).
const FLEET_ONLY_TARGETS = new Set(['companions.json']);

function parseBooleanEnv(raw) {
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function isMultiCompanionEnabled() {
  const raw = process.env.PSFN_MULTI_COMPANION;
  const normalized = raw?.trim();
  if (!normalized) return false;
  const parsed = parseBooleanEnv(normalized);
  if (parsed === undefined) {
    throw new Error(
      `Invalid PSFN_MULTI_COMPANION=${JSON.stringify(raw)}. `
        + 'Expected a boolean flag (1/0, true/false, yes/no, on/off).',
    );
  }
  return parsed;
}

const multiCompanion = isMultiCompanionEnabled();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeDefaults(defaults, current) {
  if (!isRecord(defaults) || !isRecord(current)) {
    return current;
  }

  const merged = { ...defaults };
  for (const [key, value] of Object.entries(current)) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      merged[key] = mergeDefaults(defaults[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function sameStringSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function normalizeTrustPolicy(owner) {
  if (!isRecord(owner)) {
    return owner;
  }
  const normalized = { ...owner };

  if (isRecord(owner.visibilityAllowed)) {
    const visibilityAllowed = { ...owner.visibilityAllowed };
    if (Object.prototype.hasOwnProperty.call(visibilityAllowed, 'semi_private')) {
      visibilityAllowed.invite_only = visibilityAllowed.semi_private;
      delete visibilityAllowed.semi_private;
    }
    if (Object.prototype.hasOwnProperty.call(visibilityAllowed, 'broadcast')) {
      if (!sameStringSet(visibilityAllowed.broadcast, visibilityAllowed.public)) {
        throw new Error('legacy trust-policy visibilityAllowed.broadcast differs from public');
      }
      delete visibilityAllowed.broadcast;
    }
    normalized.visibilityAllowed = visibilityAllowed;
  }

  if (isRecord(owner.channelClassification)) {
    const channelClassification = { ...owner.channelClassification };
    if (channelClassification.defaultVisibility === 'semi_private') {
      channelClassification.defaultVisibility = 'invite_only';
    }
    if (isRecord(channelClassification.visibilityOverrides)) {
      const visibilityOverrides = { ...channelClassification.visibilityOverrides };
      for (const scope of ['exact', 'prefix']) {
        if (!isRecord(visibilityOverrides[scope])) {
          continue;
        }
        const entries = { ...visibilityOverrides[scope] };
        for (const [key, value] of Object.entries(entries)) {
          if (value === 'semi_private') {
            entries[key] = 'invite_only';
          } else if (value === 'broadcast') {
            entries[key] = { privacy: 'public', broadcast: true };
          }
        }
        visibilityOverrides[scope] = entries;
      }
      channelClassification.visibilityOverrides = visibilityOverrides;
    }
    normalized.channelClassification = channelClassification;
  }

  return normalized;
}

function normalizeOwner(targetName, owner) {
  if (targetName === 'trust-policy.json') {
    return normalizeTrustPolicy(owner);
  }
  return owner;
}

const migrated = [];
const skipped = [];
for (const entry of fs.readdirSync(configDir)) {
  if (!entry.endsWith('.seed.json')) {
    continue;
  }
  const targetName = entry.replace(/\.seed\.json$/, '.json');
  if (FLEET_ONLY_TARGETS.has(targetName) && !multiCompanion) {
    skipped.push(targetName);
    continue;
  }
  const seedPath = path.join(configDir, entry);
  const targetPath = path.join(systemDataDir, targetName);
  const seed = readJson(seedPath);
  const owner = normalizeOwner(targetName, fs.existsSync(targetPath) ? mergeDefaults(seed, readJson(targetPath)) : seed);
  fs.writeFileSync(targetPath, `${JSON.stringify(owner, null, 2)}\n`);
  migrated.push(targetName);
}

// Fleet-only owners must never be left behind in single-companion mode, even if
// the fixture shipped one: retaining companions.json fails all processes closed.
if (!multiCompanion) {
  for (const targetName of FLEET_ONLY_TARGETS) {
    const targetPath = path.join(systemDataDir, targetName);
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath);
      skipped.push(targetName);
    }
  }
}

console.log(
  `prepared ${migrated.length} system owner files from current seed defaults`
    + (skipped.length > 0 ? `; withheld fleet-only owners: ${[...new Set(skipped)].join(', ')}` : ''),
);
NODE

  SEED_ROOT="$PREPARED_ROOT"
}

wait_pvc_bound() {
  local pvc=$1
  local deadline=$((SECONDS + 180))
  while ((SECONDS < deadline)); do
    if [[ "$(kubectl -n "$NAMESPACE" get pvc "$pvc" -o jsonpath='{.status.phase}' 2>/dev/null || true)" == "Bound" ]]; then
      return 0
    fi
    sleep 2
  done
  kubectl -n "$NAMESPACE" get pvc "$pvc" || true
  echo "PVC did not become Bound: $pvc" >&2
  exit 1
}

helm_base_args() {
  local short=$1
  local full=$2
  printf '%s\0' \
    "$RELEASE" deploy/helm/psfn \
    --namespace "$NAMESPACE" \
    --create-namespace \
    --set psfnAppImage.repository=localhost/psfn-framework \
    --set "psfnAppImage.tag=0.1.0-kube-${short}" \
    --set-string psfnAppImage.digest= \
    --set psfnAppImage.pullPolicy=IfNotPresent \
    --set "psfnAppImage.gitCommit=${full}" \
    --set "runtime.companionId=${COMPANION_ID}" \
    --set "runtime.companionName=${COMPANION_NAME}" \
    --set identity.seedStarterCard=false \
    --set bootstrap.seedOwnerFiles=false \
    --set secrets.create=false \
    --set secrets.existingSecret=psfn-app
}

helm_upgrade() {
  local short=$1
  local full=$2
  shift 2
  local -a args=()
  while IFS= read -r -d '' arg; do
    args+=("$arg")
  done < <(helm_base_args "$short" "$full")
  helm upgrade --install "${args[@]}" "$@"
}

# Derive the role-bound gateway worker proofs the runtime requires from the SAME
# COMPANION_ID and session HMAC key that go into the app Secret. These are HMAC
# proofs, not independent placeholders: without a valid
# GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN the agent container fails closed
# (CreateContainerConfigError), and without GATEWAY_COMPANION_AUTH_TOKEN the
# worker cannot authenticate to the gateway. Delegates to the canonical helper.
derive_role_bound_tokens() {
  local hmac_key=$1
  local auth_output=""
  if [[ -x ./node_modules/.bin/tsx ]]; then
    auth_output="$(COMPANION_ID="$COMPANION_ID" GATEWAY_SESSION_HMAC_KEY="$hmac_key" \
      ./node_modules/.bin/tsx scripts/resolve-single-companion-auth.ts)" || {
      echo "failed to derive role-bound gateway credentials" >&2
      exit 1
    }
  else
    auth_output="$(COMPANION_ID="$COMPANION_ID" GATEWAY_SESSION_HMAC_KEY="$hmac_key" \
      npm run --silent resolve:single-companion-auth)" || {
      echo "failed to derive role-bound gateway credentials" >&2
      exit 1
    }
  fi
  IFS=$'\t' read -r COMPANION_AUTH_TOKEN SESSION_INTEGRITY_AUTH_TOKEN <<<"$auth_output"
  if [[ -z "$COMPANION_AUTH_TOKEN" || -z "$SESSION_INTEGRITY_AUTH_TOKEN" ]]; then
    echo "gateway credential helper returned an invalid response" >&2
    exit 1
  fi
}

write_app_secret_env() {
  local path=$1
  chmod 600 "$path"
  local hmac_key="${GATEWAY_SESSION_HMAC_KEY:-$(random_secret)}"
  derive_role_bound_tokens "$hmac_key"
  {
    printf 'API_KEY=%s\n' "${API_KEY:-$(random_secret)}"
    printf 'ADMIN_TOKEN=%s\n' "${ADMIN_TOKEN:-$(random_secret)}"
    printf 'GATEWAY_SESSION_HMAC_KEY=%s\n' "$hmac_key"
    printf 'GATEWAY_COMPANION_AUTH_TOKEN=%s\n' "$COMPANION_AUTH_TOKEN"
    printf 'GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN=%s\n' "$SESSION_INTEGRITY_AUTH_TOKEN"
    printf 'PSFN_BACKUP_ENCRYPTION_KEY=%s\n' "${PSFN_BACKUP_ENCRYPTION_KEY:-$(random_secret)}"
    printf 'LITELLM_API_KEY=%s\n' "${LITELLM_API_KEY:-$(random_secret)}"
    printf 'OPENROUTER_API_KEY=%s\n' "${OPENROUTER_API_KEY:-}"
    printf 'OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY:-}"
    printf 'EMBEDDING_API_KEY=%s\n' "${EMBEDDING_API_KEY:-}"
    printf 'HF_TOKEN=%s\n' "${HF_TOKEN:-}"
    printf 'FAL_API_KEY=%s\n' "${FAL_API_KEY:-}"
    printf 'DEEPGRAM_API_KEY=%s\n' "${DEEPGRAM_API_KEY:-}"
    printf 'ELEVENLABS_API_KEY=%s\n' "${ELEVENLABS_API_KEY:-}"
    printf 'NTFY_TOKEN=%s\n' "${NTFY_TOKEN:-}"
    printf 'DISCORD_TOKEN=\n'
    printf 'DISCORD_BOT_ID=\n'
  } >"$path"
}

create_local_app_secret() {
  local env_file
  env_file="$(mktemp "${TMPDIR:-/tmp}/psfn-artemis-secret.XXXXXX")"
  SECRET_ENV_FILE="$env_file"
  write_app_secret_env "$env_file"
  kubectl -n "$NAMESPACE" create secret generic psfn-app \
    --from-env-file="$env_file" \
    --dry-run=client \
    -o yaml \
    | kubectl apply -f -
  rm -f "$env_file"
}

launch_seed_pod() {
  local short=$1
  local pod=$2
  local image="localhost/psfn-framework:0.1.0-kube-${short}"

  kubectl -n "$NAMESPACE" delete pod "$pod" --ignore-not-found --wait=true >/dev/null
  cat <<YAML | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${pod}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: psfn
    app.kubernetes.io/instance: ${RELEASE}
    app.kubernetes.io/component: artemis-seed
spec:
  restartPolicy: Never
  containers:
    - name: seed
      image: ${image}
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "sleep 3600"]
      securityContext:
        runAsUser: 0
        runAsGroup: 0
      volumeMounts:
        - name: system-data
          mountPath: /target/system-data
        - name: companion-data
          mountPath: /target/companion-data
        - name: workspace
          mountPath: /target/workspace
  volumes:
    - name: system-data
      persistentVolumeClaim:
        claimName: ${RELEASE}-system-data
    - name: companion-data
      persistentVolumeClaim:
        claimName: ${RELEASE}-companion-data
    - name: workspace
      persistentVolumeClaim:
        claimName: ${RELEASE}-workspace
YAML
  kubectl -n "$NAMESPACE" wait --for=condition=Ready "pod/${pod}" --timeout=180s
}

delete_seed_pod() {
  local pod=$1
  kubectl -n "$NAMESPACE" delete pod "$pod" --wait=true >/dev/null
}

seed_artemis_files() {
  local short=$1
  local pod=psfn-artemis-seed
  launch_seed_pod "$short" "$pod"
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c 'rm -rf /seed && mkdir -p /seed/system-data /seed/companion-data /seed/workspace'
  kubectl -n "$NAMESPACE" cp "${SEED_ROOT}/system-data/." "${pod}:/seed/system-data"
  kubectl -n "$NAMESPACE" cp "${SEED_ROOT}/companion-data/." "${pod}:/seed/companion-data"
  if [[ -d "${SEED_ROOT}/workspace" ]]; then
    kubectl -n "$NAMESPACE" cp "${SEED_ROOT}/workspace/." "${pod}:/seed/workspace"
  fi
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c '
    set -eu
    rm -rf /target/system-data/* /target/companion-data/* /target/workspace/*
    cp -a /seed/system-data/. /target/system-data/
    cp -a /seed/companion-data/. /target/companion-data/
    cp -a /seed/workspace/. /target/workspace/
    chown -R 999:999 /target/system-data /target/companion-data /target/workspace
    test -f /target/system-data/settings.json
    test -f /target/system-data/models.json
    test -f /target/system-data/providers.json
    test -f /target/companion-data/companion.json
  '
  delete_seed_pod "$pod"
}

# Preserve-mode owner-file migration: keep every existing owner file exactly as
# it is on the PVC and only add owner files that are newly required by the
# current runtime (e.g. intake-policy.json) but absent from a PVC that predates
# them. Existing mutable owners are never overwritten, and fleet-only owners
# withheld by prepare_seed_root (single-companion mode) are never introduced.
migrate_missing_owner_files() {
  local short=$1
  local pod=psfn-artemis-migrate
  launch_seed_pod "$short" "$pod"
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c 'rm -rf /seed && mkdir -p /seed/system-data'
  kubectl -n "$NAMESPACE" cp "${SEED_ROOT}/system-data/." "${pod}:/seed/system-data"
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c '
    set -eu
    for seed in /seed/system-data/*.json; do
      [ -e "$seed" ] || continue
      name="$(basename "$seed")"
      if [ -e "/target/system-data/$name" ]; then
        continue
      fi
      cp -a "$seed" "/target/system-data/$name"
      chown 999:999 "/target/system-data/$name"
      echo "seeded missing owner file: $name"
    done
  '
  delete_seed_pod "$pod"
}

start_port_forward() {
  local name=$1
  local target=$2
  local mapping=$3
  local dir="${TMPDIR:-/tmp}/psfn-artemis-helm-port-forward"
  mkdir -p "$dir"
  local pidfile="${dir}/${name}.pid"
  if [[ -f "$pidfile" ]]; then
    local old_pid
    old_pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ "$old_pid" =~ ^[0-9]+$ ]]; then
      local old_command
      old_command="$(ps -p "$old_pid" -o args= 2>/dev/null || true)"
      if [[ "$old_command" == *"keep-kube-port-forward.sh"* || "$old_command" == kubectl\ *port-forward* ]]; then
        kill "$old_pid" 2>/dev/null || true
        wait "$old_pid" 2>/dev/null || true
      fi
    fi
    rm -f "$pidfile"
  fi
  nohup setsid "$PORT_FORWARD_RUNNER" \
    --context "k3d-${CLUSTER}" \
    --namespace "$NAMESPACE" \
    --target "$target" \
    --mapping "$mapping" \
    >"${dir}/${name}.log" 2>&1 &
  echo "$!" >"$pidfile"
}

wait_http() {
  local url=$1
  local deadline=$((SECONDS + 60))
  while ((SECONDS < deadline)); do
    if node -e 'fetch(process.argv[1]).then((r)=>process.exit(r.status < 500 ? 0 : 1)).catch(()=>process.exit(1))' "$url"; then
      return 0
    fi
    sleep 1
  done
  echo "endpoint did not become reachable: $url" >&2
  return 1
}

require_command git
require_command docker
require_command helm
require_command kubectl
require_command k3d
require_command node
require_command setsid

[[ -d "$SHAKEDOWN_ROOT/system-data" ]] || { echo "missing system-data under $SHAKEDOWN_ROOT" >&2; exit 2; }
[[ -d "$SHAKEDOWN_ROOT/companion-data" ]] || { echo "missing companion-data under $SHAKEDOWN_ROOT" >&2; exit 2; }
[[ -f "$SHAKEDOWN_ROOT/companion-data/companion.json" ]] || { echo "missing Artemis companion.json" >&2; exit 2; }
prepare_seed_root

SHORT="$(git rev-parse --short=8 HEAD)"
FULL="$(git rev-parse HEAD)"
TAG="0.1.0-kube-${SHORT}"

echo "==> local Artemis Helm shakedown"
echo "    commit=${FULL}"
echo "    tag=${TAG}"
echo "    shakedown_root=${SHAKEDOWN_ROOT}"
echo "    prepared_seed_root=${SEED_ROOT}"
echo "    cluster=${CLUSTER} namespace=${NAMESPACE} release=${RELEASE}"
echo "    companion_id=${COMPANION_ID}"

if ((RESET_CLUSTER)); then
  k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
fi
if ! k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  k3d cluster create "$CLUSTER" --servers 1 --agents 0 --wait
fi
kubectl config use-context "k3d-${CLUSTER}" >/dev/null

helm repo add jetstack https://charts.jetstack.io >/dev/null
helm repo update jetstack >/dev/null
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.20.3 \
  --set crds.enabled=true >/dev/null
kubectl -n cert-manager rollout status deploy/cert-manager --timeout=180s
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=180s
kubectl -n cert-manager rollout status deploy/cert-manager-cainjector --timeout=180s

echo "==> building ${TAG}"
docker build --platform linux/amd64 \
  --label "org.opencontainers.image.revision=${SHORT}" \
  -f docker/Dockerfile.agent \
  -t "localhost/psfn-framework:${TAG}" \
  -t localhost/psfn-framework:0.1.0-kube .
k3d image import "localhost/psfn-framework:${TAG}" -c "$CLUSTER"

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
create_local_app_secret

if ((RESET_DATA)); then
  echo "==> resetting local release data in namespace ${NAMESPACE}"
  helm uninstall "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete pvc \
    "${RELEASE}-system-data" \
    "${RELEASE}-companion-data" \
    "${RELEASE}-workspace" \
    "${RELEASE}-runtime" \
    "${RELEASE}-model-cache" \
    "data-${RELEASE}-postgres-0" \
    "data-${RELEASE}-redis-0" \
    --ignore-not-found --wait=true >/dev/null
fi

echo "==> installing PVCs and backing services with app replicas disabled"
helm_upgrade "$SHORT" "$FULL" \
  --set workloads.agent.replicaCount=0 \
  --set workloads.gateway.replicaCount=0 \
  --set workloads.garden.replicaCount=0 \
  --timeout 10m >/dev/null

if ((RESET_DATA)); then
  echo "==> seeding Artemis owner files into local PVCs"
  seed_artemis_files "$SHORT"
else
  echo "==> preserving existing PVC contents; migrating only newly required owner files"
  migrate_missing_owner_files "$SHORT"
fi

if ((RUN_PREFETCH)); then
  echo "==> prefetching local text-emotion model cache"
  kubectl -n "$NAMESPACE" delete job "${RELEASE}-model-prefetch" --ignore-not-found --wait=true >/dev/null
  helm_upgrade "$SHORT" "$FULL" \
    --set workloads.agent.replicaCount=0 \
    --set workloads.gateway.replicaCount=0 \
    --set workloads.garden.replicaCount=0 \
    --set modelPrefetch.enabled=true \
    --timeout 10m >/dev/null
  kubectl -n "$NAMESPACE" wait --for=condition=complete "job/${RELEASE}-model-prefetch" --timeout=30m
fi

echo "==> enabling Artemis app deployments"
helm_upgrade "$SHORT" "$FULL" \
  --set modelPrefetch.enabled=false \
  --set workloads.agent.replicaCount=1 \
  --set workloads.gateway.replicaCount=1 \
  --set workloads.garden.replicaCount=1 \
  --timeout 10m >/dev/null

kubectl -n "$NAMESPACE" rollout status deploy/psfn-agent --timeout=300s
kubectl -n "$NAMESPACE" rollout status deploy/psfn-gateway --timeout=300s
kubectl -n "$NAMESPACE" rollout status deploy/psfn-garden --timeout=300s

if ((START_PORT_FORWARDS)); then
  echo "==> starting local port-forwards"
  start_port_forward gateway "svc/${RELEASE}-gateway" "${GATEWAY_LOCAL_PORT}:10053"
  start_port_forward garden "svc/${RELEASE}-garden" "${GARDEN_LOCAL_PORT}:10054"
  wait_http "http://127.0.0.1:${GARDEN_LOCAL_PORT}/health" || true
  echo "    gateway=http://127.0.0.1:${GATEWAY_LOCAL_PORT}"
  echo "    garden=http://127.0.0.1:${GARDEN_LOCAL_PORT}"
fi

if ((RUN_GATE)); then
  echo "==> validation gate"
  gate_args=(--local --namespace "$NAMESPACE" --expect-tag "$TAG" --companion-pattern "$COMPANION_ID")
  if ((RUN_CHAT_SMOKE)); then
    gate_args+=(--smoke)
  else
    gate_args+=(--skip-provider-routing)
  fi
  bash scripts/ops/validate-kube-rollout.sh "${gate_args[@]}"
fi

echo "==> Artemis local Helm shakedown ready"
