import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { FleetGardenRequestContext, GardenRequestContext } from '../garden-request-context.js';
import type {
  AdminPrivacyBreakGlassService,
  PrivacyBreakGlassAuditEvidence,
} from '../services/privacy-break-glass-service.js';
import { buildAdminPrivacyBreakGlassRoutes } from './privacy-break-glass-routes.js';
import type { AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const ID = 'memory-private-b';
const TOKEN = 'f'.repeat(64);
const BODY = { reasonCategory: 'incident_response' as const, reason: 'Contain active compromise.' };

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

function context(phase: 'confirm' | 'decide'): FleetGardenRequestContext {
  return {
    kind: 'fleet_principal',
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionId: phase === 'confirm'
      ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    authorizationEventId: 'event-a',
    resolvedAt: '2030-01-01T00:00:00.000Z',
    versions: {
      authorityGeneration: 1, globalAuthEpoch: 1, sessionAuthnVersion: 1,
      sessionAuthzVersion: 1, bindingVersion: 1, grantVersion: 1, policyVersion: 1,
    },
    issuedAt: 1,
    expiresAt: 2,
    actor: {
      kind: 'fleet_principal', principalId: 'principal-a', provider: 'discord',
      providerSubjectId: 'private-provider-subject', contactId: 'contact-a',
      contactBindingId: 'binding-a', role: 'admin', operatorGrantId: 'grant-a',
      sessionRecordId: 'session-a', sessionAssurance: phase === 'confirm' ? 'break_glass' : 'oauth',
    },
    action: 'privacy.break_glass',
    resource: {
      routeId: `POST /api/admin/privacy-break-glass/memory/:id/${phase}`,
      scope: 'personal_workspace', area: 'memory',
      companionId: '11111111-1111-4111-8111-111111111111',
      pathParams: { id: ID }, query: {},
    },
    subjectRelation: 'none',
    authorization: {
      action: 'privacy.break_glass', baseRole: 'admin',
      resource: { scope: 'personal_workspace', area: 'memory' }, subjectRelation: 'none',
      requirements: {
        assurance: phase === 'confirm' ? 'privacy_break_glass' : 'oauth',
        confirmation: 'explicit', approvals: [],
      },
      publicAccess: 'never', recoveryAccess: 'forbidden',
    },
  };
}

const auditEvidence: PrivacyBreakGlassAuditEvidence = {
  assurance: 'webauthn_uv',
  resourceKind: 'memory',
  resourceSelectorDigest: '1'.repeat(64),
  reasonCategory: BODY.reasonCategory,
  reasonDigest: '2'.repeat(64),
  subjectScopeDigest: '3'.repeat(64),
  confirmationDecisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  expiresAt: '2030-01-01T00:01:00.000Z',
};

type AuditCall = Parameters<AdminAuditTimelineAppender>;

async function invoke(input: {
  phase: 'confirm' | 'decide';
  body: unknown;
  service?: Partial<AdminPrivacyBreakGlassService>;
  context?: GardenRequestContext;
  appendAudit?: AdminAuditTimelineAppender;
  withoutAudit?: boolean;
}): Promise<{ status: number; body: unknown }> {
  const withBody: AdminBodyReader = (_req, _res, callback) => {
    callback(typeof input.body === 'string' ? input.body : JSON.stringify(input.body));
  };
  const routes = buildAdminPrivacyBreakGlassRoutes({
    service: (input.service ?? {}) as AdminPrivacyBreakGlassService,
    withBody,
    appendAuditTimelineEntry: input.withoutAudit
      ? undefined
      : input.appendAudit ?? (() => undefined),
  });
  const path = `/api/admin/privacy-break-glass/memory/${ID}/${input.phase}`;
  const route = routes.find(candidate => candidate.method === 'POST' && candidate.match(path));
  if (!route) throw new Error(`missing route ${path}`);
  const response = new CapturingResponse();
  route.handle(
    { headers: {} } as IncomingMessage,
    response as unknown as ServerResponse,
    route.match(path) ?? {},
    input.context ?? context(input.phase),
  );
  await response.done;
  return { status: response.statusCode, body: JSON.parse(response.body) as unknown };
}

describe('privacy break-glass routes', () => {
  it('audits both confirmation and decision without raw reason, token, content, or provider subject', async () => {
    const calls: AuditCall[] = [];
    const appendAudit: AdminAuditTimelineAppender = (...args) => { calls.push(args); };
    const begin = vi.fn().mockResolvedValue({
      ok: true, confirmToken: TOKEN, expiresAt: auditEvidence.expiresAt, audit: auditEvidence,
    });
    const confirm = await invoke({
      phase: 'confirm', body: BODY, service: { begin }, appendAudit,
    });
    expect(confirm).toEqual({
      status: 200,
      body: { ok: true, confirmToken: TOKEN, expiresAt: auditEvidence.expiresAt },
    });
    expect(calls[0]?.[1]).toBe('needs_approval');

    const secretText = 'private content must never enter audit';
    const decide = vi.fn().mockResolvedValue({
      ok: true,
      disclosure: { kind: 'memory', memory: { id: ID, text: secretText } },
      audit: auditEvidence,
    });
    const decision = await invoke({
      phase: 'decide', body: { ...BODY, confirmToken: TOKEN }, service: { decide }, appendAudit,
    });
    expect(decision).toMatchObject({ status: 200, body: { ok: true } });
    expect(calls[1]?.[1]).toBe('allowed');
    const persistedAuditShape = JSON.stringify(calls);
    expect(persistedAuditShape).not.toContain(BODY.reason);
    expect(persistedAuditShape).not.toContain(TOKEN);
    expect(persistedAuditShape).not.toContain(secretText);
    expect(persistedAuditShape).toContain(`reasonDigest=${auditEvidence.reasonDigest}`);
    expect(persistedAuditShape).toContain(`subjectScopeDigest=${auditEvidence.subjectScopeDigest}`);
    expect(calls[1]?.[5]).toMatchObject({ kind: 'fleet_principal', action: 'privacy.break_glass' });
  });

  it('rejects public/legacy contexts and unknown request fields with a denied audit', async () => {
    const calls: AuditCall[] = [];
    const appendAudit: AdminAuditTimelineAppender = (...args) => { calls.push(args); };
    const begin = vi.fn();
    const publicContext = {
      kind: 'public',
      actor: { kind: 'public', actorId: 'public:anonymous' },
    } as unknown as GardenRequestContext;
    const denied = await invoke({
      phase: 'confirm', body: BODY, service: { begin }, context: publicContext, appendAudit,
    });
    expect(denied.status).toBe(403);
    const invalid = await invoke({
      phase: 'confirm', body: { ...BODY, subjectConsent: true }, service: { begin }, appendAudit,
    });
    expect(invalid.status).toBe(400);
    expect(begin).not.toHaveBeenCalled();
    expect(calls.map(call => call[1])).toEqual(['denied', 'denied']);
  });

  it('fails closed when durable audit or the service is unavailable', async () => {
    const noAudit = await invoke({
      phase: 'confirm', body: BODY,
      service: { begin: vi.fn().mockResolvedValue({ ok: false, status: 403, code: 'denied' }) },
      withoutAudit: true,
    });
    expect(noAudit.status).toBe(503);

    const routes = buildAdminPrivacyBreakGlassRoutes({
      service: null,
      withBody: (_req, _res, callback) => callback(JSON.stringify(BODY)),
      appendAuditTimelineEntry: vi.fn(),
    });
    const path = `/api/admin/privacy-break-glass/memory/${ID}/confirm`;
    const route = routes.find(candidate => candidate.match(path));
    if (!route) throw new Error('missing unavailable route');
    const response = new CapturingResponse();
    route.handle({} as IncomingMessage, response as unknown as ServerResponse, route.match(path) ?? {});
    await response.done;
    expect(response.statusCode).toBe(503);
  });

  it('registers and discloses through the companion-journal route pair', async () => {
    const calls: AuditCall[] = [];
    const appendAudit: AdminAuditTimelineAppender = (...args) => { calls.push(args); };
    const journalDisclosure = {
      kind: 'journal' as const,
      journal: {
        stream: 'reflection-journal' as const,
        entries: [{ id: 'reflection-1', reflection: 'private companion reflection' }],
      },
    };
    const decide = vi.fn().mockResolvedValue({
      ok: true, disclosure: journalDisclosure, audit: { ...auditEvidence, resourceKind: 'journal' },
    });
    const withBody: AdminBodyReader = (_req, _res, callback) => {
      callback(JSON.stringify({ ...BODY, confirmToken: TOKEN }));
    };
    const routes = buildAdminPrivacyBreakGlassRoutes({
      service: { decide } as unknown as AdminPrivacyBreakGlassService,
      withBody,
      appendAuditTimelineEntry: appendAudit,
    });
    const path = '/api/admin/privacy-break-glass/journal/reflection-journal/decide';
    const route = routes.find(candidate => candidate.method === 'POST' && candidate.match(path));
    expect(route).toBeDefined();
    const response = new CapturingResponse();
    route!.handle(
      { headers: {} } as IncomingMessage,
      response as unknown as ServerResponse,
      route!.match(path) ?? {},
      { ...context('decide'), resource: { ...context('decide').resource, routeId: 'POST /api/admin/privacy-break-glass/journal/:id/decide', area: 'values', pathParams: { id: 'reflection-journal' } } } as unknown as GardenRequestContext,
    );
    await response.done;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('reflection-journal');
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ resourceKind: 'journal' }));
    expect(calls[0]?.[1]).toBe('allowed');
  });

  it('never returns a disclosure when durable audit persistence throws', async () => {
    const secretText = 'must remain undisclosed';
    const decision = await invoke({
      phase: 'decide',
      body: { ...BODY, confirmToken: TOKEN },
      service: {
        decide: vi.fn().mockResolvedValue({
          ok: true,
          disclosure: { kind: 'memory', memory: { id: ID, text: secretText } },
          audit: auditEvidence,
        }),
      },
      appendAudit: () => { throw new Error('durable audit unavailable'); },
    });
    expect(decision.status).toBe(503);
    expect(JSON.stringify(decision.body)).not.toContain(secretText);
  });
});
