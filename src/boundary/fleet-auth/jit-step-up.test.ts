import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { compileGatewayGardenRequestTarget } from './request-capability-target.js';
import {
  FleetJitStepUpCoordinator,
  type FleetJitPendingChallenge,
  type FleetJitRequestBinding,
  type FleetJitStepUpStore,
} from './jit-step-up.js';

const ORIGIN = 'https://fleet.example.test';
const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT_ID = '123456789012345678';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CHALLENGE_ID = '44444444-4444-4444-8444-444444444444';
const GRANT_ID = '55555555-5555-4555-8555-555555555555';
const DIGEST = 'a'.repeat(64);
const NOW = new Date('2026-07-16T20:00:00.000Z');

function binding(strong = true): FleetJitRequestBinding {
  const target = compileGatewayGardenRequestTarget({
    rawTarget: strong ? '/api/admin/channels/context-envelope' : '/api/admin/dashboard',
    method: strong ? 'POST' : 'GET',
    companionId: COMPANION_ID,
    body: strong ? Buffer.from('{"channel":"direct"}', 'utf8') : Buffer.alloc(0),
  });
  return {
    target,
    subjectScopeDigest: DIGEST,
    purpose: 'Approve the exact declared operation',
    memoryRevision: 1,
    classifierEvidenceDigest: 'b'.repeat(64),
  };
}

function fixture() {
  let pending: FleetJitPendingChallenge | undefined;
  let consumed = false;
  const createChallenge = vi.fn<FleetJitStepUpStore['createChallenge']>(async input => {
    pending = {
      challengeId: input.challengeId,
      challenge: input.challenge,
      requestNonceDigest: input.requestNonceDigest,
      assurance: input.assurance,
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      browserSessionId: SESSION_ID,
      globalAuthEpoch: 3,
      binding: input.binding,
      credentialFloorGeneration: input.credentialFloorGeneration,
    };
    return {
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      browserSessionId: SESSION_ID,
      globalAuthEpoch: 3,
    };
  });
  const store: FleetJitStepUpStore = {
    createChallenge,
    prepareChallenge: vi.fn(async () => {
      if (!pending || consumed) throw new Error('challenge unavailable');
      return pending;
    }),
    completeChallenge: vi.fn(async input => {
      if (consumed) throw new Error('replay');
      consumed = true;
      return {
        grantId: GRANT_ID,
        principalId: PRINCIPAL_ID,
        browserSessionId: SESSION_ID,
        assurance: input.challenge.assurance,
        credentialFloorGeneration: input.completedCredentialFloorGeneration,
        expiresAt: input.grantExpiresAt,
      };
    }),
    cancelChallenge: vi.fn(async () => undefined),
    consumeGrant: vi.fn(async () => ({
      grantId: GRANT_ID,
      principalId: PRINCIPAL_ID,
      browserSessionId: SESSION_ID,
      assurance: 'webauthn_uv',
      credentialFloorGeneration: 9,
      expiresAt: new Date(NOW.getTime() + 60_000),
    })),
  };
  const finishAuthentication = vi.fn(async () => ({
    credentialIdHash: 'c'.repeat(64),
    generation: 9,
  }));
  const deliver = vi.fn(async () => undefined);
  const coordinator = new FleetJitStepUpCoordinator({
    canonicalOrigin: ORIGIN,
    challengeTtlMs: 60_000,
    grantTtlMs: 60_000,
    store,
    webAuthn: {
      startAuthentication: vi.fn(async input => ({ ...input, kind: 'authentication' })),
      finishAuthentication,
    },
    readCredentialFloorGeneration: () => 8,
    discordPossession: { deliver },
    lowerAssuranceActions: new Set(['garden.read']),
    now: () => NOW,
    randomBytes: () => Buffer.alloc(32, 7),
    randomUuid: () => CHALLENGE_ID,
  });
  return { coordinator, store, createChallenge, finishAuthentication, deliver };
}

describe('FleetJitStepUpCoordinator', () => {
  it('binds strong approval to exact session identity, route target, nonce, origin, and floor', async () => {
    const { coordinator, createChallenge, finishAuthentication, store } = fixture();
    const request = binding(true);
    const started = await coordinator.startWebAuthn({
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: ORIGIN,
      binding: request,
    });
    expect(started).toMatchObject({
      challengeId: CHALLENGE_ID,
      assurance: 'webauthn_uv',
      publicKey: { kind: 'authentication' },
    });
    expect(createChallenge).toHaveBeenCalledWith(expect.objectContaining({
      exactOrigin: ORIGIN,
      credentialFloorGeneration: 8,
      binding: expect.objectContaining({
        companionId: COMPANION_ID,
        action: request.target.action,
        targetDigest: request.target.targetDigest,
        assuranceRequirement: 'webauthn_uv',
      }),
    }));

    await expect(coordinator.finishWebAuthn({
      challengeId: started.challengeId,
      requestNonce: started.requestNonce,
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: ORIGIN,
      response: { id: 'opaque-browser-response' },
    })).resolves.toMatchObject({ grantId: GRANT_ID, credentialFloorGeneration: 9 });
    expect(finishAuthentication).toHaveBeenCalledWith(expect.objectContaining({
      expectedPrincipalId: PRINCIPAL_ID,
      expectedProviderSubjectId: SUBJECT_ID,
    }));
    expect(store.completeChallenge).toHaveBeenCalledTimes(1);
  });

  it('rejects origin confusion before persisting a challenge', async () => {
    const { coordinator, createChallenge } = fixture();
    await expect(coordinator.startWebAuthn({
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: 'https://evil.example.test',
      binding: binding(true),
    })).rejects.toMatchObject({ code: 'origin_mismatch' });
    expect(createChallenge).not.toHaveBeenCalled();
  });

  it('never permits lower-assurance Discord possession for a strong route', async () => {
    const { coordinator, deliver } = fixture();
    await expect(coordinator.startDiscordPossession({
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: ORIGIN,
      binding: binding(true),
    })).rejects.toMatchObject({ code: 'strong_assurance_required' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('labels and delivers an explicitly allowed lower-assurance challenge', async () => {
    const { coordinator, deliver } = fixture();
    const started = await coordinator.startDiscordPossession({
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: ORIGIN,
      binding: binding(false),
    });
    expect(started).toMatchObject({ assurance: 'discord_possession' });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      providerSubjectId: SUBJECT_ID,
      action: 'garden.read',
      companionId: COMPANION_ID,
    }));
  });
});
