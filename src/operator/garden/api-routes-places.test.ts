import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
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
import type { AdminPlacesService } from './services/places-service.js';
import type { AdminChatBootstrapApi } from './admin-contract.js';

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

function makeRequest(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost' } } as IncomingMessage;
}

const MERMAID = 'flowchart TB\n  empty["No places configured"]\n';

function makeRoutes(placesService: AdminPlacesService | null): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config: {} as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    imagesService: {} as AdminImagesService,
    shardFoldReviewService: {} as AdminShardFoldReviewService,
    memoryService: {} as AdminMemoryService,
    sessionService: {} as AdminSessionService,
    contactsService: {} as AdminContactsService,
    settingsService: {} as AdminSettingsService,
    identityService: {} as AdminIdentityService,
    promptsService: {} as AdminPromptsService,
    chatBootstrapService: {} as AdminChatBootstrapApi,
    placesService,
    withBody: () => {},
  });
}

async function invokeRoute(route: AdminApiRoute, url: string): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  route.handle(makeRequest(url), response as unknown as ServerResponse, {});
  await new Promise((resolve) => setImmediate(resolve));
  return response;
}

describe('places map admin API route', () => {
  it('returns the rendered Mermaid map with no-store caching', async () => {
    const placesService: AdminPlacesService = {
      listPlaces: () => Promise.reject(new Error('unused')),
      rebindSatellite: () => Promise.reject(new Error('unused')),
      renderMermaidMap: () => Promise.resolve(MERMAID),
    };

    const route = makeRoutes(placesService)
      .find((candidate) => candidate.method === 'GET' && candidate.match('/api/admin/places/map'));
    expect(route).toBeDefined();

    const response = await invokeRoute(route!, '/api/admin/places/map');
    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(response.body)).toEqual({ mermaid: MERMAID });
  });

  it('surfaces a sanitized 500 when rendering fails', async () => {
    const placesService: AdminPlacesService = {
      listPlaces: () => Promise.reject(new Error('unused')),
      rebindSatellite: () => Promise.reject(new Error('unused')),
      renderMermaidMap: () => Promise.reject(new Error('boom')),
    };

    const route = makeRoutes(placesService)
      .find((candidate) => candidate.method === 'GET' && candidate.match('/api/admin/places/map'));
    const response = await invokeRoute(route!, '/api/admin/places/map');
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toHaveProperty('error');
  });

  it('does not mount the map route when no places service is wired', () => {
    const route = makeRoutes(null)
      .find((candidate) => candidate.method === 'GET' && candidate.match('/api/admin/places/map'));
    expect(route).toBeUndefined();
  });
});
