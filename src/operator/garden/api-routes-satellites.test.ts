import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseSatelliteRegistryConfig } from '../../channels/backplane/satellite-registry.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type {
  AdminContactsService,
  AdminDashboardService,
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

function makeRoutes(config: SubstrateConfig): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config,
    dashboardService: {} as AdminDashboardService,
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

async function invokeRoute(route: AdminApiRoute, url: string): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  route.handle(makeRequest(url), response as unknown as ServerResponse, {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('satellite registry admin API route', () => {
  it('returns a sanitized registry view without certificate or API key binding values', async () => {
    const satelliteRegistry = parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: true,
      satellites: [
        {
          satelliteId: 'amica',
          displayName: 'Amica',
          mobility: 'portable',
          staticLocationLabel: 'Live test desk',
          endpoints: [
            {
              endpointId: 'amica-browser',
              displayName: 'Amica Browser Conduit',
              claimTypes: ['amica-conduit'],
              promptChannelType: 'avatar_satellite',
              auth: {
                mode: 'mtls',
                apiKeyPrincipalIds: ['admin-user'],
                clientCertFingerprintSha256: 'aa'.repeat(32),
                clientCertSubject: 'CN=amica-browser',
              },
              defaultIdentity: {
                authorId: 'vega',
                authorName: 'Vega',
                canonicalContactId: 'contact-vega',
                channelPrivacy: 'private',
              },
              maxCapabilities: ['text', 'audio_input', 'speech_to_text', 'audio_output', 'text_to_speech', 'vision'],
              telemetryScopes: ['presence', 'device'],
            },
          ],
        },
      ],
    });

    const route = makeRoutes({ satelliteRegistry } as SubstrateConfig)
      .find(candidate => candidate.match('/api/admin/satellites'));
    expect(route).toBeDefined();

    const response = await invokeRoute(route!, '/api/admin/satellites');
    const payload = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(payload).toMatchObject({
      enabled: true,
      satelliteCount: 1,
      endpointCount: 1,
      liveObservationStatus: 'not_implemented',
      satellites: [
        {
          satelliteId: 'amica',
          displayName: 'Amica',
          mobility: 'portable',
          staticLocationLabel: 'Live test desk',
          endpoints: [
            {
              endpointId: 'amica-browser',
              displayName: 'Amica Browser Conduit',
              claimTypes: ['amica-conduit'],
              promptChannelType: 'avatar_satellite',
              auth: {
                mode: 'mtls',
                allowedPrincipalCount: 1,
                certBound: true,
                certBindingTypes: ['fingerprint_sha256', 'subject'],
              },
              live: {
                status: 'not_observed',
              },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('aaaaaaaa');
    expect(JSON.stringify(payload)).not.toContain('CN=amica-browser');
    expect(JSON.stringify(payload)).not.toContain('admin-user');
  });
});
