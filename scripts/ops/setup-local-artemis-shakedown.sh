#!/usr/bin/env bash
set -euo pipefail

SHAKEDOWN_ROOT="${PSFN_ARTEMIS_SHAKEDOWN_ROOT:-${HOME}/psfn-artemis-shakedown}"
CLUSTER="${PSFN_ARTEMIS_CLUSTER:-psfn-kube-test}"
NAMESPACE="${PSFN_ARTEMIS_NAMESPACE:-psfn-test}"
RELEASE="${PSFN_ARTEMIS_RELEASE:-psfn}"
COMPANION_ID="${PSFN_ARTEMIS_COMPANION_ID:-11111111-1111-4111-8111-111111111111}"
COMPANION_NAME="${PSFN_ARTEMIS_COMPANION_NAME:-ARTEMIS}"
OWNER_DISCORD_ID="${PSFN_ARTEMIS_OWNER_DISCORD_ID:-123456789012345678}"
GATEWAY_HOST="${PSFN_ARTEMIS_GATEWAY_HOST:-psfn-gateway.local}"
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
KEEP_PREPARED_ROOT=0
PREPARE_SEED_ONLY_OUTPUT=""
SPLICE_OWNER_TARGET=""
SPLICE_OWNER_SEED=""
COMPANION_AUTH_TOKEN=""
SESSION_INTEGRITY_AUTH_TOKEN=""
GATEWAY_SESSION_HMAC_KEY_VALUE=""
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
COMPANION_DATABASE_PASSWORD=""
SHARED_SCHEMA_MIGRATION_PASSWORD=""
FLEET_AUTH_RUNTIME_DATABASE_URL_VALUE=""
FLEET_AUTH_MIGRATION_DATABASE_URL_VALUE=""
FLEET_AUTH_BACKUP_DATABASE_URL_VALUE=""
COMPANION_DATABASE_URL_VALUE=""
SHARED_SCHEMA_MIGRATION_DATABASE_URL_VALUE=""
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
  companion id:   11111111-1111-4111-8111-111111111111
  gateway URL:    http://127.0.0.1:10153
  Garden URL:     http://127.0.0.1:10154

Options:
  --shakedown-root PATH   Optional Artemis fixture overrides. Missing fixture
                         directories are generated from current seed defaults.
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
  --prepare-seed-only DIR Prepare the resolved one-entry fleet fixture at DIR
                         without requiring Docker, Helm, or Kubernetes.
  -h, --help              Show this help.

Secrets:
  The script creates a local app Secret from the current process environment.
  It generates local API/admin/HMAC/backup/fleet-auth credentials when absent, derives
  the role-bound gateway worker proofs (GATEWAY_COMPANION_AUTH_TOKEN and
  GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN) from the same COMPANION_ID and session
  HMAC key, and only copies provider/media keys that are already set in the
  environment. FLEET_AUTH_DISCORD_CLIENT_SECRET is copied when supplied; its
  generated fallback is only a startup-safe placeholder and cannot complete
  OAuth. A real OAuth exercise also needs the registered Discord clientId in a
  fixture fleet-auth.json. --chat-smoke requires OPENROUTER_API_KEY. Bot and
  Telegram keys are deliberately not copied into this local shakedown. Set
  PSFN_ARTEMIS_OWNER_DISCORD_ID to the real operator Discord snowflake before
  exercising login; the disposable offline-safe default is not a provider key.
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
    --prepare-seed-only)
      PREPARE_SEED_ONLY_OUTPUT="${2:?--prepare-seed-only requires a value}"
      shift 2
      ;;
    --splice-owner-files)
      SPLICE_OWNER_TARGET="${2:?--splice-owner-files requires a target root}"
      SPLICE_OWNER_SEED="${3:?--splice-owner-files requires a seed root}"
      shift 3
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
  if ((KEEP_PREPARED_ROOT == 0)) && [[ -n "$PREPARED_ROOT" && -d "$PREPARED_ROOT" ]]; then
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

