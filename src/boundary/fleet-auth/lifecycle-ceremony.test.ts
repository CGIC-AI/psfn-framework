import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Pool } from 'pg';
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

function bindingRequest(): Extract<
  FleetAuthLifecycleCeremonyRequest,
  { action: 'binding.activate' }
> {
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

function harness(options: {
  role?: string;
  contact?: boolean;
  adminTokenApproval?: boolean;
} = {}) {
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
  const pool = fromPartial<Pool>({
    query: vi.fn(async (sql: string) => (
      sql.includes('browser_sessions')
        ? { rowCount: 1, rows: [session] }
        : sql.includes('principal_contact_bindings')
          ? { rowCount: 1, rows: [{ principal_id: TARGET_ID }] }
          : { rowCount: 1, rows: [target] }
    )),
  });
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
  const recordApproval = vi.fn(async () => ({
    authorizationEventId: '00000000-0000-4000-8000-000000000199',
    authorityGeneration: 21,
    globalAuthEpoch: 22,
  }));
  const service = new GatewayFleetAuthLifecycleCeremonyService({
    pool,
    sessionPepper: 'session-pepper',
    canonicalOrigin: ORIGIN,
    lifecycle: { execute },
    contactAuthority: { read },
    denialAudit: { record: recordDenial },
    ...(options.adminTokenApproval === false ? {} : { adminTokenApproval: { record: recordApproval } }),
    now: () => new Date('2026-07-16T22:00:00.000Z'),
  });
  return { service, execute, read, recordDenial, recordApproval, pool };
}

describe('gateway fleet-auth lifecycle ceremony', () => {
  it('gates binding activation on the session role declared for contacts.bind', async () => {
    // binding.activate compiles to the contacts.bind action, whose base role is
    // admin: a member session must never reach the authority store.
    const { service, execute, recordDenial } = harness({ role: 'member' });
    await expect(service.complete({
      token: 'session-token',
      requestOrigin: ORIGIN,
      request: bindingRequest(),
    })).rejects.toMatchObject({ code: 'session_unavailable' });
    expect(execute).not.toHaveBeenCalled();
    expect(recordDenial).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'session_unavailable',
    }));
  });

  it('binds live contact versions into the atomic decision', async () => {
    const request = bindingRequest();
    const { service, execute, read } = harness();
    const result = await service.complete({
      token: 'session-token',
      requestOrigin: ORIGIN,
      request,
    });
    expect(read).toHaveBeenCalledWith({
      companionId: COMPANION_ID,
      contactId: request.contactId,
      providerSubjectId: request.newProvider.subjectId,
    });
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

  it('fails before executing when current companion contact truth is absent', async () => {
    const { service, execute, recordDenial } = harness({ contact: false });
    await expect(service.complete({
      token: 'session-token',
      requestOrigin: ORIGIN,
      request: bindingRequest(),
    })).rejects.toBeInstanceOf(FleetAuthLifecycleCeremonyError);
    expect(execute).not.toHaveBeenCalled();
    expect(recordDenial).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'contact_authority_unavailable',
    }));
  });

  it('requires owner authority for provider mutation under an authenticated admin session', async () => {
    const { service, execute, read, recordDenial } = harness({ role: 'admin' });
    await expect(service.complete({
      token: 'session-token',
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
    expect(read).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(recordDenial).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'session_unavailable',
    }));
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

  it('binds an exact role grant and target principal into the owner-only decision', async () => {
    const request: FleetAuthLifecycleCeremonyRequest = {
      action: 'role.grant',
      ceremonyId: randomUUID(),
      companionId: COMPANION_ID,
      targetPrincipalId: TARGET_ID,
      grantId: randomUUID(),
      role: 'member',
      reason: 'grant ordinary companion access',
    };
    const { service, execute } = harness();
    await service.complete({
      token: 'session-token',
      requestOrigin: ORIGIN,
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

  it('refuses a role grant from an admin session because roles.manage is owner-only', async () => {
    const { service, execute, recordDenial } = harness({ role: 'admin' });
    await expect(service.complete({
      token: 'session-token',
      requestOrigin: ORIGIN,
      request: {
        action: 'role.grant',
        ceremonyId: randomUUID(),
        companionId: COMPANION_ID,
        targetPrincipalId: TARGET_ID,
        grantId: randomUUID(),
        role: 'member',
        reason: 'grant ordinary companion access',
      },
    })).rejects.toMatchObject({ code: 'session_unavailable' });
    expect(execute).not.toHaveBeenCalled();
    expect(recordDenial).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'session_unavailable',
    }));
  });

  describe('ADMIN_TOKEN operator approval (psfn-framework-ja7n0)', () => {
    function roleGrant() {
      return {
        action: 'role.grant' as const,
        ceremonyId: randomUUID(),
        companionId: COMPANION_ID,
        targetPrincipalId: TARGET_ID,
        grantId: randomUUID(),
        role: 'owner' as const,
        reason: 'operator grants ownership',
      };
    }

    it('approves under a durable approval bound to the decision, with no session lookup', async () => {
      const { service, execute, recordApproval, pool } = harness();
      const request = roleGrant();
      await service.completeAsAdminTokenOperator({ requestOrigin: ORIGIN, request });
      const decision = execute.mock.calls[0]![0];
      expect(recordApproval).toHaveBeenCalledWith({
        decisionId: decision.decisionId,
        ceremonyId: request.ceremonyId,
        companionId: COMPANION_ID,
        lifecycleAction: 'role.grant',
      });
      expect(decision).toMatchObject({
        operator: {
          kind: 'admin_token_operator',
          authorizationEventId: '00000000-0000-4000-8000-000000000199',
        },
        authorityGeneration: 21,
        globalAuthEpoch: 22,
        target: { principalId: TARGET_ID },
      });
      expect(decision.actor).toBeUndefined();
      expect(decision.actorSession).toBeUndefined();
      const sql = vi.mocked(pool.query).mock.calls.map(call => String(call[0]));
      expect(sql.some(text => text.includes('browser_sessions'))).toBe(false);
    });

    it('activates a pending binding with the key alone: no OAuth proof, no contact snapshot', async () => {
      const { service, execute, read } = harness();
      const bindingId = randomUUID();
      await service.completeAsAdminTokenOperator({
        requestOrigin: ORIGIN,
        request: {
          action: 'binding.activate',
          ceremonyId: randomUUID(),
          companionId: COMPANION_ID,
          targetPrincipalId: TARGET_ID,
          contactId: 'contact-new',
          bindingId,
          providerSubjectId: '223456789012345679',
          reason: 'operator activates the pending account',
        },
      });
      const decision = execute.mock.calls[0]![0];
      expect(decision).toMatchObject({
        action: 'binding.activate',
        target: { principalId: TARGET_ID },
        contactId: 'contact-new',
        bindingId,
        providerSubjectId: '223456789012345679',
        operator: { kind: 'admin_token_operator' },
      });
      expect(decision).not.toHaveProperty('newProvider');
      expect(decision).not.toHaveProperty('contactAuthority');
      expect(read).not.toHaveBeenCalled();
    });

    it('refuses provider ceremonies on the key path: they are SSO-only', async () => {
      const { service, execute, recordApproval } = harness();
      await expect(service.completeAsAdminTokenOperator({
        requestOrigin: ORIGIN,
        request: {
          action: 'provider.add',
          ceremonyId: randomUUID(),
          companionId: COMPANION_ID,
          contactId: 'contact-member',
          newProvider: proof('323456789012345679'),
          reason: 'not applicable in key mode',
        },
      })).rejects.toMatchObject({ code: 'invalid_request' });
      expect(recordApproval).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('fails closed without approval audit wiring or with a foreign origin', async () => {
      const unwired = harness({ adminTokenApproval: false });
      await expect(unwired.service.completeAsAdminTokenOperator({
        requestOrigin: ORIGIN,
        request: roleGrant(),
      })).rejects.toMatchObject({ code: 'operator_approval_unavailable' });
      expect(unwired.execute).not.toHaveBeenCalled();

      const wired = harness();
      await expect(wired.service.completeAsAdminTokenOperator({
        requestOrigin: 'https://evil.example.test',
        request: roleGrant(),
      })).rejects.toBeInstanceOf(FleetAuthLifecycleCeremonyError);
      expect(wired.recordApproval).not.toHaveBeenCalled();
    });

    it('never executes when the approval audit cannot be recorded', async () => {
      const { service, execute, recordApproval } = harness();
      recordApproval.mockRejectedValueOnce(new Error('audit store unavailable'));
      await expect(service.completeAsAdminTokenOperator({
        requestOrigin: ORIGIN,
        request: roleGrant(),
      })).rejects.toMatchObject({ code: 'operator_approval_unavailable' });
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
