#!/usr/bin/env node
// ── Compose smoke Hub device enrollment (psfn-framework-gdv64) ──
// Gives the smoke Satellite Hub a device registry with ONE enrolled test
// device, so a websocket session that authenticates as that device receives
// the capabilities its enrollment grants (including the `emotion` output that
// companion-ui advertises). A registry-less Hub deliberately clamps every hello
// to the presentation-only ceiling; this does not relax that ceiling, it takes
// the enrolled path instead.
//
// Nothing here is a committed secret. smoke:docker generates the device
// credential per run (PSFN_SMOKE_HUB_DEVICE_CREDENTIAL) and presents it in its
// hello; this seed stores only its SHA-256. The Ed25519 key the Hub requires
// to sign device assertions in registry mode is generated here, at stack-up,
// into the disposable hub-device volume and never leaves it.
//
// Runs inside the runtime image as root (node only), during the seed step.

import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// The Hub image runs as this uid/gid (docker/satellite-hub/Dockerfile).
const HUB_UID = 999;
const HUB_GID = 999;
const MIN_DEVICE_CREDENTIAL_LENGTH = 32;
export const SMOKE_HUB_DEVICE_ID = 'smoke-companion-ui-device';
const SMOKE_HUB_DEVICE_REGISTRY_FILE = 'devices.json';
const SMOKE_HUB_DEVICE_ASSERTION_KEY_FILE = 'device-assertion-key.pem';

// Least privilege: exactly what companion-ui's default hello advertises
// (companion-ui/src/lib/api/auth.ts MOBILE_CHAT_APP_CAPABILITIES), which the
// Hub intersects with this ceiling. Asserted against the real constant in
// scripts/compose-hub-verification.test.ts.
const SMOKE_DEVICE_MAX_CAPABILITIES = Object.freeze({
  input: ['text', 'device_location'],
  output: ['text', 'subtitle', 'artifact', 'tool_activity', 'emotion'],
  control: ['interrupt', 'presence', 'session_attach', 'approvals', 'touch'],
  safety: ['confirmation_required', 'local_only'],
});

/** schemaVersion 1 Hub device registry with the one enrolled smoke device. */
export function buildSmokeHubDeviceRegistry(options) {
  const credential = options.credential ?? '';
  if (credential.length < MIN_DEVICE_CREDENTIAL_LENGTH) {
    throw new Error(`Hub device credential must be at least ${MIN_DEVICE_CREDENTIAL_LENGTH} characters`);
  }
  const companionId = (options.companionId ?? '').trim();
  const satelliteId = (options.satelliteId ?? '').trim();
  const endpointId = (options.endpointId ?? '').trim();
  const claimType = (options.claimType ?? '').trim();
  if (!companionId || !satelliteId || !endpointId || !claimType) {
    throw new Error('companionId, satelliteId, endpointId, and claimType are required');
  }
  return {
    schemaVersion: 1,
    devices: [
      {
        deviceId: SMOKE_HUB_DEVICE_ID,
        deviceName: 'Compose smoke companion-ui device',
        satelliteId,
        satelliteName: 'Compose smoke Satellite Hub',
        endpointId,
        claimType,
        credentialSha256: createHash('sha256').update(credential, 'utf8').digest('hex'),
        enrollmentVersion: 1,
        enrollmentAssurance: 'device_credential',
        enrollmentStatus: 'active',
        companionId,
        maxCapabilities: {
          input: [...SMOKE_DEVICE_MAX_CAPABILITIES.input],
          output: [...SMOKE_DEVICE_MAX_CAPABILITIES.output],
          control: [...SMOKE_DEVICE_MAX_CAPABILITIES.control],
          safety: [...SMOKE_DEVICE_MAX_CAPABILITIES.safety],
        },
      },
    ],
  };
}

/** Fresh Ed25519 signing key for the Hub's device assertions (PKCS#8 PEM). */
export function generateSmokeHubDeviceAssertionKey() {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function writeOwned(path, content, mode) {
  writeFileSync(path, content, { encoding: 'utf8', mode });
  chmodSync(path, mode);
  chownSync(path, HUB_UID, HUB_GID);
}

function main() {
  const directory = process.env.PSFN_SMOKE_HUB_DEVICE_DIR;
  if (!directory) {
    console.error('[smoke-hub-device] PSFN_SMOKE_HUB_DEVICE_DIR is required');
    return 2;
  }
  const registry = buildSmokeHubDeviceRegistry({
    credential: process.env.PSFN_SMOKE_HUB_DEVICE_CREDENTIAL,
    companionId: process.env.COMPANION_ID,
    satelliteId: process.env.PSFN_SMOKE_SATELLITE_ID,
    endpointId: process.env.PSFN_SMOKE_SATELLITE_ENDPOINT_ID,
    claimType: process.env.PSFN_SMOKE_SATELLITE_CLAIM_TYPE,
  });
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o700);
  chownSync(directory, HUB_UID, HUB_GID);
  // Rewritten on every seed so the registry always matches this run's credential.
  writeOwned(join(directory, SMOKE_HUB_DEVICE_REGISTRY_FILE), `${JSON.stringify(registry, null, 2)}\n`, 0o600);
  writeOwned(join(directory, SMOKE_HUB_DEVICE_ASSERTION_KEY_FILE), generateSmokeHubDeviceAssertionKey(), 0o600);
  console.log(`[smoke-hub-device] enrolled ${SMOKE_HUB_DEVICE_ID} in ${directory}`);
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[smoke-hub-device] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