splice_owner_files() {
  local target_root=$1
  local seed_root=$2
  [[ -d "$target_root" ]] || { echo "owner target root is not a directory: $target_root" >&2; exit 2; }
  [[ -d "$seed_root" ]] || { echo "owner seed root is not a directory: $seed_root" >&2; exit 2; }
  local staging_root
  staging_root="$(mktemp -d "${TMPDIR:-/tmp}/psfn-owner-splice.XXXXXX")"
  if ! node - "$target_root" "$seed_root" "$staging_root" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [, , targetRoot, seedRoot, stagingRoot] = process.argv;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function spliceMissing(seed, current) {
  if (Array.isArray(seed) && Array.isArray(current)) {
    return current.map((value, index) => index < seed.length
      ? spliceMissing(seed[index], value)
      : value);
  }
  if (!isRecord(seed) || !isRecord(current)) return current;
  const merged = { ...seed };
  for (const [key, value] of Object.entries(current)) {
    merged[key] = Object.prototype.hasOwnProperty.call(seed, key)
      ? spliceMissing(seed[key], value)
      : value;
  }
  return merged;
}

const actions = [];
for (const name of fs.readdirSync(seedRoot).filter(entry => entry.endsWith('.json')).sort()) {
  if (!/^[a-z0-9-]+\.json$/.test(name)) {
    throw new Error(`owner seed contains an unsafe file name: ${name}`);
  }
  const seedPath = path.join(seedRoot, name);
  const targetPath = path.join(targetRoot, name);
  const seed = readJson(seedPath);
  if (!fs.existsSync(targetPath)) {
    fs.copyFileSync(seedPath, path.join(stagingRoot, name));
    actions.push(`create\t${name}`);
    continue;
  }
  const current = readJson(targetPath);
  const merged = spliceMissing(seed, current);
  if (JSON.stringify(merged) === JSON.stringify(current)) continue;
  fs.writeFileSync(path.join(stagingRoot, name), `${JSON.stringify(merged, null, 2)}\n`);
  actions.push(`update\t${name}`);
}
fs.writeFileSync(path.join(stagingRoot, 'manifest'), actions.length > 0 ? `${actions.join('\n')}\n` : '');
NODE
  then
    rm -rf "$staging_root"
    exit 1
  fi
  local action name target_path
  while IFS=$'\t' read -r action name; do
    [[ -n "$action" ]] || continue
    target_path="${target_root}/${name}"
    case "$action" in
      create)
        cp "${staging_root}/${name}" "$target_path"
        echo "seeded missing owner file: $name"
        ;;
      update)
        cp -p "$target_path" "$target_path.bak-$(date +%Y%m%d-%H%M%S)"
        cp "${staging_root}/${name}" "$target_path"
        echo "spliced missing owner keys: $name"
        ;;
      *)
        echo "owner splice produced an unsupported action: $action" >&2
        rm -rf "$staging_root"
        exit 1
        ;;
    esac
  done <"${staging_root}/manifest"
  rm -rf "$staging_root"
}

prepare_seed_root() {
  if [[ -n "$PREPARE_SEED_ONLY_OUTPUT" ]]; then
    if [[ -e "$PREPARE_SEED_ONLY_OUTPUT" ]]; then
      echo "--prepare-seed-only output already exists: $PREPARE_SEED_ONLY_OUTPUT" >&2
      exit 2
    fi
    PREPARED_ROOT="$PREPARE_SEED_ONLY_OUTPUT"
    KEEP_PREPARED_ROOT=1
  else
    PREPARED_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/psfn-artemis-seed.XXXXXX")"
  fi
  mkdir -p "$PREPARED_ROOT/system-data" "$PREPARED_ROOT/companion-data" "$PREPARED_ROOT/workspace"
  if [[ -d "${SHAKEDOWN_ROOT}/system-data" ]]; then
    cp -a "${SHAKEDOWN_ROOT}/system-data/." "$PREPARED_ROOT/system-data/"
  fi
  if [[ -d "${SHAKEDOWN_ROOT}/companion-data" ]]; then
    cp -a "${SHAKEDOWN_ROOT}/companion-data/." "$PREPARED_ROOT/companion-data/"
  fi
  if [[ -d "${SHAKEDOWN_ROOT}/workspace" ]]; then
    cp -a "${SHAKEDOWN_ROOT}/workspace/." "$PREPARED_ROOT/workspace/"
  fi

  node - \
    "$PREPARED_ROOT/system-data" \
    "$PREPARED_ROOT/companion-data" \
    "$PWD/config" \
    "$COMPANION_ID" \
    "$COMPANION_NAME" \
    "$OWNER_DISCORD_ID" \
    "$GATEWAY_HOST" \
    "$PREPARED_ROOT/fleet-auth-assertion-private.pem" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [
  ,
  ,
  systemDataDir,
  companionDataDir,
  configDir,
  companionId,
  companionName,
  ownerDiscordId,
  gatewayHost,
  assertionPrivateKeyPath,
] = process.argv;

const PER_COMPANION_OWNERS = new Set([
  'capability-tier.json',
  'scheduler.json',
  'charge-policy.json',
  'skills.json',
]);

if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(gatewayHost)) {
  throw new Error('PSFN_ARTEMIS_GATEWAY_HOST must be a lowercase RFC1123 hostname');
}

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
      postgres: {
        sharedMigrationRole: 'shared_schema_migration',
        sharedMigrationDatabaseUrlRef: {
          kind: 'env',
          envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
        },
      },
      companions: [{
        companionId,
        companionDataDir: `companions/${companionId}`,
        characterCardPath: `companions/${companionId}/companion.json`,
        postgresSchema: 'companion_default',
        postgresRole: 'companion_default_runtime',
        postgresDatabaseUrlRef: {
          kind: 'env',
          envName: 'COMPANION_DEFAULT_DATABASE_URL',
        },
        displayName: companionName,
      }],
    };
  }
  if (targetName === 'trust-policy.json') {
    return normalizeTrustPolicy(owner);
  }
  return owner;
}

