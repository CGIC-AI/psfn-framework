#!/usr/bin/env node
// ── Compose smoke satellite registry seed (psfn-framework-2ahwj) ──
// Writes the SYSTEM_DATA_DIR satellites.json that admits the Compose smoke
// stack's Satellite Hub. There is no config/satellites.seed.json template: the
// registry binds a specific bearer credential to a specific endpoint, so it has
// to be derived from the deployment's own satellite key.
//
// The gateway derives a satellite principal as api-key-<sha256(key)[:24]>
// (src/channels/backplane/http/auth.ts deriveApiKeyPrincipalId). A satellite
// principal is admitted on an endpoint only when that endpoint's
// auth.apiKeyPrincipalIds lists the derived id, so this file is what turns the
// hub's PSFN_API_KEY into an accepted satellite claim.
//
// Runs inside the runtime image (node only, no framework build output), and is
// idempotent: an existing satellites.json is left untouched.

import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const PRINCIPAL_DIGEST_LENGTH = 24;
const MIN_SATELLITE_API_KEY_LENGTH = 16;

export function deriveApiKeyPrincipalId(token) {
  return `api-key-${createHash('sha256').update(token.trim()).digest('hex').slice(0, PRINCIPAL_DIGEST_LENGTH)}`;
}

/**
 * Build the smoke stack's satellite registry. The shape is validated by the
 * framework's own parseSatelliteRegistryConfig, which rejects unknown keys and
 * empty arrays, so every field here is deliberate.
 */
export function buildSmokeSatelliteRegistry(options) {
  const apiKey = (options.apiKey ?? '').trim();
  if (apiKey.length < MIN_SATELLITE_API_KEY_LENGTH) {
    throw new Error(`satellite API key must be at least ${MIN_SATELLITE_API_KEY_LENGTH} characters`);
  }
  const satelliteId = (options.satelliteId ?? '').trim();
  const endpointId = (options.endpointId ?? '').trim();
  const claimType = (options.claimType ?? '').trim();
  if (!satelliteId || !endpointId || !claimType) {
    throw new Error('satelliteId, endpointId, and claimType are required');
  }
  return {
    schemaVersion: 1,
    enabled: true,
    satellites: [
      {
        satelliteId,
        displayName: 'Compose smoke Satellite Hub',
        mobility: 'static',
        endpoints: [
          {
            endpointId,
            displayName: 'Compose smoke Satellite Hub endpoint',
            claimTypes: [claimType],
            promptChannelType: claimType,
            auth: {
              mode: 'api_key',
              apiKeyPrincipalIds: [deriveApiKeyPrincipalId(apiKey)],
            },
            defaultIdentity: {
              authorId: 'smoke-partner',
              authorName: 'Smoke Partner',
              canonicalContactId: 'contact:smoke-partner',
              channelPrivacy: 'private',
            },
            // The hub runs HUB_TEXT_ONLY with the text-only capability profile,
            // whose framework capability set is exactly ["text"].
            maxCapabilities: ['text'],
            // Companion relay scopes. An empty array is rejected by the
            // registry parser, so omit the key rather than emptying it.
            telemetryScopes: ['approvals', 'artifacts', 'tool_activity'],
          },
        ],
      },
    ],
  };
}

function main() {
  const systemDataDir = process.env.SYSTEM_DATA_DIR;
  if (!systemDataDir) {
    console.error('[smoke-satellites] SYSTEM_DATA_DIR is required');
    return 2;
  }
  const target = join(systemDataDir, 'satellites.json');
  if (existsSync(target)) {
    console.log(`[smoke-satellites] keep existing satellite registry: ${target}`);
    return 0;
  }
  const registry = buildSmokeSatelliteRegistry({
    apiKey: process.env.PSFN_SMOKE_SATELLITE_API_KEY,
    satelliteId: process.env.PSFN_SMOKE_SATELLITE_ID,
    endpointId: process.env.PSFN_SMOKE_SATELLITE_ENDPOINT_ID,
    claimType: process.env.PSFN_SMOKE_SATELLITE_CLAIM_TYPE,
  });
  writeFileSync(target, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  console.log(`[smoke-satellites] wrote satellite registry: ${target}`);
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[smoke-satellites] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
