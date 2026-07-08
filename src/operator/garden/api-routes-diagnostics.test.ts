import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type {
  AdminContactsService,
  AdminDashboardService,
  AdminDiagnosticsService,
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

function makeRoutes(diagnosticsService?: AdminDiagnosticsService | null): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config: {} as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    diagnosticsService,
    imagesService: {} as AdminImagesService,
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

async function invokeDiagnosticsRoute(
  route: AdminApiRoute,
  url: string,
): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  route.handle(makeRequest(url), response as unknown as ServerResponse, {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('diagnostics admin API route', () => {
  it('returns bounded diagnostics with parsed query parameters', async () => {
    const diagnosticsService: AdminDiagnosticsService = {
      getDiagnostics: vi.fn(async query => ({
        schemaVersion: 1,
        generatedAt: 1_700_000_000_000,
        window: {
          sinceMs: 1_699_999_940_000,
          untilMs: 1_700_000_000_000,
          windowMs: query?.windowMs ?? 60_000,
          limit: query?.limit ?? 5,
          includeFileLogs: query?.includeFileLogs ?? false,
          logsDir: '/app/logs',
        },
        sources: [{
          name: 'kubernetes',
          status: 'unavailable',
          reason: 'requires kube surface (x5rt.4)',
        }],
        agentLog: { status: 'available', counts: { warn: 0, error: 0, total: 0 }, records: [] },
        fileLogs: { status: 'unavailable', reason: 'file log diagnostics disabled for this request' },
        toolValidationFailures: { status: 'available', total: 0, byTool: [] },
        lifecycle: { status: 'available', events: [] },
        rollout: { status: 'unavailable', reason: 'requires kube surface (x5rt.4)' },
        pods: { status: 'unavailable', reason: 'requires kube surface (x5rt.4)' },
        backup: {
          status: 'available',
          counts: { success: 0, failure: 0, total: 0 },
          lastSuccess: null,
          lastFailure: null,
          recent: [],
        },
      })),
    };
    const route = makeRoutes(diagnosticsService).find(candidate => candidate.match('/api/admin/diagnostics'));
    expect(route).toBeDefined();

    const response = await invokeDiagnosticsRoute(
      route!,
      '/api/admin/diagnostics?windowMs=60000&limit=5&includeFileLogs=false',
    );

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(diagnosticsService.getDiagnostics).toHaveBeenCalledWith({
      windowMs: 60_000,
      limit: 5,
      includeFileLogs: false,
    });
    expect(JSON.parse(response.body).rollout).toEqual({
      status: 'unavailable',
      reason: 'requires kube surface (x5rt.4)',
    });
  });

  it('rejects invalid diagnostics query parameters', async () => {
    const diagnosticsService: AdminDiagnosticsService = {
      getDiagnostics: vi.fn(),
    };
    const route = makeRoutes(diagnosticsService).find(candidate => candidate.match('/api/admin/diagnostics'));
    expect(route).toBeDefined();

    const response = await invokeDiagnosticsRoute(route!, '/api/admin/diagnostics?includeFileLogs=maybe');

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toContain('Invalid includeFileLogs query parameter');
    expect(diagnosticsService.getDiagnostics).not.toHaveBeenCalled();
  });

  it('reports diagnostics as unavailable when the service is absent', async () => {
    const route = makeRoutes(null).find(candidate => candidate.match('/api/admin/diagnostics'));
    expect(route).toBeDefined();

    const response = await invokeDiagnosticsRoute(route!, '/api/admin/diagnostics');

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Diagnostics backend unavailable',
    });
  });
});