function normalizeLocalChannelRouting(owner) {
  if (!isRecord(owner)) {
    throw new Error('local channels owner must be an object');
  }
  const wrapped = Object.prototype.hasOwnProperty.call(owner, 'channels');
  if (wrapped && !isRecord(owner.channels)) {
    throw new Error('local channels owner channels section must be an object');
  }
  const channels = { ...(wrapped ? owner.channels : owner) };
  function copyOptionalSection(sectionName) {
    if (!Object.prototype.hasOwnProperty.call(channels, sectionName)) {
      return {};
    }
    if (!isRecord(channels[sectionName])) {
      throw new Error(`local channels owner ${sectionName} section must be an object`);
    }
    return { ...channels[sectionName] };
  }

  const discord = copyOptionalSection('discord');
  if (Object.prototype.hasOwnProperty.call(discord, 'accounts')) {
    if (!Array.isArray(discord.accounts) || discord.accounts.length !== 1
      || !isRecord(discord.accounts[0])) {
      throw new Error('one-entry local fleet requires exactly one configured Discord account');
    }
    discord.accounts = [{
      ...discord.accounts[0],
      companionId,
    }];
  } else {
    discord.companionId = companionId;
  }

  const telegram = copyOptionalSection('telegram');
  if (Object.keys(telegram).length === 0) {
    telegram.enabled = false;
  }
  telegram.companionId = companionId;

  channels.discord = discord;
  channels.telegram = telegram;
  channels.api = {
    testingHarness: {
      principalId: 'testing-harness',
      tokenRef: {
        kind: 'env',
        envName: 'TESTING_HARNESS_API_KEY',
      },
    },
    ...copyOptionalSection('api'),
    companionId,
  };
  return wrapped
    ? { ...owner, channels }
    : channels;
}

