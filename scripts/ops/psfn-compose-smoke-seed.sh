#!/bin/sh
# ── Compose smoke seed (psfn-framework-65rk.12) ──
# One-shot seeder for the docker-compose.smoke.yml stack. Runs inside the PSFN
# runtime image (which ships config/*.seed.json) as root, before the gateway and
# agent start, and:
#   * lays the split-root owner files into their canonical roots — cluster-global
#     owners under SYSTEM_DATA_DIR, the four per-companion owners under
#     COMPANION_DATA_DIR (setup.md "What Goes In JSON Owner Files"),
#   * writes a first-run starter companion card at CHARACTER_CARD_PATH,
#   * chowns the shared named volumes to the runtime UID (999) so the non-root
#     gateway/agent can write runtime state and bind the gateway socket.
#
# Every PSFN deployment is a fleet of one or more companions, so it writes a
# single-entry companions.json naming this deployment's COMPANION_ID (the gateway
# fails closed without the fleet manifest). It deliberately does NOT seed
# fleet-auth.json: that absence keeps the deployment on ADMIN_TOKEN-style local
# auth instead of forcing the cluster-auth (gateway-HTTPS + mTLS) path that the
# k3d/Helm shakedown covers. Cluster/fleet topology stays the Helm reference shape.
#
# Idempotent: existing owner files and an existing card are left untouched, so a
# re-up over a populated volume preserves operator edits.
set -eu

SYSTEM_DATA_DIR="${SYSTEM_DATA_DIR:-/app/system-data}"
COMPANION_DATA_DIR="${COMPANION_DATA_DIR:-/app/companion-data}"
WORKSPACE_PATH="${WORKSPACE_PATH:-/app/workspace}"
GATEWAY_SOCKET_DIR="$(dirname "${GATEWAY_SOCKET:-/run/psfn/gateway.sock}")"
CONFIG_DIR="${PSFN_SEED_CONFIG_DIR:-/app/config}"
CHARACTER_CARD_PATH="${CHARACTER_CARD_PATH:-${COMPANION_DATA_DIR}/companion.json}"
COMPANION_NAME="${PSFN_SMOKE_COMPANION_NAME:-Smoke}"
MODEL_CACHE_DIR="${PSFN_SMOKE_MODEL_CACHE_ROOT:-/app/models}"
RUNTIME_UID="${PSFN_RUNTIME_UID:-999}"
RUNTIME_GID="${PSFN_RUNTIME_GID:-999}"

# Cluster-global owner files (SYSTEM_DATA_DIR). Startup no longer copies seed
# templates into runtime state, so every owner the runtime requires must be laid
# down here or the process fails closed on the first missing one.
SYSTEM_OWNERS="settings models providers trust-policy intake-policy backup partner-affect-shadow places runtime-prompt-layers"
# Per-companion owner files (COMPANION_DATA_DIR) — startup never reads a
# system-root copy of these as a fallback.
COMPANION_OWNERS="scheduler capability-tier charge-policy skills"

mkdir -p "$SYSTEM_DATA_DIR" "$COMPANION_DATA_DIR" "$WORKSPACE_PATH" "$GATEWAY_SOCKET_DIR" "$MODEL_CACHE_DIR"

seed_owner() {
  target_dir="$1"
  name="$2"
  seed_file="${CONFIG_DIR}/${name}.seed.json"
  target_file="${target_dir}/${name}.json"
  if [ ! -f "$seed_file" ]; then
    echo "[smoke-seed] missing seed template: $seed_file" >&2
    exit 1
  fi
  if [ -f "$target_file" ]; then
    echo "[smoke-seed] keep existing owner: $target_file"
    return 0
  fi
  cp "$seed_file" "$target_file"
  echo "[smoke-seed] seeded owner: $target_file"
}

for owner in $SYSTEM_OWNERS; do
  seed_owner "$SYSTEM_DATA_DIR" "$owner"
