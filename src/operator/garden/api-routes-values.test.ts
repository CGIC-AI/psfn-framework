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
  AdminSchedulerApi,
  AdminValuesJournalApi,
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
import type { GardenRequestContext } from './garden-request-context.js';
import { requireGardenRouteAuthorization } from '../../boundary/fleet-auth/garden-route-authorization.js';
import { isPrivacyBreakGlassConfirmRoute } from '../../shared/contracts/privacy-break-glass.js';

/**
 * Companion-private journals are gated behind the privacy break-glass
 * assurance; every read carries a fleet-principal context whose session
 * assurance decides disclosure. These builders synthesise just the fields the
 * route gate inspects (`kind`, `actor.sessionAssurance`).
 */
function breakGlassContext(): GardenRequestContext {
  return { kind: 'fleet_principal', actor: { sessionAssurance: 'break_glass' } } as unknown as GardenRequestContext;
}

function oauthContext(): GardenRequestContext {
  return { kind: 'fleet_principal', actor: { sessionAssurance: 'oauth' } } as unknown as GardenRequestContext;
}

type AuditAppender = NonNullable<
  Parameters<typeof buildAdminApiRoutes>[0]['appendAuditTimelineEntry']
>;

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
  valuesJournal?: AdminValuesJournalApi | null;
  reflectionMetacognitionJournal?: AdminReflectionMetacognitionJournalApi | null;
  reflectionDailyJournal?: AdminReflectionDailyJournalApi | null;
  reflectionJournal?: AdminReflectionJournalApi | null;
  scheduler?: AdminSchedulerApi | null;
  appendAuditTimelineEntry?: AuditAppender;
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
    valuesJournal: options.valuesJournal,
    reflectionMetacognitionJournal: options.reflectionMetacognitionJournal,
    reflectionDailyJournal: options.reflectionDailyJournal,
    reflectionJournal: options.reflectionJournal,
    scheduler: options.scheduler,
    // A break-glass disclosure fails closed unless it can be audited, so tests
    // default to a real appender; passing the key explicitly (even undefined)
    // exercises the unauditable path.
    appendAuditTimelineEntry: 'appendAuditTimelineEntry' in options
      ? options.appendAuditTimelineEntry
      : vi.fn(),
    withBody: () => {},
  });
}

async function invokeRoute(
  route: AdminApiRoute,
  url: string,
  context: GardenRequestContext | undefined = breakGlassContext(),
): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  const params = route.match(new URL(url, 'http://localhost').pathname);
  route.handle(makeRequest(url), response as unknown as ServerResponse, params ?? {}, context);
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

const JOURNAL_ROUTE_URLS = [
  '/api/admin/values',
  '/api/admin/values/reflections/metacognition',
  '/api/admin/values/reflections/daily',
  '/api/admin/values/reflections/journal',
] as const;

