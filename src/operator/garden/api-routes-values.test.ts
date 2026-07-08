import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type {
  AdminChatBootstrapApi,
  AdminReflectionDailyJournalApi,
  AdminReflectionJournalApi,
  AdminReflectionMetacognitionJournalApi,
} from './admin-contract.js';
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
import type { ReflectionMetacognitionJournalEntry } from '../../persistence/journals/reflection-metacognition-journal.js';
import type { ReflectionDailyJournalEntry } from '../../persistence/journals/reflection-substrate.js';
import type { ReflectionJournalEntry } from '../../persistence/journals/reflection-journal.js';

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

function makeRoutes(options: {
  reflectionMetacognitionJournal?: AdminReflectionMetacognitionJournalApi | null;
  reflectionDailyJournal?: AdminReflectionDailyJournalApi | null;
  reflectionJournal?: AdminReflectionJournalApi | null;
}): AdminApiRoute[] {
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
    reflectionMetacognitionJournal: options.reflectionMetacognitionJournal,
    reflectionDailyJournal: options.reflectionDailyJournal,
    reflectionJournal: options.reflectionJournal,
    withBody: () => {},
  });
}

async function invokeRoute(route: AdminApiRoute, url: string): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  const params = route.match(new URL(url, 'http://localhost').pathname);
  route.handle(makeRequest(url), response as unknown as ServerResponse, params ?? {});
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('values reflection journal admin API routes', () => {
  it('returns recent metacognition, daily, and free-form reflection entries', async () => {
    const metacognitionEntry: ReflectionMetacognitionJournalEntry = {
      id: 'meta-1',
      kind: 'reflection_run',
      occurredAt: '2026-03-08T07:00:00.000Z',
      initiatorSurface: 'heartbeat',
      initiatedBy: 'scheduler',
      templateId: 'weekly-review',
      templateName: 'Weekly Review',
      executionSource: 'scheduled',
      channelId: 'discord:heartbeat',
      sendToDiscordEffective: false,
      mode: 'deliberation',
      prompt: 'Review this week.',
      reflection: 'A realistic metacognition reflection entry.',
    };
    const dailyEntry: ReflectionDailyJournalEntry = {
      id: 'daily-1',
      kind: 'daily_journal_entry',
      source: 'heartbeat_template',
      executionSource: 'scheduled',
      reflection: 'A realistic daily journal reflection entry.',
      createdAt: '2026-03-08T06:10:00.000Z',
      date: '2026-03-08',
      templateId: 'daily-reflection',
      templateName: 'Daily Reflection',
      channelId: 'discord:heartbeat',
      prompt: 'What matters today?',
      mode: 'agent',
    };
    const reflectionEntry: ReflectionJournalEntry = {
      id: 'reflection-1',
      templateId: 'musing',
      templateName: 'Musing',
      prompt: 'Free-form reflection prompt.',
      reflection: 'A realistic free-form reflection journal entry.',
      channelId: 'discord:heartbeat',
      mode: 'agent',
      createdAt: '2026-03-08T08:00:00.000Z',
    };
    const metacognitionService: AdminReflectionMetacognitionJournalApi = {
      listRecent: vi.fn(() => [metacognitionEntry]),
    };
    const dailyService: AdminReflectionDailyJournalApi = {
      listRecent: vi.fn(() => [dailyEntry]),
    };
    const reflectionService: AdminReflectionJournalApi = {
      listRecent: vi.fn(() => [reflectionEntry]),
    };
    const routes = makeRoutes({
      reflectionMetacognitionJournal: metacognitionService,
      reflectionDailyJournal: dailyService,
      reflectionJournal: reflectionService,
    });

    const metacognitionRoute = routes.find(route => route.match('/api/admin/values/reflections/metacognition'));
    const dailyRoute = routes.find(route => route.match('/api/admin/values/reflections/daily'));
    const reflectionRoute = routes.find(route => route.match('/api/admin/values/reflections/journal'));
    expect(metacognitionRoute).toBeDefined();
    expect(dailyRoute).toBeDefined();
    expect(reflectionRoute).toBeDefined();

    const metacognitionResponse = await invokeRoute(
      metacognitionRoute!,
      '/api/admin/values/reflections/metacognition?limit=5',
    );
    const dailyResponse = await invokeRoute(dailyRoute!, '/api/admin/values/reflections/daily?limit=5');
    const reflectionResponse = await invokeRoute(reflectionRoute!, '/api/admin/values/reflections/journal?limit=5');

    expect(metacognitionResponse.status).toBe(200);
    expect(dailyResponse.status).toBe(200);
    expect(reflectionResponse.status).toBe(200);
    expect(JSON.parse(metacognitionResponse.body)).toEqual({ entries: [metacognitionEntry] });
    expect(JSON.parse(dailyResponse.body)).toEqual({ entries: [dailyEntry] });
    expect(JSON.parse(reflectionResponse.body)).toEqual({ entries: [reflectionEntry] });
    expect(metacognitionService.listRecent).toHaveBeenCalledWith({ limit: 5 });
    expect(dailyService.listRecent).toHaveBeenCalledWith({ limit: 5 });
    expect(reflectionService.listRecent).toHaveBeenCalledWith({ limit: 5 });
  });

  it('caps reflection journal route limits and fails closed when a service is missing', async () => {
    const dailyService: AdminReflectionDailyJournalApi = {
      listRecent: vi.fn(() => []),
    };
    const routes = makeRoutes({
      reflectionMetacognitionJournal: null,
      reflectionDailyJournal: dailyService,
      reflectionJournal: null,
    });
    const dailyRoute = routes.find(route => route.match('/api/admin/values/reflections/daily'));
    const metacognitionRoute = routes.find(route => route.match('/api/admin/values/reflections/metacognition'));
    expect(dailyRoute).toBeDefined();
    expect(metacognitionRoute).toBeDefined();

    const capped = await invokeRoute(dailyRoute!, '/api/admin/values/reflections/daily?limit=1000');
    expect(capped.status).toBe(200);
    expect(dailyService.listRecent).toHaveBeenCalledWith({ limit: 250 });

    const missing = await invokeRoute(metacognitionRoute!, '/api/admin/values/reflections/metacognition');
    expect(missing.status).toBe(503);
    expect(JSON.parse(missing.body)).toEqual({
      error: 'Reflection metacognition journal unavailable',
    });
  });
});