function generateFleetAuthOwner(owner) {
  if (!isRecord(owner) || !isRecord(owner.hubDeviceAssertions)) {
    throw new Error('fleet-auth seed must contain the canonical owner-file structure');
  }
  if (!/^[1-9][0-9]{16,19}$/.test(ownerDiscordId)) {
    throw new Error('PSFN_ARTEMIS_OWNER_DISCORD_ID must be a Discord snowflake (17-20 digits)');
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
    canonicalOrigin: `https://${gatewayHost}`,
    accountRoster: [{
      providerSubjectId: ownerDiscordId,
      companionId,
      contactId: `fleet-owner-${companionId}`,
      role: 'owner',
    }],
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
      audience: `https://${gatewayHost}`,
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
  const targetRoot = PER_COMPANION_OWNERS.has(targetName) ? companionDataDir : systemDataDir;
  const targetPath = path.join(targetRoot, targetName);
  const legacySystemPath = path.join(systemDataDir, targetName);
  const seed = readJson(seedPath);
  const currentPath = fs.existsSync(targetPath)
    ? targetPath
    : PER_COMPANION_OWNERS.has(targetName) && fs.existsSync(legacySystemPath)
      ? legacySystemPath
      : undefined;
  const merged = currentPath ? mergeDefaults(seed, readJson(currentPath)) : seed;
  const normalized = normalizeOwner(targetName, merged);
  const owner = targetName === 'fleet-auth.json'
    ? generateFleetAuthOwner(normalized)
    : normalized;
  fs.writeFileSync(targetPath, `${JSON.stringify(owner, null, 2)}\n`);
  if (PER_COMPANION_OWNERS.has(targetName) && fs.existsSync(legacySystemPath)) {
    fs.rmSync(legacySystemPath);
  }
  migrated.push(targetName);
}

const channelsPath = path.join(systemDataDir, 'channels.json');
const channelsOwner = fs.existsSync(channelsPath) ? readJson(channelsPath) : {};
fs.writeFileSync(
  channelsPath,
  `${JSON.stringify(normalizeLocalChannelRouting(channelsOwner), null, 2)}\n`,
);

const companionCardPath = path.join(companionDataDir, 'companion.json');
if (!fs.existsSync(companionCardPath)) {
  const starterCard = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: companionName,
      description: `${companionName} is a newly bootstrapped companion instance awaiting onboarding and identity tuning.`,
      personality: 'Warm, attentive, honest about uncertainty, and ready to be personalized through onboarding.',
      scenario: 'You are meeting your Partner for the first time and can be customized further through companion setup.',
      first_mes: `Hi, I'm ${companionName}.`,
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      tags: ['bootstrap'],
      creator: 'system',
      creator_notes: 'Auto-seeded starter identity for first-run bootstrap.',
    },
  };
  fs.writeFileSync(companionCardPath, `${JSON.stringify(starterCard, null, 2)}\n`);
}

if (!migrated.includes('companions.json')) {
  throw new Error('current config is missing companions.seed.json');
}
if (!migrated.includes('fleet-auth.json')) {
  throw new Error('current config is missing fleet-auth.seed.json');
}

console.log(`prepared ${migrated.length} owner files from current seed defaults`);
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
    --set fleet.enabled=true \
    --set "fleet.companions[0].companionId=${COMPANION_ID}" \
    --set "fleet.companions[0].postgresSchema=companion_default" \
    --set-string "fleet.companions[0].companionDataClaim=" \
    --set-string "fleet.companions[0].workspaceClaim=" \
    --set-string "fleet.companions[0].authSecret.name=" \
    --set-string "fleet.companions[0].authSecret.sessionIntegrityKey=" \
    --set-string "fleet.companions[0].authSecret.companionAuthKey=" \
    --set fleetAuth.enabled=true \
    --set-string fleetAuth.authorityFloor.existingClaim= \
    --set fleetAuth.authorityFloor.size=64Mi \
    --set-string fleetAuth.authorityFloor.storageClassName= \
    --set fleetAuth.authorityFloor.mountPath=/var/lib/psfn/fleet-auth-floor \
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
    --set-string "fleetAuth.credentialEnv[8].name=SHARED_SCHEMA_MIGRATION_DATABASE_URL" \
    --set-string "fleetAuth.credentialEnv[8].secretRef.name=psfn-app" \
    --set-string "fleetAuth.credentialEnv[8].secretRef.key=SHARED_SCHEMA_MIGRATION_DATABASE_URL" \
    --set-string "fleetAuth.credentialEnv[9].name=COMPANION_DEFAULT_DATABASE_URL" \
    --set-string "fleetAuth.credentialEnv[9].secretRef.name=psfn-app" \
    --set-string "fleetAuth.credentialEnv[9].secretRef.key=COMPANION_DEFAULT_DATABASE_URL" \
    --set ingress.enabled=true \
    --set ingress.gateway.enabled=true \
    --set "ingress.gateway.host=${GATEWAY_HOST}" \
    --set ingress.gateway.path=/ \
    --set ingress.gateway.pathType=Prefix \
    --set ingress.gateway.tls.enabled=true \
    --set "ingress.gateway.tls.secretName=${RELEASE}-gateway-edge-tls" \
    --set identity.seedStarterCard=false \
    --set bootstrap.seedOwnerFiles=false \
    --set secrets.create=false \
    --set secrets.existingSecret=psfn-app \
    --set postgres.auth.existingSecret=psfn-postgres
}

