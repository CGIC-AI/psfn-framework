import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { buildAdminMemoryRoutes } from './api-routes-memory.js';
import type { AdminApiRoute } from './routes/types.js';
import type { AdminMemoryService, AdminMemorySessionService } from './services/types.js';
import { AdminMemoryDataService } from './services/memory-service.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import type { AdminSubjectVisibleAuditService } from './services/subject-visible-audit-service.js';
import type { FleetGardenRequestContext } from './garden-request-context.js';

class CapturingResponse {
  status = 0;
  headers: Record<string, string> = {};
  setHeaders: Record<string, string> = {};
  body = '';

  setHeader(name: string, value: string): this {
    this.setHeaders[name] = value;
    return this;
  }

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

function makeRequest(url: string, body = ''): IncomingMessage {
  return {
    url,
    headers: { host: 'localhost' },
    body,
  } as IncomingMessage;
}

type TestAdminMemoryService = AdminMemoryService & AdminMemorySessionService;

function makeMemoryService(overrides: Partial<AdminMemorySessionService> = {}): TestAdminMemoryService {
  const service = {
    listMemories: vi.fn(async () => ({
      memories: [],
      pagination: { limit: 50, offset: 0, total: 0, hasPrevious: false, hasNext: false },
      privacySummary: {
        activeMemoryCount: 0,
        matchingMemoryCount: 0,
        pageMemoryCount: 0,
        highSensitivityCount: 0,
        consentGatedCount: 0,
        sensitivityCounts: {},
      },
      contactsById: new Map([['contact-1', { id: 'contact-1', displayName: 'Ada' }]]),
    })),
    getMemoryDetail: vi.fn(async id => ({ memory: { id }, links: [] } as never)),
    listManagedScopes: vi.fn(async () => ({ scopes: [] })),
    getManagedScopeDetail: vi.fn(async () => null),
    searchMemories: vi.fn(async () => ({
      results: [],
      privacySummary: {
        activeMemoryCount: 0,
        matchingMemoryCount: 0,
        highSensitivityCount: 0,
        consentGatedCount: 0,
        sensitivityCounts: {},
      },
      contactsById: new Map(),
    })),
    sharedBackground: vi.fn(async (contactAId: string, contactBId: string) => ({
      contactAId,
      contactBId,
      resolved: true,
      missingContactIds: [],
      items: [],
      contactsById: new Map(),
      totalCandidates: 0,
      truncated: false,
      limit: 12,
      elevation: { elevated: false, ttlMs: 900_000 },
    })),
    supersedeMemory: vi.fn(async () => ({ ok: true })),
    patchMemory: vi.fn(async () => ({ ok: true })),
    updateMemoryScope: vi.fn(async () => ({ ok: true, memory: {} as never })),
    linkMemories: vi.fn(async () => ({ ok: true, link: {} as never })),
    unlinkMemories: vi.fn(async () => ({ ok: true })),
    getMemoryLinks: vi.fn(async () => []),
    bulkDelete: vi.fn(async ids => ({ ok: true, count: ids.length })),
    bulkUpdate: vi.fn(async ids => ({ ok: true, count: ids.length })),
    getBodyElevationStatus: vi.fn(() => ({ elevated: false, ttlMs: 900_000 })),
    elevateBodyAccess: vi.fn(() => ({ elevated: true, expiresAt: 900_000, ttlMs: 900_000 })),
    dropBodyElevation: vi.fn(() => ({ elevated: false, ttlMs: 900_000 })),
    revealMemory: vi.fn(async id => ({
      memory: { id },
      scopeAssignments: [],
      elevation: { elevated: false, ttlMs: 900_000 },
    } as never)),
    ...overrides,
  } as AdminMemorySessionService;
  // The route layer binds a per-request session; the flat mock stands in for
  // both the service and its session view so call assertions stay direct.
  return Object.assign(service, {
    forSession: vi.fn(() => service),
  }) as TestAdminMemoryService;
}

function makeRoutes(memoryService: AdminMemoryService): AdminApiRoute[] {
  return buildAdminMemoryRoutes({
    memoryService,
    withBody: (req, _res, cb) => cb((req as IncomingMessage & { body?: string }).body ?? ''),
  });
}

async function invokeRoute(
  routes: AdminApiRoute[],
  method: AdminApiRoute['method'],
  url: string,
  body = '',
): Promise<CapturingResponse> {
  const path = new URL(url, 'http://localhost').pathname;
  const route = routes.find(candidate => candidate.method === method && candidate.match(path));
  expect(route, `${method} ${path}`).toBeDefined();

  const response = new CapturingResponse();
  const params = route?.match(path) ?? {};
  route?.handle(makeRequest(url, body), response as unknown as ServerResponse, params);
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

function parseBody(response: CapturingResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe('admin memory API route split', () => {
  it('validates memory list filters before forwarding canonical query params', async () => {
    const memoryService = makeMemoryService();
    const routes = makeRoutes(memoryService);

    const okResponse = await invokeRoute(
      routes,
      'GET',
      '/api/admin/memory?type=semantic&sensitivity=personal&retention=durable&startDate=2026-01-01&endDate=2026-01-31',
    );
    expect(okResponse.status).toBe(200);
    expect(parseBody(okResponse).contactsById).toEqual({
      'contact-1': { id: 'contact-1', displayName: 'Ada' },
    });
    const forwardedParams = vi.mocked(memoryService.listMemories).mock.calls[0]?.[0];
    expect(forwardedParams?.get('type')).toBe('semantic');
    expect(forwardedParams?.get('sensitivity')).toBe('personal');
    expect(forwardedParams?.get('retention')).toBe('durable');

    const badRangeResponse = await invokeRoute(
      routes,
      'GET',
      '/api/admin/memory?startDate=2026-02-01&endDate=2026-01-31',
    );
    expect(badRangeResponse.status).toBe(400);
    expect(parseBody(badRangeResponse).error).toBe('startDate must be before or equal to endDate');
    expect(memoryService.listMemories).toHaveBeenCalledTimes(1);
  });

  it('keeps sub-path memory routes ahead of the generic memory detail route', async () => {
    const memoryService = makeMemoryService({
      getMemoryLinks: vi.fn(async id => [{ id1: id, id2: 'mem-2', linkType: 'supports' } as never]),
    });
    const routes = makeRoutes(memoryService);

    const linksResponse = await invokeRoute(routes, 'GET', '/api/admin/memory/mem-1/links');
    expect(linksResponse.status).toBe(200);
    expect(parseBody(linksResponse).links).toEqual([
      { id1: 'mem-1', id2: 'mem-2', linkType: 'supports' },
    ]);
    expect(memoryService.getMemoryLinks).toHaveBeenCalledWith('mem-1');
    expect(memoryService.getMemoryDetail).not.toHaveBeenCalled();
  });

  it('validates and dispatches the memory patch sub-route', async () => {
    const patchMemory = vi.fn(async (
      _memoryId: string,
      _fields: { text: string; reason?: string; referencePath?: string },
    ) => ({ ok: true }));
    const memoryService = makeMemoryService() as TestAdminMemoryService & {
      patchMemory: typeof patchMemory;
    };
    memoryService.patchMemory = patchMemory;
    const routes = makeRoutes(memoryService);

    const blankResponse = await invokeRoute(
      routes,
      'PATCH',
      '/api/admin/memory/mem-1/patch',
      JSON.stringify({ text: '   ' }),
    );
    expect(blankResponse.status).toBe(400);
    expect(parseBody(blankResponse).error).toBe('Replacement text is required');
    expect(patchMemory).not.toHaveBeenCalled();

    const okResponse = await invokeRoute(
      routes,
      'PATCH',
      '/api/admin/memory/mem-1/patch',
      JSON.stringify({
        text: '  Updated memory text.  ',
        reason: '  operator correction  ',
        referencePath: '  docs/memory.md  ',
      }),
    );
    expect(okResponse.status).toBe(200);
    expect(patchMemory).toHaveBeenCalledWith('mem-1', {
      text: 'Updated memory text.',
      reason: 'operator correction',
      referencePath: 'docs/memory.md',
    });
  });

  it('rejects body patches for redacted high-intimacy memories without a reveal', async () => {
    const patchMemory = vi.fn(async () => ({ ok: true }));
    const memoryService = makeMemoryService({
      getMemoryDetail: vi.fn(async id => ({
        memory: {
          id,
          sensitivity: 'intimate',
          bodyRedacted: true,
          bodyRedaction: {
            sensitivity: 'intimate',
            originalLength: 42,
            reason: 'high_intimacy_sensitivity',
            revealHint: 'reveal or elevate',
          },
        },
        scopeAssignments: [],
        elevation: { elevated: false, ttlMs: 900_000 },
      } as never)),
    }) as TestAdminMemoryService & { patchMemory: typeof patchMemory };
    memoryService.patchMemory = patchMemory;
    const routes = makeRoutes(memoryService);

    const response = await invokeRoute(
      routes,
      'PATCH',
      '/api/admin/memory/mem-intimate/patch',
      JSON.stringify({ text: 'Rewritten body.' }),
    );
    expect(response.status).toBe(403);
    expect(parseBody(response).error).toBe(
      'Memory body is redacted (intimate). Reveal the memory or elevate memory body access before editing its body.',
    );
    expect(patchMemory).not.toHaveBeenCalled();
  });

  it('returns 404 for body patches of missing memories before invoking patchMemory', async () => {
    const patchMemory = vi.fn(async () => ({ ok: true }));
    const memoryService = makeMemoryService({
      getMemoryDetail: vi.fn(async () => null),
    }) as TestAdminMemoryService & { patchMemory: typeof patchMemory };
    memoryService.patchMemory = patchMemory;
    const routes = makeRoutes(memoryService);

    const response = await invokeRoute(
      routes,
      'PATCH',
      '/api/admin/memory/missing/patch',
      JSON.stringify({ text: 'Rewritten body.' }),
    );
    expect(response.status).toBe(404);
    expect(parseBody(response).error).toBe('Memory not found');
    expect(patchMemory).not.toHaveBeenCalled();
  });

  it('patches a memory body end-to-end through the real AdminMemoryDataService', async () => {
    const stored: PurrMemory = {
      id: 'mem-real',
      text: 'Original body text.',
      type: 'semantic',
      importance: 0.6,
      confidence: 0.7,
      emotionalValence: 0.1,
      salience: 0.6,
      sourceRef: 'turn:seed',
      sourceType: 'turn',
      extractedAt: Date.now() - 100_000,
      lastAccessed: Date.now() - 50_000,
      accessCount: 2,
      tags: [],
      sensitivity: 'public',
    } as unknown as PurrMemory;

    const recordedPatchEvents: Array<Record<string, unknown>> = [];
    const embeddedTexts: string[] = [];
    const store = {
      getById: vi.fn(async (id: string) => (id === stored.id ? stored : undefined)),
      updateMemory: vi.fn(async (id: string, updates: Partial<PurrMemory>) => {
        if (id !== stored.id) return;
        Object.assign(stored, updates);
      }),
      recordPatchEvent: vi.fn(async (event: Record<string, unknown>) => {
        recordedPatchEvents.push(event);
      }),
      runInTransaction: vi.fn(async (handler: () => Promise<unknown>) => handler()),
    } as unknown as MemoryStorePort;

    const embeddingService: EmbeddingProviderPort = {
      dims: 4,
      embed: vi.fn(async (text: string) => {
        embeddedTexts.push(text);
        return new Float32Array([0.1, 0.2, 0.3, 0.4]);
      }),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]))),
    };

    const audits: Array<{ decision: string; narrative: string }> = [];
    const service = new AdminMemoryDataService({
      memoryStore: store,
      embeddingService,
      appendAuditTimelineEntry: (_actionType, decision, narrative) => {
        audits.push({ decision, narrative });
      },
    });
    const routes = makeRoutes(service);

    const response = await invokeRoute(
      routes,
      'PATCH',
      '/api/admin/memory/mem-real/patch',
      JSON.stringify({ text: '  Rewritten body text.  ', reason: 'operator correction', referencePath: 'docs/memory.md' }),
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)).toMatchObject({ ok: true });
    // Body was actually persisted, not just acknowledged.
    expect(stored.text).toBe('Rewritten body text.');
    // Retrieval stays consistent: the new body was re-embedded and stored.
    expect(embeddedTexts).toContain('Rewritten body text.');
    const storedEmbedding = (stored as unknown as { embedding?: Float32Array }).embedding;
    expect(storedEmbedding).toBeInstanceOf(Float32Array);
    expect(storedEmbedding).toHaveLength(4);
    expect(storedEmbedding?.[0]).toBeCloseTo(0.1, 5);
    // A durable, audited patch event captured the edit and its reference.
    expect(recordedPatchEvents).toHaveLength(1);
    expect(recordedPatchEvents[0]).toMatchObject({
      memoryId: 'mem-real',
      patch: expect.objectContaining({ text: 'Rewritten body text.' }),
      previousValues: expect.objectContaining({ text: 'Original body text.' }),
    });
    expect(String(recordedPatchEvents[0]?.reason)).toContain('docs/memory.md');
    expect(audits.some(entry => entry.decision === 'allowed' && entry.narrative.includes('mem-real'))).toBe(true);
  });

  it('wires the elevation status, elevate, and drop routes to the memory service', async () => {
    const memoryService = makeMemoryService();
    const routes = makeRoutes(memoryService);

    const statusResponse = await invokeRoute(routes, 'GET', '/api/admin/memory/elevation');
    expect(statusResponse.status).toBe(200);
    expect(parseBody(statusResponse)).toEqual({ elevated: false, ttlMs: 900_000 });
    expect(memoryService.getBodyElevationStatus).toHaveBeenCalledTimes(1);
    // The generic detail route must not swallow the elevation path.
    expect(memoryService.getMemoryDetail).not.toHaveBeenCalled();

    const elevateResponse = await invokeRoute(routes, 'POST', '/api/admin/memory/elevation');
    expect(elevateResponse.status).toBe(200);
    expect(parseBody(elevateResponse)).toEqual({ elevated: true, expiresAt: 900_000, ttlMs: 900_000 });
    expect(memoryService.elevateBodyAccess).toHaveBeenCalledTimes(1);

    const dropResponse = await invokeRoute(routes, 'DELETE', '/api/admin/memory/elevation');
    expect(dropResponse.status).toBe(200);
    expect(parseBody(dropResponse)).toEqual({ elevated: false, ttlMs: 900_000 });
    expect(memoryService.dropBodyElevation).toHaveBeenCalledTimes(1);
  });

  it('dispatches per-item reveals ahead of the generic detail route and handles missing memories', async () => {
    const memoryService = makeMemoryService();
    const routes = makeRoutes(memoryService);

    const revealResponse = await invokeRoute(routes, 'POST', '/api/admin/memory/mem-1/reveal');
    expect(revealResponse.status).toBe(200);
    expect(parseBody(revealResponse).memory).toEqual({ id: 'mem-1' });
    expect(memoryService.revealMemory).toHaveBeenCalledWith('mem-1');

    const missingService = makeMemoryService({ revealMemory: vi.fn(async () => null) });
    const missingResponse = await invokeRoute(
      makeRoutes(missingService),
      'POST',
      '/api/admin/memory/missing/reveal',
    );
    expect(missingResponse.status).toBe(404);
    expect(parseBody(missingResponse).error).toBe('Memory not found');
  });
});

