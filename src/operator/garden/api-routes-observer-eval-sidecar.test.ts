import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type { AdminChatBootstrapApi } from './admin-contract.js';
import {
  ObserverEvalSidecarApiUnavailableError,
  type AdminObserverEvalSidecarService,
} from './services/observer-eval-sidecar-service.js';
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

function makeRoutes(observerEvalSidecarService?: AdminObserverEvalSidecarService | null): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config: {} as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    imagesService: {} as AdminImagesService,
    observerEvalSidecarService,
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

async function invokeRoute(
  route: AdminApiRoute,
  url: string,
): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  route.handle(makeRequest(url), response as unknown as ServerResponse, {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('observer eval sidecar admin API routes', () => {
  it('returns health with no-store headers', async () => {
    const service = makeService({
      getHealth: vi.fn(async () => ({
        status: 'degraded',
        observedAt: 1_780_000_000_000,
        runtime: null,
        persistence: {
          available: true,
          evalOwned: true,
          authoritative: false,
        },
      })),
    });
    const route = makeRoutes(service).find(candidate => candidate.match('/api/admin/evals/observer-sidecar/health'));
    expect(route).toBeDefined();

    const response = await invokeRoute(route!, '/api/admin/evals/observer-sidecar/health');

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'degraded',
      persistence: {
        available: true,
        authoritative: false,
      },
    });
  });

  it('passes observation filters and pagination to the service', async () => {
    const service = makeService({
      queryObservations: vi.fn(async query => ({
        observations: [],
        filters: query ?? {},
        pagination: { limit: query?.limit ?? 100, count: 0, hasMore: false },
      })),
    });
    const route = makeRoutes(service).find(candidate => candidate.match('/api/admin/evals/observer-sidecar/observations'));
    expect(route).toBeDefined();

    const response = await invokeRoute(
      route!,
      '/api/admin/evals/observer-sidecar/observations'
      + '?runId=run-1&evalSessionId=eval-1&scenarioId=scenario-1&testRunId=test-1'
      + '&turnId=turn-1&privacyClass=private&status=degraded&minDivergenceScore=0.4'
      + '&sinceMs=10&untilMs=20&limit=25',
    );

    expect(response.status).toBe(200);
    expect(service.queryObservations).toHaveBeenCalledWith({
      runId: 'run-1',
      evalSessionId: 'eval-1',
      scenarioId: 'scenario-1',
      testRunId: 'test-1',
      turnId: 'turn-1',
      privacyClass: 'private',
      status: 'degraded',
      minDivergenceScore: 0.4,
      sinceMs: 10,
      untilMs: 20,
      limit: 25,
    });
  });

  it('rejects invalid observer filters before calling the service', async () => {
    const service = makeService({
      queryObservations: vi.fn(),
    });
    const route = makeRoutes(service).find(candidate => candidate.match('/api/admin/evals/observer-sidecar/observations'));
    expect(route).toBeDefined();

    const response = await invokeRoute(route!, '/api/admin/evals/observer-sidecar/observations?privacyClass=raw');

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toContain('Invalid privacyClass query parameter');
    expect(service.queryObservations).not.toHaveBeenCalled();
  });

  it('supports latest and redacted export routes', async () => {
    const service = makeService({
      getLatestObservation: vi.fn(async filters => ({
        observation: null,
        filters: filters ?? {},
      })),
      exportObservations: vi.fn(async filters => ({
        exportVersion: 'garden.observer-eval-sidecar.export.v1',
        generatedAtMs: 1,
        redacted: true,
        filters: filters ?? {},
        observations: [],
      })),
    });
    const routes = makeRoutes(service);
    const latest = routes.find(candidate => candidate.match('/api/admin/evals/observer-sidecar/latest'));
    const exportRoute = routes.find(candidate => candidate.match('/api/admin/evals/observer-sidecar/export'));
    expect(latest).toBeDefined();
    expect(exportRoute).toBeDefined();

    const latestResponse = await invokeRoute(latest!, '/api/admin/evals/observer-sidecar/latest?runId=run-1&limit=99');
    const exportResponse = await invokeRoute(exportRoute!, '/api/admin/evals/observer-sidecar/export?limit=5');

    expect(latestResponse.status).toBe(200);
    expect(service.getLatestObservation).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(exportResponse.status).toBe(200);
    expect(JSON.parse(exportResponse.body)).toMatchObject({
      exportVersion: 'garden.observer-eval-sidecar.export.v1',
      redacted: true,
    });
    expect(service.exportObservations).toHaveBeenCalledWith({ limit: 5 });
  });

  it('passes run filters to the service', async () => {
    const service = makeService({
      queryRuns: vi.fn(async filters => ({
        runs: [],
        filters: filters ?? {},
        pagination: { limit: filters?.limit ?? 100, count: 0, hasMore: false },
      })),
    });
    const route = makeRoutes(service).find(candidate => candidate.match('/api/admin/evals/observer-sidecar/runs'));
    expect(route).toBeDefined();

    const response = await invokeRoute(
      route!,
      '/api/admin/evals/observer-sidecar/runs?evalSessionId=eval-1&scenarioId=scenario-1'
      + '&testRunId=test-1&status=completed&sinceMs=1&untilMs=2&limit=12',
    );

    expect(response.status).toBe(200);
    expect(service.queryRuns).toHaveBeenCalledWith({
      evalSessionId: 'eval-1',
      scenarioId: 'scenario-1',
      testRunId: 'test-1',
      status: 'completed',
      sinceMs: 1,
      untilMs: 2,
      limit: 12,
    });
  });

  it('reports observer eval routes as unavailable when service or persistence is absent', async () => {
    const absentRoute = makeRoutes(null).find(candidate => candidate.match('/api/admin/evals/observer-sidecar/health'));
    expect(absentRoute).toBeDefined();

    const absentResponse = await invokeRoute(absentRoute!, '/api/admin/evals/observer-sidecar/health');
    expect(absentResponse.status).toBe(503);
    expect(JSON.parse(absentResponse.body)).toEqual({
      error: 'Observer eval sidecar backend unavailable',
    });

    const service = makeService({
      queryObservations: vi.fn(async () => {
        throw new ObserverEvalSidecarApiUnavailableError('Observer eval sidecar persistence unavailable');
      }),
    });
    const route = makeRoutes(service).find(candidate => candidate.match('/api/admin/evals/observer-sidecar/observations'));
    expect(route).toBeDefined();

    const response = await invokeRoute(route!, '/api/admin/evals/observer-sidecar/observations');
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error).toBe('Observer eval sidecar persistence unavailable');
  });
});

function makeService(
  overrides: Partial<AdminObserverEvalSidecarService> = {},
): AdminObserverEvalSidecarService {
  return {
    getHealth: vi.fn(),
    getLatestObservation: vi.fn(),
    queryObservations: vi.fn(),
    queryRuns: vi.fn(),
    exportObservations: vi.fn(),
    ...overrides,
  } as AdminObserverEvalSidecarService;
}
