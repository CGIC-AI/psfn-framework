#!/usr/bin/env node

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHubDeviceAssertionIssuer } from '../../apps/satellite-hub/src/ts/hub/device-assertion.js';
import { parseSatelliteRegistryConfig } from '../../src/channels/backplane/satellite-registry.js';
import {
  extractHubDeviceAssertionBlock,
  parseHubDeviceAssertionVerifierConfig,
} from '../../src/boundary/fleet-auth/hub-device-assertion-config.js';
import type {
  HubDeviceAssertionVerifierConfig,
  HubDeviceAssertionVerifierKey,
} from '../../src/boundary/fleet-auth/hub-device-assertion.js';
import { isRecord } from '../../src/shared/utils/types.js';
import { validateFleetAuthConfig } from '../../src/system/config/fleet-auth-config.js';

// Mint a Hub device assertion from an operator-held Ed25519 private key.
//
// The verifier ring comes from whichever authority the deployment uses
// (psfn-framework-n66dn.2): fleet-auth.json (`fleetAuthPath`), a standalone
// verifier file (`hubDeviceAssertionsPath`, the same block shape), or the
// `hubDeviceAssertions` block inside satellites.json itself. Fleet auth is
// never required. The signing key is matched to the ring by public key, so a
// rotation can carry several active/retiring keys and the operator picks the
// one they hold (psfn-framework-wlls6); `kid` pins the choice when the same
// key appears under several ids.

const INPUT_KEYS = new Set([
  'fleetAuthPath',
  'hubDeviceAssertionsPath',
  'satelliteRegistryPath',
  'privateKeyPath',
  'ttlSeconds',
  'companionId',
  'satelliteId',
  'endpointId',
  'sessionId',
  'issuedAtSeconds',
  'jti',
  'kid',
]);

export interface HubDeviceAssertionIssueInput {
  /** fleet-auth.json carrying the ring. Optional: the ring may live elsewhere. */
  fleetAuthPath?: string;
  /** Standalone verifier file (bare block, `{ hubDeviceAssertions }`, or a satellites.json document). */
  hubDeviceAssertionsPath?: string;
  satelliteRegistryPath: string;
  privateKeyPath: string;
  ttlSeconds: number;
  companionId: string;
  satelliteId: string;
  endpointId: string;
  sessionId: string;
  issuedAtSeconds?: number;
  jti?: string;
  /** Pin the verifier key id when the held key appears under several ids. */
  kid?: string;
}

export type HubDeviceAssertionRingSource = 'fleet-auth.json' | 'hubDeviceAssertionsPath' | 'satellites.json';

