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

let nextRequestBody = '';

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
    withBody: (_req, _res, cb) => cb(nextRequestBody),
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
  nextRequestBody = '';
  route!.handle(makeRequest(url), response as unknown as ServerResponse, route!.match(path) ?? {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

async function invokePost(
  routes: AdminApiRoute[],
  url: string,
  body: unknown,
): Promise<CapturingResponse> {
  const path = new URL(url, 'http://localhost').pathname;
  const route = routes.find(candidate => candidate.method === 'POST' && candidate.match(path));
  expect(route).toBeDefined();
  const response = new CapturingResponse();
  nextRequestBody = JSON.stringify(body);
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
    listWikiScopes: vi.fn(async () => ({
      boundary: 'Wiki/reference knowledge is workspace-backed durable reference material, separate from L0/L0.1/L2 memory.',
      scopes: [
        { scope: 'personal', displayName: 'Personal (companion)', documentCount: 1 },
        { scope: 'shared_world:home', siteId: 'home', displayName: 'Home (shared world)', documentCount: 2 },
      ],
    })),
    listSharedWorldWikiDocuments: vi.fn(async (siteId: string) => ({
      scope: `shared_world:${siteId}` as const,
      siteId,
      roots: {
        wikiRoot: `/system-data/shared-world/wiki/sites/${siteId}`,
        documentsDir: `/system-data/shared-world/wiki/sites/${siteId}/documents`,
        metadataDir: `/system-data/shared-world/wiki/sites/${siteId}/metadata`,
      },
      boundary: 'Wiki/reference knowledge is workspace-backed durable reference material, separate from L0/L0.1/L2 memory.',
      documents: [{
        schemaVersion: 1,
        id: 'site-overview',
        title: 'Home — World Overview',
        bodyPath: 'documents/site-overview.md',
        bodyFormat: 'markdown',
        tags: ['generated:places', 'site:home', 'overview'],
        sourceClass: 'system_seed',
        provenanceRefs: [],
        sensitivity: 'personal',
        scope: `shared_world:${siteId}` as const,
        createdAt: '2026-07-08T00:00:00.000Z',
        updatedAt: '2026-07-08T00:00:00.000Z',
        updatedBy: 'places-wiki-publisher',
        version: 1,
        bodySha256: 'sha256',
        preview: 'Browsable world overview for Home.',
        bodyCharCount: 40,
      }],
    })),
    getSharedWorldWikiDocument: vi.fn(async (_siteId: string, id: string) => (id === 'site-overview'
      ? {
        schemaVersion: 1 as const,
        id,
        title: 'Home — World Overview',
        bodyPath: 'documents/site-overview.md',
        bodyFormat: 'markdown' as const,
        tags: ['generated:places'],
        sourceClass: 'system_seed' as const,
        provenanceRefs: [],
        sensitivity: 'personal' as const,
        scope: 'shared_world:home' as const,
        createdAt: '2026-07-08T00:00:00.000Z',
        updatedAt: '2026-07-08T00:00:00.000Z',
        updatedBy: 'places-wiki-publisher',
        version: 1,
        bodySha256: 'sha256',
        body: 'World overview body.',
      }
      : null)),
    publishSharedWorldSite: vi.fn(async (siteId: string) => ({
      siteId,
      created: ['site-overview', 'place-kitchen'],
      updated: [],
      unchanged: [],
      deleted: [],
    })),
    importSharedWorldDirectory: vi.fn(async (siteId: string, request) => ({
      directory: request.directory,
      scope: `shared_world:${siteId}` as const,
      personalFactGuard: true,
      imported: [{ file: 'kitchen.md', id: 'kitchen', title: 'Kitchen' }],
      rejected: [{ file: 'partner.md', reason: 'contains a first-person relational marker (personal fact)' }],
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

describe('wiki admin API scope delineation (vinz.28)', () => {
  it('enumerates scopes and resolves personal scope on document metadata', async () => {
    const wikiService = makeWikiService();
    const routes = makeRoutes(wikiService);

    const scopes = await invokeRoute(routes, '/api/admin/wiki/scopes');
    expect(scopes.status).toBe(200);
    expect(JSON.parse(scopes.body)).toMatchObject({
      scopes: [
        expect.objectContaining({ scope: 'personal' }),
        expect.objectContaining({ scope: 'shared_world:home', siteId: 'home' }),
      ],
    });

    // The personal list route resolves scope explicitly on each entry.
    const list = await invokeRoute(routes, '/api/admin/wiki');
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body).documents[0]).toMatchObject({ id: 'garden-boundary' });
  });

  it('filters the list by a shared_world scope and reads a shared doc', async () => {
    const wikiService = makeWikiService();
    const routes = makeRoutes(wikiService);

    const filtered = await invokeRoute(routes, '/api/admin/wiki?scope=shared_world:home');
    expect(filtered.status).toBe(200);
    expect(wikiService.listSharedWorldWikiDocuments).toHaveBeenCalledWith('home');
    expect(JSON.parse(filtered.body)).toMatchObject({
      scope: 'shared_world:home',
      siteId: 'home',
      documents: [expect.objectContaining({ id: 'site-overview', scope: 'shared_world:home' })],
    });

    const sharedList = await invokeRoute(routes, '/api/admin/wiki/shared-world/home');
    expect(sharedList.status).toBe(200);
    expect(JSON.parse(sharedList.body).siteId).toBe('home');

    const sharedDoc = await invokeRoute(routes, '/api/admin/wiki/shared-world/home?id=site-overview');
    expect(sharedDoc.status).toBe(200);
    expect(wikiService.getSharedWorldWikiDocument).toHaveBeenCalledWith('home', 'site-overview');
    expect(JSON.parse(sharedDoc.body)).toMatchObject({ id: 'site-overview', scope: 'shared_world:home' });
  });

  it('runs publication and personal-fact-guarded import through admin routes', async () => {
    const wikiService = makeWikiService();
    const routes = makeRoutes(wikiService);

    const publish = await invokePost(routes, '/api/admin/wiki/shared-world/home/publish', {});
    expect(publish.status).toBe(200);
    expect(wikiService.publishSharedWorldSite).toHaveBeenCalledWith('home');
    expect(JSON.parse(publish.body)).toMatchObject({ siteId: 'home', created: ['site-overview', 'place-kitchen'] });

    const importResp = await invokePost(routes, '/api/admin/wiki/shared-world/home/import', {
      directory: '/tmp/world-notes',
      dryRun: true,
    });
    expect(importResp.status).toBe(200);
    expect(wikiService.importSharedWorldDirectory).toHaveBeenCalledWith('home', {
      directory: '/tmp/world-notes',
      dryRun: true,
    });
    expect(JSON.parse(importResp.body)).toMatchObject({
      imported: [expect.objectContaining({ file: 'kitchen.md' })],
      rejected: [expect.objectContaining({ file: 'partner.md' })],
    });
  });

  it('rejects an import with no directory', async () => {
    const routes = makeRoutes(makeWikiService());
    const bad = await invokePost(routes, '/api/admin/wiki/shared-world/home/import', { dryRun: true });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('directory (string) is required');
  });
});
