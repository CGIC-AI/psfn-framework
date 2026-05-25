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
} from './services/types.js';

class CapturingResponse {
  status = 0;
  headers: Record<string, string | number> = {};
  body: Buffer | string = '';

  writeHead(status: number, headers?: Record<string, string | number>): this {
    this.status = status;
    this.headers = headers ?? {};
    return this;
  }

  end(body?: string | Buffer): this {
    this.body = body ?? '';
    return this;
  }
}

function makeRequest(url: string, body = '{}'): IncomingMessage {
  return {
    url,
    headers: {
      host: 'localhost',
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'data') listener(body);
      if (event === 'end') listener();
      return this;
    },
  } as IncomingMessage;
}

function makeImagesService(): AdminImagesService {
  return {
    listGeneratedImages: vi.fn(async () => ({
      roots: [{ kind: 'personal', path: '/workspace/images' }],
      images: [{
        id: 'img-1',
        url: '/api/admin/images/generated/img-1/blob',
        rootKind: 'personal',
        relativePath: '2026-05-24/image.png',
        fileName: 'image.png',
        contentType: 'image/png',
        sizeBytes: 4,
        createdAt: '2026-05-24T00:00:00.000Z',
        updatedAt: '2026-05-24T00:00:00.000Z',
        sourceToolName: 'selfie_create',
      }],
    })),
    getGeneratedImageBlob: vi.fn(async () => ({
      fileName: 'image.png',
      contentType: 'image/png',
      data: Buffer.from([1, 2, 3, 4]),
    })),
    listReferencePhotos: vi.fn(async () => ({
      defaultReferenceId: 'ref-1',
      references: [{
        id: 'ref-1',
        fileName: 'ref.png',
        contentType: 'image/png',
        description: 'default reference',
        tags: ['default'],
        sizeBytes: 4,
        createdAt: '2026-05-24T00:00:00.000Z',
        updatedAt: '2026-05-24T00:00:00.000Z',
        isDefault: true,
      }],
    })),
    addReferencePhoto: vi.fn(),
    updateReferencePhoto: vi.fn(async id => ({
      id,
      fileName: 'ref.png',
      contentType: 'image/png',
      description: 'updated reference',
      tags: ['updated'],
      sizeBytes: 4,
      createdAt: '2026-05-24T00:00:00.000Z',
      updatedAt: '2026-05-24T01:00:00.000Z',
      isDefault: true,
    })),
    deleteReferencePhoto: vi.fn(async () => {}),
    setDefaultReferencePhoto: vi.fn(async id => ({
      id,
      fileName: 'ref.png',
      contentType: 'image/png',
      description: 'default reference',
      tags: ['default'],
      sizeBytes: 4,
      createdAt: '2026-05-24T00:00:00.000Z',
      updatedAt: '2026-05-24T00:00:00.000Z',
      isDefault: true,
    })),
    getReferencePhotoBlob: vi.fn(async () => ({
      id: 'ref-1',
      fileName: 'ref.png',
      contentType: 'image/png',
      data: Buffer.from([5, 6, 7, 8]),
    })),
  };
}

function makeRoutes(imagesService: AdminImagesService): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config: {} as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    imagesService,
    shardFoldReviewService: {} as AdminShardFoldReviewService,
    memoryService: {} as AdminMemoryService,
    sessionService: {} as AdminSessionService,
    contactsService: {} as AdminContactsService,
    settingsService: {} as AdminSettingsService,
    identityService: {} as AdminIdentityService,
    promptsService: {} as AdminPromptsService,
    chatBootstrapService: {} as AdminChatBootstrapApi,
    withBody: (req, _res, cb) => {
      let body = '';
      req.on('data', chunk => {
        body += String(chunk);
      });
      req.on('end', () => cb(body));
    },
  });
}

async function invokeRoute(
  routes: AdminApiRoute[],
  method: AdminApiRoute['method'],
  url: string,
  body = '{}',
): Promise<CapturingResponse> {
  const path = new URL(url, 'http://localhost').pathname;
  const route = routes.find(candidate => candidate.method === method && candidate.match(path));
  expect(route).toBeDefined();
  const response = new CapturingResponse();
  route!.handle(makeRequest(url, body), response as unknown as ServerResponse, route!.match(path) ?? {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('image admin API routes', () => {
  it('serves generated image metadata and image blobs behind admin routes', async () => {
    const imagesService = makeImagesService();
    const routes = makeRoutes(imagesService);

    const listResponse = await invokeRoute(routes, 'GET', '/api/admin/images/generated');
    expect(listResponse.status).toBe(200);
    expect(JSON.parse(String(listResponse.body))).toMatchObject({
      images: [expect.objectContaining({ sourceToolName: 'selfie_create' })],
    });

    const blobResponse = await invokeRoute(routes, 'GET', '/api/admin/images/generated/img-1/blob');
    expect(blobResponse.status).toBe(200);
    expect(blobResponse.headers['Content-Type']).toBe('image/png');
    expect(blobResponse.body).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('serves and updates identity reference photo records', async () => {
    const imagesService = makeImagesService();
    const routes = makeRoutes(imagesService);

    const listResponse = await invokeRoute(routes, 'GET', '/api/admin/image-references');
    expect(listResponse.status).toBe(200);
    expect(JSON.parse(String(listResponse.body))).toMatchObject({
      defaultReferenceId: 'ref-1',
      references: [expect.objectContaining({ tags: ['default'] })],
    });

    const patchResponse = await invokeRoute(
      routes,
      'PATCH',
      '/api/admin/image-references/ref-1',
      JSON.stringify({ description: 'updated reference', tags: ['updated'] }),
    );
    expect(patchResponse.status).toBe(200);
    expect(imagesService.updateReferencePhoto).toHaveBeenCalledWith('ref-1', {
      description: 'updated reference',
      tags: ['updated'],
    });
    expect(JSON.parse(String(patchResponse.body))).toMatchObject({
      ok: true,
      reference: expect.objectContaining({ description: 'updated reference' }),
    });
  });
});
