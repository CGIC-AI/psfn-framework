import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  PasskeyAuthorityCandidate,
  PasskeyAuthorityEntry,
  PasskeyAuthorityFloor,
  PasskeyAuthorityPort,
} from './passkey-authority.js';
import {
  FleetWebAuthnError,
  FleetWebAuthnUvBoundary,
  type FleetWebAuthnCryptoPort,
  parseAuthenticationResponse,
  parseRegistrationResponse,
} from './webauthn-uv.js';

const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';
const SUBJECT_ID = '123456789012345678';
const ORIGIN = 'https://fleet.example.test';
const RP_ID = 'fleet.example.test';
const CHALLENGE = Buffer.alloc(32, 7).toString('base64url');
const CREDENTIAL_ID = Buffer.from('credential-a').toString('base64url');
const CREDENTIAL_HASH = createHash('sha256')
  .update(Buffer.from(CREDENTIAL_ID, 'base64url'))
  .digest('hex');

function registrationResponse(extra: Record<string, unknown> = {}): unknown {
  return {
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'AA',
      attestationObject: 'AA',
      transports: ['internal', 'hybrid'],
    },
    ...extra,
  };
}

function authenticationResponse(id = CREDENTIAL_ID): unknown {
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'AA',
      authenticatorData: 'AA',
      signature: 'AA',
    },
  };
}

function currentCredential(overrides: Partial<PasskeyAuthorityEntry> = {}): PasskeyAuthorityEntry {
  return {
    credentialIdHash: CREDENTIAL_HASH,
    publicKeyVerifier: Buffer.from([1, 2, 3]).toString('base64url'),
    rpId: RP_ID,
    principalId: PRINCIPAL_ID,
    expectedProvider: 'discord',
    expectedProviderSubjectId: SUBJECT_ID,
    signCount: 4,
    backupEligible: true,
    backupState: false,
    generation: 8,
    status: 'current',
    createdAt: '2026-07-16T20:00:00.000Z',
    ...overrides,
  };
}

function authority(entry = currentCredential()): PasskeyAuthorityPort {
  let floor: PasskeyAuthorityFloor = { generation: entry.generation, credentials: [entry], tombstones: [] };
  return {
    readPasskeys: () => floor,
    verifyCurrentPasskey(candidate: PasskeyAuthorityCandidate) {
      return candidate.credentialIdHash === entry.credentialIdHash && entry.status === 'current'
        ? { allowed: true, generation: entry.generation }
        : { allowed: false, reason: 'not_current' };
    },
    updateCurrentPasskeySignals(input) {
      if (input.expectedGeneration !== floor.generation) throw new Error('generation is stale');
      const updated: PasskeyAuthorityEntry = {
        ...entry,
        generation: entry.generation + 1,
        signCount: input.signCount,
        backupEligible: input.backupEligible,
        backupState: input.backupState,
      };
      floor = { ...floor, generation: updated.generation, credentials: [updated] };
      return floor;
    },
  };
}

function crypto(overrides: Partial<FleetWebAuthnCryptoPort> = {}): FleetWebAuthnCryptoPort {
  return {
    generateRegistration: vi.fn(async input => ({ kind: 'registration', ...input })),
    verifyRegistration: vi.fn(async input => ({
      verified: true,
      credentialId: input.response.id,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      userVerified: true,
      deviceType: 'multiDevice',
      backedUp: false,
      origin: input.expectedOrigin,
      rpId: input.expectedRpId,
    })),
    generateAuthentication: vi.fn(async input => ({ kind: 'authentication', ...input })),
    verifyAuthentication: vi.fn(async input => ({
      verified: true,
      credentialId: input.response.id,
      newCounter: input.credential.counter + 1,
      userVerified: true,
      deviceType: 'multiDevice',
      backedUp: true,
      origin: input.expectedOrigin,
      rpId: input.expectedRpId,
    })),
    ...overrides,
  };
}

function boundary(input: {
  authority?: PasskeyAuthorityPort;
  crypto?: FleetWebAuthnCryptoPort;
} = {}): FleetWebAuthnUvBoundary {
  return new FleetWebAuthnUvBoundary({
    canonicalOrigin: ORIGIN,
    rpId: RP_ID,
    rpName: 'PSFN Fleet',
    timeoutMs: 60_000,
    authority: input.authority ?? authority(),
    crypto: input.crypto ?? crypto(),
    now: () => new Date('2026-07-16T20:01:00.000Z'),
  });
}