helm_upgrade() {
  local short=$1
  local full=$2
  shift 2
  local -a args=()
  while IFS= read -r -d '' arg; do
    args+=("$arg")
  done < <(helm_base_args "$short" "$full")
  helm upgrade --install --take-ownership "${args[@]}" "$@"
}

provision_gateway_edge_certificate() {
  local issuer_name="${RELEASE}-ca"
  local certificate_name="${RELEASE}-gateway-edge"
  local secret_name="${RELEASE}-gateway-edge-tls"
  kubectl -n "$NAMESPACE" wait --for=condition=Ready "issuer/${issuer_name}" --timeout=180s
  kubectl -n "$NAMESPACE" apply -f - <<YAML
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ${certificate_name}
spec:
  secretName: ${secret_name}
  dnsNames:
    - "${GATEWAY_HOST}"
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: ${issuer_name}
    kind: Issuer
    group: cert-manager.io
YAML
  kubectl -n "$NAMESPACE" wait --for=condition=Ready \
    "certificate/${certificate_name}" --timeout=180s
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

prepare_gateway_credentials() {
  [[ -z "$GATEWAY_SESSION_HMAC_KEY_VALUE" ]] || return 0
  GATEWAY_SESSION_HMAC_KEY_VALUE="${GATEWAY_SESSION_HMAC_KEY:-$(random_secret)}"
  derive_role_bound_tokens "$GATEWAY_SESSION_HMAC_KEY_VALUE"
}

prepare_fleet_auth_credentials() {
  [[ -z "$COMPANION_DATABASE_URL_VALUE" ]] || return 0
  if ((RETAINED_FLEET_AUTH_OWNER)); then
    FLEET_AUTH_DISCORD_CLIENT_SECRET_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_DISCORD_CLIENT_SECRET")"
    FLEET_AUTH_TOKEN_ENCRYPTION_KEY_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_TOKEN_ENCRYPTION_KEY")"
    FLEET_AUTH_SESSION_PEPPER_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_SESSION_PEPPER")"
    FLEET_AUTH_RECOVERY_CREDENTIAL_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_RECOVERY_CREDENTIAL")"
    FLEET_AUTH_RUNTIME_DATABASE_URL_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_RUNTIME_DATABASE_URL")"
    FLEET_AUTH_MIGRATION_DATABASE_URL_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_MIGRATION_DATABASE_URL")"
    FLEET_AUTH_BACKUP_DATABASE_URL_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_BACKUP_DATABASE_URL")"
    COMPANION_DATABASE_URL_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/COMPANION_DEFAULT_DATABASE_URL")"
    SHARED_SCHEMA_MIGRATION_DATABASE_URL_VALUE="$(<"${PRESERVED_FLEET_AUTH_SECRET_DIR}/SHARED_SCHEMA_MIGRATION_DATABASE_URL")"
    return
  fi

  FLEET_AUTH_DISCORD_CLIENT_SECRET_VALUE="${FLEET_AUTH_DISCORD_CLIENT_SECRET:-$(random_secret)}"
  FLEET_AUTH_TOKEN_ENCRYPTION_KEY_VALUE="$(random_secret)"
  FLEET_AUTH_SESSION_PEPPER_VALUE="$(random_secret)"
  FLEET_AUTH_RECOVERY_CREDENTIAL_VALUE="$(random_secret)"
  FLEET_AUTH_RUNTIME_PASSWORD="$(random_secret)"
  FLEET_AUTH_MIGRATION_PASSWORD="$(random_secret)"
  FLEET_AUTH_BACKUP_PASSWORD="$(random_secret)"
  COMPANION_DATABASE_PASSWORD="$(random_secret)"
  SHARED_SCHEMA_MIGRATION_PASSWORD="$(random_secret)"
  local database_host="${RELEASE}-postgres"
  local database_name="psfn"
  FLEET_AUTH_RUNTIME_DATABASE_URL_VALUE="postgresql://fleet_auth_runtime:${FLEET_AUTH_RUNTIME_PASSWORD}@${database_host}:5432/${database_name}"
  FLEET_AUTH_MIGRATION_DATABASE_URL_VALUE="postgresql://fleet_auth_migration:${FLEET_AUTH_MIGRATION_PASSWORD}@${database_host}:5432/${database_name}"
  FLEET_AUTH_BACKUP_DATABASE_URL_VALUE="postgresql://fleet_auth_backup:${FLEET_AUTH_BACKUP_PASSWORD}@${database_host}:5432/${database_name}"
  COMPANION_DATABASE_URL_VALUE="postgresql://companion_default_runtime:${COMPANION_DATABASE_PASSWORD}@${database_host}:5432/${database_name}"
  SHARED_SCHEMA_MIGRATION_DATABASE_URL_VALUE="postgresql://shared_schema_migration:${SHARED_SCHEMA_MIGRATION_PASSWORD}@${database_host}:5432/${database_name}"
}

write_app_secret_env() {
  local path=$1
  chmod 600 "$path"
  prepare_gateway_credentials
  {
    printf 'API_KEY=%s\n' "${API_KEY:-$(random_secret)}"
    printf 'ADMIN_TOKEN=%s\n' "${ADMIN_TOKEN:-$(random_secret)}"
    printf 'TESTING_HARNESS_API_KEY=%s\n' "${TESTING_HARNESS_API_KEY:-$(random_secret)}"
    printf 'GATEWAY_SESSION_HMAC_KEY=%s\n' "$GATEWAY_SESSION_HMAC_KEY_VALUE"
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
    printf 'COMPANION_DEFAULT_DATABASE_URL=%s\n' "$COMPANION_DATABASE_URL_VALUE"
    printf 'SHARED_SCHEMA_MIGRATION_DATABASE_URL=%s\n' "$SHARED_SCHEMA_MIGRATION_DATABASE_URL_VALUE"
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
      "COMPANION_DEFAULT_DATABASE_URL",
      "SHARED_SCHEMA_MIGRATION_DATABASE_URL",
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
    --dry-run=client \
    -o json \
    | node -e '
      const fs = require("node:fs");
      const secret = JSON.parse(fs.readFileSync(0, "utf8"));
      secret.data ??= {};
      secret.data.FLEET_AUTH_ASSERTION_PRIVATE_KEY =
        fs.readFileSync(process.argv[1]).toString("base64");
      process.stdout.write(JSON.stringify(secret));
    ' "$FLEET_AUTH_ASSERTION_PRIVATE_KEY_FILE" \
    | kubectl apply -f -
  rm -f "$env_file"
  SECRET_ENV_FILE=""
}

write_local_postgres_secret() {
  local password=$1
  local database_url=$2
  local env_file
  env_file="$(mktemp "${TMPDIR:-/tmp}/psfn-artemis-postgres-secret.XXXXXX")"
  SECRET_ENV_FILE="$env_file"
  chmod 600 "$env_file"
  {
    printf 'postgres-password=%s\n' "$password"
    printf 'postgres-database-url=%s\n' "$database_url"
  } >"$env_file"
  kubectl -n "$NAMESPACE" create secret generic psfn-postgres \
    --from-env-file="$env_file" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  rm -f "$env_file"
  SECRET_ENV_FILE=""
}

create_fresh_postgres_secret() {
  local password
  password="$(random_secret)"
  write_local_postgres_secret "$password" "$COMPANION_DATABASE_URL_VALUE"
}

replace_postgres_runtime_database_url() {
  local env_file
  env_file="$(mktemp "${TMPDIR:-/tmp}/psfn-artemis-postgres-secret.XXXXXX")"
  SECRET_ENV_FILE="$env_file"
  chmod 600 "$env_file"
  printf 'postgres-password=' >"$env_file"
  kubectl -n "$NAMESPACE" get secret psfn-postgres -o json | node -e '
    const fs = require("node:fs");
    const secret = JSON.parse(fs.readFileSync(0, "utf8"));
    const encoded = secret.data?.["postgres-password"];
    if (typeof encoded !== "string" || encoded.length === 0) process.exit(2);
    process.stdout.write(Buffer.from(encoded, "base64"));
  ' >>"$env_file"
  {
    printf '\n'
    printf 'postgres-database-url=%s\n' "$COMPANION_DATABASE_URL_VALUE"
  } >>"$env_file"
  kubectl -n "$NAMESPACE" create secret generic psfn-postgres \
    --from-env-file="$env_file" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  rm -f "$env_file"
  SECRET_ENV_FILE=""
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
        - name: fleet-auth-floor
          mountPath: /target/fleet-auth-floor
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
    - name: fleet-auth-floor
      persistentVolumeClaim:
        claimName: ${RELEASE}-fleet-auth-floor
YAML
  kubectl -n "$NAMESPACE" wait --for=condition=Ready "pod/${pod}" --timeout=180s
}

prepare_fleet_auth_authority_floor() {
  local pod=$1
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c '
    set -eu
    legacy_floor=/target/runtime/logs/fleet-auth-authority
    if [ -d "$legacy_floor" ] \
      && [ -n "$(find "$legacy_floor" -mindepth 1 -maxdepth 1 -print -quit)" ] \
      && [ -z "$(find /target/fleet-auth-floor -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      cp -a "$legacy_floor/." /target/fleet-auth-floor/
      echo "migrated legacy fleet-auth authority floor to dedicated PVC"
    fi
    chown 999:999 /target/fleet-auth-floor
    chmod 700 /target/fleet-auth-floor
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
    test -f /target/companion-data/capability-tier.json
    test -f /target/companion-data/scheduler.json
    test -f /target/companion-data/charge-policy.json
    test -f /target/companion-data/skills.json
  '
  verify_fleet_auth_broker_key "$pod"
  delete_seed_pod "$pod"
}

# Preserve-mode owner-file migration: seed-splice recursively adds missing keys
# and missing owner files while every existing scalar, object member, and array
# remains authoritative. The chart retains ownership of its marker-bound
# scheduler/capability cutover; charge/skills legacy roots require the canonical
# receipt-bearing operator migration and fail closed here.
migrate_missing_owner_files() {
  local short=$1
  local pod=psfn-artemis-migrate
  launch_seed_pod "$short" "$pod"
  prepare_fleet_auth_authority_floor "$pod"
  local retained_fleet_auth_owner=0
  if kubectl -n "$NAMESPACE" exec "$pod" -- test -f /target/system-data/fleet-auth.json; then
    retained_fleet_auth_owner=1
  fi
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
      COMPANION_DEFAULT_DATABASE_URL \
      SHARED_SCHEMA_MIGRATION_DATABASE_URL; do
      if [[ -z "$PRESERVED_FLEET_AUTH_SECRET_DIR" \
        || ! -s "${PRESERVED_FLEET_AUTH_SECRET_DIR}/${required_credential}" ]]; then
        echo "preserve mode retained fleet-auth.json but psfn-app lacks ${required_credential}" >&2
        exit 1
      fi
    done
    FLEET_AUTH_ASSERTION_PRIVATE_KEY_FILE="${PRESERVED_FLEET_AUTH_SECRET_DIR}/FLEET_AUTH_ASSERTION_PRIVATE_KEY"
    RETAINED_FLEET_AUTH_OWNER=1
    verify_fleet_auth_broker_key "$pod"
  fi
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c '
    set -eu
    rm -rf /seed
    mkdir -p /seed/system-data /seed/companion-data
  '
  kubectl -n "$NAMESPACE" cp "${SEED_ROOT}/system-data/." "${pod}:/seed/system-data"
  kubectl -n "$NAMESPACE" cp "${SEED_ROOT}/companion-data/." "${pod}:/seed/companion-data"
  kubectl -n "$NAMESPACE" cp "$SCRIPT_DIR/setup-local-artemis-shakedown.sh" \
    "${pod}:/seed/setup-local-artemis-shakedown.sh"
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c '
    set -eu
    for name in scheduler.json capability-tier.json; do
      if [ -f "/target/system-data/$name" ] && [ ! -e "/target/companion-data/$name" ]; then
        rm -f "/seed/companion-data/$name"
        echo "deferring marker-bound owner cutover to chart init: $name"
      fi
    done
    for name in charge-policy.json skills.json; do
      if [ -f "/target/system-data/$name" ] && [ ! -e "/target/companion-data/$name" ]; then
        echo "legacy $name requires npm run migrate:system-owner-fleet before --preserve-data" >&2
        exit 1
      fi
    done
  '
  kubectl -n "$NAMESPACE" exec "$pod" -- bash /seed/setup-local-artemis-shakedown.sh \
    --splice-owner-files /target/system-data /seed/system-data
  kubectl -n "$NAMESPACE" exec "$pod" -- bash /seed/setup-local-artemis-shakedown.sh \
    --splice-owner-files /target/companion-data /seed/companion-data
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c '
    set -eu
    chown -R 999:999 /target/system-data /target/companion-data
    test -f /target/system-data/companions.json
    test -f /target/system-data/fleet-auth.json
    test -f /target/companion-data/companion.json
    test -f /target/companion-data/charge-policy.json
    test -f /target/companion-data/skills.json
  '
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
    "$FLEET_AUTH_BACKUP_PASSWORD" \
    "$COMPANION_DATABASE_PASSWORD" \
    "$SHARED_SCHEMA_MIGRATION_PASSWORD"; do
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
  'fleet_auth_backup',
  'companion_default_runtime',
  'shared_schema_migration'
]) AS roles(role_name)
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_roles
  WHERE pg_roles.rolname = roles.role_name
)
\gexec
SQL
    printf "ALTER ROLE fleet_auth_runtime WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 60 VALID UNTIL 'infinity' PASSWORD '%s';\n" \
      "$FLEET_AUTH_RUNTIME_PASSWORD"
    printf "ALTER ROLE fleet_auth_migration WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 60 VALID UNTIL 'infinity' PASSWORD '%s';\n" \
      "$FLEET_AUTH_MIGRATION_PASSWORD"
    printf "ALTER ROLE fleet_auth_backup WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 60 VALID UNTIL 'infinity' PASSWORD '%s';\n" \
      "$FLEET_AUTH_BACKUP_PASSWORD"
    printf "ALTER ROLE companion_default_runtime WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 60 VALID UNTIL 'infinity' PASSWORD '%s';\n" \
      "$COMPANION_DATABASE_PASSWORD"
    printf "ALTER ROLE shared_schema_migration WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 60 VALID UNTIL 'infinity' PASSWORD '%s';\n" \
      "$SHARED_SCHEMA_MIGRATION_PASSWORD"
    cat <<'SQL'
GRANT CONNECT ON DATABASE psfn TO fleet_auth_runtime, fleet_auth_migration, fleet_auth_backup, companion_default_runtime, shared_schema_migration;
GRANT CREATE ON DATABASE psfn TO fleet_auth_migration, companion_default_runtime, shared_schema_migration;
GRANT CONNECT ON DATABASE psfn_restore_verify TO fleet_auth_migration, fleet_auth_backup;
GRANT CREATE ON DATABASE psfn_restore_verify TO fleet_auth_migration;
\connect psfn
CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION psfn;
ALTER EXTENSION vector SET SCHEMA extensions;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
GRANT USAGE ON SCHEMA extensions TO companion_default_runtime, shared_schema_migration;
CREATE SCHEMA companion_default AUTHORIZATION companion_default_runtime;
REVOKE ALL ON SCHEMA companion_default FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA companion_default TO companion_default_runtime;
ALTER ROLE companion_default_runtime IN DATABASE psfn SET search_path TO companion_default, extensions;
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

if [[ -n "$SPLICE_OWNER_TARGET" ]]; then
  require_command node
  splice_owner_files "$SPLICE_OWNER_TARGET" "$SPLICE_OWNER_SEED"
  exit 0
fi

if [[ -n "$PREPARE_SEED_ONLY_OUTPUT" ]]; then
  require_command node
  prepare_seed_root
  echo "prepared one-entry fleet fixture at ${SEED_ROOT}"
  exit 0
fi

require_command git
require_command docker
require_command helm
require_command kubectl
require_command k3d
require_command node
require_command setsid

prepare_seed_root
prepare_gateway_credentials

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
    "${RELEASE}-fleet-auth-floor" \
    "data-${RELEASE}-postgres-0" \
    "data-${RELEASE}-redis-0" \
    --ignore-not-found --wait=true >/dev/null
fi

if ((RESET_DATA)); then
  prepare_fleet_auth_credentials
  create_fresh_postgres_secret
elif ! kubectl -n "$NAMESPACE" get secret psfn-postgres >/dev/null 2>&1; then
  echo "preserve mode requires the existing psfn-postgres Secret" >&2
  exit 1
fi

echo "==> installing PVCs, backing services, and fail-closed fleet workloads"
helm_upgrade "$SHORT" "$FULL" \
  --timeout 10m >/dev/null
provision_gateway_edge_certificate

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
replace_postgres_runtime_database_url
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
