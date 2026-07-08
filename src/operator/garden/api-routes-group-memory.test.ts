import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { AdminChatBootstrapApi } from './admin-contract.js';
import {
  buildAdminApiRoutes,
  type AdminApiRoute,
} from './api-routes.js';
import type {
  AdminContactsService,
  AdminDashboardService,
  AdminGroupMemoryService,
  AdminIdentityService,
  AdminImagesService,
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
    headers: {
      host: 'localhost',
    },
    body,
  } as IncomingMessage;
}

function makeRoutes(groupMemoryService?: AdminGroupMemoryService | null): AdminApiRoute[] {
  return buildAdminApiRoutes({
    config: {} as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    imagesService: {} as AdminImagesService,
    groupMemoryService,
    shardFoldReviewService: {} as AdminShardFoldReviewService,
    memoryService: {} as AdminMemoryService,
    sessionService: {} as AdminSessionService,
    contactsService: {} as AdminContactsService,
    settingsService: {} as AdminSettingsService,
    identityService: {} as AdminIdentityService,
    promptsService: {} as AdminPromptsService,
    chatBootstrapService: {} as AdminChatBootstrapApi,
    withBody: (req, _res, cb) => cb((req as IncomingMessage & { body?: string }).body ?? ''),
  });
}

async function invokeRoute(
  route: AdminApiRoute,
  url: string,
  body = '',
): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  const params = route.match(new URL(url, 'http://localhost').pathname);
  route.handle(makeRequest(url, body), response as unknown as ServerResponse, params ?? {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('group memory admin API routes', () => {
  it('returns list and channel diagnostics through canonical admin paths', async () => {
    const groupMemoryService: AdminGroupMemoryService = {
      listGroupMemoryDiagnostics: vi.fn(async () => ({
        channels: [{
          channelId: 'discord:general',
          channelType: 'discord',
          messageCount: 50,
          resolvedConfig: {} as never,
          classification: {
            mode: 'group',
            reason: 'manual_group',
            topology: {
              kind: 'group_channel',
              source: 'manual',
              isDirect: false,
              isGroupCapable: true,
            },
            configuredMemoryMode: 'group',
            configuredMemoryModeSource: 'settings',
            recentParticipantCount: 2,
            recentParticipantContactIds: ['contact-a'],
            recentParticipants: [],
            participantWindow: {
              requestedMessageLimit: 50,
              requestedTimeWindowMs: 1_000,
              newestTimestamp: null,
              cutoffTimestamp: null,
              scannedEntryCount: 50,
              eligibleEntryCount: 25,
              oldestEntryId: 1,
              newestEntryId: 50,
            },
          },
          watermark: {} as never,
          range: {
            headMessageId: 50,
            watermarkLagMessageIds: 50,
            plannedChunkCount: 1,
            hasDeferredBacklog: false,
          },
          salience: null,
          lastExtraction: null,
          coverage: {
            channelMemoryCount: 0,
            activeMemoryCount: 0,
            highSensitivityMemoryCount: 0,
            perContact: [],
          },
          privacy: {
            rawTranscriptTextIncluded: false,
            memoryTextIncluded: false,
          },
        }],
        reasonCounts: { manual_group: 1 },
      })),
      getGroupMemoryChannelDiagnostics: vi.fn(async channelId => ({
        channelId,
        channelType: 'discord',
        messageCount: 50,
        resolvedConfig: {} as never,
        classification: {
          mode: 'group',
          reason: 'manual_group',
          topology: {
            kind: 'group_channel',
            source: 'manual',
            isDirect: false,
            isGroupCapable: true,
          },
          configuredMemoryMode: 'group',
          configuredMemoryModeSource: 'settings',
          recentParticipantCount: 2,
          recentParticipantContactIds: [],
          recentParticipants: [],
          participantWindow: {
            requestedMessageLimit: 50,
            requestedTimeWindowMs: 1_000,
            newestTimestamp: null,
            cutoffTimestamp: null,
            scannedEntryCount: 50,
            eligibleEntryCount: 25,
            oldestEntryId: 1,
            newestEntryId: 50,
          },
        },
        watermark: {} as never,
        range: {
          headMessageId: 50,
          watermarkLagMessageIds: 50,
          plannedChunkCount: 1,
          hasDeferredBacklog: false,
        },
        salience: null,
        lastExtraction: null,
        coverage: {
          channelMemoryCount: 0,
          activeMemoryCount: 0,
          highSensitivityMemoryCount: 0,
          perContact: [],
        },
        privacy: {
          rawTranscriptTextIncluded: false,
          memoryTextIncluded: false,
        },
      })),
      runGroupMemoryBackfill: vi.fn(async () => ({
        status: 'planned',
        channelId: 'discord:general',
        target: {
          channelId: 'discord:general',
          channelType: 'discord',
          mode: 'dry_run',
          resume: true,
          startMessageId: 1,
          endMessageId: 100,
        },
        resolvedConfig: {} as never,
        classification: {} as never,
        watermarkBefore: {} as never,
        watermarkAfter: {} as never,
        headMessageId: 100,
        watermarkLagMessageIds: 100,
        hasDeferredBacklog: false,
        plannedChunkCount: 1,
        plannedLlmCalls: 1,
        executedLlmCalls: 0,
        processedChunkCount: 0,
        skippedChunkCount: 0,
        failedChunkCount: 0,
        candidateSpanCount: 1,
        chunks: [],
        privacy: {
          rawTranscriptTextIncluded: false,
          memoryTextIncluded: false,
        },
      })),
    };
    const routes = makeRoutes(groupMemoryService);
    const listRoute = routes.find(candidate => candidate.match('/api/admin/group-memory'));
    const detailRoute = routes.find(candidate => candidate.match('/api/admin/group-memory/discord%3Ageneral'));
    expect(listRoute).toBeDefined();
    expect(detailRoute).toBeDefined();

    const listResponse = await invokeRoute(listRoute!, '/api/admin/group-memory');
    const detailResponse = await invokeRoute(detailRoute!, '/api/admin/group-memory/discord%3Ageneral');

    expect(listResponse.status).toBe(200);
    expect(listResponse.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(listResponse.body).reasonCounts).toEqual({ manual_group: 1 });
    expect(detailResponse.status).toBe(200);
    expect(JSON.parse(detailResponse.body)).toEqual(expect.objectContaining({
      channelId: 'discord:general',
      privacy: {
        rawTranscriptTextIncluded: false,
        memoryTextIncluded: false,
      },
    }));
    expect(groupMemoryService.getGroupMemoryChannelDiagnostics).toHaveBeenCalledWith('discord:general');
  });

  it('runs group memory backfill through the admin route', async () => {
    const groupMemoryService: AdminGroupMemoryService = {
      listGroupMemoryDiagnostics: vi.fn(async () => ({ channels: [], reasonCounts: {} })),
      getGroupMemoryChannelDiagnostics: vi.fn(async () => null),
      runGroupMemoryBackfill: vi.fn(async (channelId, input) => ({
        status: 'planned',
        channelId,
        target: {
          channelId,
          channelType: 'discord',
          mode: input.mode ?? 'dry_run',
          resume: input.resume ?? true,
          startMessageId: input.startMessageId ?? 1,
          endMessageId: input.endMessageId ?? null,
        },
        resolvedConfig: {} as never,
        classification: {} as never,
        watermarkBefore: {} as never,
        watermarkAfter: {} as never,
        headMessageId: input.endMessageId ?? null,
        watermarkLagMessageIds: 50,
        hasDeferredBacklog: false,
        plannedChunkCount: 1,
        plannedLlmCalls: 1,
        executedLlmCalls: 0,
        processedChunkCount: 0,
        skippedChunkCount: 0,
        failedChunkCount: 0,
        candidateSpanCount: 1,
        chunks: [],
        privacy: {
          rawTranscriptTextIncluded: false,
          memoryTextIncluded: false,
        },
      })),
    };
    const routes = makeRoutes(groupMemoryService);
    const route = routes.find(candidate => (
      candidate.method === 'POST'
      && candidate.match('/api/admin/group-memory/discord%3Ageneral/backfill')
    ));
    expect(route).toBeDefined();

    const response = await invokeRoute(
      route!,
      '/api/admin/group-memory/discord%3Ageneral/backfill',
      JSON.stringify({
        mode: 'dry_run',
        startMessageId: 1,
        endMessageId: 100,
        maxMessagesPerRun: 50,
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({
      status: 'planned',
      privacy: {
        rawTranscriptTextIncluded: false,
        memoryTextIncluded: false,
      },
    }));
    expect(groupMemoryService.runGroupMemoryBackfill).toHaveBeenCalledWith('discord:general', {
      mode: 'dry_run',
      startMessageId: 1,
      endMessageId: 100,
      maxMessagesPerRun: 50,
    });
  });

  it('fails closed when the group-memory diagnostics service is unavailable', async () => {
    const route = makeRoutes(null).find(candidate => candidate.match('/api/admin/group-memory'));
    expect(route).toBeDefined();

    const response = await invokeRoute(route!, '/api/admin/group-memory');

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Group memory diagnostics backend unavailable',
    });
  });
});
