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
FLEET_AUTH_ASSERTION_PRIVATE_KEY_FILE=""
PRESERVED_FLEET_AUTH_SECRET_DIR=""
RETAINED_FLEET_AUTH_OWNER=0
FLEET_AUTH_DISCORD_CLIENT_SECRET_VALUE=""
FLEET_AUTH_TOKEN_ENCRYPTION_KEY_VALUE=""
FLEET_AUTH_SESSION_PEPPER_VALUE=""
FLEET_AUTH_RECOVERY_CREDENTIAL_VALUE=""
FLEET_AUTH_RUNTIME_PASSWORD=""
FLEET_AUTH_MIGRATION_PASSWORD=""
FLEET_AUTH_BACKUP_PASSWORD=""
FLEET_AUTH_RUNTIME_DATABASE_URL_VALUE=""
FLEET_AUTH_MIGRATION_DATABASE_URL_VALUE=""
FLEET_AUTH_BACKUP_DATABASE_URL_VALUE=""
FLEET_AUTH_AUTHORITY_FLOOR_ROOT_VALUE="/runtime/logs/fleet-auth-authority"
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
  It generates local API/admin/HMAC/backup/fleet-auth credentials when absent, derives
  the role-bound gateway worker proofs (GATEWAY_COMPANION_AUTH_TOKEN and
  GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN) from the same COMPANION_ID and session
  HMAC key, and only copies provider/media keys that are already set in the
  environment. The Discord OAuth client secret is copied only when explicitly
  supplied as FLEET_AUTH_DISCORD_CLIENT_SECRET; bot and Telegram keys are
  deliberately not copied into this local shakedown.
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

  node - \
    "$PREPARED_ROOT/system-data" \
    "$PWD/config" \
    "$COMPANION_ID" \
    "$COMPANION_NAME" \
    "$PREPARED_ROOT/fleet-auth-assertion-private.pem" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [
  ,
  ,
  systemDataDir,
  configDir,
  companionId,
  companionName,
  assertionPrivateKeyPath,
] = process.argv;

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
  if (targetName === 'companions.json') {
    return {
      companions: [{
        companionId,
        companionDataDir: `companions/${companionId}`,
        characterCardPath: `companions/${companionId}/companion.json`,
        postgresSchema: 'companion_default',
        displayName: companionName,
      }],
    };
  }
  if (targetName === 'trust-policy.json') {
    return normalizeTrustPolicy(owner);
  }
  return owner;
}

function generateFleetAuthOwner(owner) {
  if (!isRecord(owner) || !isRecord(owner.hubDeviceAssertions)) {
    throw new Error('fleet-auth seed must contain the canonical owner-file structure');
  }
  if (owner.accountRoster !== undefined) {
    if (!Array.isArray(owner.accountRoster)) {
      throw new Error('fleet-auth accountRoster must be an array when present');
    }
    for (const [index, entry] of owner.accountRoster.entries()) {
      if (!isRecord(entry) || entry.companionId !== companionId) {
        throw new Error(
          `fleet-auth accountRoster[${index}] must target the one generated companion ${companionId}`,
        );
      }
    }
  }
  const broker = crypto.generateKeyPairSync('ed25519');
  const hub = crypto.generateKeyPairSync('ed25519');
  const brokerPublicKeyPem = broker.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const hubPublicKeyPem = hub.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const brokerPrivateKeyPem = broker.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const generatedAt = Date.now();
  const notBefore = new Date(generatedAt - 5 * 60_000).toISOString();
  const notAfter = new Date(generatedAt + 10 * 365 * 24 * 60 * 60_000).toISOString();
  const brokerKid = `artemis-broker-${crypto.randomBytes(12).toString('hex')}`;
  const hubKid = `artemis-hub-${crypto.randomBytes(12).toString('hex')}`;

  fs.writeFileSync(assertionPrivateKeyPath, brokerPrivateKeyPem, { mode: 0o600 });
  return {
    ...owner,
    verifierKeys: [{
      issuer: 'psfn-fleet-auth',
      kid: brokerKid,
      publicKeyPem: brokerPublicKeyPem,
      notBefore,
      notAfter,
      status: 'active',
    }],
    hubDeviceAssertions: {
      ...owner.hubDeviceAssertions,
      keys: [{
        kid: hubKid,
        publicKeyPem: hubPublicKeyPem,
        notBefore,
        notAfter,
        status: 'active',
      }],
    },
  };
}

