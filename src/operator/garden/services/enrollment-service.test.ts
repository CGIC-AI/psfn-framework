import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { Contact } from '../../../core/contacts/types.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { HubIdentityEnrollmentStorePort } from '../../../core/enrollment/enrollment-store-port.js';
import type {
  HubIdentityEnrollment,
  HubIdentityEnrollmentInput,
  HubIdentityResolution,
} from '../../../core/enrollment/types.js';
import { HubIdentityEnrollmentService } from '../../../core/enrollment/service.js';
import { buildAdminEnrollmentRoutes } from '../api-routes-enrollment.js';
import { createAdminEnrollmentService } from './enrollment-service.js';

// Port-level fakes only — mirrors core/enrollment/service.test.ts. The Garden
// wrapper is storage-agnostic and the fail-closed policy (contact must exist)
// lives in HubIdentityEnrollmentService, exercised end-to-end here.
class InMemoryEnrollmentStore implements HubIdentityEnrollmentStorePort {
  private bindings = new Map<string, HubIdentityEnrollment>();

  async enroll(input: HubIdentityEnrollmentInput): Promise<HubIdentityEnrollment> {
    const hubIdentityId = input.hubIdentityId.trim();
    const existing = this.bindings.get(hubIdentityId);
    if (existing && existing.status === 'enrolled' && existing.canonicalContactId !== input.canonicalContactId.trim()) {
      throw new Error(`hub identity ${hubIdentityId} already enrolled to a different contact`);
    }
    const now = new Date().toISOString();
    const binding: HubIdentityEnrollment = {
      hubIdentityId,
      canonicalContactId: input.canonicalContactId.trim(),
      status: 'enrolled',
      enrolledAt: now,
      enrolledBy: input.actor?.trim() || 'system:unknown',
      revokedAt: null,
      revokedBy: null,
      satelliteId: input.satelliteId?.trim() || null,
      endpointId: input.endpointId?.trim() || null,
    };
    this.bindings.set(hubIdentityId, binding);
    return binding;
  }

  async revoke(hubIdentityId: string, actor?: string): Promise<boolean> {
    const existing = this.bindings.get(hubIdentityId.trim());
    if (!existing || existing.status !== 'enrolled') return false;
    existing.status = 'revoked';
    existing.revokedAt = new Date().toISOString();
    existing.revokedBy = actor?.trim() || 'system:unknown';
    return true;
  }

  async resolve(hubIdentityId: string): Promise<HubIdentityResolution> {
    const binding = this.bindings.get(hubIdentityId.trim());
    if (!binding || binding.status !== 'enrolled') return { status: 'unenrolled' };
    return { status: 'enrolled', binding };
  }

  async getBinding(hubIdentityId: string): Promise<HubIdentityEnrollment | undefined> {
    return this.bindings.get(hubIdentityId.trim());
  }

  async listByContact(contactId: string): Promise<HubIdentityEnrollment[]> {
    return [...this.bindings.values()].filter(b => b.canonicalContactId === contactId.trim());
  }

  async listAll(): Promise<HubIdentityEnrollment[]> {
    return [...this.bindings.values()];
  }

  async listAudit(): Promise<never[]> {
    return [];
  }
}

class InMemoryContactStore {
  private contacts = new Map<string, Contact>();

  add(id: string, displayName: string): void {
    const now = new Date().toISOString();
    this.contacts.set(id, {
      id,
      displayName,
      trustLevel: 'regular',
      relationshipType: 'stranger',
      firstSeen: now,
      lastSeen: now,
    });
  }

  async getById(id: string): Promise<Contact | undefined> {
    return this.contacts.get(id);
  }
}

function buildService(): ReturnType<typeof createAdminEnrollmentService> {
  const contactStore = new InMemoryContactStore();
  contactStore.add('contact-1', 'Resident');
  const core = new HubIdentityEnrollmentService(
    new InMemoryEnrollmentStore(),
    contactStore as unknown as ContactStorePort,
  );
  return createAdminEnrollmentService({ enrollmentService: core });
}

class CapturingResponse {
  status = 0;
  headers: Record<string, string> = {};
  body = '';
  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = headers ?? {};
    return this;
  }
  end(body?: string): this {
    this.body = body ?? '';
    return this;
  }
}

