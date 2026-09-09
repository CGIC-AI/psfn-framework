#!/usr/bin/env node

import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HubDeviceAssertionVerifierKey } from '../../src/boundary/fleet-auth/hub-device-assertion.js';

// Generate the Ed25519 keypair a Satellite Hub signs device assertions with,
// and print the verifier-ring entry the gateway owner file needs. The private
// half is written once, mode 0600, and never printed; the public entry goes to
// stdout so it can be pasted into satellites.json `hubDeviceAssertions.keys`
// (or fleet-auth.json / the PSFN_HUB_DEVICE_ASSERTIONS_PATH file). No fleet
// auth is involved (psfn-framework-n66dn.2, psfn-framework-wlls6).
//
//   tsx scripts/ops/generate-hub-device-key.ts --out /secrets/hub-device-private.pem \
//     [--kid <id>] [--not-before <iso>] [--not-after <iso>] [--status active|retiring]

export interface GenerateHubDeviceKeyInput {
  out: string;
  kid?: string;
  notBefore?: string;
  notAfter?: string;
  status?: 'active' | 'retiring';
  now?: () => Date;
}

export interface GenerateHubDeviceKeyResult {
  privateKeyPath: string;
  verifierKey: HubDeviceAssertionVerifierKey;
}

const DEFAULT_VALIDITY_YEARS = 5;

export function generateHubDeviceKey(input: GenerateHubDeviceKeyInput): GenerateHubDeviceKeyResult {
  const privateKeyPath = resolve(input.out);
  if (existsSync(privateKeyPath)) {
    throw new Error(`Refusing to overwrite an existing key at ${privateKeyPath}`);
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  const kid = input.kid ?? `hub-device-${fingerprint.slice(0, 24)}`;
  const now = (input.now ?? (() => new Date()))();
  const notBefore = input.notBefore ?? new Date(now.getTime() - 60_000).toISOString();
  const notAfter = input.notAfter ?? new Date(Date.UTC(
    now.getUTCFullYear() + DEFAULT_VALIDITY_YEARS,
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
  )).toISOString();
  if (Number.isNaN(Date.parse(notBefore)) || Number.isNaN(Date.parse(notAfter))
    || Date.parse(notBefore) >= Date.parse(notAfter)) {
    throw new Error('notBefore must be an ISO timestamp earlier than notAfter');
  }
  writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600, flag: 'wx' });
  return {
    privateKeyPath,
    verifierKey: {
      kid,
      publicKeyPem,
      notBefore: new Date(Date.parse(notBefore)).toISOString(),
      notAfter: new Date(Date.parse(notAfter)).toISOString(),
      status: input.status ?? 'active',
    },
  };
}

function parseArgs(argv: readonly string[]): GenerateHubDeviceKeyInput {
  const input: GenerateHubDeviceKeyInput = { out: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    switch (flag) {
      case '--out': input.out = value; break;
      case '--kid': input.kid = value; break;
      case '--not-before': input.notBefore = value; break;
      case '--not-after': input.notAfter = value; break;
      case '--status':
        if (value !== 'active' && value !== 'retiring') throw new Error('--status must be active or retiring');
        input.status = value;
        break;
      default: throw new Error(`Unknown argument ${flag}`);
    }
    index += 1;
  }
  if (!input.out) throw new Error('--out <private-key.pem> is required');
  return input;
}

function main(): void {
  const result = generateHubDeviceKey(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result.verifierKey, null, 2)}\n`);
  process.stderr.write(`private key written (mode 0600): ${result.privateKeyPath}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
