import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresContactStore } from '../../../core/contacts/postgres-adapter.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import {
  FLEET_GARDEN_CONTACT_OPERATOR_ACTOR,
  type FleetGardenRequestContext,
} from '../garden-request-context.js';
import { AdminContactsDataService } from '../services/contacts-service.js';
import type { AdminContactsService } from '../services/types.js';
import { buildAdminContactRoutes } from './contact-routes.js';
import type { AdminApiRoute, AdminBodyReader } from './types.js';

const TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, TIMEOUT_MS);

class CapturingResponse {
  statusCode = 0;
  body = '';
  readonly done: Promise<void>;
  private resolveDone: () => void = () => undefined;

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

function requirePatchRoute(service: AdminContactsService, withBody: AdminBodyReader, target: string): AdminApiRoute {
  const matched = buildAdminContactRoutes({ contactsService: service, withBody })
    .find(candidate => candidate.method === 'PATCH' && candidate.match(target));
  if (!matched) throw new Error('contact update route missing');
  return matched;
}

function parseResponseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`contact route returned invalid JSON: ${String(error)}`);
  }
}

function fleetOwnerContext(actorContactId: string, targetContactId: string): FleetGardenRequestContext {
  return {
    kind: 'fleet_principal',
    requestId: 'request-real-postgres-fixture',
    decisionId: 'decision-real-postgres-fixture',
    authorizationEventId: 'authorization-event-real-postgres-fixture',
    resolvedAt: '2030-01-01T00:00:00.000Z',
    versions: {
      authorityGeneration: 1, globalAuthEpoch: 1, sessionAuthnVersion: 1,
      sessionAuthzVersion: 1, bindingVersion: 1, grantVersion: 1, policyVersion: 1,
    },
    issuedAt: 1,
    expiresAt: 2,
    actor: {
      kind: 'fleet_principal', principalId: 'principal-real-postgres-fixture', provider: 'discord',
      providerSubjectId: 'provider-subject-real-postgres-fixture', contactId: actorContactId,
      contactBindingId: 'binding-real-postgres-fixture', role: 'owner',
      operatorGrantId: 'grant-real-postgres-fixture', sessionRecordId: 'session-real-postgres-fixture',
      sessionAssurance: 'oauth', accessMode: 'sole_admin',
    },
    action: 'contacts.manage',
    resource: {
      routeId: 'PATCH /api/admin/contacts/:id', scope: 'personal_workspace', area: 'contacts',
      companionId: '11111111-1111-4111-8111-111111111111',
      pathParams: { id: targetContactId }, query: {},
    },
    subjectRelation: 'none',
    authorization: {
      action: 'contacts.manage', baseRole: 'admin',
      resource: { scope: 'personal_workspace', area: 'contacts' }, subjectRelation: 'none',
      requirements: { assurance: 'oauth', confirmation: 'explicit', approvals: ['contact_approval'] },
      publicAccess: 'never', recoveryAccess: 'forbidden',
    },
  };
}

function createService(contactStore: ContactStorePort): AdminContactsDataService {
  return new AdminContactsDataService({
    contactStore,
    memoryStore: {
      listRecentContactShapes: () => [],
      getRecentContactShape: () => undefined,
    } as unknown as MemoryStorePort,
    sessionStore: {
      listChannels: () => [],
      getLastEntry: () => undefined,
    } as unknown as SessionStore,
  });
}

async function invoke(
  service: AdminContactsService,
  targetContactId: string,
  body: string,
  context: FleetGardenRequestContext,
): Promise<{ status: number; body: unknown }> {
  const withBody: AdminBodyReader = (_req, _res, callback) => callback(body);
  const target = `/api/admin/contacts/${targetContactId}`;
  const route = requirePatchRoute(service, withBody, target);
  const response = new CapturingResponse();
  route.handle(
    { headers: {} } as IncomingMessage,
    response as unknown as ServerResponse,
    route.match(target) ?? {},
    context,
  );
  await response.done;
  return { status: response.statusCode, body: parseResponseBody(response.body) };
}

function requirePostgresHarness(): PostgresTestHarness {
  if (harness) return harness;
  throw new Error('Postgres test harness unavailable');
}

async function freshStore(): Promise<{ store: ContactStorePort; pool: Pool }> {
  const database = await requirePostgresHarness().createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'garden-contact-route-real-postgres',
    allowExitOnIdle: true,
    max: 8,
  });
  const store = await createPostgresContactStore(
    database.databaseUrl,
    'primary-provider-real-postgres-fixture',
    { pool },
  );
  return { store, pool };
}