done
# The four per-companion owners are seeded into BOTH roots: the companion-scoped
# agent reads them from COMPANION_DATA_DIR, while the single non-fleet gateway
# resolves them from its own (system-data) root. Seeding both keeps each process
# fail-closed-satisfied without a shared/overlapping root. (In the Helm/fleet
# reference shape these live only under each companion root.)
for owner in $COMPANION_OWNERS; do
  seed_owner "$COMPANION_DATA_DIR" "$owner"
  seed_owner "$SYSTEM_DATA_DIR" "$owner"
done

# ── Fleet manifest ──
# Every PSFN deployment is a fleet of one or more companions and the gateway
# fails closed without companions.json, so write a one-entry fleet naming THIS
# deployment's COMPANION_ID. The topology credential refs must not reuse
# POSTGRES_DATABASE_URL (the manifest contract rejects that), so they carry their
# own env names; this single-node stack resolves persistence from
# POSTGRES_DATABASE_URL directly and never dereferences them.
COMPANIONS_MANIFEST="${SYSTEM_DATA_DIR}/companions.json"
if [ -f "$COMPANIONS_MANIFEST" ]; then
  echo "[smoke-seed] keep existing fleet manifest: $COMPANIONS_MANIFEST"
else
  if [ -z "${COMPANION_ID:-}" ]; then
    echo "[smoke-seed] COMPANION_ID is required to write the fleet manifest" >&2
    exit 2
  fi
  PSFN_SMOKE_CARD_NAME="$COMPANION_NAME" node -e '
    const fs = require("node:fs");
    const companionId = String(process.env.COMPANION_ID).trim();
    const displayName = process.env.PSFN_SMOKE_CARD_NAME || "Smoke";
    const manifest = {
      postgres: {
        sharedMigrationRole: "shared_schema_migration",
        sharedMigrationDatabaseUrlRef: { kind: "env", envName: "SHARED_SCHEMA_MIGRATION_DATABASE_URL" },
      },
      companions: [
        {
          companionId,
          companionDataDir: "companions/smoke",
          characterCardPath: "companions/smoke/character-card.json",
          postgresSchema: "companion_smoke",
          postgresRole: "companion_smoke_runtime",
          postgresDatabaseUrlRef: { kind: "env", envName: "COMPANION_SMOKE_DATABASE_URL" },
          displayName,
        },
      ],
    };
    fs.writeFileSync(process.argv[1], `${JSON.stringify(manifest, null, 2)}\n`);
  ' "$COMPANIONS_MANIFEST"
  echo "[smoke-seed] wrote fleet manifest: $COMPANIONS_MANIFEST"
fi

if [ -f "$CHARACTER_CARD_PATH" ]; then
  echo "[smoke-seed] keep existing card: $CHARACTER_CARD_PATH"
else
  mkdir -p "$(dirname "$CHARACTER_CARD_PATH")"
  PSFN_SMOKE_CARD_NAME="$COMPANION_NAME" node -e '
    const fs = require("node:fs");
    const name = process.env.PSFN_SMOKE_CARD_NAME || "Smoke";
    const card = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description: `${name} is a first-run companion instance for the docker compose smoke stack.`,
        personality: "Warm, concise, honest about uncertainty.",
        scenario: "You are meeting your Partner for the first time inside a local smoke deployment.",
        first_mes: `Hi, I am ${name}.`,
        mes_example: "",
        system_prompt: "",
        post_history_instructions: "",
        tags: ["smoke", "bootstrap"],
        creator: "system",
        creator_notes: "Auto-seeded starter identity for the docker compose smoke stack.",
      },
    };
    fs.writeFileSync(process.argv[1], `${JSON.stringify(card, null, 2)}\n`);
  ' "$CHARACTER_CARD_PATH"
  echo "[smoke-seed] wrote starter card: $CHARACTER_CARD_PATH"
fi