describe('FleetWebAuthnUvBoundary', () => {
  it('rejects any origin/RP ambiguity at construction', () => {
    expect(() => new FleetWebAuthnUvBoundary({
      canonicalOrigin: 'https://gateway.example.test',
      rpId: RP_ID,
      rpName: 'PSFN Fleet',
      timeoutMs: 60_000,
      authority: authority(),
    })).toThrowError(FleetWebAuthnError);
  });

  it('creates UV resident registration options and returns an exact authority-floor candidate', async () => {
    const cryptoPort = crypto();
    const service = boundary({ crypto: cryptoPort });
    await expect(service.startRegistration({ challenge: CHALLENGE, principalId: PRINCIPAL_ID }))
      .resolves.toMatchObject({
        kind: 'registration',
        rpId: RP_ID,
        principalId: PRINCIPAL_ID,
        challenge: CHALLENGE,
      });

    const candidate = await service.finishRegistration({
      response: registrationResponse(),
      expectedChallenge: CHALLENGE,
      principalId: PRINCIPAL_ID,
      expectedProviderSubjectId: SUBJECT_ID,
    });

    expect(candidate).toEqual({
      credentialIdHash: CREDENTIAL_HASH,
      publicKeyVerifier: Buffer.from([1, 2, 3]).toString('base64url'),
      rpId: RP_ID,
      principalId: PRINCIPAL_ID,
      expectedProvider: 'discord',
      expectedProviderSubjectId: SUBJECT_ID,
      signCount: 0,
      backupEligible: true,
      backupState: false,
    });
    expect(cryptoPort.verifyRegistration).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
    }));
  });

  it('fails registration closed when UV, origin, or RP verification is not exact', async () => {
    const service = boundary({
      crypto: crypto({
        verifyRegistration: vi.fn(async input => ({
          verified: true,
          credentialId: input.response.id,
          publicKey: new Uint8Array([1]),
          counter: 0,
          userVerified: false,
          deviceType: 'singleDevice',
          backedUp: false,
          origin: 'https://evil.example.test',
          rpId: RP_ID,
        })),
      }),
    });
    await expect(service.finishRegistration({
      response: registrationResponse(),
      expectedChallenge: CHALLENGE,
      principalId: PRINCIPAL_ID,
      expectedProviderSubjectId: SUBJECT_ID,
    })).rejects.toMatchObject({ code: 'registration_denied' });
  });

  it('authenticates only the exact current floor credential and advances its counter/generation', async () => {
    const authorityPort = authority();
    const cryptoPort = crypto();
    const service = boundary({ authority: authorityPort, crypto: cryptoPort });

    await expect(service.startAuthentication({ challenge: CHALLENGE })).resolves.toMatchObject({
      kind: 'authentication',
      rpId: RP_ID,
      challenge: CHALLENGE,
    });
    await expect(service.finishAuthentication({
      response: authenticationResponse(),
      expectedChallenge: CHALLENGE,
      expectedPrincipalId: PRINCIPAL_ID,
      expectedProviderSubjectId: SUBJECT_ID,
    })).resolves.toEqual({ credentialIdHash: CREDENTIAL_HASH, generation: 9 });
    expect(authorityPort.readPasskeys().credentials[0]).toMatchObject({
      signCount: 5,
      backupState: true,
      generation: 9,
    });
    expect(cryptoPort.verifyAuthentication).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
      credential: expect.objectContaining({ id: CREDENTIAL_ID, counter: 4 }),
    }));
  });

  it('denies unknown/restored/revoked credentials before invoking cryptographic verification', async () => {
    const verifyAuthentication = vi.fn<FleetWebAuthnCryptoPort['verifyAuthentication']>();
    const service = boundary({
      authority: authority(currentCredential({ status: 'revoked' })),
      crypto: crypto({ verifyAuthentication }),
    });
    await expect(service.finishAuthentication({
      response: authenticationResponse(),
      expectedChallenge: CHALLENGE,
      expectedPrincipalId: PRINCIPAL_ID,
      expectedProviderSubjectId: SUBJECT_ID,
    })).rejects.toMatchObject({ code: 'credential_not_current' });
    expect(verifyAuthentication).not.toHaveBeenCalled();
  });

  it('fails closed when the floor generation changes during authentication', async () => {
    const authorityPort = authority();
    const original = authorityPort.updateCurrentPasskeySignals;
    authorityPort.updateCurrentPasskeySignals = input => original({
      ...input,
      expectedGeneration: input.expectedGeneration - 1,
    });
    await expect(boundary({ authority: authorityPort }).finishAuthentication({
      response: authenticationResponse(),
      expectedChallenge: CHALLENGE,
      expectedPrincipalId: PRINCIPAL_ID,
      expectedProviderSubjectId: SUBJECT_ID,
    })).rejects.toThrow(/generation is stale/i);
  });
});

describe('strict WebAuthn response parsing', () => {
  it('rejects unknown authority-shaped fields and duplicate transports', () => {
    expect(() => parseRegistrationResponse(registrationResponse({ principalId: PRINCIPAL_ID })))
      .toThrow(/unknown keys/i);
    const duplicate = registrationResponse();
    if (typeof duplicate !== 'object' || duplicate === null || !('response' in duplicate)
      || typeof duplicate.response !== 'object' || duplicate.response === null) {
      throw new Error('Invalid test fixture');
    }
    duplicate.response.transports = ['internal', 'internal'];
    expect(() => parseRegistrationResponse(duplicate)).toThrow(/duplicates/i);
  });

  it('rejects malformed assertion fields before cryptographic work', () => {
    const malformed = authenticationResponse() as Record<string, unknown>;
    malformed.type = 'payment';
    expect(() => parseAuthenticationResponse(malformed)).toThrow(/shape is invalid/i);
  });
});
