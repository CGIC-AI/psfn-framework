import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { buildAdminMemoryRoutes } from './api-routes-memory.js';
import type { AdminApiRoute } from './routes/types.js';
import type { AdminMemoryService, AdminSharedBackgroundResult } from './services/types.js';

class CapturingResponse {
  status = 0;
  body = '';
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  end(body?: string): this {
    this.body = body ?? '';
    return this;
  }
}

function makeRequest(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost' } } as IncomingMessage;
}

function makeService(
  sharedBackground: AdminMemoryService['sharedBackground'],
): AdminMemoryService {
  return { sharedBackground } as unknown as AdminMemoryService;
}

function routesFor(service: AdminMemoryService): AdminApiRoute[] {
  return buildAdminMemoryRoutes({
    memoryService: service,
    withBody: (req, _res, cb) => cb((req as IncomingMessage & { body?: string }).body ?? ''),
  });
}

async function invoke(routes: AdminApiRoute[], url: string): Promise<CapturingResponse> {
  const path = new URL(url, 'http://localhost').pathname;
  const route = routes.find(candidate => candidate.method === 'GET' && candidate.match(path));
  expect(route, `GET ${path}`).toBeDefined();
  const response = new CapturingResponse();
  route?.handle(makeRequest(url), response as unknown as ServerResponse, route.match(path) ?? {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

const sample: AdminSharedBackgroundResult = {
  contactAId: 'contact-a',
  contactBId: 'contact-b',
  contactADisplayName: 'Ada',
  contactBDisplayName: 'Bosco',
  resolved: true,
  missingContactIds: [],
  items: [{
    memory: { id: 'mem-1', text: '[redacted]', bodyRedacted: true } as never,
    sources: ['edge_evidence'],
    score: 3.4,
  }],
  contactsById: new Map([['contact-a', { id: 'contact-a', displayName: 'Ada' }]]),
  totalCandidates: 1,
  truncated: false,
  limit: 12,
  elevation: { elevated: false, ttlMs: 900_000 },
};

describe('GET /api/admin/memory/shared-background', () => {
  it('forwards a and b and serializes contactsById', async () => {
    const sharedBackground = vi.fn(async () => sample);
    const routes = routesFor(makeService(sharedBackground));

    const response = await invoke(routes, '/api/admin/memory/shared-background?a=contact-a&b=contact-b&limit=5');
    expect(response.status).toBe(200);
    expect(sharedBackground).toHaveBeenCalledWith('contact-a', 'contact-b', 5);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.contactsById).toEqual({ 'contact-a': { id: 'contact-a', displayName: 'Ada' } });
    const items = body.items as Array<{ memory: { bodyRedacted?: boolean }; sources: string[] }>;
    expect(items[0].sources).toEqual(['edge_evidence']);
    // Redaction from the service body gate is carried through unchanged.
    expect(items[0].memory.bodyRedacted).toBe(true);
  });

  it('rejects a request missing a contact id', async () => {
    const sharedBackground = vi.fn(async () => sample);
    const routes = routesFor(makeService(sharedBackground));
    const response = await invoke(routes, '/api/admin/memory/shared-background?a=contact-a');
    expect(response.status).toBe(400);
    expect(sharedBackground).not.toHaveBeenCalled();
  });

  it('rejects identical contacts', async () => {
    const sharedBackground = vi.fn(async () => sample);
    const routes = routesFor(makeService(sharedBackground));
    const response = await invoke(routes, '/api/admin/memory/shared-background?a=x&b=x');
    expect(response.status).toBe(400);
    expect(sharedBackground).not.toHaveBeenCalled();
  });

  it('resolves the exact route ahead of the generic memory-detail route', async () => {
    const routes = routesFor(makeService(vi.fn(async () => sample)));
    // The first GET route matching the literal path must be the exact
    // shared-background route (which does NOT also match an arbitrary id),
    // proving it is registered before the generic /:id route.
    const firstMatch = routes.find(r => r.method === 'GET' && r.match('/api/admin/memory/shared-background'));
    expect(firstMatch).toBeDefined();
    expect(firstMatch?.match('/api/admin/memory/some-random-id')).toBeFalsy();
  });
});