const migrated = [];
for (const entry of fs.readdirSync(configDir)) {
  if (!entry.endsWith('.seed.json')) {
    continue;
  }
  const targetName = entry.replace(/\.seed\.json$/, '.json');
  const seedPath = path.join(configDir, entry);
  const targetPath = path.join(systemDataDir, targetName);
  const seed = readJson(seedPath);
  const merged = fs.existsSync(targetPath) ? mergeDefaults(seed, readJson(targetPath)) : seed;
  const normalized = normalizeOwner(targetName, merged);
  const owner = targetName === 'fleet-auth.json'
    ? generateFleetAuthOwner(normalized)
    : normalized;
  fs.writeFileSync(targetPath, `${JSON.stringify(owner, null, 2)}\n`);
  migrated.push(targetName);
}

if (!migrated.includes('companions.json')) {
  throw new Error('current config is missing companions.seed.json');
}
if (!migrated.includes('fleet-auth.json')) {
  throw new Error('current config is missing fleet-auth.seed.json');
}

console.log(`prepared ${migrated.length} system owner files from current seed defaults`);
NODE

  FLEET_AUTH_ASSERTION_PRIVATE_KEY_FILE="$PREPARED_ROOT/fleet-auth-assertion-private.pem"
  [[ -s "$FLEET_AUTH_ASSERTION_PRIVATE_KEY_FILE" ]] || {
    echo "fleet-auth key generation did not write the broker private key" >&2
    exit 1
  }
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
    --set "runtime.companionDataDir=/runtime/companions/${COMPANION_ID}" \
    --set "runtime.workspacePath=/runtime/workspaces/personal/${COMPANION_ID}" \
    --set "runtime.characterCardPath=/runtime/companions/${COMPANION_ID}/companion.json" \
    --set "fleet.companions[0].companionId=${COMPANION_ID}" \
    --set "fleet.companions[0].postgresSchema=companion_default" \
    --set-string "fleet.companions[0].companionDataClaim=" \
    --set-string "fleet.companions[0].workspaceClaim=" \
    --set-string "fleet.companions[0].authSecret.name=" \
    --set-string "fleet.companions[0].authSecret.sessionIntegrityKey=" \
    --set-string "fleet.companions[0].authSecret.companionAuthKey=" \
    --set-string "fleetAuth.credentialEnv[0].name=FLEET_AUTH_DISCORD_CLIENT_SECRET" \
    --set-string "fleetAuth.credentialEnv[0].secretRef.name=psfn-app" \
    --set-string "fleetAuth.credentialEnv[0].secretRef.key=FLEET_AUTH_DISCORD_CLIENT_SECRET" \
    --set-string "fleetAuth.credentialEnv[1].name=FLEET_AUTH_TOKEN_ENCRYPTION_KEY" \
    --set-string "fleetAuth.credentialEnv[1].secretRef.name=psfn-app" \
    --set-string "fleetAuth.credentialEnv[1].secretRef.key=FLEET_AUTH_TOKEN_ENCRYPTION_KEY" \
    --set-string "fleetAuth.credentialEnv[2].name=FLEET_AUTH_SESSION_PEPPER" \
    --set-string "fleetAuth.credentialEnv[2].secretRef.name=psfn-app" \
    --set-string "fleetAuth.credentialEnv[2].secretRef.key=FLEET_AUTH_SESSION_PEPPER" \
    --set-string "fleetAuth.credentialEnv[3].name=FLEET_AUTH_ASSERTION_PRIVATE_KEY" \
    --set-string "fleetAuth.credentialEnv[3].secretRef.name=psfn-app" \
    --set-string "fleetAuth.credentialEnv[3].secretRef.key=FLEET_AUTH_ASSERTION_PRIVATE_KEY" \
    --set-string "fleetAuth.credentialEnv[4].name=FLEET_AUTH_RECOVERY_CREDENTIAL" \
    --set-string "fleetAuth.credentialEnv[4].secretRef.name=psfn-app" \
    --set-string "fleetAuth.credentialEnv[4].secretRef.key=FLEET_AUTH_RECOVERY_CREDENTIAL" \
    --set-string "fleetAuth.credentialEnv[5].name=FLEET_AUTH_RUNTIME_DATABASE_URL" \
    --set-string "fleetAuth.credentialEnv[5].secretRef.name=psfn-app" \
    --set-string "fleetAuth.credentialEnv[5].secretRef.key=FLEET_AUTH_RUNTIME_DATABASE_URL" \
    --set-string "fleetAuth.credentialEnv[6].name=FLEET_AUTH_MIGRATION_DATABASE_URL" \
    --set-string "fleetAuth.credentialEnv[6].secretRef.name=psfn-app" \
    --set-string "fleetAuth.credentialEnv[6].secretRef.key=FLEET_AUTH_MIGRATION_DATABASE_URL" \
    --set-string "fleetAuth.credentialEnv[7].name=FLEET_AUTH_BACKUP_DATABASE_URL" \
    --set-string "fleetAuth.credentialEnv[7].secretRef.name=psfn-app" \
    --set-string "fleetAuth.credentialEnv[7].secretRef.key=FLEET_AUTH_BACKUP_DATABASE_URL" \
    --set-string "fleetAuth.credentialEnv[8].name=FLEET_AUTH_AUTHORITY_FLOOR_ROOT" \
    --set-string "fleetAuth.credentialEnv[8].secretRef.name=psfn-app" \
    --set-string "fleetAuth.credentialEnv[8].secretRef.key=FLEET_AUTH_AUTHORITY_FLOOR_ROOT" \
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

