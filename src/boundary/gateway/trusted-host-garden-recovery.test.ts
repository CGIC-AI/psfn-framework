import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  trustedHostRecoveryResource,
} from '../fleet-auth/request-capability.js';
import type {
  TrustedHostRecoveryReplayConsumption,
  TrustedHostRecoveryReplayPort,
} from '../fleet-auth/request-capability-replay.js';
import {
  GatewayTrustedHostGardenRecoveryService,
  type TrustedHostRecoveryAuthoritySnapshot,
} from './trusted-host-garden-recovery.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL = 'trusted-host-independent-recovery-secret';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const pair = generateKeyPairSync('ed25519');
  let snapshot: TrustedHostRecoveryAuthoritySnapshot = {
    lineageId: 'a'.repeat(64),
    provisioningSecret: 'b'.repeat(64),
    authorityGeneration: 4,
    activationGeneration: 2,
    restoreCheckpoint: 1,
    revocationCheckpoint: 0,
    tombstones: [],
  };
  const records = new Map<string, TrustedHostRecoveryReplayConsumption>();
  const audits: Array<Parameters<TrustedHostRecoveryReplayPort['auditRecovery']>[0]> = [];
  const replay: TrustedHostRecoveryReplayPort = {
    auditRecovery: async input => { audits.push(input); },
    consumeRecovery: async input => {
      const key = `${input.issuer}:${input.jti}`;
      const prior = records.get(key);
      if (!prior) {
        records.set(key, input);
        return { outcome: 'consumed', result: input.consumeResult };
      }
      const fields = [
        'capabilityDigest', 'targetDigest', 'bodyDigest', 'audienceDigest',
        'companionDigest', 'actionDigest', 'resourceDigest', 'parentDigest',
        'decisionDigest', 'authorityVersionsDigest',
      ] as const;
      if (fields.some(field => prior[field] !== input[field])) return { outcome: 'mismatch' };
      return { outcome: 'replayed', result: prior.consumeResult };
    },
  };
  const signer = createGatewayRequestCapabilitySigner({
    issuer: 'fleet-auth',
    kid: 'active-key',
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ttlSeconds: 30,
  });
  const verifier = createRequestCapabilityVerifier({
    issuer: 'fleet-auth',
    maxTtlSeconds: 30,
    keys: [{
      issuer: 'fleet-auth',
      kid: 'active-key',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      notBefore: '2020-01-01T00:00:00.000Z',
      notAfter: '2100-01-01T00:00:00.000Z',
      status: 'active',
    }],
  });
  const service = new GatewayTrustedHostGardenRecoveryService({
    configuredCredential: CREDENTIAL,
    knownCompanionIds: new Set([COMPANION_ID]),
    signer,
    verifier,
    replay,
    authority: {
      readTrustedHost: () => snapshot,
      revokeRecoveryCredential: input => {
        snapshot = {
          ...snapshot,
          revocationCheckpoint: snapshot.revocationCheckpoint + 1,
          tombstones: [...snapshot.tombstones, {
            kind: 'recovery_credential',
            resourceHash: hash(input.credentialId),
          }],
        };
        return { trustedHost: snapshot };
      },
    },
  });
  const scope = {
    companionId: COMPANION_ID,
    action: 'recovery.begin' as const,
    resource: trustedHostRecoveryResource(COMPANION_ID),
    reason: 'Restore only the exact recovery session entrypoint',
    credential: CREDENTIAL,
  };
  return { service, scope, audits, getSnapshot: () => snapshot };
}

describe('GatewayTrustedHostGardenRecoveryService', () => {
  it('returns one durable first result for byte-identical retries and denies mutation', async () => {
    const { service, scope, audits } = fixture();
    const issued = await service.issue(scope);
    const exact = {
      ...scope,
      token: issued.token,
      transportDigest: hash('exact consume body bytes'),
    };
    const [first, retry] = await Promise.all([
      service.consume(exact),
      service.consume(exact),
    ]);
    expect(first).toEqual(retry);
    expect(first).toEqual(expect.objectContaining({
      kind: 'trusted_host_garden_recovery_receipt',
      outcome: 'recovery_ready',
      companionId: COMPANION_ID,
      action: 'recovery.begin',
    }));
    await expect(service.consume({
      ...exact,
      transportDigest: hash('mutated consume body bytes'),
    })).rejects.toMatchObject({ code: 'recovery_replay_mismatch' });
    expect(audits[0]).toEqual(expect.objectContaining({
      outcome: 'issued',
      companionId: COMPANION_ID,
    }));
    expect(JSON.stringify(audits)).not.toContain(CREDENTIAL);
  });

  it('lets credential revocation win over issued unconsumed capability without role-floor advance', async () => {
    const { service, scope, getSnapshot } = fixture();
    const issued = await service.issue(scope);
    const authorityGeneration = getSnapshot().authorityGeneration;
    const [revoked, consume] = await Promise.allSettled([
      service.revoke(scope),
      service.consume({
        ...scope,
        token: issued.token,
        transportDigest: hash('consume after revocation'),
      }),
    ]);
    expect(revoked.status).toBe('fulfilled');
    expect(consume).toMatchObject({
      status: 'rejected',
      reason: { code: 'recovery_credential_rejected' },
    });
    expect(getSnapshot().authorityGeneration).toBe(authorityGeneration);
    expect(getSnapshot().revocationCheckpoint).toBe(1);
  });

  it('denies wrong credential, companion, resource, and reason', async () => {
    const { service, scope } = fixture();
    await expect(service.issue({ ...scope, credential: 'wrong' }))
      .rejects.toMatchObject({ code: 'recovery_credential_rejected' });
    await expect(service.issue({ ...scope, companionId: '22222222-2222-4222-8222-222222222222' }))
      .rejects.toMatchObject({ code: 'recovery_request_invalid' });
    await expect(service.issue({ ...scope, reason: ` ${scope.reason}` }))
      .rejects.toThrow(/reason must be an exact/);
    await expect(service.issue({
      ...scope,
      resource: { ...scope.resource, area: 'documents' as 'sessions' },
    })).rejects.toThrow(/dedicated recovery resource/);
  });
});