async function rejectFleetTrustAudit(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE FUNCTION reject_fleet_garden_trust_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.field = 'trust_level' AND NEW.actor = 'operator:fleet-garden' THEN
        RAISE EXCEPTION 'injected fleet Garden audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await pool.query(`
    CREATE TRIGGER reject_fleet_garden_trust_audit_trigger
    BEFORE INSERT ON contact_mutation_audit
    FOR EACH ROW
    EXECUTE FUNCTION reject_fleet_garden_trust_audit()
  `);
}

describe('fleet contact mutation route with real Postgres', () => {
  it('persists protected mutations with canonical operator and full fleet audit attribution', async () => {
    const { store, pool } = await freshStore();
    try {
      const owner = await store.upsert({ displayName: 'Fleet Owner' });
      const target = await store.upsert({
        displayName: 'Chosen Family', relationshipType: 'friend', trustLevel: 'regular',
      });
      const context = fleetOwnerContext(owner.id, target.id);

      const response = await invoke(
        createService(store),
        target.id,
        JSON.stringify({
          displayName: 'Chosen Family Updated', trustLevel: 'trusted', relationshipType: 'family',
        }),
        context,
      );

      expect(response.status).toBe(200);
      await expect(store.getById(target.id)).resolves.toMatchObject({
        displayName: 'Chosen Family Updated', trustLevel: 'trusted', relationshipType: 'family',
      });
      const audit = (await store.listMutationAuditEntries({ contactId: target.id }))
        .filter(entry => ['display_name', 'trust_level', 'relationship_type'].includes(entry.field));
      expect(audit).toHaveLength(3);
      expect(audit.every(entry => entry.actor === FLEET_GARDEN_CONTACT_OPERATOR_ACTOR)).toBe(true);
      for (const entry of audit) {
        expect(entry.metadata).toEqual({
          source: 'fleet_garden',
          provider: 'discord',
          providerSubjectId: 'provider-subject-real-postgres-fixture',
          principalId: 'principal-real-postgres-fixture',
          requestId: 'request-real-postgres-fixture',
          decisionId: 'decision-real-postgres-fixture',
          authorizationEventId: 'authorization-event-real-postgres-fixture',
          operatorGrantId: 'grant-real-postgres-fixture',
          sessionRecordId: 'session-real-postgres-fixture',
          contactBindingId: 'binding-real-postgres-fixture',
        });
      }
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('rolls back the protected mutation when its real audit insert fails', async () => {
    const { store, pool } = await freshStore();
    try {
      const owner = await store.upsert({ displayName: 'Fleet Owner' });
      const target = await store.upsert({ displayName: 'Protected Contact', trustLevel: 'regular' });
      await rejectFleetTrustAudit(pool);

      const response = await invoke(
        createService(store),
        target.id,
        JSON.stringify({ trustLevel: 'trusted' }),
        fleetOwnerContext(owner.id, target.id),
      );

      expect(response.status).toBe(500);
      await expect(store.getById(target.id)).resolves.toMatchObject({ trustLevel: 'regular' });
      await expect(store.listMutationAuditEntries({
        contactId: target.id,
        field: 'trust_level',
      })).resolves.toEqual([]);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('fails closed for a non-owner without persisting contact or audit changes', async () => {
    const { store, pool } = await freshStore();
    try {
      const requester = await store.upsert({ displayName: 'Fleet Admin' });
      const target = await store.upsert({
        displayName: 'Protected Contact', relationshipType: 'friend', trustLevel: 'regular',
      });
      const ownerContext = fleetOwnerContext(requester.id, target.id);
      const nonOwnerContext: FleetGardenRequestContext = {
        ...ownerContext,
        actor: { ...ownerContext.actor, role: 'admin' },
      };

      const response = await invoke(
        createService(store),
        target.id,
        JSON.stringify({ trustLevel: 'trusted', relationshipType: 'family' }),
        nonOwnerContext,
      );

      expect(response.status).toBe(403);
      await expect(store.getById(target.id)).resolves.toMatchObject({
        trustLevel: 'regular', relationshipType: 'friend',
      });
      await expect(store.listMutationAuditEntries({ contactId: target.id })).resolves.toEqual([]);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('preserves primary-contact trust immutability without writing a fleet audit', async () => {
    const { store, pool } = await freshStore();
    try {
      const primary = await store.upsert({
        displayName: 'Primary Fleet Owner',
        discordUserId: 'primary-provider-real-postgres-fixture',
        trustLevel: 'primary',
      }, {
        actor: 'operator:real-postgres-fixture',
        mutationSource: 'manual',
        allowPrimaryTrustAssignment: true,
      });
      const auditBefore = await store.listMutationAuditEntries({ contactId: primary.id });

      const response = await invoke(
        createService(store),
        primary.id,
        JSON.stringify({ trustLevel: 'trusted' }),
        fleetOwnerContext(primary.id, primary.id),
      );

      expect(response.status).toBe(409);
      await expect(store.getById(primary.id)).resolves.toMatchObject({ trustLevel: 'primary' });
      await expect(store.listMutationAuditEntries({ contactId: primary.id }))
        .resolves.toEqual(auditBefore);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);
});