prepare_fleet_auth_credentials() {
  if ((RETAINED_FLEET_AUTH_OWNER)); then
    FLEET_AUTH_DISCORD_CLIENT_SECRET_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_DISCORD_CLIENT_SECRET")"
    FLEET_AUTH_TOKEN_ENCRYPTION_KEY_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_TOKEN_ENCRYPTION_KEY")"
    FLEET_AUTH_SESSION_PEPPER_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_SESSION_PEPPER")"
    FLEET_AUTH_RECOVERY_CREDENTIAL_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_RECOVERY_CREDENTIAL")"
    FLEET_AUTH_RUNTIME_DATABASE_URL_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_RUNTIME_DATABASE_URL")"
    FLEET_AUTH_MIGRATION_DATABASE_URL_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_MIGRATION_DATABASE_URL")"
    FLEET_AUTH_BACKUP_DATABASE_URL_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_BACKUP_DATABASE_URL")"
    FLEET_AUTH_AUTHORITY_FLOOR_ROOT_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_AUTHORITY_FLOOR_ROOT")"
    if [[ "$FLEET_AUTH_AUTHORITY_FLOOR_ROOT_VALUE" != "/runtime/logs/fleet-auth-authority" ]]; then
      echo "preserved fleet-auth authority floor must remain at /runtime/logs/fleet-auth-authority" >&2
      exit 1
    fi
    return
  fi

  FLEET_AUTH_DISCORD_CLIENT_SECRET_VALUE="${FLEET_AUTH_DISCORD_CLIENT_SECRET:-$(random_secret)}"
  FLEET_AUTH_TOKEN_ENCRYPTION_KEY_VALUE="$(random_secret)"
  FLEET_AUTH_SESSION_PEPPER_VALUE="$(random_secret)"
  FLEET_AUTH_RECOVERY_CREDENTIAL_VALUE="$(random_secret)"
  FLEET_AUTH_RUNTIME_PASSWORD="$(random_secret)"
  FLEET_AUTH_MIGRATION_PASSWORD="$(random_secret)"
  FLEET_AUTH_BACKUP_PASSWORD="$(random_secret)"
  local database_host="${RELEASE}-postgres"
  local database_name="psfn"
  FLEET_AUTH_RUNTIME_DATABASE_URL_VALUE="postgresql://fleet_auth_runtime:${FLEET_AUTH_RUNTIME_PASSWORD}@${database_host}:5432/${database_name}"
  FLEET_AUTH_MIGRATION_DATABASE_URL_VALUE="postgresql://fleet_auth_migration:${FLEET_AUTH_MIGRATION_PASSWORD}@${database_host}:5432/${database_name}"
  FLEET_AUTH_BACKUP_DATABASE_URL_VALUE="postgresql://fleet_auth_backup:${FLEET_AUTH_BACKUP_PASSWORD}@${database_host}:5432/${database_name}"
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
    printf 'FLEET_AUTH_DISCORD_CLIENT_SECRET=%s\n' "$FLEET_AUTH_DISCORD_CLIENT_SECRET_VALUE"
    printf 'FLEET_AUTH_TOKEN_ENCRYPTION_KEY=%s\n' "$FLEET_AUTH_TOKEN_ENCRYPTION_KEY_VALUE"
    printf 'FLEET_AUTH_SESSION_PEPPER=%s\n' "$FLEET_AUTH_SESSION_PEPPER_VALUE"
    printf 'FLEET_AUTH_RECOVERY_CREDENTIAL=%s\n' "$FLEET_AUTH_RECOVERY_CREDENTIAL_VALUE"
    printf 'FLEET_AUTH_RUNTIME_DATABASE_URL=%s\n' "$FLEET_AUTH_RUNTIME_DATABASE_URL_VALUE"
    printf 'FLEET_AUTH_MIGRATION_DATABASE_URL=%s\n' "$FLEET_AUTH_MIGRATION_DATABASE_URL_VALUE"
    printf 'FLEET_AUTH_BACKUP_DATABASE_URL=%s\n' "$FLEET_AUTH_BACKUP_DATABASE_URL_VALUE"
    printf 'FLEET_AUTH_AUTHORITY_FLOOR_ROOT=%s\n' "$FLEET_AUTH_AUTHORITY_FLOOR_ROOT_VALUE"
    printf 'DISCORD_TOKEN=\n'
    printf 'DISCORD_BOT_ID=\n'
  } >"$path"
}

