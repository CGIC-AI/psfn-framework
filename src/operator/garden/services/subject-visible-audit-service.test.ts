import { describe, expect, it, vi } from 'vitest';
import type { FleetGardenRequestContext } from '../garden-request-context.js';
import type { AdminAuditHistoryService } from './audit-history-service.js';
import { AdminSubjectVisibleAuditService } from './subject-visible-audit-service.js';

const NOW = Date.parse('2026-08-06T18:00:00.000Z');

function context(
  overrides: Partial<FleetGardenRequestContext> = {},
): FleetGardenRequestContext {
  return {
    kind: 'fleet_principal',
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authorizationEventId: 'authorization-event-a',
    resolvedAt: '2026-08-06T17:59:59.000Z',
    versions: {
      authorityGeneration: 1,
      globalAuthEpoch: 1,
      sessionAuthnVersion: 1,
      sessionAuthzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
    },
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    actor: {
      kind: 'fleet_principal',
      principalId: 'principal-owner-a',
      provider: 'discord',
      providerSubjectId: 'provider-subject-must-not-be-visible',
      contactId: 'contact-owner-a',
      contactBindingId: 'binding-owner-a',
      role: 'owner',
      operatorGrantId: 'operator-grant-a',
      sessionRecordId: 'browser-session-a',
      sessionAssurance: 'escalated',
      accessMode: 'sole_admin',
    },
    action: 'cogsec.manage',
    resource: {
      routeId: 'POST /api/admin/concerns/:concernId/resolve',
      scope: 'personal_workspace',
      area: 'cognitive_security',
      companionId: '11111111-1111-4111-8111-111111111111',
      pathParams: { concernId: 'protected-concern-id-must-not-be-visible' },
      query: {},
    },
    subjectRelation: 'current_companion',
    authorization: {
      action: 'cogsec.manage',
      baseRole: 'admin',
      resource: { scope: 'personal_workspace', area: 'cognitive_security' },
      subjectRelation: 'current_companion',
      requirements: {
        assurance: 'escalated',
        confirmation: 'explicit',
        approvals: ['cogsec'],
      },
      publicAccess: 'never',
      recoveryAccess: 'forbidden',
    },
    ...overrides,
  };
}

function harness(input: { appendFails?: boolean } = {}) {
  const appendGardenEntry = input.appendFails
    ? vi.fn(() => { throw new Error('audit store unavailable'); })
    : vi.fn();
  const appendContextSystemNote = vi.fn();
  const service = new AdminSubjectVisibleAuditService({
    auditHistory: { appendGardenEntry } as unknown as AdminAuditHistoryService,
    sessionManager: {
      appendContextSystemNote,
      listRecentSessions: vi.fn(() => [{ sessionId: 'discord:subject-home' }]),
    },
    companionDataDir: '/nonexistent/subject-audit-test',
    now: () => NOW,
  });
  return { service, appendGardenEntry, appendContextSystemNote };
}

describe('AdminSubjectVisibleAuditService', () => {
  it('records the actor, exact action, protected category, time, and reason without concern payload', () => {
    const { service, appendGardenEntry, appendContextSystemNote } = harness();
    const reason = 'Verify the remediation after a policy incident';

    service.recordConcernAction({
      context: context(),
      action: 'resolve',
      reason,
    });

    expect(appendGardenEntry).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'external_action',
      decision: 'allowed',
      actor: 'operator',
      timestamp: NOW,
    }));
    expect(appendContextSystemNote).toHaveBeenCalledWith(
      'discord:subject-home',
      expect.stringContaining('[System notice: protected administration]'),
      'garden:protected-action-audit',
    );

    const visibleRecord = JSON.stringify({
      audit: appendGardenEntry.mock.calls,
      notice: appendContextSystemNote.mock.calls,
    });
    expect(visibleRecord).toContain('principal-owner-a');
    expect(visibleRecord).toContain('resolve');
    expect(visibleRecord).toContain('Cognitive Security concern');
    expect(visibleRecord).toContain('2026-08-06T18:00:00.000Z');
    expect(visibleRecord).toContain(reason);
    expect(visibleRecord).not.toContain('protected-concern-id-must-not-be-visible');
    expect(visibleRecord).not.toContain('provider-subject-must-not-be-visible');
  });

  it('fails closed before the companion notice when durable audit persistence fails', () => {
    const { service, appendContextSystemNote } = harness({ appendFails: true });

    expect(() => service.recordConcernAction({
      context: context({
        resource: {
          ...context().resource,
          routeId: 'POST /api/admin/concerns/:concernId/suppress',
        },
      }),
      action: 'suppress',
      reason: 'Remove a confirmed duplicate concern',
    })).toThrow(/audit store unavailable/u);
    expect(appendContextSystemNote).not.toHaveBeenCalled();
  });

  it('rejects a non-escalated or mismatched request context without writing', () => {
    const { service, appendGardenEntry, appendContextSystemNote } = harness();

    const oauthContext = context({
      actor: { ...context().actor, sessionAssurance: 'oauth' },
    });
    expect(() => service.recordConcernAction({
      context: oauthContext,
      action: 'transition',
      reason: 'Monitor a concern while evidence develops',
    })).toThrow(/escalated/u);

    const wrongAction = context({ action: 'contacts.manage' });
    expect(() => service.recordConcernAction({
      context: wrongAction,
      action: 'resolve',
      reason: 'Verify the remediation',
    })).toThrow(/CogSec concern action/u);
    expect(appendGardenEntry).not.toHaveBeenCalled();
    expect(appendContextSystemNote).not.toHaveBeenCalled();
  });
});
