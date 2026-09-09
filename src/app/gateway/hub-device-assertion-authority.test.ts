import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HubDeviceAttachmentRejectedError } from '../../boundary/fleet-auth/hub-device-ingress.js';
import type { HubDeviceAssertionVerifierConfig } from '../../boundary/fleet-auth/hub-device-assertion.js';
import { InMemoryHubDeviceAssertionReplayStore } from '../../boundary/fleet-auth/hub-device-assertion-replay-memory.js';
import { GuestOnlyHubDeviceAttachmentStore } from '../../boundary/fleet-auth/hub-device-guest-attachments.js';
import { parseSatelliteRegistryConfig } from '../../channels/backplane/satellite-registry.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import {
  createStandaloneHubDeviceAssertionAuthority,
  HUB_DEVICE_ASSERTIONS_PATH_ENV,
  HUB_DEVICE_ASSERTION_AUDIT_PEPPER_ENV,
  loadStandaloneHubDeviceAssertionConfig,
  resolveGatewayHubDeviceAssertionVerifier,
  resolveHubDeviceAssertionAuditPepper,
} from './hub-device-assertion-authority.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const AUDIENCE = 'https://psfn-gateway.local';
const ISSUER = 'psfn-satellite-hub';
const NOW_MS = Date.parse('2026-09-09T22:00:00.000Z');

function keyRing(publicKey: KeyObject, kid = 'hub-key-1'): HubDeviceAssertionVerifierConfig {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    maxTtlSeconds: 60,
    clockSkewSeconds: 2,
    keys: [{
      kid,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2099-01-01T00:00:00.000Z',
      status: 'active',
    }],
  };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Mint exactly what apps/satellite-hub's issuer mints (canonical order, raw Ed25519 signature). */
function mint(privateKey: KeyObject, overrides: Partial<Record<string, unknown>> = {}): string {
  const header = base64url({ alg: 'EdDSA', typ: 'PSFN-HUB-DEVICE', v: 1, kid: 'hub-key-1' });
  const iat = Math.floor(NOW_MS / 1000);
  const claims = base64url({
    iss: ISSUER,
    device_id: 's12g-hub-device',
    enrollment_version: 1,
    enrollment_assurance: 'device_credential',
    place_id: 'eidoverse:commons',
    aud: AUDIENCE,
    companion_id: COMPANION_ID,
    session_id: 'realtime:s12g-hub-device',
    iat,
    exp: iat + 30,
    jti: '018f0f10-79b2-4cc7-8c99-0242ac120002',
    ...overrides,
  });
  const signature = sign(null, Buffer.from(`${header}.${claims}`, 'ascii'), privateKey);
  return `${header}.${claims}.${signature.toString('base64url')}`;
}

const EXPECTED = {
  deviceId: 's12g-hub-device',
  enrollmentVersion: 1,
  enrollmentStatus: 'active' as const,
  companionId: COMPANION_ID,
  sessionId: 'realtime:s12g-hub-device',
  placeId: 'eidoverse:commons',
};

function registryWithRing(ring: HubDeviceAssertionVerifierConfig): SatelliteRegistryConfig {
  return parseSatelliteRegistryConfig({
    schemaVersion: 1,
    enabled: true,
    hubDeviceAssertions: ring,
    satellites: [{
      satelliteId: 'hub',
      displayName: 'Hub',
      mobility: 'static',
      endpoints: [{
        endpointId: 'hub',
        displayName: 'Hub endpoint',
        claimTypes: ['world-avatar'],
        promptChannelType: 'satellite_hub',
        auth: { mode: 'api_key' },
        defaultIdentity: {
          authorId: 'visitor',
          authorName: 'Visitor',
          canonicalContactId: 'visitor-contact',
          channelPrivacy: 'private',
        },
        maxCapabilities: ['text'],
        hubDeviceEnrollment: {
          deviceId: 's12g-hub-device',
          enrollmentVersion: 1,
          enrollmentStatus: 'active',
        },
      }],
    }],
  });
}

