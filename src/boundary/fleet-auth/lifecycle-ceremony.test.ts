import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GatewayFleetAuthLifecycleCeremonyService,
  FleetAuthLifecycleCeremonyError,
  type FleetAuthLifecycleCeremonyRequest,
} from './lifecycle-ceremony.js';
import { digestVerifiedProviderProof } from '../../persistence/postgres/fleet-auth/authority-lifecycle-types.js';

const ORIGIN = 'https://fleet.example.test';
const ACTOR_ID = '00000000-0000-4000-8000-000000000101';
const TARGET_ID = '00000000-0000-4000-8000-000000000102';
const SESSION_ID = '00000000-0000-4000-8000-000000000103';
const COMPANION_ID = '00000000-0000-4000-8000-000000000104';
const SUBJECT = '123456789012345679';

function proof(subjectId = '223456789012345679') {
  const callbackTransactionId = randomUUID();
  return {
    provider: 'discord' as const,
    subjectId,
    callbackTransactionId,
    proofDigest: digestVerifiedProviderProof({
      provider: 'discord',
      subjectId,
      callbackTransactionId,
    }),
  };
}

function bindingRequest(): FleetAuthLifecycleCeremonyRequest {
  return {
    action: 'binding.activate',
    ceremonyId: randomUUID(),
    companionId: COMPANION_ID,
    targetPrincipalId: TARGET_ID,
    contactId: 'contact-new',
    bindingId: randomUUID(),
    newProvider: proof(),
    reason: 'verified owner activation',
  };
}

function harness(options: { role?: string; contact?: boolean } = {}) {
  const session = {
    record_id: SESSION_ID,
    principal_id: ACTOR_ID,
    status: 'active',
    authn_version: '2',
    authz_version: '3',
    binding_version: '4',
    grant_version: '5',
    policy_version: '6',
    provider: 'discord',
    provider_subject_id: SUBJECT,
    global_auth_epoch: '7',
    authority_generation: '8',
    role: options.role ?? 'owner',
    contact_id: 'contact-owner',
  };
  const target = {
    principal_id: TARGET_ID,
    authn_version: '1',
    authz_version: '1',
    binding_version: '1',
    grant_version: '1',
    policy_version: '1',
  };
  const pool = {
    query: vi.fn(async (sql: string) => (
      sql.includes('browser_sessions')
        ? { rowCount: 1, rows: [session] }
        : { rowCount: 1, rows: [target] }
    )),
  };
  const startWebAuthn = vi.fn(async () => ({
    challengeId: randomUUID(),
    requestNonce: 'a'.repeat(43),
    assurance: 'webauthn_uv' as const,
  }));
  const consumeGrant = vi.fn(async (input: { grantId: string }) => ({
    grantId: input.grantId,
    principalId: ACTOR_ID,
    browserSessionId: SESSION_ID,
    assurance: 'webauthn_uv' as const,
    credentialFloorGeneration: 2,
    expiresAt: new Date('2026-07-16T23:00:00.000Z'),
  }));
  const execute = vi.fn(async (decision: any) => ({
    decisionId: decision.decisionId,
    action: decision.action,
    authorityGeneration: 8,
    globalAuthEpoch: 8,
    target: decision.target,
  }));
  const read = vi.fn(async (input: {
    contactId: string;
    providerSubjectId: string;
  }) => options.contact === false ? undefined : ({
    schemaVersion: 1 as const,
    contactId: input.contactId,
    channel: 'discord' as const,
    providerSubjectId: input.providerSubjectId,
    identityVersion: 9,
    verificationId: '00000000-0000-4000-8000-000000000105',
    verificationDigest: 'b'.repeat(64),
    contactAuthorityVersion: 10,
    ownershipState: 'verified' as const,
    restoreState: 'live' as const,
  }));
  const recordDenial = vi.fn(async () => undefined);
  const service = new GatewayFleetAuthLifecycleCeremonyService({
    pool: pool as any,
    sessionPepper: 'session-pepper',
    canonicalOrigin: ORIGIN,
    lifecycle: { execute },
    jitStepUp: { startWebAuthn, consumeGrant },
    contactAuthority: { read },
    denialAudit: { record: recordDenial },
    now: () => new Date('2026-07-16T22:00:00.000Z'),
  });
  return { service, startWebAuthn, consumeGrant, execute, read, recordDenial };
}

