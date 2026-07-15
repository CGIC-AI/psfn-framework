import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type {
  AdminChargeCostReconciliationService,
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

function makeRoutes(service?: AdminChargeCostReconciliationService | null): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config: { companionId: 'companion-a' } as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    imagesService: {} as AdminImagesService,
    chargeCostReconciliationService: service,
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

async function invoke(route: AdminApiRoute, url: string): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  route.handle({ url, headers: { host: 'localhost' } } as IncomingMessage, response as unknown as ServerResponse, {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('charge-cost reconciliation admin API route', () => {
  it('returns the operator reconciliation with strict filters and no-store headers', async () => {
    const getChargeCostReconciliation = vi.fn(async query => ({ query }));
    const route = makeRoutes({ getChargeCostReconciliation } as AdminChargeCostReconciliationService)
      .find(candidate => candidate.match('/api/admin/charge-costs'));
    expect(route).toBeDefined();

    const response = await invoke(
      route!,
      '/api/admin/charge-costs?sinceMs=100&untilMs=200&companionId=companion-a'
        + '&channelId=channel-a&lane=interactive&surface=externalModelConsult&runId=run-a&rootRunId=root-a',
    );

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(getChargeCostReconciliation).toHaveBeenCalledWith({
      sinceMs: 100,
      untilMs: 200,
      companionId: 'companion-a',
      channelId: 'channel-a',
      lane: 'interactive',
      surface: 'externalModelConsult',
      runId: 'run-a',
      rootRunId: 'root-a',
    });
  });

  it('rejects malformed and cross-tenant queries before calling the service', async () => {
    const getChargeCostReconciliation = vi.fn();
    const route = makeRoutes({ getChargeCostReconciliation } as AdminChargeCostReconciliationService)
      .find(candidate => candidate.match('/api/admin/charge-costs'))!;

    expect((await invoke(route, '/api/admin/charge-costs?lane=free')).status).toBe(400);
    expect((await invoke(route, '/api/admin/charge-costs?companionId=companion-b')).status).toBe(403);
    expect(getChargeCostReconciliation).not.toHaveBeenCalled();
  });

  it('reports canonical reconciliation as unavailable without both ledgers', async () => {
    const route = makeRoutes(null).find(candidate => candidate.match('/api/admin/charge-costs'))!;
    const response = await invoke(route, '/api/admin/charge-costs');
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'Charge-cost reconciliation unavailable' });
  });
});