describe('standalone Hub device assertion authority (no fleet auth)', () => {
  it('admits a freshly minted assertion, treats exact re-presentation as a retry, and rejects a mutated replay', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const replayStore = new InMemoryHubDeviceAssertionReplayStore({ now: () => NOW_MS });
    const authority = createStandaloneHubDeviceAssertionAuthority({
      standalone: { source: 'satellites.json', path: '/data/satellites.json', config: keyRing(publicKey) },
      sessionPepper: 'x'.repeat(48),
      replayStore,
      now: () => NOW_MS,
    });
    const token = mint(privateKey);

    await expect(authority.verifyAndConsumeHubDeviceAssertion(token, EXPECTED))
      .resolves.toMatchObject({ kind: 'hub_device', deviceId: 's12g-hub-device', companionId: COMPANION_ID });
    expect(replayStore.size).toBe(1);

    // Exact same bytes: a transport retry of the same turn, which the ingress admits as 'retry'.
    await expect(authority.verifyAndConsumeHubDeviceAssertion(token, EXPECTED)).resolves.toMatchObject({
      jti: '018f0f10-79b2-4cc7-8c99-0242ac120002',
    });

    // Same jti, different signed bytes: a replay with a mutated body is rejected.
    const mutated = mint(privateKey, { exp: Math.floor(NOW_MS / 1000) + 31 });
    await expect(authority.verifyAndConsumeHubDeviceAssertion(mutated, EXPECTED))
      .rejects.toThrow(/mutated replay was rejected/u);
  });

  it('rejects an assertion signed by a key outside the ring and a revoked enrollment', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const { privateKey: rogue } = generateKeyPairSync('ed25519');
    const authority = createStandaloneHubDeviceAssertionAuthority({
      standalone: { source: 'satellites.json', path: '/data/satellites.json', config: keyRing(publicKey) },
      sessionPepper: 'x'.repeat(48),
      now: () => NOW_MS,
    });
    await expect(authority.verifyAndConsumeHubDeviceAssertion(mint(rogue), EXPECTED))
      .rejects.toThrow(/signature is invalid/u);
  });

  it('expires replay entries with the assertion and bounds the fence', async () => {
    let now = NOW_MS;
    const store = new InMemoryHubDeviceAssertionReplayStore({ now: () => now, maxEntries: 2 });
    const audit = {
      issuerDigest: 'a', keyIdDigest: 'b', audienceDigest: 'c', companionIdDigest: 'd',
      deviceIdDigest: 'e', sessionIdDigest: 'f', enrollmentVersionDigest: 'g', jtiDigest: 'h',
    };
    const consume = (jti: string, digest: string, expiresInMs: number) => store.consume({
      issuer: ISSUER, jti, assertionDigest: digest, deviceId: 'd', enrollmentVersion: 1,
      expiresAt: new Date(now + expiresInMs), auditContext: audit,
    });
    await expect(consume('j1', 'digest-1', 10_000)).resolves.toEqual({ outcome: 'consumed' });
    await expect(consume('j1', 'digest-1', 10_000)).resolves.toEqual({ outcome: 'replayed' });
    await expect(consume('j1', 'digest-other', 10_000)).resolves.toEqual({ outcome: 'mismatch' });
    await expect(consume('j2', 'digest-2', 20_000)).resolves.toEqual({ outcome: 'consumed' });
    // At the bound the soonest-expiring entry (j1) is evicted for j3.
    await expect(consume('j3', 'digest-3', 30_000)).resolves.toEqual({ outcome: 'consumed' });
    expect(store.size).toBe(2);
    now += 25_000;
    await expect(consume('j2', 'digest-2', 1_000)).resolves.toEqual({ outcome: 'consumed' });
  });

  it('guest attachments bind to the enrolled companion, refuse SSO browser sessions, and fence for a bounded time', async () => {
    let now = NOW_MS;
    const store = new GuestOnlyHubDeviceAttachmentStore({ now: () => now, fenceTtlMs: 5_000 });
    const principal = {
      kind: 'hub_device' as const,
      issuer: ISSUER,
      keyId: 'hub-key-1',
      deviceId: 's12g-hub-device',
      enrollmentVersion: 1,
      enrollmentAssurance: 'device_credential' as const,
      audience: AUDIENCE,
      companionId: COMPANION_ID,
      sessionId: 'realtime:s12g-hub-device',
      issuedAt: new Date(NOW_MS).toISOString(),
      expiresAt: new Date(NOW_MS + 30_000).toISOString(),
      jti: '018f0f10-79b2-4cc7-8c99-0242ac120002',
    };
    const connection = { ...EXPECTED, connectionId: 'conn-1' };
    const created = await store.attach({
      assertionDigest: 'digest-1', devicePrincipal: principal, connection, human: { kind: 'guest' },
    });
    expect(created).toMatchObject({
      disposition: 'created',
      actor: { kind: 'guest', companionId: COMPANION_ID },
      channel: { source: 'server', companionId: COMPANION_ID },
    });
    expect(created.channel.id).toMatch(/^hub-device:[0-9a-f]{64}$/u);
    await expect(store.attach({
      assertionDigest: 'digest-1', devicePrincipal: principal, connection, human: { kind: 'guest' },
    })).resolves.toMatchObject({ disposition: 'retry', attachmentId: created.attachmentId });
    await expect(store.attach({
      assertionDigest: 'digest-2', devicePrincipal: principal, connection,
      human: { kind: 'fleet_browser_session', sessionToken: 'sso-token' },
    })).rejects.toBeInstanceOf(HubDeviceAttachmentRejectedError);

    await store.fenceDevice({ assertionDigest: 'digest-2', connectionId: 'conn-1', reason: 'assertion_rejected' });
    await expect(store.attach({
      assertionDigest: 'digest-3', devicePrincipal: principal, connection, human: { kind: 'guest' },
    })).rejects.toMatchObject({ code: 'device_fenced' });
    now += 5_001;
    await expect(store.attach({
      assertionDigest: 'digest-3', devicePrincipal: principal, connection, human: { kind: 'guest' },
    })).resolves.toMatchObject({ disposition: 'created' });
  });
});

