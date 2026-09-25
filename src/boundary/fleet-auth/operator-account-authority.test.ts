import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GatewayOperatorAccountAuthorityService,
  parseOperatorAccountRequest,
} from './operator-account-authority.js';

const ORIGIN = 'https://fleet.example.test';
const COMPANION_ID = '00000000-0000-4000-8000-000000000601';
const PRINCIPAL_ID = '00000000-0000-4000-8000-000000000602';

function harness(options: { tombstoned?: boolean; approvalFails?: boolean } = {}) {
  const recordApproval = vi.fn(async () => {
    if (options.approvalFails) throw new Error('audit store unavailable');
    return { authorizationEventId: '00000000-0000-4000-8000-000000000699' };
  });
  const execute = vi.fn(async (input: { request: { action: string; companionId: string }; auditEventId: string }) => ({
    action: input.request.action as 'principal.suspend',
    companionId: input.request.companionId,
    authorityGeneration: 3,
    globalAuthEpoch: 4,
    auditEventId: input.auditEventId,
  }));
  const isAccountAuthorityTombstoned = vi.fn(() => options.tombstoned === true);
  const service = new GatewayOperatorAccountAuthorityService({
    canonicalOrigin: ORIGIN,
    ports: { recordApproval, execute, isAccountAuthorityTombstoned },
  });
  return { service, recordApproval, execute, isAccountAuthorityTombstoned };
}

const reinstate = () => ({
  action: 'principal.reinstate',
  ceremonyId: randomUUID(),
  companionId: COMPANION_ID,
  principalId: PRINCIPAL_ID,
  bindingId: randomUUID(),
  roleGrantId: randomUUID(),
});

describe('ADMIN_TOKEN operator account authority (psfn-framework-aol3m)', () => {
  it('records a decision-bound approval, then executes with the same audit identity', async () => {
    const { service, recordApproval, execute } = harness();
    const request = reinstate();
    const result = await service.complete({ requestOrigin: ORIGIN, request });
    const approval = recordApproval.mock.calls[0]![0] as { decisionId: string };
    expect(recordApproval).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      lifecycleAction: 'principal.reinstate',
      ceremonyId: request.ceremonyId,
    }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      approvalEventId: '00000000-0000-4000-8000-000000000699',
      auditEventId: approval.decisionId,
      request: expect.objectContaining({ action: 'principal.reinstate', principalId: PRINCIPAL_ID }),
    }));
    expect(result.auditEventId).toBe(approval.decisionId);
  });

  it('fails closed on tombstones, origin, malformed input and missing approval audit', async () => {
    const tombstoned = harness({ tombstoned: true });
    await expect(tombstoned.service.complete({ requestOrigin: ORIGIN, request: reinstate() }))
      .rejects.toMatchObject({ code: 'lifecycle_denied' });
    expect(tombstoned.recordApproval).not.toHaveBeenCalled();

    const wired = harness();
    await expect(wired.service.complete({ requestOrigin: 'https://evil.example.test', request: reinstate() }))
      .rejects.toMatchObject({ code: 'origin_mismatch' });
    await expect(wired.service.complete({
      requestOrigin: ORIGIN,
      request: { ...reinstate(), extra: true },
    })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(wired.service.complete({
      requestOrigin: ORIGIN,
      request: { action: 'provider.add', ceremonyId: randomUUID(), companionId: COMPANION_ID },
    })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(wired.execute).not.toHaveBeenCalled();

    const noAudit = harness({ approvalFails: true });
    await expect(noAudit.service.complete({
      requestOrigin: ORIGIN,
      request: { action: 'principal.suspend', ceremonyId: randomUUID(), companionId: COMPANION_ID, principalId: PRINCIPAL_ID },
    })).rejects.toMatchObject({ code: 'operator_approval_unavailable' });
    expect(noAudit.execute).not.toHaveBeenCalled();
  });

  it('parses exactly the four account actions', () => {
    expect(parseOperatorAccountRequest({
      action: 'companion.reinstate', ceremonyId: randomUUID(), companionId: COMPANION_ID, companionVersion: 2,
    })).toMatchObject({ action: 'companion.reinstate', companionVersion: 2 });
    for (const action of ['principal.suspend', 'principal.reactivate'] as const) {
      expect(parseOperatorAccountRequest({
        action, ceremonyId: randomUUID(), companionId: COMPANION_ID, principalId: PRINCIPAL_ID,
      }).action).toBe(action);
    }
    expect(() => parseOperatorAccountRequest({
      action: 'companion.reinstate', ceremonyId: randomUUID(), companionId: COMPANION_ID, companionVersion: 0,
    })).toThrow(/companionVersion/);
  });
});