describe('gateway fleet-auth lifecycle ceremony', () => {
  it('compiles binding activation into the declared strong-assurance target', async () => {
    const request = bindingRequest();
    const { service, startWebAuthn } = harness();
    await service.startStrongAssurance({
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: ORIGIN,
      request,
    });
    expect(startWebAuthn).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({
        target: expect.objectContaining({
          canonicalPath: '/v1/fleet-auth/lifecycle/binding/complete',
          action: 'contacts.bind',
        }),
      }),
    }));
  });

  it('binds live contact versions and one-shot UV grant into the atomic decision', async () => {
    const request = bindingRequest();
    const { service, consumeGrant, execute, read } = harness();
    const result = await service.complete({
      token: 'session-token',
      requestOrigin: ORIGIN,
      jitGrantId: randomUUID(),
      request,
    });
    expect(read).toHaveBeenCalledWith({
      companionId: COMPANION_ID,
      contactId: request.contactId,
      providerSubjectId: request.newProvider.subjectId,
    });
    expect(consumeGrant).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      verification: 'gateway_verified',
      action: 'binding.activate',
      contactAuthority: expect.objectContaining({
        contactAuthorityVersion: 10,
        identityVersion: 9,
      }),
      actorSession: expect.objectContaining({
        sessionId: SESSION_ID,
        providerSubjectId: SUBJECT,
        globalAuthEpoch: 7,
      }),
    }));
    expect(result.action).toBe('binding.activate');
  });

  it('fails before consuming assurance when current companion contact truth is absent', async () => {
    const { service, consumeGrant, execute, recordDenial } = harness({ contact: false });
    await expect(service.complete({
      token: 'session-token',
      requestOrigin: ORIGIN,
      jitGrantId: randomUUID(),
      request: bindingRequest(),
    })).rejects.toBeInstanceOf(FleetAuthLifecycleCeremonyError);
    expect(consumeGrant).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(recordDenial).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'contact_authority_unavailable',
    }));
  });

  it('requires owner authority for provider mutation even with a valid passkey', async () => {
    const { service, startWebAuthn } = harness({ role: 'admin' });
    await expect(service.startStrongAssurance({
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: ORIGIN,
      request: {
        action: 'provider.add',
        ceremonyId: randomUUID(),
        companionId: COMPANION_ID,
        contactId: 'contact-owner',
        newProvider: proof(),
        reason: 'add backup sign-in subject',
      },
    })).rejects.toMatchObject({ code: 'session_unavailable' });
    expect(startWebAuthn).not.toHaveBeenCalled();
  });

  it('rechecks the exact current contact against the new provider before linking', async () => {
    const newProvider = proof();
    const request: FleetAuthLifecycleCeremonyRequest = {
      action: 'provider.add',
      ceremonyId: randomUUID(),
      companionId: COMPANION_ID,
      contactId: 'contact-owner',
      newProvider,
      reason: 'add verified backup provider',
    };
    const { service, read, execute } = harness();
    await service.complete({
      token: 'session-token',
      requestOrigin: ORIGIN,
      jitGrantId: randomUUID(),
      request,
    });
    expect(read).toHaveBeenCalledWith({
      companionId: COMPANION_ID,
      contactId: 'contact-owner',
      providerSubjectId: newProvider.subjectId,
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      action: 'provider.add',
      companionId: COMPANION_ID,
      contactId: 'contact-owner',
      contactAuthority: expect.objectContaining({
        providerSubjectId: newProvider.subjectId,
        contactAuthorityVersion: 10,
      }),
    }));
  });

  it('binds an exact role grant and target principal into owner-only strong assurance', async () => {
    const request: FleetAuthLifecycleCeremonyRequest = {
      action: 'role.grant',
      ceremonyId: randomUUID(),
      companionId: COMPANION_ID,
      targetPrincipalId: TARGET_ID,
      grantId: randomUUID(),
      role: 'member',
      reason: 'grant ordinary companion access',
    };
    const { service, startWebAuthn, execute } = harness();
    await service.startStrongAssurance({
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: ORIGIN,
      request,
    });
    expect(startWebAuthn).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({
        target: expect.objectContaining({
          canonicalPath: '/v1/fleet-auth/lifecycle/role/complete',
          action: 'roles.manage',
        }),
      }),
    }));
    await service.complete({
      token: 'session-token',
      requestOrigin: ORIGIN,
      jitGrantId: randomUUID(),
      request,
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      action: 'role.grant',
      companionId: COMPANION_ID,
      grantId: request.grantId,
      role: 'member',
      target: expect.objectContaining({ principalId: TARGET_ID }),
    }));
  });
});
