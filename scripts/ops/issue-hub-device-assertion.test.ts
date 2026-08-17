import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyAndConsumeHubDeviceAssertion } from '../../src/boundary/fleet-auth/hub-device-assertion.js';
import { issueHubDeviceAssertionFromInput } from './issue-hub-device-assertion.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_PEPPER = 'hub-device-assertion-session-pepper-32b';

function writeAuthorityFiles(
  root: string,
  publicKeyPem: string,
  enrollmentStatus: 'active' | 'revoked' = 'active',
): { fleetAuthPath: string; satelliteRegistryPath: string } {
  const fleetAuth = JSON.parse(
    readFileSync(join(process.cwd(), 'config/fleet-auth.seed.json'), 'utf8'),
  ) as { hubDeviceAssertions: Record<string, unknown> };
  fleetAuth.hubDeviceAssertions = {
    ...fleetAuth.hubDeviceAssertions,
    keys: [{
      kid: 'hub-key-1',
      publicKeyPem,
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2099-01-01T00:00:00.000Z',
      status: 'active',
    }],
  };
  const fleetAuthPath = join(root, 'fleet-auth.seed.json');
  writeFileSync(fleetAuthPath, JSON.stringify(fleetAuth));

  const satelliteRegistryPath = join(root, 'satellites.json');
  writeFileSync(satelliteRegistryPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    satellites: [{
      satelliteId: 'office-satellite',
      displayName: 'Office satellite',
      mobility: 'static',
      placeId: 'office',
      endpoints: [{
        endpointId: 'office-endpoint',
        displayName: 'Office endpoint',
        claimTypes: ['hub-device'],
        promptChannelType: 'satellite_hub',
        auth: { mode: 'api_key' },
        defaultIdentity: {
          authorId: 'office-device',
          authorName: 'Office device',
          canonicalContactId: 'office-device-contact',
          channelPrivacy: 'private',
        },
        maxCapabilities: ['text'],
        hubDeviceEnrollment: {
          deviceId: 'office-device',
          enrollmentVersion: 7,
          enrollmentStatus,
        },
      }],
    }],
  }));
  return { fleetAuthPath, satelliteRegistryPath };
}

describe('Hub device assertion operations issuer', () => {
  it('issues through the canonical Hub authority with the exact device/session binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-hub-assertion-'));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPath = join(root, 'assertion-private.pem');
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const authority = writeAuthorityFiles(root, publicKeyPem);
    const now = new Date('2026-08-17T12:00:00.000Z');
    const assertion = issueHubDeviceAssertionFromInput({
      ...authority,
      privateKeyPath,
      ttlSeconds: 30,
      companionId: COMPANION_ID,
      satelliteId: 'office-satellite',
      endpointId: 'office-endpoint',
      sessionId: 'realtime:office-device:session',
      issuedAtSeconds: Math.floor(now.getTime() / 1_000),
      jti: '018f0f10-79b2-4cc7-8c99-0242ac120002',
    });

    await expect(verifyAndConsumeHubDeviceAssertion({
      token: assertion,
      config: {
        issuer: 'psfn-satellite-hub',
        audience: 'https://fleet.example.invalid',
        maxTtlSeconds: 60,
        clockSkewSeconds: 2,
        keys: [{
          kid: 'hub-key-1',
          publicKeyPem,
          notBefore: '2026-01-01T00:00:00.000Z',
          notAfter: '2099-01-01T00:00:00.000Z',
          status: 'active',
        }],
      },
      expected: {
        deviceId: 'office-device',
        enrollmentVersion: 7,
        enrollmentStatus: 'active',
        companionId: COMPANION_ID,
        sessionId: 'realtime:office-device:session',
        placeId: 'office',
      },
      replayStore: {
        consume: async () => ({ outcome: 'consumed' as const }),
      },
      nowSeconds: Math.floor(now.getTime() / 1_000),
      sessionPepper: SESSION_PEPPER,
    })).resolves.toMatchObject({
      deviceId: 'office-device',
      companionId: COMPANION_ID,
      sessionId: 'realtime:office-device:session',
      placeId: 'office',
    });
  });

  it('refuses a group/world-readable signing key', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-hub-assertion-mode-'));
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPath = join(root, 'assertion-private.pem');
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o644 });
    const publicKeyPem = generateKeyPairSync('ed25519').publicKey
      .export({ type: 'spki', format: 'pem' }).toString();
    const authority = writeAuthorityFiles(root, publicKeyPem);

    expect(() => issueHubDeviceAssertionFromInput({
      ...authority,
      privateKeyPath,
      ttlSeconds: 30,
      companionId: COMPANION_ID,
      satelliteId: 'office-satellite',
      endpointId: 'office-endpoint',
      sessionId: 'realtime:office-device:session',
    })).toThrow(/must not be group\/world accessible/u);
  });

  it('refuses to sign for a revoked current endpoint enrollment', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-hub-assertion-revoked-'));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPath = join(root, 'assertion-private.pem');
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const authority = writeAuthorityFiles(
      root,
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      'revoked',
    );

    expect(() => issueHubDeviceAssertionFromInput({
      ...authority,
      privateKeyPath,
      ttlSeconds: 30,
      companionId: COMPANION_ID,
      satelliteId: 'office-satellite',
      endpointId: 'office-endpoint',
      sessionId: 'realtime:office-device:session',
    })).toThrow(/requires a current active endpoint enrollment/u);
  });
});