capture_preserved_fleet_auth_credentials() {
  ((RESET_DATA == 0)) || return 0
  local secret_json
  secret_json="$(kubectl -n "$NAMESPACE" get secret psfn-app -o json 2>/dev/null || true)"
  [[ -n "$secret_json" ]] || return 0
  PRESERVED_FLEET_AUTH_SECRET_DIR="$PREPARED_ROOT/fleet-auth-preserved-secret"
  mkdir -p "$PRESERVED_FLEET_AUTH_SECRET_DIR"
  printf '%s' "$secret_json" | node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const secret = JSON.parse(fs.readFileSync(0, "utf8"));
    const outputDir = process.argv[1];
    const required = [
      "FLEET_AUTH_DISCORD_CLIENT_SECRET",
      "FLEET_AUTH_TOKEN_ENCRYPTION_KEY",
      "FLEET_AUTH_SESSION_PEPPER",
      "FLEET_AUTH_ASSERTION_PRIVATE_KEY",
      "FLEET_AUTH_RECOVERY_CREDENTIAL",
      "FLEET_AUTH_RUNTIME_DATABASE_URL",
      "FLEET_AUTH_MIGRATION_DATABASE_URL",
      "FLEET_AUTH_BACKUP_DATABASE_URL",
      "FLEET_AUTH_AUTHORITY_FLOOR_ROOT",
    ];
    for (const name of required) {
      const encoded = secret.data?.[name];
      if (typeof encoded !== "string" || encoded.length === 0) {
        continue;
      }
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length === 0) {
        continue;
      }
      fs.writeFileSync(path.join(outputDir, name), decoded, { mode: 0o600 });
    }
  ' "$PRESERVED_FLEET_AUTH_SECRET_DIR"
}

