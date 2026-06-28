import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type { AdminChatBootstrapApi } from './admin-contract.js';
import type {
  AdminContactsService,
  AdminDashboardService,
  AdminImagesService,
  AdminIdentityService,
  AdminMemoryService,
  AdminPromptsService,
  AdminSessionService,
  AdminSettingsService,
  AdminShardFoldReviewService,
  AdminWikiService,
} from './services/types.js';

class CapturingResponse {
  status = 0;
  headers: Record<string, string | number> = {};
  body = '';

  writeHead(status: number, headers?: Record<string, string | number>): this {
    this.status = status;
    this.headers = headers ?? {};
    return this;
  }

  end(body?: string): this {
    this.body = body ?? '';
    return this;
  }
}

function makeRequest(url: string): IncomingMessage {
  return {
    url,
    headers: {
      host: 'localhost',
    },
  } as IncomingMessage;
}

function makeRoutes(wikiService?: AdminWikiService | null): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config: {} as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    imagesService: {} as AdminImagesService,
    shardFoldReviewService: {} as AdminShardFoldReviewService,
    wikiService,
    memoryService: {} as AdminMemoryService,
    sessionService: {} as AdminSessionService,
    contactsService: {} as AdminContactsService,
    settingsService: {} as AdminSettingsService,
    identityService: {} as AdminIdentityService,
    promptsService: {} as AdminPromptsService,
    chatBootstrapService: {} as AdminChatBootstrapApi,
    withBody: () => {},
  });
}

async function invokeRoute(
  routes: AdminApiRoute[],
  url: string,
): Promise<CapturingResponse> {
  const path = new URL(url, 'http://localhost').pathname;
  const route = routes.find(candidate => candidate.method === 'GET' && candidate.match(path));
  expect(route).toBeDefined();
  const response = new CapturingResponse();
  route!.handle(makeRequest(url), response as unknown as ServerResponse, route!.match(path) ?? {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

function makeWikiService(): AdminWikiService {
  return {
    listWikiDocuments: vi.fn(async () => ({
      roots: {
        workspaceRoot: '/workspace',
        wikiRoot: '/workspace/knowledge/wiki',
        documentsDir: '/workspace/knowledge/wiki/documents',
        metadataDir: '/workspace/knowledge/wiki/metadata',
      },
      boundary: 'Wiki/reference knowledge is workspace-backed durable reference material, separate from L0/L0.1/L2 memory.',
      documents: [{
        schemaVersion: 1,
        id: 'garden-boundary',
        title: 'Garden Boundary',
        bodyPath: 'documents/garden-boundary.md',
        bodyFormat: 'markdown',
        tags: ['garden', 'wiki'],
        sourceClass: 'operator_authored_note',
        provenanceRefs: [],
        sensitivity: 'personal',
        createdAt: '2026-06-28T00:00:00.000Z',
        updatedAt: '2026-06-28T01:00:00.000Z',
        updatedBy: 'operator',
        version: 1,
        bodySha256: 'sha256',
        preview: 'Wiki stays separate from memory.',
        bodyCharCount: 32,
      }],
    })),
    getWikiDocument: vi.fn(async id => (id === 'garden-boundary'
      ? {
        schemaVersion: 1,
        id,
        title: 'Garden Boundary',
        bodyPath: 'documents/garden-boundary.md',
        bodyFormat: 'markdown',
        tags: ['garden', 'wiki'],
        sourceClass: 'operator_authored_note',
        provenanceRefs: [],
        sensitivity: 'personal',
        createdAt: '2026-06-28T00:00:00.000Z',
        updatedAt: '2026-06-28T01:00:00.000Z',
        updatedBy: 'operator',
        version: 1,
        bodySha256: 'sha256',
        body: 'Wiki stays separate from memory.',
      }
      : null)),
    searchWikiDocuments: vi.fn(async query => ({
      query: query.query,
      count: 1,
      matches: [{
        id: 'garden-boundary',
        title: 'Garden Boundary',
        sourceClass: 'operator_authored_note',
        sensitivity: 'personal',
        path: 'documents/garden-boundary.md',
        preview: 'Wiki stays separate from memory.',
      }],
    })),
  };
}

describe('wiki admin API routes', () => {
  it('serves wiki list, read, and search routes with boundary metadata', async () => {
    const wikiService = makeWikiService();
    const routes = makeRoutes(wikiService);

    const listResponse = await invokeRoute(routes, '/api/admin/wiki');
    expect(listResponse.status).toBe(200);
    expect(JSON.parse(listResponse.body)).toMatchObject({
      boundary: expect.stringContaining('separate from L0/L0.1/L2 memory'),
      roots: { wikiRoot: '/workspace/knowledge/wiki' },
      documents: [expect.objectContaining({ id: 'garden-boundary' })],
    });

    const readResponse = await invokeRoute(routes, '/api/admin/wiki/garden-boundary');
    expect(readResponse.status).toBe(200);
    expect(JSON.parse(readResponse.body)).toMatchObject({
      id: 'garden-boundary',
      body: expect.stringContaining('separate from memory'),
    });

    const searchResponse = await invokeRoute(routes, '/api/admin/wiki/search?query=memory&limit=12');
    expect(searchResponse.status).toBe(200);
    expect(wikiService.searchWikiDocuments).toHaveBeenCalledWith({ query: 'memory', limit: 12 });
    expect(JSON.parse(searchResponse.body)).toMatchObject({
      query: 'memory',
      matches: [expect.objectContaining({ id: 'garden-boundary' })],
    });
  });

  it('fails closed for invalid wiki route inputs and unavailable backend', async () => {
    const routes = makeRoutes(makeWikiService());

    const emptyQuery = await invokeRoute(routes, '/api/admin/wiki/search');
    expect(emptyQuery.status).toBe(400);
    expect(JSON.parse(emptyQuery.body).error).toBe('query is required');

    const missing = await invokeRoute(routes, '/api/admin/wiki/missing-doc');
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error).toBe('Wiki document not found');

    const unavailable = await invokeRoute(makeRoutes(null), '/api/admin/wiki');
    expect(unavailable.status).toBe(503);
    expect(JSON.parse(unavailable.body)).toEqual({ error: 'Wiki backend unavailable' });
  });
});
