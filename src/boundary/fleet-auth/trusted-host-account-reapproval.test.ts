import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PasskeyAuthorityPort } from './passkey-authority.js';
import {
  TrustedHostAccountReapprovalService,
  type TrustedHostAccountReapprovalStore,
} from './trusted-host-account-reapproval.js';

const CEREMONY_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const COMPANION_ID = '33333333-3333-4333-8333-333333333333';
const BINDING_ID = '44444444-4444-4444-8444-444444444444';
const GRANT_ID = '55555555-5555-4555-8555-555555555555';
const ACTOR_ID = '66666666-6666-4666-8666-666666666666';
const ACTOR_SESSION_ID = '77777777-7777-4777-8777-777777777777';
const OAUTH_TRANSACTION_ID = '88888888-8888-4888-8888-888888888888';
const PROVIDER_SUBJECT_ID = '123456789012345678';
const CREDENTIAL_HASH = 'a'.repeat(64);
const NONCE = 'n'.repeat(43);
const CHALLENGE = 'c'.repeat(43);
const NOW = new Date('2026-07-16T12:00:00.000Z');

function proof() {
  return {
    provider: 'discord' as const,
    subjectId: PROVIDER_SUBJECT_ID,
    callbackTransactionId: OAUTH_TRANSACTION_ID,
    proofDigest: createHash('sha256').update(
      `fleet-auth-verified-provider-proof:v1:discord:${PROVIDER_SUBJECT_ID}:${OAUTH_TRANSACTION_ID}`,
    ).digest('hex'),
  };
}

function fixture() {
  const prepared = {
    ceremonyId: CEREMONY_ID,
    challenge: CHALLENGE,
    principalId: PRINCIPAL_ID,
    providerSubjectId: PROVIDER_SUBJECT_ID,
    companionId: COMPANION_ID,
    contactId: 'contact-owner',
    bindingId: BINDING_ID,
    roleGrantId: GRANT_ID,
    credentialFloorGeneration: 3,
    actorPrincipalId: ACTOR_ID,
    actorSessionId: ACTOR_SESSION_ID,
    oauthTransactionId: OAUTH_TRANSACTION_ID,
    oauthProofDigest: proof().proofDigest,
  };
  const store: TrustedHostAccountReapprovalStore = {
    create: vi.fn(async () => undefined),
    prepare: vi.fn(async () => prepared),
    confirm: vi.fn(async () => undefined),
    recordDenial: vi.fn(async () => undefined),
  };
  const authority: PasskeyAuthorityPort = {
    readPasskeys: vi.fn(() => ({
      generation: 3,
      credentials: [{
        credentialIdHash: CREDENTIAL_HASH,
        publicKeyVerifier: 'verifier',
        rpId: 'fleet.example.test',
        principalId: PRINCIPAL_ID,
        expectedProvider: 'discord',
        expectedProviderSubjectId: PROVIDER_SUBJECT_ID,
        signCount: 5,
        backupEligible: false,
        backupState: false,
        generation: 3,
        status: 'current',
        createdAt: NOW.toISOString(),
      }],
      tombstones: [],
    })),
    verifyCurrentPasskey: vi.fn(() => ({ allowed: true, generation: 3 })),
    updateCurrentPasskeySignals: vi.fn(),
  };
  const webAuthn = {
    startAuthentication: vi.fn(async () => ({ challenge: CHALLENGE })),
    finishAuthentication: vi.fn(async () => ({
      credentialIdHash: CREDENTIAL_HASH,
      generation: 3,
    })),
  };
  const reapprove = vi.fn(async () => ({
    principalId: PRINCIPAL_ID,
    authorityGeneration: 4,
    globalAuthEpoch: 9,
    authnVersion: 2,
    authzVersion: 2,
    bindingVersion: 2,
    roleVersion: 2,
    auditEventId: '99999999-9999-4999-8999-999999999999',
  }));
  const service = new TrustedHostAccountReapprovalService({
    canonicalOrigin: 'https://fleet.example.test',
    rpId: 'fleet.example.test',
    ttlMs: 300_000,
    store,
    authority,
    webAuthn,
    reapprove,
    now: () => NOW,
    randomBytes: () => Buffer.from('0'.repeat(64), 'hex'),
    randomUuid: () => CEREMONY_ID,
  });
  return { service, store, authority, webAuthn, reapprove, prepared };
}

