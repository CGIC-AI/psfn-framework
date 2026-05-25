import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type {
  AdminChargeLedgerService,
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

function makeRoutes(chargeLedgerService?: AdminChargeLedgerService | null): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config: {} as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    imagesService: {} as AdminImagesService,
    chargeLedgerService,
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

async function invokeChargeRoute(
  route: AdminApiRoute,
  url: string,
): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  route.handle(makeRequest(url), response as unknown as ServerResponse, {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('charge ledger admin API route', () => {
  it('returns charge ledger data with query filters', async () => {
    const service: AdminChargeLedgerService = {
      getChargeLedgerData: vi.fn(async query => ({
        activeRun: null,
        recentRuns: [],
        aggregates: {
          amount: 0,
          eventCount: 0,
          byLane: [],
          bySurface: [],
          byLineage: [],
        },
        events: [],
        query,
      })),
    } as AdminChargeLedgerService;
    const route = makeRoutes(service).find(candidate => candidate.match('/api/admin/charges'));
    expect(route).toBeDefined();

    const response = await invokeChargeRoute(
      route!,
      '/api/admin/charges?limit=5&sinceMs=100&untilMs=200&runId=run-a',
    );

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(service.getChargeLedgerData).toHaveBeenCalledWith({
      limit: 5,
      sinceMs: 100,
      untilMs: 200,
      runId: 'run-a',
    });
  });

  it('rejects malformed charge ledger query parameters', async () => {
    const service: AdminChargeLedgerService = {
      getChargeLedgerData: vi.fn(),
    };
    const route = makeRoutes(service).find(candidate => candidate.match('/api/admin/charges'));
    expect(route).toBeDefined();

    const response = await invokeChargeRoute(route!, '/api/admin/charges?limit=0');

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Invalid limit query parameter. Expected a positive integer.',
    });
    expect(service.getChargeLedgerData).not.toHaveBeenCalled();
  });

  it('reports the charge ledger route as unavailable when the service is absent', async () => {
    const route = makeRoutes(null).find(candidate => candidate.match('/api/admin/charges'));
    expect(route).toBeDefined();

    const response = await invokeChargeRoute(route!, '/api/admin/charges');

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Charge ledger backend unavailable',
    });
  });
});
