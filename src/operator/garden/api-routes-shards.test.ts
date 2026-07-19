import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { GardenRequestContext } from './garden-request-context.js';
import { buildAdminApiRoutes, type AdminApiRoute } from './api-routes.js';
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

function makeRequest(url: string, body = ''): IncomingMessage {
  return {
    url,
    headers: { host: 'localhost' },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'data' && body) listener(body);
      if (event === 'end') listener();
      return this;
    },
  } as IncomingMessage;
}

function context(): GardenRequestContext {
  return {
    kind: 'fleet_principal',
    actor: { kind: 'fleet_principal', principalId: 'operator-a' },
    resource: { companionId: 'companion-a' },
  } as unknown as GardenRequestContext;
}

function routes(service: AdminShardFoldReviewService): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config: {} as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    imagesService: {} as AdminImagesService,
    shardFoldReviewService: service,
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

function service(overrides: Partial<AdminShardFoldReviewService> = {}): AdminShardFoldReviewService {
  return {
    listShardFoldReviews: vi.fn(async () => ({ reviews: [], shards: [] })),
    getShardFoldReview: vi.fn(async () => null),
    resolveShardFoldReview: vi.fn(async () => ({
      ok: false,
      message: 'Shard fold review not found',
    })),
    getShardConfiguration: vi.fn(async () => null),
    updateShardConfiguration: vi.fn(async () => ({
      ok: false,
      code: 'not_found',
      message: 'Shard not found',
    })),
    ...overrides,
  };
}

async function invoke(
  route: AdminApiRoute,
  url: string,
  body = '',
): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  const path = new URL(url, 'http://localhost').pathname;
  route.handle(
    makeRequest(url, body),
    response as unknown as ServerResponse,
    route.match(path) ?? {},
    context(),
  );
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('shard configuration admin routes', () => {
  it('returns a parent-scoped configuration snapshot with no-store headers', async () => {
    const snapshot = {
      schemaVersion: 1,
      shardId: 'shard-a',
      parentCompanionId: 'companion-a',
    };
    const getShardConfiguration = vi.fn(async () => snapshot as never);
    const route = routes(service({ getShardConfiguration }))
      .find(candidate => (
        candidate.method === 'GET'
        && candidate.match('/api/admin/shards/shard-a/configuration')
      ));
    expect(route).toBeDefined();

    const response = await invoke(route!, '/api/admin/shards/shard-a/configuration');

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(response.body)).toEqual(snapshot);
    expect(getShardConfiguration).toHaveBeenCalledWith('shard-a', context());
  });

  it('maps unknown/cross-parent/completed configuration mutations to generic 404', async () => {
    const updateShardConfiguration = vi.fn(async () => ({
      ok: false as const,
      code: 'not_found' as const,
      message: 'Shard not found',
    }));
    const route = routes(service({ updateShardConfiguration }))
      .find(candidate => (
        candidate.method === 'PATCH'
        && candidate.match('/api/admin/shards/shard-a/configuration')
      ));
    expect(route).toBeDefined();

    const response = await invoke(
      route!,
      '/api/admin/shards/shard-a/configuration',
      JSON.stringify({ model: { provider: 'provider-a', model: 'bounded-model' } }),
    );

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: 'Shard not found' });
    expect(updateShardConfiguration).toHaveBeenCalledWith(
      'shard-a',
      { model: { provider: 'provider-a', model: 'bounded-model' } },
      context(),
    );
  });

  it('rejects malformed JSON before the shard service sees a mutation', async () => {
    const updateShardConfiguration = vi.fn();
    const route = routes(service({ updateShardConfiguration }))
      .find(candidate => (
        candidate.method === 'PATCH'
        && candidate.match('/api/admin/shards/shard-a/configuration')
      ));

    const response = await invoke(
      route!,
      '/api/admin/shards/shard-a/configuration',
      '{"model":',
    );

    expect(response.status).toBe(400);
    expect(updateShardConfiguration).not.toHaveBeenCalled();
  });
});
