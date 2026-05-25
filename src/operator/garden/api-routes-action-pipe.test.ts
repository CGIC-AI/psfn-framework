import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type { AdminChatBootstrapApi } from './admin-contract.js';
import type {
  AdminActionPipeService,
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
import type { PostTurnActionQueueStatus } from '../../core/agent/post-turn-action-runtime.js';

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

function makeStatus(): PostTurnActionQueueStatus {
  return {
    timestamp: 1,
    processing: false,
    queueDepth: 0,
    maxQueueDepth: 4,
    availableSlots: 4,
    saturated: false,
    readyCount: 0,
    scheduledCount: 0,
    retryScheduledCount: 0,
    runningCount: 0,
    lanes: [],
    queued: [],
    backPressure: {
      droppedCount: 0,
      recentDrops: [],
    },
    failures: {
      failedCount: 0,
      recentFailures: [],
    },
    terminal: {
      cancelledCount: 0,
      acknowledgedCount: 0,
      recentTerminals: [],
    },
    completions: {
      completedCount: 0,
      recentCompletions: [],
    },
    quarantine: {
      count: 0,
      persisted: true,
      entries: [],
    },
    persistence: {
      enabled: true,
      loadState: 'loaded',
      loadedEntries: 0,
      quarantinedEntries: 0,
      quarantinePersisted: true,
    },
  };
}

function makeRoutes(actionPipeService?: AdminActionPipeService | null): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config: {} as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    imagesService: {} as AdminImagesService,
    actionPipeService,
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
  route: AdminApiRoute,
  url: string,
  body = '{}',
): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  const params = route.match(new URL(url, 'http://localhost').pathname);
  route.handle(makeRequest(url, body), response as unknown as ServerResponse, params ?? {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('action pipe admin API routes', () => {
  it('returns runtime queue status', async () => {
    const status = makeStatus();
    const service: AdminActionPipeService = {
      getActionPipeStatus: vi.fn(async () => status),
      cancelAction: vi.fn(),
      acknowledgeAction: vi.fn(),
    };
    const route = makeRoutes(service).find(candidate => candidate.match('/api/admin/action-pipe'));
    expect(route).toBeDefined();

    const response = await invokeRoute(route!, '/api/admin/action-pipe');

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(response.body)).toEqual(status);
  });

  it('cancels actions by route action reference', async () => {
    const status = makeStatus();
    const service: AdminActionPipeService = {
      getActionPipeStatus: vi.fn(),
      cancelAction: vi.fn(async () => ({
        ok: true,
        message: 'Action cancelled.',
        status,
      })),
      acknowledgeAction: vi.fn(),
    };
    const route = makeRoutes(service).find(candidate => candidate.match('/api/admin/action-pipe/actions/action-1/cancel'));
    expect(route).toBeDefined();

    const response = await invokeRoute(
      route!,
      '/api/admin/action-pipe/actions/action-1/cancel',
      '{"reason":"operator stop"}',
    );

    expect(response.status).toBe(200);
    expect(service.cancelAction).toHaveBeenCalledWith({
      actionRef: 'action-1',
      reason: 'operator stop',
    });
    expect(JSON.parse(response.body).ok).toBe(true);
  });

  it('reports the action pipe route as unavailable when the service is absent', async () => {
    const route = makeRoutes(null).find(candidate => candidate.match('/api/admin/action-pipe'));
    expect(route).toBeDefined();

    const response = await invokeRoute(route!, '/api/admin/action-pipe');

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Action pipe backend unavailable',
    });
  });
});