describe('standalone Hub device assertion configuration', () => {
  it('reads the ring from satellites.json and round-trips it through the registry parser', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const registry = registryWithRing(keyRing(publicKey));
    const loaded = loadStandaloneHubDeviceAssertionConfig({
      systemDataDir: '/data',
      satelliteRegistry: registry,
      env: {},
    });
    expect(loaded).toMatchObject({
      source: 'satellites.json',
      path: '/data/satellites.json',
      config: { issuer: ISSUER, audience: AUDIENCE, keys: [{ kid: 'hub-key-1', status: 'active' }] },
    });
  });

  it('prefers the PSFN_HUB_DEVICE_ASSERTIONS_PATH file and warns when satellites.json is shadowed', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const root = mkdtempSync(join(tmpdir(), 'psfn-hub-ring-'));
    const envFile = join(root, 'hub-device-assertions.json');
    writeFileSync(envFile, JSON.stringify({ hubDeviceAssertions: keyRing(publicKey, 'env-key') }));
    const warnings: string[] = [];
    const loaded = loadStandaloneHubDeviceAssertionConfig({
      systemDataDir: root,
      satelliteRegistry: registryWithRing(keyRing(publicKey, 'registry-key')),
      env: { [HUB_DEVICE_ASSERTIONS_PATH_ENV]: envFile },
      warn: message => warnings.push(message),
    });
    expect(loaded).toMatchObject({ source: 'env-file', path: envFile, config: { keys: [{ kid: 'env-key' }] } });
    expect(warnings).toEqual([expect.stringMatching(/shadowed by the standalone verifier file/u)]);

    // A bare block is accepted too.
    writeFileSync(envFile, JSON.stringify(keyRing(publicKey, 'bare-key')));
    expect(loadStandaloneHubDeviceAssertionConfig({
      systemDataDir: root,
      satelliteRegistry: { schemaVersion: 1, enabled: false, satellites: [] },
      env: { [HUB_DEVICE_ASSERTIONS_PATH_ENV]: envFile },
    })).toMatchObject({ source: 'env-file', config: { keys: [{ kid: 'bare-key' }] } });

    writeFileSync(envFile, JSON.stringify({ unrelated: true }));
    expect(() => loadStandaloneHubDeviceAssertionConfig({
      systemDataDir: root,
      satelliteRegistry: { schemaVersion: 1, enabled: false, satellites: [] },
      env: { [HUB_DEVICE_ASSERTIONS_PATH_ENV]: envFile },
    })).toThrow(/must contain a hubDeviceAssertions verifier block/u);
  });

  it('returns nothing when no ring is configured anywhere', () => {
    expect(loadStandaloneHubDeviceAssertionConfig({
      systemDataDir: '/data',
      satelliteRegistry: { schemaVersion: 1, enabled: false, satellites: [] },
      env: {},
    })).toBeUndefined();
  });

  it('rejects a malformed satellites.json ring with the registry field path', () => {
    expect(() => parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: false,
      hubDeviceAssertions: { issuer: 'hub', audience: 'http://insecure', maxTtlSeconds: 60, clockSkewSeconds: 2, keys: [] },
      satellites: [],
    })).toThrow(/satellites\.json\.hubDeviceAssertions\.audience must be an exact normalized https origin/u);
  });

  it('resolves the audit pepper from the explicit env or derives it from the session HMAC key', () => {
    expect(resolveHubDeviceAssertionAuditPepper({
      env: { [HUB_DEVICE_ASSERTION_AUDIT_PEPPER_ENV]: 'p'.repeat(40) },
    })).toBe('p'.repeat(40));
    expect(() => resolveHubDeviceAssertionAuditPepper({
      env: { [HUB_DEVICE_ASSERTION_AUDIT_PEPPER_ENV]: 'short' },
    })).toThrow(/at least 32 characters/u);
    const derived = resolveHubDeviceAssertionAuditPepper({
      env: {},
      sessionHmacKeyring: { activeVersion: 'v1', keys: { v1: 'gateway-session-key' } },
    });
    expect(derived).toMatch(/^[0-9a-f]{64}$/u);
    expect(resolveHubDeviceAssertionAuditPepper({
      env: {},
      sessionHmacKeyring: { activeVersion: 'v1', keys: { v1: 'gateway-session-key' } },
    })).toBe(derived);
    expect(() => resolveHubDeviceAssertionAuditPepper({ env: {} })).toThrow(/audit pepper requires/u);
  });

  it('lets fleet-auth.json win with a warning, and otherwise composes the standalone verifier', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const standalone = {
      source: 'satellites.json' as const,
      path: '/data/satellites.json',
      config: keyRing(publicKey),
    };
    const warnings: string[] = [];
    const infos: string[] = [];
    const fleetVerifier = {
      verifyAndConsumeHubDeviceAssertion: async () => { throw new Error('fleet verifier invoked'); },
      attachHubDeviceHuman: async () => { throw new Error('fleet attach invoked'); },
      fenceHubDeviceAttachment: async () => undefined,
    };
    const underFleet = resolveGatewayHubDeviceAssertionVerifier({
      fleetAuthVerifier: fleetVerifier,
      standalone,
      sessionPepper: () => 'x'.repeat(48),
      warn: message => warnings.push(message),
      info: message => infos.push(message),
    });
    expect(underFleet?.source).toBe('fleet-auth.json');
    expect(warnings).toEqual([expect.stringMatching(/shadowed by fleet-auth\.json/u)]);
    await expect(underFleet!.verifyAndConsumeHubDeviceAssertion('token', EXPECTED))
      .rejects.toThrow(/fleet verifier invoked/u);

    const standaloneVerifier = resolveGatewayHubDeviceAssertionVerifier({
      standalone,
      sessionPepper: () => 'x'.repeat(48),
      warn: message => warnings.push(message),
      info: message => infos.push(message),
    });
    expect(standaloneVerifier?.source).toBe('satellites.json');
    expect(infos).toEqual([expect.stringMatching(/ready without fleet auth/u)]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = (() => {
      const header = base64url({ alg: 'EdDSA', typ: 'PSFN-HUB-DEVICE', v: 1, kid: 'hub-key-1' });
      const claims = base64url({
        iss: ISSUER, device_id: 's12g-hub-device', enrollment_version: 1,
        enrollment_assurance: 'device_credential', place_id: 'eidoverse:commons', aud: AUDIENCE,
        companion_id: COMPANION_ID, session_id: 'realtime:s12g-hub-device',
        iat: nowSeconds, exp: nowSeconds + 30, jti: '018f0f10-79b2-4cc7-8c99-0242ac120003',
      });
      const signature = sign(null, Buffer.from(`${header}.${claims}`, 'ascii'), privateKey);
      return `${header}.${claims}.${signature.toString('base64url')}`;
    })();
    await expect(standaloneVerifier!.verifyAndConsumeHubDeviceAssertion(token, EXPECTED))
      .resolves.toMatchObject({ deviceId: 's12g-hub-device' });

    expect(resolveGatewayHubDeviceAssertionVerifier({
      sessionPepper: () => 'x'.repeat(48),
      warn: () => undefined,
      info: () => undefined,
    })).toBeUndefined();
  });
});