export function resolveHubDeviceAssertionRing(parsed: Pick<
  HubDeviceAssertionIssueInput,
  'fleetAuthPath' | 'hubDeviceAssertionsPath' | 'satelliteRegistryPath'
>): { source: HubDeviceAssertionRingSource; ring: HubDeviceAssertionVerifierConfig } {
  if (parsed.fleetAuthPath !== undefined) {
    const fleetAuthPath = resolve(parsed.fleetAuthPath);
    const fleetAuth = validateFleetAuthConfig(
      JSON.parse(readFileSync(fleetAuthPath, 'utf8')) as unknown,
      fleetAuthPath,
    );
    return { source: 'fleet-auth.json', ring: fleetAuth.hubDeviceAssertions };
  }
  if (parsed.hubDeviceAssertionsPath !== undefined) {
    const path = resolve(parsed.hubDeviceAssertionsPath);
    const block = extractHubDeviceAssertionBlock(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    if (block === undefined) {
      throw new Error('hubDeviceAssertionsPath file must contain a hubDeviceAssertions verifier block');
    }
    return {
      source: 'hubDeviceAssertionsPath',
      ring: parseHubDeviceAssertionVerifierConfig(block, { field: 'hubDeviceAssertions' }),
    };
  }
  const registryPath = resolve(parsed.satelliteRegistryPath);
  const registry = parseSatelliteRegistryConfig(
    JSON.parse(readFileSync(registryPath, 'utf8')) as unknown,
    registryPath,
  );
  if (!registry.hubDeviceAssertions) {
    throw new Error(
      'Hub device assertion issuance needs a verifier ring: pass fleetAuthPath or '
      + 'hubDeviceAssertionsPath, or add a hubDeviceAssertions block to satellites.json',
    );
  }
  return { source: 'satellites.json', ring: registry.hubDeviceAssertions };
}

export function selectHubDeviceSigningKey(
  ring: HubDeviceAssertionVerifierConfig,
  privateKeyPem: string,
  pinnedKid?: string,
): HubDeviceAssertionVerifierKey {
  const candidates = ring.keys.filter(key => (
    key.status !== 'revoked'
    && (pinnedKid === undefined || key.kid === pinnedKid)
    && privateKeyMatchesPublicKey(privateKeyPem, key.publicKeyPem)
  ));
  if (candidates.length === 0) {
    throw new Error(
      pinnedKid === undefined
        ? 'Hub device assertion private key does not match any active or retiring verifier key'
        : `Hub device assertion private key does not match verifier key ${pinnedKid}`,
    );
  }
  const active = candidates.find(key => key.status === 'active');
  return active ?? candidates[0]!;
}

export function issueHubDeviceAssertionFromInput(input: unknown): string {
  const parsed = parseInput(input);
  const privateKeyPath = resolve(parsed.privateKeyPath);
  if ((statSync(privateKeyPath).mode & 0o077) !== 0) {
    throw new Error('Hub device assertion private key must not be group/world accessible');
  }
  const privateKeyPem = readFileSync(privateKeyPath, 'utf8');
  const { ring } = resolveHubDeviceAssertionRing(parsed);
  const signingKey = selectHubDeviceSigningKey(ring, privateKeyPem, parsed.kid);
  if (parsed.ttlSeconds > ring.maxTtlSeconds) {
    throw new Error('Hub device assertion TTL exceeds the active verifier maximum');
  }

  const registryPath = resolve(parsed.satelliteRegistryPath);
  const registry = parseSatelliteRegistryConfig(
    JSON.parse(readFileSync(registryPath, 'utf8')) as unknown,
    registryPath,
  );
  const satellite = registry.satellites.find(candidate => candidate.satelliteId === parsed.satelliteId);
  const endpoint = satellite?.endpoints.find(candidate => candidate.endpointId === parsed.endpointId);
  const enrollment = endpoint?.hubDeviceEnrollment;
  if (!registry.enabled || !satellite || !endpoint || !enrollment || enrollment.enrollmentStatus !== 'active') {
    throw new Error('Hub device assertion requires a current active endpoint enrollment');
  }

  return createHubDeviceAssertionIssuer({
    issuer: ring.issuer,
    kid: signingKey.kid,
    audience: ring.audience,
    privateKeyPem,
    ttlSeconds: parsed.ttlSeconds,
  }).issue({
    device: {
      deviceId: enrollment.deviceId,
      enrollmentVersion: enrollment.enrollmentVersion,
      enrollmentAssurance: 'device_credential',
      enrollmentStatus: enrollment.enrollmentStatus,
      companionId: parsed.companionId,
      ...(satellite.placeId ? { placeId: satellite.placeId } : {}),
    },
    sessionId: parsed.sessionId,
    ...(parsed.issuedAtSeconds === undefined ? {} : { issuedAtSeconds: parsed.issuedAtSeconds }),
    ...(parsed.jti === undefined ? {} : { jti: parsed.jti }),
  });
}

function parseInput(input: unknown): HubDeviceAssertionIssueInput {
  if (!isRecord(input)) {
    throw new Error('Hub device assertion issue input must be an object');
  }
  assertNoUnknownKeys(input, INPUT_KEYS, 'Hub device assertion issue input');
  return {
    ...(input.fleetAuthPath === undefined
      ? {}
      : { fleetAuthPath: requireString(input.fleetAuthPath, 'fleetAuthPath') }),
    ...(input.hubDeviceAssertionsPath === undefined
      ? {}
      : { hubDeviceAssertionsPath: requireString(input.hubDeviceAssertionsPath, 'hubDeviceAssertionsPath') }),
    satelliteRegistryPath: requireString(input.satelliteRegistryPath, 'satelliteRegistryPath'),
    privateKeyPath: requireString(input.privateKeyPath, 'privateKeyPath'),
    ttlSeconds: requirePositiveInteger(input.ttlSeconds, 'ttlSeconds'),
    companionId: requireString(input.companionId, 'companionId'),
    satelliteId: requireString(input.satelliteId, 'satelliteId'),
    endpointId: requireString(input.endpointId, 'endpointId'),
    sessionId: requireString(input.sessionId, 'sessionId'),
    ...(input.issuedAtSeconds === undefined
      ? {}
      : { issuedAtSeconds: requirePositiveInteger(input.issuedAtSeconds, 'issuedAtSeconds') }),
    ...(input.jti === undefined ? {} : { jti: requireString(input.jti, 'jti') }),
    ...(input.kid === undefined ? {} : { kid: requireString(input.kid, 'kid') }),
  };
}

function privateKeyMatchesPublicKey(privateKeyPem: string, publicKeyPem: string): boolean {
  const actual = createPublicKey(createPrivateKey(privateKeyPem)).export({
    type: 'spki',
    format: 'der',
  });
  const expected = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return actual.equals(expected);
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${field} contains unknown fields: ${unknown.join(', ')}`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(value);
}

async function main(): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  const assertion = issueHubDeviceAssertionFromInput(JSON.parse(raw) as unknown);
  process.stdout.write(`${assertion}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch(() => {
    process.stderr.write('Hub device assertion issuance failed\n');
    process.exitCode = 1;
  });
}
