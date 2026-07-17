import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compileTrustedHostRecoveryTarget,
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  trustedHostRecoveryResource,
} from './request-capability.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000;

function fixture() {
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signer = createGatewayRequestCapabilitySigner({
    issuer: 'fleet-auth',
    kid: 'active-key',
    privateKeyPem,
    ttlSeconds: 30,
    nowSeconds: () => NOW,
  });
  const verifier = createRequestCapabilityVerifier({
    issuer: 'fleet-auth',
    maxTtlSeconds: 30,
    keys: [{
      issuer: 'fleet-auth',
      kid: 'active-key',
      publicKeyPem,
      notBefore: '2027-01-01T00:00:00.000Z',
      notAfter: '2028-12-31T00:00:00.000Z',
      status: 'active',
    }],
  });
  const target = compileTrustedHostRecoveryTarget({
    companionId: COMPANION_ID,
    action: 'recovery.begin',
    resource: trustedHostRecoveryResource(COMPANION_ID),
    reason: 'Recover the exact companion session surface',
    credentialId: 'c'.repeat(64),
    authorityFloor: {
      lineageId: 'a'.repeat(64),
      authorityGeneration: 7,
      activationGeneration: 3,
      restoreCheckpoint: 2,
      revocationCheckpoint: 5,
    },
  });
  return { signer, verifier, target, publicKeyPem };
}

describe('trusted-host recovery request capabilities', () => {
  it('round-trips only the distinct exact recovery target', () => {
    const { signer, verifier, target } = fixture();
    const requestId = randomUUID();
    const decisionId = randomUUID();
    const token = signer.signRecovery({ target, requestId, decisionId });
    expect(verifier.verifyRecovery({ token, target, nowSeconds: NOW + 1 }))
      .toEqual(expect.objectContaining({
        kind: 'trusted_host_garden_recovery',
        audience: `recovery:${COMPANION_ID}`,
        companionId: COMPANION_ID,
        action: 'recovery.begin',
        requestId,
        decisionId,
        reasonDigest: target.reasonDigest,
        credentialId: target.credentialId,
        authorityFloor: target.authorityFloor,
      }));
  });

  it('denies cross-companion, reason, credential, floor, and expiry changes', () => {
    const { signer, verifier, target } = fixture();
    const token = signer.signRecovery({
      target,
      requestId: randomUUID(),
      decisionId: randomUUID(),
    });
    const changed = (overrides: Partial<Parameters<typeof compileTrustedHostRecoveryTarget>[0]>) => (
      compileTrustedHostRecoveryTarget({
        companionId: target.companionId,
        action: 'recovery.begin',
        resource: target.resource,
        reason: 'Recover the exact companion session surface',
        credentialId: target.credentialId,
        authorityFloor: target.authorityFloor,
        ...overrides,
      })
    );
    expect(() => verifier.verifyRecovery({
      token,
      target: changed({ reason: 'different reason' }),
      nowSeconds: NOW + 1,
    })).toThrow(/exact recovery target binding/);
    expect(() => verifier.verifyRecovery({
      token,
      target: changed({ credentialId: 'd'.repeat(64) }),
      nowSeconds: NOW + 1,
    })).toThrow(/exact recovery target binding/);
    expect(() => verifier.verifyRecovery({
      token,
      target: changed({ authorityFloor: { ...target.authorityFloor, revocationCheckpoint: 6 } }),
      nowSeconds: NOW + 1,
    })).toThrow(/exact recovery target binding/);
    expect(() => verifier.verifyRecovery({ token, target, nowSeconds: NOW + 30 }))
      .toThrow(/expired/);
  });

  it('denies wrong issuer, key id, revoked key, and signature', () => {
    const { signer, target, publicKeyPem } = fixture();
    const token = signer.signRecovery({
      target,
      requestId: randomUUID(),
      decisionId: randomUUID(),
    });
    const verifier = (issuer: string, kid: string, status: 'active' | 'revoked') => (
      createRequestCapabilityVerifier({
        issuer,
        maxTtlSeconds: 30,
        keys: [{
          issuer,
          kid,
          publicKeyPem,
          notBefore: '2027-01-01T00:00:00.000Z',
          notAfter: '2028-12-31T00:00:00.000Z',
          status,
        }],
      })
    );
    expect(() => verifier('other-issuer', 'active-key', 'active').verifyRecovery({
      token, target, nowSeconds: NOW + 1,
    })).toThrow(/issuer/);
    expect(() => verifier('fleet-auth', 'other-key', 'active').verifyRecovery({
      token, target, nowSeconds: NOW + 1,
    })).toThrow(/allowlisted/);
    const revokedVerifier = createRequestCapabilityVerifier({
      issuer: 'fleet-auth',
      maxTtlSeconds: 30,
      keys: [{
        issuer: 'fleet-auth',
        kid: 'active-key',
        publicKeyPem,
        notBefore: '2027-01-01T00:00:00.000Z',
        notAfter: '2028-12-31T00:00:00.000Z',
        status: 'revoked',
      }, {
        issuer: 'fleet-auth',
        kid: 'replacement-key',
        publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({
          type: 'spki', format: 'pem',
        }).toString(),
        notBefore: '2027-01-01T00:00:00.000Z',
        notAfter: '2028-12-31T00:00:00.000Z',
        status: 'active',
      }],
    });
    expect(() => revokedVerifier.verifyRecovery({ token, target, nowSeconds: NOW + 1 }))
      .toThrow(/revoked/);
    expect(() => fixture().verifier.verifyRecovery({
      token: `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
      target,
      nowSeconds: NOW + 1,
    })).toThrow(/signature/);
  });
});
