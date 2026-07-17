import { describe, expect, it, vi } from 'vitest';
import { digestFleetAuthVerifiedProviderProof } from '../../shared/contracts/fleet-auth-lifecycle-oauth.js';
import type { PasskeyAuthorityFloor } from './passkey-authority.js';
import {
  TrustedHostProviderRecoveryError,
  TrustedHostProviderRecoveryService,
  type PreparedProviderRecovery,
  type ProviderRecoveryOAuthProof,
  type TrustedHostProviderRecoveryStore,
} from './trusted-host-provider-recovery.js';

const ORIGIN = 'https://fleet.example.test';
const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';
const COMPANION_ID = '22222222-2222-4222-8222-222222222222';
const CEREMONY_ID = '33333333-3333-4333-8333-333333333333';
const CURRENT_SUBJECT = '123456789012345678';
const NEW_SUBJECT = '223456789012345678';
const CREDENTIAL_HASH = 'a'.repeat(64);
const NOW = new Date('2026-07-16T20:00:00.000Z');

function oauthProof(): ProviderRecoveryOAuthProof {
  const callbackTransactionId = '44444444-4444-4444-8444-444444444444';
  return {
    provider: 'discord',
    subjectId: NEW_SUBJECT,
    callbackTransactionId,
    proofDigest: digestFleetAuthVerifiedProviderProof({
      provider: 'discord',
      subjectId: NEW_SUBJECT,
      callbackTransactionId,
    }),
  };
}

function fixture() {
  let floor: PasskeyAuthorityFloor = {
    generation: 4,
    tombstones: [],
    credentials: [{
      credentialIdHash: CREDENTIAL_HASH,
      publicKeyVerifier: 'AQID',
      rpId: 'fleet.example.test',
      principalId: PRINCIPAL_ID,
      expectedProvider: 'discord',
      expectedProviderSubjectId: CURRENT_SUBJECT,
      signCount: 1,
      backupEligible: false,
      backupState: false,
      generation: 4,
      status: 'current',
      createdAt: NOW.toISOString(),
    }],
  };
  const prepared: PreparedProviderRecovery = {
    ceremonyId: CEREMONY_ID,
    challenge: 'c'.repeat(43),
    companionId: COMPANION_ID,
    principal: {
      principalId: PRINCIPAL_ID,
      authnVersion: 1,
      authzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
    },
    actorSession: {
      sessionId: '55555555-5555-4555-8555-555555555555',
      authnVersion: 1,
      authzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
      globalAuthEpoch: 7,
      provider: 'discord',
      providerSubjectId: CURRENT_SUBJECT,
    },
    currentProviderSubjectId: CURRENT_SUBJECT,
    currentProviderAuthorityGeneration: 9,
    expectedNewProviderSubjectId: NEW_SUBJECT,
    authorityGeneration: 9,
    globalAuthEpoch: 7,
    reasonDigest: 'b'.repeat(64),
    credentialIdHash: CREDENTIAL_HASH,
    credentialFloorGeneration: 4,
  };
  const create = vi.fn<TrustedHostProviderRecoveryStore['create']>(async () => undefined);
  const auditDenial = vi.fn<TrustedHostProviderRecoveryStore['auditDenial']>(
    async () => undefined,
  );
  const createChallenge = vi.fn<TrustedHostProviderRecoveryStore['createChallenge']>(
    async input => ({ ...prepared, challenge: input.challenge }),
  );
  const prepareChallenge = vi.fn<TrustedHostProviderRecoveryStore['prepareChallenge']>(
    async () => prepared,
  );
  const recordWebAuthn = vi.fn<TrustedHostProviderRecoveryStore['recordWebAuthn']>(
    async () => undefined,
  );
  const execute = vi.fn(async input => ({
    decisionId: input.decisionId,
    authorityGeneration: 10,
    globalAuthEpoch: 8,
  }));
  const service = new TrustedHostProviderRecoveryService({
    canonicalOrigin: ORIGIN,
    rpId: 'fleet.example.test',
    ttlMs: 60_000,
    store: { auditDenial, create, createChallenge, prepareChallenge, recordWebAuthn },
    authority: {
      readPasskeys: () => floor,
      verifyCurrentPasskey: () => ({ allowed: true, generation: 4 }),
      updateCurrentPasskeySignals: () => floor,
    },
    webAuthn: {
      startAuthentication: vi.fn(async ({ challenge }) => ({ challenge })),
      finishAuthentication: vi.fn(async () => {
        floor = {
          ...floor,
          generation: 5,
          credentials: floor.credentials.map(entry => ({
            ...entry,
            generation: 5,
            signCount: 2,
          })),
        };
        return { credentialIdHash: CREDENTIAL_HASH, generation: 5 };
      }),
    },
    execute,
    now: () => NOW,
    randomBytes: () => Buffer.alloc(32, 7),
    randomUuid: () => CEREMONY_ID,
  });
  return { service, create, createChallenge, recordWebAuthn, execute };
}

describe('TrustedHostProviderRecoveryService', () => {
  it('pre-binds the full trusted-host provider recovery scope', async () => {
    const value = fixture();
    await expect(value.service.create({
      companionId: COMPANION_ID,
      principalId: PRINCIPAL_ID,
      currentProviderSubjectId: CURRENT_SUBJECT,
      currentProviderAuthorityGeneration: 9,
      expectedNewProviderSubjectId: NEW_SUBJECT,
      reason: 'operator confirmed current subject loss',
      expiresAt: new Date(NOW.getTime() + 60_000),
    })).resolves.toMatchObject({ ceremonyId: CEREMONY_ID });
    expect(value.create).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      principalId: PRINCIPAL_ID,
      currentProviderSubjectId: CURRENT_SUBJECT,
      currentProviderAuthorityGeneration: 9,
      expectedNewProviderSubjectId: NEW_SUBJECT,
      credentialIdHash: CREDENTIAL_HASH,
      credentialFloorGeneration: 4,
      reasonDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    }));
  });

  it('requires exact confirmation, new-subject OAuth, and live WebAuthn before execution', async () => {
    const value = fixture();
    const common = {
      oneTimeCredential: Buffer.alloc(32, 7).toString('base64url'),
      confirmation: 'provider.recover',
      reason: 'operator confirmed current subject loss',
      newProvider: oauthProof(),
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: ORIGIN,
    };
    await expect(value.service.start(common)).resolves.toMatchObject({ ceremonyId: CEREMONY_ID });
    await expect(value.service.finish({ ...common, response: { assertion: true } }))
      .resolves.toMatchObject({ authorityGeneration: 10, globalAuthEpoch: 8 });
    expect(value.recordWebAuthn).toHaveBeenCalledWith(expect.objectContaining({
      credentialIdHash: CREDENTIAL_HASH,
      credentialGeneration: 5,
      completedCredentialFloorGeneration: 5,
    }));
    expect(value.execute).toHaveBeenCalledWith(expect.objectContaining({
      currentProviderSubjectId: CURRENT_SUBJECT,
      expectedNewProviderSubjectId: NEW_SUBJECT,
      credentialGeneration: 5,
      completedCredentialFloorGeneration: 5,
      newProvider: oauthProof(),
    }));

    await expect(value.service.start({ ...common, confirmation: 'yes' }))
      .rejects.toBeInstanceOf(TrustedHostProviderRecoveryError);
    await expect(value.service.start({ ...common, requestOrigin: 'https://evil.example.test' }))
      .rejects.toMatchObject({ code: 'origin_mismatch' });
  });
});
