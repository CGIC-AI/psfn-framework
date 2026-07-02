import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { buildAdminMemoryRoutes } from './api-routes-memory.js';
import type { AdminApiRoute } from './routes/types.js';
import type { AdminMemoryService } from './services/types.js';

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

function makeRequest(url: string, body = ''): IncomingMessage {
  return {
    url,
    headers: { host: 'localhost' },
    body,
  } as IncomingMessage;
}

function makeMemoryService(overrides: Partial<AdminMemoryService> = {}): AdminMemoryService {
  return {
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
  };
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

  it('validates and dispatches the optional memory patch sub-route', async () => {
    const patchMemory = vi.fn(async (
      _memoryId: string,
      _fields: { text: string; reason?: string; referencePath?: string },
    ) => ({ ok: true }));
    const memoryService = makeMemoryService() as AdminMemoryService & {
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

  it('fails closed when memory patching is not implemented by the service', async () => {
    const routes = makeRoutes(makeMemoryService());

    const response = await invokeRoute(
      routes,
      'PATCH',
      '/api/admin/memory/mem-1/patch',
      JSON.stringify({ text: 'Updated memory text.' }),
    );
    expect(response.status).toBe(400);
    expect(parseBody(response).error).toBe('Memory patching is not available');
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
    }) as AdminMemoryService & { patchMemory: typeof patchMemory };
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
    }) as AdminMemoryService & { patchMemory: typeof patchMemory };
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
