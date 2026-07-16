import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  verifyAndConsumeHubDeviceAssertion,
  type HubDeviceAssertionReplayStore,
  type HubDeviceAssertionVerifierConfig,
} from './hub-device-assertion.js';

const PRIVATE_KEY = createPrivateKey({
  key: Buffer.from('MC4CAQAwBQYDK2VwBCIEIBxi3MoZ6dMittBNv2g0RvbmOi9PJuzu5IVCwAL2tIbN', 'base64'),
  format: 'der',
  type: 'pkcs8',
});
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1QtSd1BkjN8MfcUdxGshRQsTRWmoPMPmcXtCQfY2Ytk=
-----END PUBLIC KEY-----
`;
const ROTATED_PUBLIC_KEY_PEM = generateKeyPairSync('ed25519').publicKey
  .export({ type: 'spki', format: 'pem' }).toString();
const NOW = 1_784_112_410;
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const JTI = '018f0f10-79b2-4cc7-8c99-0242ac120002';
const fixture = JSON.parse(readFileSync(
  'test-fixtures/fleet-sso/hub-device-assertion-v1.json',
  'utf8',
)) as { validToken: string };

function config(status: 'active' | 'retiring' | 'revoked' = 'active'): HubDeviceAssertionVerifierConfig {
  return {
    issuer: 'psfn-satellite-hub',
    audience: 'https://fleet.example.test',
    maxTtlSeconds: 60,
    clockSkewSeconds: 2,
    keys: [{
      kid: 'hub-2026-07',
      publicKeyPem: PUBLIC_KEY_PEM,
      notBefore: '2026-07-01T00:00:00.000Z',
      notAfter: '2099-07-01T00:00:00.000Z',
      status,
    }, ...(status === 'active' ? [] : [{
      kid: 'hub-2026-08',
      publicKeyPem: ROTATED_PUBLIC_KEY_PEM,
      notBefore: '2026-07-01T00:00:00.000Z',
      notAfter: '2099-07-01T00:00:00.000Z',
      status: 'active' as const,
    }])],
  };
}

function token(overrides: Record<string, unknown> = {}, kid = 'hub-2026-07'): string {
  const header = { alg: 'EdDSA', typ: 'PSFN-HUB-DEVICE', v: 1, kid };
  const claims = {
    iss: 'psfn-satellite-hub',
    device_id: 'office-device',
    enrollment_version: 7,
    enrollment_assurance: 'device_credential',
    place_id: 'office',
    aud: 'https://fleet.example.test',
    companion_id: COMPANION_ID,
    session_id: 'realtime:office-device:session',
    iat: NOW - 10,
    exp: NOW + 20,
    jti: JTI,
    ...overrides,
  };
  return signTokenObjects(header, claims);
}

function signTokenObjects(header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign(
    null,
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    PRIVATE_KEY,
  ).toString('base64url');
  return `${encodedHeader}.${encodedClaims}.${signature}`;
}

class ReplayStore implements HubDeviceAssertionReplayStore {
  readonly seen = new Map<string, string>();
  lastExpiresAt: Date | undefined;

  async consume(input: { issuer: string; jti: string; assertionDigest: string; expiresAt: Date }) {
    this.lastExpiresAt = input.expiresAt;
    const key = `${input.issuer}\0${input.jti}`;
    const previous = this.seen.get(key);
    if (previous === undefined) {
      this.seen.set(key, input.assertionDigest);
      return { outcome: 'consumed' as const };
    }
    return { outcome: previous === input.assertionDigest ? 'replayed' as const : 'mismatch' as const };
  }
}

const expected = {
  deviceId: 'office-device',
  enrollmentVersion: 7,
  enrollmentStatus: 'active' as const,
  companionId: COMPANION_ID,
  sessionId: 'realtime:office-device:session',
};

describe('Hub device assertion trust boundary', () => {
  it('consumes the canonical cross-repo fixture bytes', async () => {
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: fixture.validToken,
      config: config(),
      expected,
      replayStore: new ReplayStore(),
      nowSeconds: NOW,
    })).resolves.toMatchObject({ deviceId: 'office-device', keyId: 'hub-2026-07' });
  });

  it('verifies the Hub public ring and atomically consumes one device principal', async () => {
    const replayStore = new ReplayStore();
    const first = await verifyAndConsumeHubDeviceAssertion({
      token: token(),
      config: config(),
      expected,
      replayStore,
      nowSeconds: NOW,
    });
    expect(first).toEqual({
      kind: 'hub_device',
      issuer: 'psfn-satellite-hub',
      keyId: 'hub-2026-07',
      deviceId: 'office-device',
      enrollmentVersion: 7,
      enrollmentAssurance: 'device_credential',
      placeId: 'office',
      audience: 'https://fleet.example.test',
      companionId: COMPANION_ID,
      sessionId: 'realtime:office-device:session',
      issuedAt: new Date((NOW - 10) * 1000),
      expiresAt: new Date((NOW + 20) * 1000),
      jti: JTI,
    });
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: token(), config: config(), expected, replayStore, nowSeconds: NOW,
    })).resolves.toEqual(first);
  });

  it('retains the replay fence through the verifier clock-skew acceptance window', async () => {
    const replayStore = new ReplayStore();
    await verifyAndConsumeHubDeviceAssertion({
      token: token(), config: config(), expected, replayStore, nowSeconds: NOW,
    });
    expect(replayStore.lastExpiresAt).toEqual(new Date((NOW + 22) * 1000));
  });

  it.each(['', ' realtime:office-device:session'])(
    'rejects a non-exact expected session binding before consuming replay state',
    async (sessionId) => {
      const replayStore = new ReplayStore();
      await expect(verifyAndConsumeHubDeviceAssertion({
        token: token(),
        config: config(),
        expected: { ...expected, sessionId },
        replayStore,
        nowSeconds: NOW,
      })).rejects.toThrow(/expected sessionId/);
      expect(replayStore.seen.size).toBe(0);
    },
  );

  it.each([
    ['wrong issuer', { iss: 'evil-hub' }, config(), expected, /issuer/],
    ['wrong audience', { aud: 'https://other.example.test' }, config(), expected, /audience/],
    ['wrong companion', { companion_id: '22222222-2222-4222-8222-222222222222' }, config(), expected, /companion/],
    ['wrong session', {}, config(), { ...expected, sessionId: 'realtime:office-device:other-session' }, /session/],
    ['expired', { exp: NOW - 3 }, config(), expected, /expired/],
    ['future issued-at', { iat: NOW + 3 }, config(), expected, /issued-at/],
    ['stale enrollment', {}, config(), { ...expected, enrollmentVersion: 8 }, /enrollment version/],
    ['revoked enrollment', {}, config(), { ...expected, enrollmentStatus: 'revoked' as const }, /enrollment is revoked/],
  ])('rejects %s before consuming replay state', async (_name, claims, verifier, expectedBinding, error) => {
    const replayStore = new ReplayStore();
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: token(claims),
      config: verifier,
      expected: expectedBinding,
      replayStore,
      nowSeconds: NOW,
    })).rejects.toThrow(error);
    expect(replayStore.seen.size).toBe(0);
  });

  it('accepts an allowlisted retiring rotation key but rejects a revoked key', async () => {
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: token(), config: config('retiring'), expected, replayStore: new ReplayStore(), nowSeconds: NOW,
    })).resolves.toMatchObject({ keyId: 'hub-2026-07' });
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: token(), config: config('revoked'), expected, replayStore: new ReplayStore(), nowSeconds: NOW,
    })).rejects.toThrow(/revoked/);
  });

  it('rejects a mutated reuse of the same jti even when the second assertion is validly signed', async () => {
    const replayStore = new ReplayStore();
    await verifyAndConsumeHubDeviceAssertion({
      token: token(), config: config(), expected, replayStore, nowSeconds: NOW,
    });
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: token({ place_id: 'kitchen' }), config: config(), expected, replayStore, nowSeconds: NOW,
    })).rejects.toThrow(/mutated replay/i);
  });

  it('rejects non-canonical or unknown claims and malformed compact tokens', async () => {
    const replayStore = new ReplayStore();
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: token({ human_principal_id: 'browser-user' }),
      config: config(), expected, replayStore, nowSeconds: NOW,
    })).rejects.toThrow(/unknown claim/);
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: 'not.a.valid.compact.token',
      config: config(), expected, replayStore, nowSeconds: NOW,
    })).rejects.toThrow(/malformed/);
    const canonicalClaims = JSON.parse(
      Buffer.from(token().split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const { aud, ...remainingClaims } = canonicalClaims;
    const reordered = signTokenObjects(
      { alg: 'EdDSA', typ: 'PSFN-HUB-DEVICE', v: 1, kid: 'hub-2026-07' },
      { aud, ...remainingClaims },
    );
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: reordered, config: config(), expected, replayStore, nowSeconds: NOW,
    })).rejects.toThrow(/canonical order/);
  });

  it('rejects verifier identities outside the owner-file protocol', async () => {
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: token(),
      config: { ...config(), issuer: 'https://mutable.example.test' },
      expected,
      replayStore: new ReplayStore(),
      nowSeconds: NOW,
    })).rejects.toThrow(/stable identifier characters/);
    await expect(verifyAndConsumeHubDeviceAssertion({
      token: token(),
      config: { ...config(), audience: 'http://fleet.example.test' },
      expected,
      replayStore: new ReplayStore(),
      nowSeconds: NOW,
    })).rejects.toThrow(/exact normalized HTTPS origin/);
  });
});