describe('values reflection journal admin API routes', () => {
  it('reports counts, latest timestamps, and schedule failures without break-glass or journal bodies', async () => {
    const routes = makeRoutes({
      valuesJournal: {
        list: () => [{ createdAt: '2026-08-09T12:00:00.000Z', reflection: 'sealed values body' }] as never,
      },
      reflectionMetacognitionJournal: {
        listRecent: () => [{ occurredAt: '2026-08-10T10:00:00.000Z', reflection: 'sealed metacognition body' }] as never,
      },
      reflectionDailyJournal: {
        listRecent: () => [{ createdAt: '2026-08-08T10:00:00.000Z', reflection: 'sealed daily body' }] as never,
      },
      reflectionJournal: {
        listRecent: () => [
          { templateId: 'musing', createdAt: '2026-08-10T11:00:00.000Z', reflection: 'sealed reflection body' },
          { templateId: 'concern_route', createdAt: '2026-08-09T11:00:00.000Z', reflection: 'sealed concern body' },
        ] as never,
      },
      scheduler: {
        listTasks: () => [
          {
            id: 'reflection:daily-review',
            state: 'idle',
            lastOutcome: 'failed',
            lastRunAt: Date.now(),
          },
          {
            id: 'reflection:weekly-review',
            state: 'paused',
            lastRunAt: Date.now(),
          },
        ] as never,
      },
    });
    const route = routes.find(candidate => candidate.match('/api/admin/values/status'));
    expect(route).toBeDefined();

    const response = await invokeRoute(route!, '/api/admin/values/status', oauthContext());
    const body = JSON.parse(response.body) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(body).toMatchObject({
      streams: {
        values: { available: true, count: 1, latestAt: '2026-08-09T12:00:00.000Z' },
        metacognition: { available: true, count: 1 },
        daily: { available: true, count: 1 },
        reflection: { available: true, count: 1 },
        concerns: { available: true, count: 1 },
      },
      tasks: {
        daily: { health: 'failed', attentionRequired: true },
        weekly: { health: 'paused', attentionRequired: true },
      },
      attentionCount: 2,
    });
    expect(response.body).not.toContain('sealed');
  });

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

describe('companion journal privacy break-glass gate', () => {
  function serviceRoutes(appendAuditTimelineEntry?: AuditAppender): AdminApiRoute[] {
    return makeRoutes({
      reflectionMetacognitionJournal: { listRecent: vi.fn(() => []) },
      reflectionDailyJournal: { listRecent: vi.fn(() => []) },
      reflectionJournal: { listRecent: vi.fn(() => []) },
      ...(appendAuditTimelineEntry ? { appendAuditTimelineEntry } : {}),
    });
  }

  it.each(JOURNAL_ROUTE_URLS)(
    'denies %s without an active break-glass grant and audits the denial',
    async (url) => {
      const appendAudit = vi.fn();
      const routes = serviceRoutes(appendAudit);
      const route = routes.find(candidate => candidate.match(new URL(url, 'http://localhost').pathname));
      expect(route).toBeDefined();

      const denied = await invokeRoute(route!, url, oauthContext());

      expect(denied.status).toBe(403);
      expect(JSON.parse(denied.body)).toEqual({
        error: 'Companion journal read requires privacy break-glass',
      });
      expect(denied.headers['Cache-Control']).toBe('no-store');
      expect(appendAudit).toHaveBeenCalledTimes(1);
      const [actionType, decision, , details] = appendAudit.mock.calls[0]!;
      expect(actionType).toBe('memory_access');
      expect(decision).toBe('denied');
      expect(details).toContain('resourceKind=journal');
      expect(details).toContain('reasonCode=break_glass_required');
    },
  );

  it('denies a standalone (non-fleet) operator context and audits the denial', async () => {
    const appendAudit = vi.fn();
    const routes = serviceRoutes(appendAudit);
    const route = routes.find(candidate => candidate.match('/api/admin/values/reflections/journal'));
    expect(route).toBeDefined();

    const denied = await invokeRoute(
      route!,
      '/api/admin/values/reflections/journal',
      { kind: 'standalone_token' } as unknown as GardenRequestContext,
    );

    expect(denied.status).toBe(403);
    const [, decision, , details] = appendAudit.mock.calls[0]!;
    expect(decision).toBe('denied');
    expect(details).toContain('reasonCode=trusted_principal_required');
  });

  it.each(JOURNAL_ROUTE_URLS)(
    'discloses %s under an active break-glass grant and audits the read',
    async (url) => {
      const appendAudit = vi.fn();
      const routes = serviceRoutes(appendAudit);
      const route = routes.find(candidate => candidate.match(new URL(url, 'http://localhost').pathname));
      expect(route).toBeDefined();

      const allowed = await invokeRoute(route!, url, breakGlassContext());

      expect(allowed.status).toBe(200);
      expect(JSON.parse(allowed.body)).toEqual({ entries: [] });
      expect(appendAudit).toHaveBeenCalledTimes(1);
      const [actionType, decision, , details] = appendAudit.mock.calls[0]!;
      expect(actionType).toBe('memory_access');
      expect(decision).toBe('allowed');
      expect(details).toContain('resourceKind=journal');
      expect(details).toContain('assurance=break_glass');
    },
  );

  it('makes the gated read reachable through the real journal break-glass confirm assurance', async () => {
    // The gateway (fleet-sso-router) mints the `break_glass` session assurance
    // the four gated GET reads require ONLY when a request targets a recognised
    // privacy break-glass confirm route whose authorization demands
    // `privacy_break_glass`. Before this seam, no journal route satisfied that
    // predicate, so the reads were a permanent 403. Assert the journal confirm
    // route now satisfies both halves of the real mint predicate, then derive
    // the minted assurance from that classification (not a hand-picked literal)
    // and prove it unlocks a disclosure.
    const confirmRouteId = 'POST /api/admin/privacy-break-glass/journal/:id/confirm';
    expect(isPrivacyBreakGlassConfirmRoute(confirmRouteId)).toBe(true);
    const mintPredicate = requireGardenRouteAuthorization(confirmRouteId).requirements.assurance;
    expect(mintPredicate).toBe('privacy_break_glass');
    const mintedAssurance = mintPredicate === 'privacy_break_glass' ? 'break_glass' : 'oauth';
    const mintedContext = {
      kind: 'fleet_principal',
      actor: { sessionAssurance: mintedAssurance },
    } as unknown as GardenRequestContext;

    const appendAudit = vi.fn();
    const routes = makeRoutes({
      reflectionJournal: { listRecent: vi.fn(() => []) },
      appendAuditTimelineEntry: appendAudit,
    });
    const route = routes.find(candidate => candidate.match('/api/admin/values/reflections/journal'));
    expect(route).toBeDefined();

    const allowed = await invokeRoute(
      route!,
      '/api/admin/values/reflections/journal',
      mintedContext,
    );

    expect(allowed.status).toBe(200);
    const [, decision, , details] = appendAudit.mock.calls[0]!;
    expect(decision).toBe('allowed');
    expect(details).toContain('assurance=break_glass');
  });

  it('fails closed with 503 when a break-glass read cannot be audited', async () => {
    const routes = makeRoutes({
      reflectionJournal: { listRecent: vi.fn(() => []) },
      // No appendAuditTimelineEntry override; force the appender absent so the
      // disclosure cannot be recorded and must not proceed.
      appendAuditTimelineEntry: undefined as unknown as AuditAppender,
    });
    const route = routes.find(candidate => candidate.match('/api/admin/values/reflections/journal'));
    expect(route).toBeDefined();

    const response = await invokeRoute(
      route!,
      '/api/admin/values/reflections/journal',
      breakGlassContext(),
    );

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'Companion journal read is unavailable' });
  });
});
