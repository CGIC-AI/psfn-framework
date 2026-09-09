import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyAndConsumeHubDeviceAssertion } from '../../src/boundary/fleet-auth/hub-device-assertion.js';
import { generateHubDeviceKey } from './generate-hub-device-key.js';
import {
  issueHubDeviceAssertionFromInput,
  resolveHubDeviceAssertionRing,
  selectHubDeviceSigningKey,
} from './issue-hub-device-assertion.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_PEPPER = 'hub-device-assertion-session-pepper-32b';

function standaloneRing(publicKeyPem: string, kid = 'hub-key-1', status: 'active' | 'retiring' = 'active') {
  return {
    issuer: 'psfn-satellite-hub',
    audience: 'https://fleet.example.invalid',
    maxTtlSeconds: 60,
    clockSkewSeconds: 2,
    keys: [{
      kid,
      publicKeyPem,
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2099-01-01T00:00:00.000Z',
      status,
    }],
  };
}

function registryDocument(
  enrollmentStatus: 'active' | 'revoked',
  hubDeviceAssertions?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    enabled: true,
    ...(hubDeviceAssertions ? { hubDeviceAssertions } : {}),
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
  };
}

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

  it('mints from a key-only standalone ring in satellites.json, selecting the key by public-key match', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-hub-assertion-standalone-'));
    const generated = generateHubDeviceKey({ out: join(root, 'hub-device-private.pem') });
    const { privateKey: rotatedOut, publicKey: rotatedOutPublic } = generateKeyPairSync('ed25519');
    void rotatedOut;
    const ring = standaloneRing(generated.verifierKey.publicKeyPem, generated.verifierKey.kid, 'retiring');
    // Two live keys: the other one is "first active" and must NOT be picked.
    ring.keys.unshift({
      kid: 'someone-elses-active-key',
      publicKeyPem: rotatedOutPublic.export({ type: 'spki', format: 'pem' }).toString(),
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2099-01-01T00:00:00.000Z',
      status: 'active',
    });
    const satelliteRegistryPath = join(root, 'satellites.json');
    writeFileSync(satelliteRegistryPath, JSON.stringify(registryDocument('active', ring)));
    const now = new Date('2026-08-17T12:00:00.000Z');

    const assertion = issueHubDeviceAssertionFromInput({
      satelliteRegistryPath,
      privateKeyPath: generated.privateKeyPath,
      ttlSeconds: 30,
      companionId: COMPANION_ID,
      satelliteId: 'office-satellite',
      endpointId: 'office-endpoint',
      sessionId: 'realtime:office-device:session',
      issuedAtSeconds: Math.floor(now.getTime() / 1_000),
      jti: '018f0f10-79b2-4cc7-8c99-0242ac120004',
    });
    const header = JSON.parse(Buffer.from(assertion.split('.')[0]!, 'base64url').toString('utf8')) as { kid: string };
    expect(header.kid).toBe(generated.verifierKey.kid);
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: assertion,
      config: ring,
      expected: {
        deviceId: 'office-device',
        enrollmentVersion: 7,
        enrollmentStatus: 'active',
        companionId: COMPANION_ID,
        sessionId: 'realtime:office-device:session',
        placeId: 'office',
      },
      replayStore: { consume: async () => ({ outcome: 'consumed' as const }) },
      nowSeconds: Math.floor(now.getTime() / 1_000),
      sessionPepper: SESSION_PEPPER,
    })).resolves.toMatchObject({ deviceId: 'office-device', keyId: generated.verifierKey.kid });
  });

  it('accepts a standalone verifier file and refuses a key outside the ring', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-hub-assertion-ringfile-'));
    const generated = generateHubDeviceKey({ out: join(root, 'hub-device-private.pem') });
    const ringPath = join(root, 'hub-device-assertions.json');
    writeFileSync(ringPath, JSON.stringify({ hubDeviceAssertions: standaloneRing(generated.verifierKey.publicKeyPem) }));
    const satelliteRegistryPath = join(root, 'satellites.json');
    writeFileSync(satelliteRegistryPath, JSON.stringify(registryDocument('active')));

    expect(resolveHubDeviceAssertionRing({ hubDeviceAssertionsPath: ringPath, satelliteRegistryPath }))
      .toMatchObject({ source: 'hubDeviceAssertionsPath', ring: { issuer: 'psfn-satellite-hub' } });
    expect(issueHubDeviceAssertionFromInput({
      hubDeviceAssertionsPath: ringPath,
      satelliteRegistryPath,
      privateKeyPath: generated.privateKeyPath,
      ttlSeconds: 30,
      companionId: COMPANION_ID,
      satelliteId: 'office-satellite',
      endpointId: 'office-endpoint',
      sessionId: 'realtime:office-device:session',
    })).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

    const stranger = generateHubDeviceKey({ out: join(root, 'stranger.pem') });
    expect(() => issueHubDeviceAssertionFromInput({
      hubDeviceAssertionsPath: ringPath,
      satelliteRegistryPath,
      privateKeyPath: stranger.privateKeyPath,
      ttlSeconds: 30,
      companionId: COMPANION_ID,
      satelliteId: 'office-satellite',
      endpointId: 'office-endpoint',
      sessionId: 'realtime:office-device:session',
    })).toThrow(/does not match any active or retiring verifier key/u);

    expect(() => resolveHubDeviceAssertionRing({ satelliteRegistryPath }))
      .toThrow(/needs a verifier ring/u);
  });

  it('selects by pinned kid and never signs under a revoked key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const ring = standaloneRing(publicKeyPem, 'k-active');
    ring.keys.push({ ...ring.keys[0]!, kid: 'k-revoked', status: 'revoked' as 'active' });
    expect(selectHubDeviceSigningKey(ring, privateKeyPem).kid).toBe('k-active');
    expect(() => selectHubDeviceSigningKey(ring, privateKeyPem, 'k-revoked'))
      .toThrow(/does not match verifier key k-revoked/u);
  });

  it('generates a 0600 private key once and prints a ring entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-hub-keygen-'));
    const out = join(root, 'hub.pem');
    const generated = generateHubDeviceKey({
      out,
      kid: 'my-hub',
      now: () => new Date('2026-09-09T00:00:00.000Z'),
    });
    expect(generated.verifierKey).toMatchObject({ kid: 'my-hub', status: 'active' });
    expect(generated.verifierKey.publicKeyPem).toContain('PUBLIC KEY');
    expect(Date.parse(generated.verifierKey.notAfter)).toBeGreaterThan(Date.parse(generated.verifierKey.notBefore));
    expect(readFileSync(out, 'utf8')).toContain('PRIVATE KEY');
    expect(() => generateHubDeviceKey({ out })).toThrow(/Refusing to overwrite/u);
  });
});