# ── Derive the agent's role-bound gateway auth proofs ──
# The isolated agent requires GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN (and presents
# GATEWAY_COMPANION_AUTH_TOKEN) — HMAC proofs over the SAME session HMAC key +
# COMPANION_ID the gateway holds. We derive them HERE (the trusted bootstrap step
# that legitimately sees the HMAC key, same posture as the gateway) and write a
# sourced env file to a dedicated volume, so the agent never receives the raw
# session HMAC key — only its two derived proofs. Mirrors the launcher/Helm
# contract (deriveCompanionAuthToken, context substrate-gateway-companion-auth-v1,
# single-key keyring version v1).
AUTH_ENV_DIR="${PSFN_SMOKE_AGENT_AUTH_DIR:-/run/psfn-auth}"
if [ -n "${GATEWAY_SESSION_HMAC_KEY:-}" ]; then
  if [ -z "${COMPANION_ID:-}" ]; then
    echo "[smoke-seed] COMPANION_ID is required to derive agent auth proofs" >&2
    exit 2
  fi
  mkdir -p "$AUTH_ENV_DIR"
  AUTH_ENV_FILE="${AUTH_ENV_DIR}/agent-auth.env"
  export AUTH_ENV_FILE
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const key = process.env.GATEWAY_SESSION_HMAC_KEY;
    const companionId = String(process.env.COMPANION_ID).trim();
    const CONTEXT = "substrate-gateway-companion-auth-v1";
    const derive = (role) =>
      "v1." + crypto.createHmac("sha256", key)
        .update(CONTEXT + "\0" + role + "\0" + companionId, "utf8")
        .digest("hex");
    const lines = [
      "export GATEWAY_COMPANION_AUTH_TOKEN=" + derive("agent"),
      "export GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN=" + derive("internal_session_integrity"),
    ];
    // The agent writes encrypted backups (backup.json encryption.mode is always
    // "required"), so it needs this persistence-tier key. It is NOT a
    // provider/egress secret; it rides the sourced file so the agent service
    // declares no secrets in its compose environment.
    const backupKey = process.env.PSFN_BACKUP_ENCRYPTION_KEY;
    if (backupKey) lines.push("export PSFN_BACKUP_ENCRYPTION_KEY=" + backupKey);
    fs.writeFileSync(process.env.AUTH_ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  '
  chown -R "${RUNTIME_UID}:${RUNTIME_GID}" "$AUTH_ENV_DIR"
  chmod 0700 "$AUTH_ENV_DIR"
  echo "[smoke-seed] derived agent auth proofs to ${AUTH_ENV_FILE}"
else
  echo "[smoke-seed] GATEWAY_SESSION_HMAC_KEY unset; skipping agent auth derivation" >&2
fi

# ── Agent persistence credential (file, never inline env) ──
# The agent process refuses POSTGRES_DATABASE_URL in its own environment: the
# runtime credential custody rule requires it to arrive via
# POSTGRES_DATABASE_URL_FILE or _FD. Hand it over as a 0600 file on the dedicated
# auth volume; the gateway keeps the inline env form.
if [ -z "${POSTGRES_DATABASE_URL:-}" ]; then
  echo "[smoke-seed] POSTGRES_DATABASE_URL is required to hand the agent its persistence credential" >&2
  exit 2
fi
mkdir -p "$AUTH_ENV_DIR"
PG_URL_FILE="${AUTH_ENV_DIR}/postgres-database-url"
printf '%s' "$POSTGRES_DATABASE_URL" > "$PG_URL_FILE"
chmod 0600 "$PG_URL_FILE"
chown "${RUNTIME_UID}:${RUNTIME_GID}" "$PG_URL_FILE"
chmod 0700 "$AUTH_ENV_DIR"
chown "${RUNTIME_UID}:${RUNTIME_GID}" "$AUTH_ENV_DIR"
echo "[smoke-seed] wrote agent persistence credential: ${PG_URL_FILE}"

# Hand the shared named volumes to the non-root runtime UID so the gateway can
# bind the socket and both processes can write runtime state.
chown -R "${RUNTIME_UID}:${RUNTIME_GID}" \
  "$SYSTEM_DATA_DIR" "$COMPANION_DATA_DIR" "$WORKSPACE_PATH" "$GATEWAY_SOCKET_DIR" "$MODEL_CACHE_DIR"
echo "[smoke-seed] chowned shared volumes to ${RUNTIME_UID}:${RUNTIME_GID}"
echo "[smoke-seed] done"
