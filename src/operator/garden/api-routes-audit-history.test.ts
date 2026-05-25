import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type {
  AdminAuditHistoryService,
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
  return {
    url,
    headers: {
      host: 'localhost',
    },
  } as IncomingMessage;
}

function makeRoutes(auditHistoryService?: AdminAuditHistoryService | null): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config: {} as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    imagesService: {} as AdminImagesService,
    auditHistoryService,
    shardFoldReviewService: {} as AdminShardFoldReviewService,
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

async function invokeAuditRoute(
  route: AdminApiRoute,
  url: string,
): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  route.handle(makeRequest(url), response as unknown as ServerResponse, {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('audit history admin API route', () => {
  it('returns persistent audit history with filters and paging', async () => {
    const service: AdminAuditHistoryService = {
      appendGardenEntry: vi.fn() as AdminAuditHistoryService['appendGardenEntry'],
      getAuditHistory: vi.fn(async query => {
        const filters = {
          actionType: query?.actionType ?? 'all',
          decision: query?.decision ?? 'all',
          timeRange: query?.timeRange ?? '24h',
          source: query?.source ?? 'all',
          limit: query?.limit ?? 100,
          offset: query?.offset ?? 0,
          ...(query?.query ? { query: query.query } : {}),
        };
        return {
          entries: [],
          filters,
          pagination: {
            limit: query?.limit ?? 100,
            offset: query?.offset ?? 0,
            total: 0,
            hasPrevious: false,
            hasNext: false,
          },
          sources: {
            garden: { available: true, count: 0 },
            gateway: { available: true, count: 0 },
            charge: { available: true, count: 0 },
          },
        };
      }),
    };
    const route = makeRoutes(service).find(candidate => candidate.match('/api/admin/audit/history'));
    expect(route).toBeDefined();

    const response = await invokeAuditRoute(
      route!,
      '/api/admin/audit/history?actionType=settings_change&decision=allowed&timeRange=7d&source=garden&query=models&limit=25&offset=50',
    );

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(service.getAuditHistory).toHaveBeenCalledWith({
      actionType: 'settings_change',
      decision: 'allowed',
      timeRange: '7d',
      source: 'garden',
      query: 'models',
      limit: 25,
      offset: 50,
    });
  });

  it('rejects invalid audit history filters', async () => {
    const service: AdminAuditHistoryService = {
      appendGardenEntry: vi.fn() as AdminAuditHistoryService['appendGardenEntry'],
      getAuditHistory: vi.fn(),
    };
    const route = makeRoutes(service).find(candidate => candidate.match('/api/admin/audit/history'));
    expect(route).toBeDefined();

    const response = await invokeAuditRoute(route!, '/api/admin/audit/history?actionType=unknown');

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toContain('Invalid actionType query parameter');
    expect(service.getAuditHistory).not.toHaveBeenCalled();
  });

  it('reports audit history as unavailable when the service is absent', async () => {
    const route = makeRoutes(null).find(candidate => candidate.match('/api/admin/audit/history'));
    expect(route).toBeDefined();

    const response = await invokeAuditRoute(route!, '/api/admin/audit/history');

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Audit history backend unavailable',
    });
  });
});
