import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { FleetGardenRequestContext } from '../garden-request-context.js';
import type { AdminConcernService } from '../services/types.js';
import type { AdminSubjectVisibleAuditService } from '../services/subject-visible-audit-service.js';
import { buildAdminConcernRoutes } from './concern-routes.js';

const REASON = 'Verify the remediation after a policy incident';

class CapturingResponse {
  statusCode = 0;
  body = '';
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor() {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
  }

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? '';
    this.resolveDone();
  }
}

function fleetContext(routeId: string): FleetGardenRequestContext {
  return {
    kind: 'fleet_principal',
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authorizationEventId: 'authorization-event-a',
    resolvedAt: '2026-08-06T17:59:59.000Z',
    versions: {
      authorityGeneration: 1, globalAuthEpoch: 1, sessionAuthnVersion: 1,
      sessionAuthzVersion: 1, bindingVersion: 1, grantVersion: 1, policyVersion: 1,
    },
    issuedAt: 1,
    expiresAt: 2,
    actor: {
      kind: 'fleet_principal', principalId: 'principal-owner-a', provider: 'discord',
      providerSubjectId: 'provider-subject-a', contactId: 'contact-owner-a',
      contactBindingId: 'binding-owner-a', role: 'admin', operatorGrantId: 'grant-a',
      sessionRecordId: 'session-a', sessionAssurance: 'escalated', accessMode: 'multi_admin',
    },
    action: 'cogsec.manage',
    resource: {
      routeId, scope: 'personal_workspace', area: 'cognitive_security',
      companionId: '11111111-1111-4111-8111-111111111111',
      pathParams: routeId.includes(':concernId') ? { concernId: 'concern-a' } : {},
      query: {},
    },
    subjectRelation: 'current_companion',
    authorization: {
      action: 'cogsec.manage', baseRole: 'admin',
      resource: { scope: 'personal_workspace', area: 'cognitive_security' },
      subjectRelation: 'current_companion',
      requirements: { assurance: 'escalated', confirmation: 'explicit', approvals: ['cogsec'] },
      publicAccess: 'never', recoveryAccess: 'forbidden',
    },
  };
}

async function invoke(input: {
  path: string;
  routeId: string;
  body: unknown;
  concernService: Partial<AdminConcernService>;
  subjectAudit?: Partial<AdminSubjectVisibleAuditService>;
}): Promise<{ status: number; body: unknown }> {
  const routes = buildAdminConcernRoutes({
    concernService: input.concernService as AdminConcernService,
    subjectAuditService: input.subjectAudit as AdminSubjectVisibleAuditService | undefined,
    withBody: (_req, _res, callback) => callback(JSON.stringify(input.body)),
  });
  const route = routes.find(candidate => candidate.method === 'POST' && candidate.match(input.path));
  if (!route) throw new Error(`missing route ${input.path}`);
  const response = new CapturingResponse();
  route.handle(
    { headers: {} } as IncomingMessage,
    response as unknown as ServerResponse,
    route.match(input.path) ?? {},
    fleetContext(input.routeId),
  );
  await response.done;
  return { status: response.statusCode, body: JSON.parse(response.body) as unknown };
}

describe('protected concern action routes', () => {
  it.each([
    {
      path: '/api/admin/concerns/concern-a/resolve',
      routeId: 'POST /api/admin/concerns/:concernId/resolve',
      action: 'resolve' as const,
      service: 'resolveConcern' as const,
      body: { reason: REASON, outcome: 'resolved safely' },
    },
    {
      path: '/api/admin/concerns/concern-a/suppress',
      routeId: 'POST /api/admin/concerns/:concernId/suppress',
      action: 'suppress' as const,
      service: 'suppressConcern' as const,
      body: { reason: REASON, outcome: 'confirmed duplicate' },
    },
    {
      path: '/api/admin/concerns/concern-a/transition',
      routeId: 'POST /api/admin/concerns/:concernId/transition',
      action: 'transition' as const,
      service: 'transitionConcern' as const,
      body: { reason: REASON, status: 'watching' },
    },
    {
      path: '/api/admin/concerns/resolve-stale',
      routeId: 'POST /api/admin/concerns/resolve-stale',
      action: 'resolve_stale' as const,
      service: 'resolveStaleConcerns' as const,
      body: { reason: REASON },
    },
  ])('records one subject-visible $action event before calling $service', async (testCase) => {
    const order: string[] = [];
    const mutation = vi.fn(async () => {
      order.push('mutation');
      return { ok: true, concerns: [] };
    });
    const recordConcernAction = vi.fn(() => { order.push('audit'); });

    const response = await invoke({
      ...testCase,
      concernService: { [testCase.service]: mutation },
      subjectAudit: { recordConcernAction },
    });

    expect(response).toEqual({ status: 200, body: { ok: true, concerns: [] } });
    expect(recordConcernAction).toHaveBeenCalledWith({
      context: expect.objectContaining({
        kind: 'fleet_principal',
        resource: expect.objectContaining({ routeId: testCase.routeId }),
      }),
      action: testCase.action,
      reason: REASON,
    });
    expect(order).toEqual(['audit', 'mutation']);
  });

  it('fails closed before mutation when the reason or subject-visible audit sink is unavailable', async () => {
    const resolveConcern = vi.fn().mockResolvedValue({ ok: true, concerns: [] });
    const missingReason = await invoke({
      path: '/api/admin/concerns/concern-a/resolve',
      routeId: 'POST /api/admin/concerns/:concernId/resolve',
      body: { outcome: 'must not run' },
      concernService: { resolveConcern },
      subjectAudit: { recordConcernAction: vi.fn() },
    });
    expect(missingReason.status).toBe(400);

    const noAudit = await invoke({
      path: '/api/admin/concerns/concern-a/resolve',
      routeId: 'POST /api/admin/concerns/:concernId/resolve',
      body: { reason: REASON },
      concernService: { resolveConcern },
    });
    expect(noAudit.status).toBe(503);

    const failedAudit = await invoke({
      path: '/api/admin/concerns/concern-a/resolve',
      routeId: 'POST /api/admin/concerns/:concernId/resolve',
      body: { reason: REASON },
      concernService: { resolveConcern },
      subjectAudit: {
        recordConcernAction: vi.fn(() => { throw new Error('audit unavailable'); }),
      },
    });
    expect(failedAudit.status).toBe(503);
    expect(resolveConcern).not.toHaveBeenCalled();
  });
});