create_local_app_secret() {
  local env_file
  env_file="$(mktemp "${TMPDIR:-/tmp}/psfn-artemis-secret.XXXXXX")"
  SECRET_ENV_FILE="$env_file"
  write_app_secret_env "$env_file"
  kubectl -n "$NAMESPACE" create secret generic psfn-app \
    --from-env-file="$env_file" \
    --from-file="FLEET_AUTH_ASSERTION_PRIVATE_KEY=${FLEET_AUTH_ASSERTION_PRIVATE_KEY_FILE}" \
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
        - name: runtime
          mountPath: /target/runtime
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
    - name: runtime
      persistentVolumeClaim:
        claimName: ${RELEASE}-runtime
YAML
  kubectl -n "$NAMESPACE" wait --for=condition=Ready "pod/${pod}" --timeout=180s
}

prepare_fleet_auth_authority_floor() {
  local pod=$1
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c '
    set -eu
    install -d -m 700 -o 999 -g 999 /target/runtime/logs/fleet-auth-authority
  '
}

verify_fleet_auth_broker_key() {
  local pod=$1
  local private_fingerprint
  local configured_fingerprint
  private_fingerprint="$(node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const privateKey = crypto.createPrivateKey(fs.readFileSync(process.argv[1], "utf8"));
    const publicDer = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
    process.stdout.write(crypto.createHash("sha256").update(publicDer).digest("base64url"));
  ' "$FLEET_AUTH_ASSERTION_PRIVATE_KEY_FILE")"
  configured_fingerprint="$(kubectl -n "$NAMESPACE" exec "$pod" -- node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const owner = JSON.parse(fs.readFileSync("/target/system-data/fleet-auth.json", "utf8"));
    const active = owner.verifierKeys?.filter((key) => key.status === "active") ?? [];
    if (active.length !== 1) process.exit(1);
    const publicDer = crypto.createPublicKey(active[0].publicKeyPem)
      .export({ type: "spki", format: "der" });
    process.stdout.write(crypto.createHash("sha256").update(publicDer).digest("base64url"));
  ')"
  if [[ -z "$private_fingerprint" || "$private_fingerprint" != "$configured_fingerprint" ]]; then
    echo "fleet-auth broker private key does not match the retained fleet-auth.json active verifier" >&2
    exit 1
  fi
}

delete_seed_pod() {
  local pod=$1
  kubectl -n "$NAMESPACE" delete pod "$pod" --wait=true >/dev/null
}

seed_artemis_files() {
  local short=$1
  local pod=psfn-artemis-seed
  launch_seed_pod "$short" "$pod"
  prepare_fleet_auth_authority_floor "$pod"
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
    test -f /target/system-data/companions.json
    test -f /target/system-data/fleet-auth.json
    test -f /target/companion-data/companion.json
  '
  verify_fleet_auth_broker_key "$pod"
  delete_seed_pod "$pod"
}

# Preserve-mode owner-file migration: keep every existing owner file exactly as
# it is on the PVC and only add owner files that are newly required by the
# current runtime (e.g. intake-policy.json) but absent from a PVC that predates
# them. Existing mutable owners are never overwritten.
migrate_missing_owner_files() {
  local short=$1
  local pod=psfn-artemis-migrate
  launch_seed_pod "$short" "$pod"
  prepare_fleet_auth_authority_floor "$pod"
  local retained_fleet_auth_owner=0
  if kubectl -n "$NAMESPACE" exec "$pod" -- test -f /target/system-data/fleet-auth.json; then
    retained_fleet_auth_owner=1
  fi
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
  if ((retained_fleet_auth_owner)); then
    local required_credential
    for required_credential in \
      FLEET_AUTH_DISCORD_CLIENT_SECRET \
      FLEET_AUTH_TOKEN_ENCRYPTION_KEY \
      FLEET_AUTH_SESSION_PEPPER \
      FLEET_AUTH_ASSERTION_PRIVATE_KEY \
      FLEET_AUTH_RECOVERY_CREDENTIAL \
      FLEET_AUTH_RUNTIME_DATABASE_URL \
      FLEET_AUTH_MIGRATION_DATABASE_URL \
      FLEET_AUTH_BACKUP_DATABASE_URL \
      FLEET_AUTH_AUTHORITY_FLOOR_ROOT; do
      if [[ -z "$PRESERVED_FLEET_AUTH_SECRET_DIR" \
        || ! -s "${PRESERVED_FLEET_AUTH_SECRET_DIR}/${required_credential}" ]]; then
        echo "preserve mode retained fleet-auth.json but psfn-app lacks ${required_credential}" >&2
        exit 1
      fi
    done
    FLEET_AUTH_ASSERTION_PRIVATE_KEY_FILE="${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_ASSERTION_PRIVATE_KEY"
    RETAINED_FLEET_AUTH_OWNER=1
  fi
  verify_fleet_auth_broker_key "$pod"
  delete_seed_pod "$pod"
}

