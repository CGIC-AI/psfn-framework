import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import { createTestPostgresContactStore } from '../../../test-support/postgres-contact-store.js';
import type { FleetGardenRequestContext } from '../garden-request-context.js';
import { AdminContactsDataService } from '../services/contacts-service.js';
import type { AdminContactsService } from '../services/types.js';
import { buildAdminContactRoutes } from './contact-routes.js';
import type { AdminBodyReader } from './types.js';

class CapturingResponse {
  statusCode = 0;
  body = '';
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  constructor() { this.done = new Promise(resolve => { this.resolveDone = resolve; }); }
  writeHead(statusCode: number): this { this.statusCode = statusCode; return this; }
  end(chunk?: string): void { this.body = chunk ?? ''; this.resolveDone(); }
}

function fleetOwnerContext(contactId: string): FleetGardenRequestContext {
  return {
    kind: 'fleet_principal', requestId: 'request-fixture', decisionId: 'decision-fixture',
    authorizationEventId: 'event-fixture', resolvedAt: '2030-01-01T00:00:00.000Z',
    versions: { authorityGeneration: 1, globalAuthEpoch: 1, sessionAuthnVersion: 1,
      sessionAuthzVersion: 1, bindingVersion: 1, grantVersion: 1, policyVersion: 1 },
    issuedAt: 1, expiresAt: 2,
    actor: { kind: 'fleet_principal', principalId: 'principal-fixture', provider: 'discord',
      providerSubjectId: 'provider-subject-fixture', contactId, contactBindingId: 'binding-fixture',
      role: 'owner', operatorGrantId: 'grant-fixture', sessionRecordId: 'session-fixture',
      sessionAssurance: 'oauth', accessMode: 'sole_admin' },
    action: 'contacts.manage',
    resource: { routeId: 'PATCH /api/admin/contacts/:id', scope: 'personal_workspace', area: 'contacts',
      companionId: '11111111-1111-4111-8111-111111111111', pathParams: { id: contactId }, query: {} },
    subjectRelation: 'self',
    authorization: { action: 'contacts.manage', baseRole: 'admin',
      resource: { scope: 'personal_workspace', area: 'contacts' }, subjectRelation: 'self',
      requirements: { assurance: 'oauth', confirmation: 'none', approvals: [] },
      publicAccess: 'never', recoveryAccess: 'forbidden' },
  };
}

async function invoke(service: AdminContactsService, id: string, body: string, context?: FleetGardenRequestContext) {
  const withBody: AdminBodyReader = (_req, _res, callback) => callback(body);
  const route = buildAdminContactRoutes({ contactsService: service, withBody })
    .find(candidate => candidate.method === 'PATCH' && candidate.match(`/api/admin/contacts/${id}`));
  if (!route) throw new Error('contact update route missing');
  const response = new CapturingResponse();
  route.handle({ headers: {} } as IncomingMessage, response as unknown as ServerResponse,
    route.match(`/api/admin/contacts/${id}`) ?? {}, context);
  await response.done;
  return { status: response.statusCode, body: JSON.parse(response.body) as unknown };
}

describe('fleet contact mutation route', () => {
  it('allows an authenticated sole owner to apply protected trust and relationship transitions', async () => {
    const { store } = await createTestPostgresContactStore();
    const owner = await store.upsert({ displayName: 'Owner' });
    const target = await store.upsert({ displayName: 'Chosen Family', relationshipType: 'friend' });
    const service = new AdminContactsDataService({ contactStore: store,
      memoryStore: { listRecentContactShapes: () => [], getRecentContactShape: () => undefined } as unknown as MemoryStorePort,
      sessionStore: { listChannels: () => [], getLastEntry: () => undefined } as unknown as SessionStore });
    const response = await invoke(service, target.id,
      JSON.stringify({ trustLevel: 'trusted', relationshipType: 'family' }), fleetOwnerContext(owner.id));
    expect(response.status).toBe(200);
    expect(await store.getById(target.id)).toMatchObject({ trustLevel: 'trusted', relationshipType: 'family' });
  });

  it.each([
    ['authorization', 403], ['immutability', 409], ['validation', 400], ['not_found', 404],
  ] as const)('maps %s failures to a distinct HTTP status', async (failureKind, status) => {
    const service = { updateContact: async () => ({ ok: false, message: 'denied', failureKind }) } as unknown as AdminContactsService;
    expect((await invoke(service, 'contact-fixture', '{}')).status).toBe(status);
  });

  it('rejects malformed JSON before mutation', async () => {
    let called = false;
    const service = { updateContact: async () => { called = true; return { ok: true, message: 'unexpected' }; } } as unknown as AdminContactsService;
    expect((await invoke(service, 'contact-fixture', '{')).status).toBe(400);
    expect(called).toBe(false);
  });
});
