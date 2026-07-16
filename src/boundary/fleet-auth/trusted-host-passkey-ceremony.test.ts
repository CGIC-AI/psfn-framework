import { describe, expect, it, vi } from 'vitest';
import type {
  PasskeyAuthorityCandidate,
  PasskeyAuthorityEntry,
  PasskeyAuthorityFloor,
} from './passkey-authority.js';
import {
  TrustedHostPasskeyCeremonyService,
  type MutablePasskeyAuthorityPort,
  type PreparedPasskeyCeremony,
  type TrustedHostPasskeyCeremonyStore,
} from './trusted-host-passkey-ceremony.js';

const ORIGIN = 'https://fleet.example.test';
const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';
const COMPANION_ID = '22222222-2222-4222-8222-222222222222';
const CEREMONY_ID = '33333333-3333-4333-8333-333333333333';
const SUBJECT_ID = '123456789012345678';
const NOW = new Date('2026-07-16T20:00:00.000Z');
const PRIOR_HASH = 'a'.repeat(64);
const NEXT_HASH = 'b'.repeat(64);

function candidate(credentialIdHash = NEXT_HASH): PasskeyAuthorityCandidate {
  return {
    credentialIdHash,
    publicKeyVerifier: 'AQID',
    rpId: 'fleet.example.test',
    principalId: PRINCIPAL_ID,
    expectedProvider: 'discord',
    expectedProviderSubjectId: SUBJECT_ID,
    signCount: 0,
    backupEligible: false,
    backupState: false,
  };
}

