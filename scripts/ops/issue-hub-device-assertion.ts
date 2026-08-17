#!/usr/bin/env node

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHubDeviceAssertionIssuer } from '../../apps/satellite-hub/src/ts/hub/device-assertion.js';
import { parseSatelliteRegistryConfig } from '../../src/channels/backplane/satellite-registry.js';
import { isRecord } from '../../src/shared/utils/types.js';
import { validateFleetAuthConfig } from '../../src/system/config/fleet-auth-config.js';

const INPUT_KEYS = new Set([
  'fleetAuthPath',
  'satelliteRegistryPath',
  'privateKeyPath',
  'ttlSeconds',
  'companionId',
  'satelliteId',
  'endpointId',
  'sessionId',
  'issuedAtSeconds',
  'jti',
]);

export interface HubDeviceAssertionIssueInput {
  fleetAuthPath: string;
  satelliteRegistryPath: string;
  privateKeyPath: string;
  ttlSeconds: number;
  companionId: string;
  satelliteId: string;
  endpointId: string;
  sessionId: string;
  issuedAtSeconds?: number;
  jti?: string;
}

export function issueHubDeviceAssertionFromInput(input: unknown): string {
  const parsed = parseInput(input);
  const privateKeyPath = resolve(parsed.privateKeyPath);
  if ((statSync(privateKeyPath).mode & 0o077) !== 0) {
    throw new Error('Hub device assertion private key must not be group/world accessible');
  }
  const privateKeyPem = readFileSync(privateKeyPath, 'utf8');
  const fleetAuthPath = resolve(parsed.fleetAuthPath);
  const fleetAuth = validateFleetAuthConfig(
    JSON.parse(readFileSync(fleetAuthPath, 'utf8')) as unknown,
    fleetAuthPath,
  );
  const activeKey = fleetAuth.hubDeviceAssertions.keys.find(key => key.status === 'active');
  if (!activeKey || !privateKeyMatchesPublicKey(privateKeyPem, activeKey.publicKeyPem)) {
    throw new Error('Hub device assertion private key does not match the active verifier');
  }
  if (parsed.ttlSeconds > fleetAuth.hubDeviceAssertions.maxTtlSeconds) {
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
    issuer: fleetAuth.hubDeviceAssertions.issuer,
    kid: activeKey.kid,
    audience: fleetAuth.hubDeviceAssertions.audience,
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
    fleetAuthPath: requireString(input.fleetAuthPath, 'fleetAuthPath'),
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