provision_fleet_auth_database_roles() {
  if ((RETAINED_FLEET_AUTH_OWNER)); then
    echo "    retaining existing fleet-auth database roles and credentials"
    return
  fi
  local postgres_pod="${RELEASE}-postgres-0"
  for password in \
    "$FLEET_AUTH_RUNTIME_PASSWORD" \
    "$FLEET_AUTH_MIGRATION_PASSWORD" \
    "$FLEET_AUTH_BACKUP_PASSWORD"; do
    if [[ ! "$password" =~ ^[0-9a-f]{64}$ ]]; then
      echo "generated fleet-auth database password is not canonical 32-byte hex" >&2
      exit 1
    fi
  done
  kubectl -n "$NAMESPACE" wait --for=condition=Ready "pod/${postgres_pod}" --timeout=180s
  {
    cat <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOINHERIT', role_name)
FROM unnest(ARRAY[
  'fleet_auth_runtime',
  'fleet_auth_migration',
  'fleet_auth_backup'
]) AS roles(role_name)
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_roles
  WHERE pg_roles.rolname = roles.role_name
)
\gexec
SQL
    printf "ALTER ROLE fleet_auth_runtime WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" \
      "$FLEET_AUTH_RUNTIME_PASSWORD"
    printf "ALTER ROLE fleet_auth_migration WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" \
      "$FLEET_AUTH_MIGRATION_PASSWORD"
    printf "ALTER ROLE fleet_auth_backup WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" \
      "$FLEET_AUTH_BACKUP_PASSWORD"
    cat <<'SQL'
GRANT CONNECT ON DATABASE psfn TO fleet_auth_runtime, fleet_auth_migration, fleet_auth_backup;
GRANT CREATE ON DATABASE psfn TO fleet_auth_migration;
GRANT CONNECT ON DATABASE psfn_restore_verify TO fleet_auth_migration, fleet_auth_backup;
GRANT CREATE ON DATABASE psfn_restore_verify TO fleet_auth_migration;
SQL
  } | kubectl -n "$NAMESPACE" exec -i "$postgres_pod" -- \
    psql --set=ON_ERROR_STOP=1 --username=psfn --dbname=postgres
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
capture_preserved_fleet_auth_credentials

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

echo "==> installing PVCs, backing services, and fail-closed fleet workloads"
helm_upgrade "$SHORT" "$FULL" \
  --timeout 10m >/dev/null

if ((RESET_DATA)); then
  echo "==> seeding Artemis owner files into local PVCs"
  seed_artemis_files "$SHORT"
else
  echo "==> preserving existing PVC contents; migrating only newly required owner files"
  migrate_missing_owner_files "$SHORT"
fi

prepare_fleet_auth_credentials
echo "==> provisioning local fleet-auth database roles"
provision_fleet_auth_database_roles
create_local_app_secret

if ((RUN_PREFETCH)); then
  echo "==> prefetching local text-emotion model cache"
  kubectl -n "$NAMESPACE" delete job "${RELEASE}-model-prefetch" --ignore-not-found --wait=true >/dev/null
  helm_upgrade "$SHORT" "$FULL" \
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

kubectl -n "$NAMESPACE" rollout status deployment \
  --selector "psfn.io/companion-id=${COMPANION_ID},psfn.io/fleet-target=registered" \
  --timeout=300s
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