describe('TrustedHostAccountReapprovalService', () => {
  it('creates one exact trusted-host restore ceremony with a redacted reason digest', async () => {
    const subject = fixture();
    await subject.service.create({
      expectedProviderSubjectId: PROVIDER_SUBJECT_ID,
      expectedPrincipalId: PRINCIPAL_ID,
      expectedCompanionId: COMPANION_ID,
      expectedContactId: 'contact-owner',
      expectedBindingId: BINDING_ID,
      expectedRoleGrantId: GRANT_ID,
      reason: 'operator verified restored owner',
    });
    expect(subject.store.create).toHaveBeenCalledWith(expect.objectContaining({
      ceremonyId: CEREMONY_ID,
      expectedProviderSubjectId: PROVIDER_SUBJECT_ID,
      expectedPrincipalId: PRINCIPAL_ID,
      expectedBindingId: BINDING_ID,
      expectedRoleGrantId: GRANT_ID,
      reasonDigest: createHash('sha256').update('operator verified restored owner').digest('hex'),
      exactOrigin: 'https://fleet.example.test',
      credentialFloorGeneration: 3,
    }));
  });

  it('starts only after the active session and exact live-provider proof are prepared', async () => {
    const subject = fixture();
    await expect(subject.service.startAuthentication({
      nonce: NONCE,
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: 'https://fleet.example.test',
      providerProof: proof(),
    })).resolves.toEqual({
      ceremonyId: CEREMONY_ID,
      publicKey: { challenge: CHALLENGE },
    });
    expect(subject.webAuthn.startAuthentication).toHaveBeenCalledWith({ challenge: CHALLENGE });
  });

  it('finishes with UV authentication, confirms exact provenance, and invokes only reapproval', async () => {
    const subject = fixture();
    await expect(subject.service.finishAuthentication({
      nonce: NONCE,
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: 'https://fleet.example.test',
      providerProof: proof(),
      response: { id: 'credential' },
    })).resolves.toMatchObject({ principalId: PRINCIPAL_ID, reauthenticationRequired: true });
    expect(subject.webAuthn.finishAuthentication).toHaveBeenCalledWith({
      response: { id: 'credential' },
      expectedChallenge: CHALLENGE,
      expectedPrincipalId: PRINCIPAL_ID,
      expectedProviderSubjectId: PROVIDER_SUBJECT_ID,
    });
    expect(subject.store.confirm).toHaveBeenCalledWith(expect.objectContaining({
      ceremony: subject.prepared,
      credentialIdHash: CREDENTIAL_HASH,
      credentialGeneration: 3,
      credentialFloorGeneration: 3,
    }));
    expect(subject.reapprove).toHaveBeenCalledWith(expect.objectContaining({
      ceremonyId: CEREMONY_ID,
      principalId: PRINCIPAL_ID,
      bindingId: BINDING_ID,
      roleGrantId: GRANT_ID,
    }));
    expect(subject.authority.updateCurrentPasskeySignals).not.toHaveBeenCalled();
  });

  it('denies activation when the non-restored passkey floor advances after confirmation', async () => {
    const subject = fixture();
    const current = subject.authority.readPasskeys();
    vi.mocked(subject.authority.readPasskeys)
      .mockReturnValueOnce(current)
      .mockReturnValueOnce({ ...current, generation: current.generation + 1 });
    await expect(subject.service.finishAuthentication({
      nonce: NONCE,
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: 'https://fleet.example.test',
      providerProof: proof(),
      response: { id: 'credential' },
    })).rejects.toMatchObject({ code: 'passkey_authority_changed' });
    expect(subject.store.confirm).toHaveBeenCalledOnce();
    expect(subject.reapprove).not.toHaveBeenCalled();
    expect(subject.store.recordDenial).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'finish',
      reasonCode: 'passkey_authority_changed',
    }));
  });

  it('durably audits a same-origin or authority denial without exposing the nonce', async () => {
    const subject = fixture();
    await expect(subject.service.startAuthentication({
      nonce: NONCE,
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: 'https://attacker.example.test',
      providerProof: proof(),
    })).rejects.toMatchObject({ code: 'origin_mismatch' });
    expect(subject.store.recordDenial).toHaveBeenCalledWith(expect.objectContaining({
      nonce: NONCE,
      stage: 'start',
      reasonCode: 'origin_mismatch',
    }));
  });
});