function entry(overrides: Partial<PasskeyAuthorityEntry> = {}): PasskeyAuthorityEntry {
  return {
    ...candidate(PRIOR_HASH),
    generation: 4,
    status: 'current',
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function authority(initial: PasskeyAuthorityFloor): MutablePasskeyAuthorityPort {
  let floor = initial;
  return {
    readPasskeys: () => floor,
    verifyCurrentPasskey: value => floor.credentials.some(current => (
      current.status === 'current' && current.credentialIdHash === value.credentialIdHash
    )) ? { allowed: true, generation: floor.generation } : { allowed: false, reason: 'not_current' },
    updateCurrentPasskeySignals: () => floor,
    enrollPasskey(value, at) {
      const generation = floor.generation + 1;
      floor = {
        ...floor,
        generation,
        credentials: [...floor.credentials, {
          ...value,
          generation,
          status: 'current',
          createdAt: at,
        }],
      };
      return { passkeys: floor };
    },
    replacePasskey(input) {
      const fencedGeneration = floor.generation + 1;
      const completedGeneration = fencedGeneration + 1;
      floor = {
        generation: completedGeneration,
        credentials: [
          ...floor.credentials.map(current => current.credentialIdHash === input.priorCredentialIdHash
            ? {
                ...current,
                generation: fencedGeneration,
                status: 'replaced' as const,
                revokedAt: input.at,
                replacedByCredentialIdHash: input.replacement.credentialIdHash,
              }
            : current),
          {
            ...input.replacement,
            generation: completedGeneration,
            status: 'current',
            createdAt: input.at,
          },
        ],
        tombstones: [...floor.tombstones, {
          credentialIdHash: input.priorCredentialIdHash,
          generation: fencedGeneration,
          status: 'replaced',
          at: input.at,
          replacedByCredentialIdHash: input.replacement.credentialIdHash,
        }],
      };
      return { passkeys: floor };
    },
  };
}

function fixture(prepared: PreparedPasskeyCeremony, floor: PasskeyAuthorityFloor) {
  const create = vi.fn<TrustedHostPasskeyCeremonyStore['create']>(async () => undefined);
  const finalizeCredential = vi.fn<TrustedHostPasskeyCeremonyStore['finalizeCredential']>(
    async () => undefined,
  );
  const bindFirstOwnerCredential = vi.fn<
    TrustedHostPasskeyCeremonyStore['bindFirstOwnerCredential']
  >(async () => undefined);
  const store: TrustedHostPasskeyCeremonyStore = {
    create,
    prepare: vi.fn(async () => prepared),
    finalizeCredential,
    bindFirstOwnerCredential,
  };
  const authorityPort = authority(floor);
  const service = new TrustedHostPasskeyCeremonyService({
    canonicalOrigin: ORIGIN,
    rpId: 'fleet.example.test',
    ttlMs: 60_000,
    store,
    authority: authorityPort,
    webAuthn: {
      startRegistration: vi.fn(async input => ({ ...input, kind: 'registration' })),
      finishRegistration: vi.fn(async () => candidate()),
    },
    now: () => NOW,
    randomBytes: () => Buffer.alloc(32, 7),
    randomUuid: () => CEREMONY_ID,
  });
  return { service, authorityPort, create, finalizeCredential, bindFirstOwnerCredential };
}

describe('TrustedHostPasskeyCeremonyService', () => {
  it('creates only exact expected-provider recovery ceremonies for a current prior credential', async () => {
    const prepared: PreparedPasskeyCeremony = {
      ceremonyId: CEREMONY_ID,
      kind: 'passkey_recovery',
      challenge: 'c'.repeat(43),
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      priorCredentialIdHash: PRIOR_HASH,
      credentialFloorGeneration: 4,
    };
    const fixtureValue = fixture(prepared, {
      generation: 4,
      credentials: [entry()],
      tombstones: [],
    });
    await expect(fixtureValue.service.create({
      kind: 'passkey_recovery',
      expectedProviderSubjectId: SUBJECT_ID,
      priorCredentialIdHash: PRIOR_HASH,
    })).resolves.toMatchObject({
      ceremonyId: CEREMONY_ID,
      kind: 'passkey_recovery',
    });
    expect(fixtureValue.create).toHaveBeenCalledWith(expect.objectContaining({
      expectedProviderSubjectId: SUBJECT_ID,
      priorCredentialIdHash: PRIOR_HASH,
      credentialFloorGeneration: 4,
      exactOrigin: ORIGIN,
    }));
  });

  it('fences the prior passkey before finalizing recovery and never grants a role', async () => {
    const prepared: PreparedPasskeyCeremony = {
      ceremonyId: CEREMONY_ID,
      kind: 'passkey_recovery',
      challenge: 'c'.repeat(43),
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      priorCredentialIdHash: PRIOR_HASH,
      credentialFloorGeneration: 4,
    };
    const fixtureValue = fixture(prepared, {
      generation: 4,
      credentials: [entry()],
      tombstones: [],
    });
    await expect(fixtureValue.service.finishRegistration({
      nonce: 'n'.repeat(43),
      kind: 'passkey_recovery',
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: ORIGIN,
      response: { id: 'new-credential' },
    })).resolves.toEqual({
      credentialIdHash: NEXT_HASH,
      credentialFloorGeneration: 6,
    });
    expect(fixtureValue.authorityPort.readPasskeys()).toMatchObject({
      generation: 6,
      credentials: expect.arrayContaining([
        expect.objectContaining({ credentialIdHash: PRIOR_HASH, status: 'replaced' }),
        expect.objectContaining({ credentialIdHash: NEXT_HASH, status: 'current' }),
      ]),
      tombstones: [expect.objectContaining({ credentialIdHash: PRIOR_HASH, status: 'replaced' })],
    });
    expect(fixtureValue.finalizeCredential).toHaveBeenCalledWith(expect.objectContaining({
      completedCredentialFloorGeneration: 6,
    }));
  });

  it('binds first-owner assurance to the exact companion/contact and enrolled floor', async () => {
    const prepared: PreparedPasskeyCeremony = {
      ceremonyId: CEREMONY_ID,
      kind: 'first_owner',
      challenge: 'c'.repeat(43),
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      companionId: COMPANION_ID,
      contactId: 'owner-contact',
      credentialFloorGeneration: 0,
    };
    const fixtureValue = fixture(prepared, { generation: 0, credentials: [], tombstones: [] });
    await expect(fixtureValue.service.verifyFirstOwner({
      evidence: { nonce: 'n'.repeat(43), response: { id: 'new-credential' } },
      expectedOrigin: ORIGIN,
    })).resolves.toEqual({
      ceremonyId: CEREMONY_ID,
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      companionId: COMPANION_ID,
      contactId: 'owner-contact',
    });
    expect(fixtureValue.bindFirstOwnerCredential).toHaveBeenCalledWith(expect.objectContaining({
      completedCredentialFloorGeneration: 1,
      candidate: expect.objectContaining({ credentialIdHash: NEXT_HASH }),
    }));
  });

  it('rejects origin confusion before reading trusted-host ceremony state', async () => {
    const prepared: PreparedPasskeyCeremony = {
      ceremonyId: CEREMONY_ID,
      kind: 'passkey_enrollment',
      challenge: 'c'.repeat(43),
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      credentialFloorGeneration: 0,
    };
    const fixtureValue = fixture(prepared, { generation: 0, credentials: [], tombstones: [] });
    await expect(fixtureValue.service.finishRegistration({
      nonce: 'n'.repeat(43),
      kind: 'passkey_enrollment',
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: 'https://evil.example.test',
      response: {},
    })).rejects.toMatchObject({ code: 'origin_mismatch' });
    expect(fixtureValue.finalizeCredential).not.toHaveBeenCalled();
  });
});