const withBody = (req: IncomingMessage, _res: ServerResponse, cb: (body: string) => void): void => {
  cb((req as unknown as { _body?: string })._body ?? '');
};

async function invokeRoute(
  routes: ReturnType<typeof buildAdminEnrollmentRoutes>,
  method: string,
  path: string,
  body?: string,
): Promise<CapturingResponse> {
  const route = routes.find(candidate => candidate.method === method && candidate.match(path));
  const response = new CapturingResponse();
  const params = route?.match(path) ?? {};
  const req = { url: path, headers: { host: 'localhost' } } as unknown as { _body?: string; url: string };
  if (body !== undefined) req._body = body;
  route?.handle(req as unknown as IncomingMessage, response as unknown as ServerResponse, params);
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('AdminEnrollmentService', () => {
  it('enrolls, lists, and revokes a hub-identity binding', async () => {
    const service = buildService();
    expect((await service.listEnrollments()).total).toBe(0);

    const binding = await service.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: 'contact-1', actor: 'operator' });
    expect(binding.hubIdentityId).toBe('hub-abc');
    expect(binding.canonicalContactId).toBe('contact-1');
    expect(binding.status).toBe('enrolled');
    // No biometric fields exist on the view.
    expect(Object.keys(binding)).not.toContain('template');
    expect(Object.keys(binding)).not.toContain('embedding');

    const list = await service.listEnrollments();
    expect(list.total).toBe(1);
    expect(list.enrollments[0]?.hubIdentityId).toBe('hub-abc');

    const revoke = await service.revoke('hub-abc', 'operator');
    expect(revoke.revoked).toBe(true);
    expect((await service.listEnrollments()).enrollments[0]?.status).toBe('revoked');
  });

  it('fails closed when binding to a contact that does not exist (never auto-creates)', async () => {
    const service = buildService();
    await expect(service.enroll({ hubIdentityId: 'hub-x', canonicalContactId: 'contact-ghost' }))
      .rejects.toThrow(/does not exist/);
    expect((await service.listEnrollments()).total).toBe(0);
  });

  it('returns revoked=false when there is nothing to revoke', async () => {
    const service = buildService();
    expect((await service.revoke('hub-missing')).revoked).toBe(false);
  });
});

describe('buildAdminEnrollmentRoutes', () => {
  it('POST enrolls and GET lists', async () => {
    const routes = buildAdminEnrollmentRoutes({ enrollmentService: buildService(), withBody });
    const post = await invokeRoute(routes, 'POST', '/api/admin/enrollments', JSON.stringify({ hubIdentityId: 'hub-1', canonicalContactId: 'contact-1' }));
    expect(post.status).toBe(201);
    expect(JSON.parse(post.body).binding.hubIdentityId).toBe('hub-1');

    const get = await invokeRoute(routes, 'GET', '/api/admin/enrollments');
    expect(get.status).toBe(200);
    expect(get.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(get.body).total).toBe(1);
  });

  it('POST to a non-existent contact returns 400 and creates nothing', async () => {
    const service = buildService();
    const routes = buildAdminEnrollmentRoutes({ enrollmentService: service, withBody });
    const res = await invokeRoute(routes, 'POST', '/api/admin/enrollments', JSON.stringify({ hubIdentityId: 'hub-1', canonicalContactId: 'contact-ghost' }));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/does not exist/);
    expect((await service.listEnrollments()).total).toBe(0);
  });

  it('POST without hubIdentityId returns 400', async () => {
    const routes = buildAdminEnrollmentRoutes({ enrollmentService: buildService(), withBody });
    const res = await invokeRoute(routes, 'POST', '/api/admin/enrollments', JSON.stringify({ canonicalContactId: 'contact-1' }));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/hubIdentityId is required/);
  });

  it('DELETE revokes an active binding and 404s when nothing to revoke', async () => {
    const service = buildService();
    const routes = buildAdminEnrollmentRoutes({ enrollmentService: service, withBody });
    await service.enroll({ hubIdentityId: 'hub-9', canonicalContactId: 'contact-1' });
    const ok = await invokeRoute(routes, 'DELETE', '/api/admin/enrollments/hub-9');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).revoked).toBe(true);

    const gone = await invokeRoute(routes, 'DELETE', '/api/admin/enrollments/hub-9');
    expect(gone.status).toBe(404);
  });
});