describe('fleet memory reveal subject-visible audit', () => {
  function fleetRevealContext(memoryId: string): FleetGardenRequestContext {
    return Object.freeze({
      kind: 'fleet_principal',
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      decisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      authorizationEventId: 'event-a',
      resolvedAt: '2030-01-01T00:00:00.000Z',
      versions: Object.freeze({
        authorityGeneration: 1,
        globalAuthEpoch: 1,
        sessionAuthnVersion: 1,
        sessionAuthzVersion: 1,
        bindingVersion: 1,
        grantVersion: 1,
        policyVersion: 1,
      }),
      issuedAt: 1,
      expiresAt: 2,
      actor: Object.freeze({
        kind: 'fleet_principal',
        principalId: 'principal-owner-a',
        provider: 'discord',
        providerSubjectId: 'provider-a',
        contactId: 'contact-a',
        contactBindingId: 'binding-a',
        role: 'owner',
        operatorGrantId: 'grant-a',
        sessionRecordId: 'session-a',
        sessionAssurance: 'escalated',
        accessMode: 'sole_admin',
      }),
      action: 'memory.reveal',
      resource: Object.freeze({
        routeId: 'POST /api/admin/memory/:id/reveal',
        scope: 'personal_workspace',
        area: 'memory',
        companionId: '11111111-1111-4111-8111-111111111111',
        pathParams: Object.freeze({ id: memoryId }),
        query: Object.freeze({}),
      }),
      subjectRelation: 'self_or_co_subject',
      authorization: Object.freeze({
        action: 'memory.reveal',
        baseRole: 'admin',
        resource: Object.freeze({ scope: 'personal_workspace', area: 'memory' }),
        subjectRelation: 'self_or_co_subject',
        requirements: Object.freeze({
          assurance: 'escalated',
          confirmation: 'explicit',
          approvals: Object.freeze([]),
        }),
        publicAccess: 'never',
        recoveryAccess: 'forbidden',
      }),
    });
  }

  async function invokeFleetReveal(input: {
    memoryId: string;
    body: unknown;
    memoryService: TestAdminMemoryService;
    subjectAudit?: Partial<AdminSubjectVisibleAuditService>;
  }): Promise<{ status: number; body: unknown }> {
    const routes = buildAdminMemoryRoutes({
      memoryService: input.memoryService,
      subjectAuditService: input.subjectAudit as AdminSubjectVisibleAuditService | undefined,
      withBody: (_req, _res, callback) => callback(JSON.stringify(input.body)),
    });
    const path = `/api/admin/memory/${input.memoryId}/reveal`;
    const route = routes.find(candidate => candidate.method === 'POST' && candidate.match(path));
    if (!route) throw new Error(`missing route ${path}`);
    const response = new CapturingResponse();
    route.handle(
      makeRequest(path, JSON.stringify(input.body)),
      response as unknown as ServerResponse,
      route.match(path) ?? {},
      fleetRevealContext(input.memoryId),
    );
    await new Promise(resolve => setImmediate(resolve));
    return {
      status: response.status,
      body: response.body ? JSON.parse(response.body) as unknown : {},
    };
  }

  it('records the content-free companion notice before revealing for a fleet principal', async () => {
    const memoryService = makeMemoryService();
    const recordMemoryReveal = vi.fn(() => undefined);
    const reason = 'Triage a welfare report that names this memory';

    const result = await invokeFleetReveal({
      memoryId: 'mem-1',
      body: { reason },
      memoryService,
      subjectAudit: { recordMemoryReveal },
    });

    expect(result.status).toBe(200);
    expect(recordMemoryReveal).toHaveBeenCalledWith({
      context: expect.objectContaining({
        kind: 'fleet_principal',
        resource: expect.objectContaining({
          routeId: 'POST /api/admin/memory/:id/reveal',
          pathParams: { id: 'mem-1' },
        }),
      }),
      reason,
    });
    // The notice is recorded before the body is disclosed (fail closed).
    const auditCall = recordMemoryReveal.mock.invocationCallOrder[0];
    const revealCall = memoryService.revealMemory.mock.invocationCallOrder[0];
    expect(auditCall).toBeDefined();
    expect(revealCall).toBeDefined();
    expect(auditCall).toBeLessThan(revealCall);
  });

  it('fails closed before the reveal when the reason is missing for a fleet principal', async () => {
    const memoryService = makeMemoryService();
    const result = await invokeFleetReveal({
      memoryId: 'mem-1',
      body: {},
      memoryService,
      subjectAudit: { recordMemoryReveal: vi.fn() },
    });
    expect(result.status).toBe(400);
    expect(memoryService.revealMemory).not.toHaveBeenCalled();
  });

  it('fails closed before the reveal when the subject-visible audit sink is unavailable', async () => {
    const memoryService = makeMemoryService();
    const result = await invokeFleetReveal({
      memoryId: 'mem-1',
      body: { reason: 'A valid reason' },
      memoryService,
      subjectAudit: { recordMemoryReveal: vi.fn(() => { throw new Error('audit unavailable'); }) },
    });
    expect(result.status).toBe(503);
    expect(memoryService.revealMemory).not.toHaveBeenCalled();
  });

  it('skips the fleet notice and reveals directly for a standalone operator session', async () => {
    const memoryService = makeMemoryService();
    const recordMemoryReveal = vi.fn();
    const routes = buildAdminMemoryRoutes({
      memoryService,
      subjectAuditService: { recordMemoryReveal } as unknown as AdminSubjectVisibleAuditService,
      withBody: (_req, _res, callback) => callback('{}'),
    });
    const path = '/api/admin/memory/mem-1/reveal';
    const route = routes.find(candidate => candidate.method === 'POST' && candidate.match(path))!;
    const response = new CapturingResponse();
    route.handle(makeRequest(path, '{}'), response as unknown as ServerResponse, { id: 'mem-1' }, undefined);
    await new Promise(resolve => setImmediate(resolve));
    expect(response.status).toBe(200);
    expect(recordMemoryReveal).not.toHaveBeenCalled();
    expect(memoryService.revealMemory).toHaveBeenCalledWith('mem-1');
  });

  it('fails closed before the reveal when the subject-visible audit service is not wired', async () => {
    const memoryService = makeMemoryService();
    const result = await invokeFleetReveal({
      memoryId: 'mem-1',
      body: { reason: 'A valid reason' },
      memoryService,
    });
    expect(result.status).toBe(503);
    expect(memoryService.revealMemory).not.toHaveBeenCalled();
  });
});
